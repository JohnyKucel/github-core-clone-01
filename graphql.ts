// GraphQL v4 API at POST /api/graphql.
// Small hand-rolled parser + executor for exactly the documents gh and
// github-mcp-server send (see kit checks-graphql.ts). No dependencies.
// Auth is done by app.ts (401 before this handler runs).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FIXED_TIME,
  OWNER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { parseJsonBody, readBody, sendJson } from './http.ts';
import {
  createIssueInRepo,
  createPullInRepo,
  globalId,
  mergePullSquash,
  parseGlobalId,
  pullFilesList,
  pullMergeable,
  resolveRefSha,
} from './rest.ts';

type Headers = Readonly<Record<string, string>>;
type JsonObj = Record<string, unknown>;

// ---------------- GraphQL document parsing ----------------

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface FieldSel {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selection: Sel[] | null;
}
interface InlineFrag {
  kind: 'inline';
  typeCondition: string | null;
  selection: Sel[];
}
interface Spread {
  kind: 'spread';
  name: string;
}
type Sel = FieldSel | InlineFrag | Spread;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: { name: string; defaultValue: Value | null }[];
  selection: Sel[];
}
interface FragmentDef {
  name: string;
  typeCondition: string;
  selection: Sel[];
}

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === ';') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():[]=@{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'u' ? JSON.parse(`"${src.slice(j, j + 6)}"`) as string : esc;
          j += esc === 'u' ? 6 : 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      let isFloat = false;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j]!)) j += 1;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j]!)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    return this.tokens[this.pos++]!;
  }
  private expect(value: string): Token {
    const t = this.next();
    if (t.value !== value) throw new Error(`Expected ${JSON.stringify(value)} but got ${JSON.stringify(t.value)}`);
    return t;
  }
  private expectName(what = 'name'): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`Expected ${what} but got ${JSON.stringify(t.value)}`);
    return t.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, FragmentDef> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      if (this.peek().value === '{') {
        operations.push({ kind: 'query', name: null, varDefs: [], selection: this.parseSelectionSet() });
      } else if (this.peek().value === 'fragment') {
        this.next();
        const name = this.expectName('fragment name');
        this.expect('on');
        const typeCondition = this.expectName('fragment type');
        fragments.set(name, { name, typeCondition, selection: this.parseSelectionSet() });
      } else {
        const kind = this.next().value;
        if (kind !== 'query' && kind !== 'mutation' && kind !== 'subscription') throw new Error(`Unknown operation ${kind}`);
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefs = this.peek().value === '(' ? this.parseVarDefs() : [];
        operations.push({ kind: kind as 'query' | 'mutation', name, varDefs, selection: this.parseSelectionSet() });
      }
    }
    return { operations, fragments };
  }

  private parseVarDefs(): { name: string; defaultValue: Value | null }[] {
    const defs: { name: string; defaultValue: Value | null }[] = [];
    this.expect('(');
    while (this.peek().value !== ')') {
      this.expect('$');
      const name = this.expectName('variable name');
      this.expect(':');
      this.parseType();
      let defaultValue: Value | null = null;
      if (this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, defaultValue });
    }
    this.expect(')');
    return defs;
  }

  private parseType(): void {
    if (this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.expectName('type name');
    }
    if (this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): Sel[] {
    this.expect('{');
    const sels: Sel[] = [];
    while (this.peek().value !== '}') {
      if (this.peek().value === '...') {
        this.next();
        if (this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expectName('inline fragment type');
          sels.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else if (this.peek().kind === 'name') {
          sels.push({ kind: 'spread', name: this.next().value });
        } else {
          sels.push({ kind: 'inline', typeCondition: null, selection: this.parseSelectionSet() });
        }
      } else {
        const first = this.expectName('field name');
        let alias: string | null = null;
        let name = first;
        if (this.peek().value === ':') {
          this.next();
          alias = first;
          name = this.expectName('field name');
        }
        let args: Record<string, Value> = {};
        if (this.peek().value === '(') args = this.parseArgs();
        // Directives (@include/@skip/...) are not used by the suite; skip them.
        while (this.peek().value === '@') {
          this.next();
          this.expectName('directive name');
          if (this.peek().value === '(') this.parseArgs();
        }
        const selection = this.peek().value === '{' ? this.parseSelectionSet() : null;
        sels.push({ kind: 'field', alias, name, args, selection });
      }
    }
    this.expect('}');
    return sels;
  }

  private parseArgs(): Record<string, Value> {
    const args: Record<string, Value> = {};
    this.expect('(');
    while (this.peek().value !== ')') {
      const name = this.expectName('argument name');
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  private parseValue(): Value {
    const t = this.next();
    switch (t.kind) {
      case 'string':
        return { kind: 'string', value: t.value };
      case 'int':
        return { kind: 'int', value: Number.parseInt(t.value, 10) };
      case 'float':
        return { kind: 'float', value: Number.parseFloat(t.value) };
      case 'name':
        if (t.value === 'true') return { kind: 'boolean', value: true };
        if (t.value === 'false') return { kind: 'boolean', value: false };
        if (t.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: t.value };
      default:
        break;
    }
    if (t.value === '$') return { kind: 'var', name: this.expectName('variable name') };
    if (t.value === '[') {
      const items: Value[] = [];
      while (this.peek().value !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (t.value === '{') {
      const fields: Record<string, Value> = {};
      while (this.peek().value !== '}') {
        const name = this.expectName('object field name');
        this.expect(':');
        fields[name] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    throw new Error(`Unexpected value token ${JSON.stringify(t.value)}`);
  }
}

// ---------------- execution ----------------

type Node =
  | { __t: 'Query' }
  | { __t: 'Mutation' }
  | { __t: 'User'; login: string }
  | { __t: 'Repository'; repo: Repo }
  | { __t: 'Issue'; repo: Repo; issue: Issue }
  | { __t: 'PullRequest'; repo: Repo; pull: Pull }
  | { __t: 'IssueConnection'; repo: Repo; issues: Issue[]; hasNextPage: boolean; endCursor: string | null }
  | { __t: 'PullRequestConnection'; repo: Repo; pulls: Pull[] }
  | { __t: 'FilesConnection'; repo: Repo; pull: Pull; files: { path: string; additions: number; deletions: number; changes: number; status: string }[] }
  | { __t: 'ChangedFile'; path: string; additions: number; deletions: number; changes: number; status: string }
  | { __t: 'Ref'; name: string }
  | { __t: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __t: '__Type'; name: string; kind: string; fields: string[]; enumValues: string[] }
  | { __t: '__Field'; name: string }
  | { __t: '__EnumValue'; name: string }
  | { __t: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __t: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __t: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __t: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __t: 'AddCommentPayload'; repo: Repo; issue: Issue; comment: { id: number; body: string } }
  | { __t: 'CommentEdge'; comment: { id: number; body: string }; repo: Repo; issue: Issue }
  | { __t: 'Comment'; comment: { id: number; body: string }; repo: Repo; issue: Issue };

interface Ctx {
  store: Store;
  vars: Record<string, unknown>;
  errors: { message: string; path?: (string | number)[] }[];
  fragments: Map<string, FragmentDef>;
}

function resolveValue(v: Value, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var':
      return vars[v.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return v.value;
    case 'null':
      return null;
    case 'enum':
      return v.value;
    case 'list':
      return v.items.map((item) => resolveValue(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v.fields)) out[k] = resolveValue(val, vars);
      return out;
    }
  }
}

function resolveArgs(field: FieldSel, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) out[k] = resolveValue(v, ctx.vars);
  return out;
}

function cursorEncode(n: number): string {
  return Buffer.from(`cursor:${n}`).toString('base64');
}
function cursorDecode(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number.parseInt(m[1]!, 10) : null;
  } catch {
    return null;
  }
}

function issueStateEnum(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateEnum(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function repoByNumericId(store: Store, id: number): Repo | undefined {
  return store.listRepos().find((r) => r.id === id);
}

function decodeRepoId(store: Store, gid: unknown): Repo | undefined {
  if (typeof gid !== 'string') return undefined;
  const parsed = parseGlobalId(gid);
  if (!parsed || parsed.kind !== 'repo' || parsed.parts.length !== 1) return undefined;
  return repoByNumericId(store, Number.parseInt(parsed.parts[0]!, 10));
}

function decodeIssueId(store: Store, gid: unknown): { repo: Repo; issue: Issue } | undefined {
  if (typeof gid !== 'string') return undefined;
  const parsed = parseGlobalId(gid);
  if (!parsed || parsed.kind !== 'issue' || parsed.parts.length !== 2) return undefined;
  const repo = repoByNumericId(store, Number.parseInt(parsed.parts[0]!, 10));
  const issue = repo?.issues.get(Number.parseInt(parsed.parts[1]!, 10));
  return repo && issue ? { repo, issue } : undefined;
}

function decodePullId(store: Store, gid: unknown): { repo: Repo; pull: Pull } | undefined {
  if (typeof gid !== 'string') return undefined;
  const parsed = parseGlobalId(gid);
  if (!parsed || parsed.kind !== 'pull' || parsed.parts.length !== 2) return undefined;
  const repo = repoByNumericId(store, Number.parseInt(parsed.parts[0]!, 10));
  const pull = repo?.pulls.get(Number.parseInt(parsed.parts[1]!, 10));
  return repo && pull ? { repo, pull } : undefined;
}

// Introspection tables: the fields gh feature-detects, plus a few extras.
const TYPE_FIELDS: Record<string, { kind: string; fields: string[]; enumValues: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository'],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'url', 'createdAt', 'updatedAt', 'mergedAt', 'author', 'repository'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'url', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'isPrivate'],
    enumValues: [],
  },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'PROJECT', 'WIKI'],
  },
  User: {
    kind: 'OBJECT',
    fields: ['id', 'login', 'name', 'url'],
    enumValues: [],
  },
};

type Resolver = (node: Node, args: Record<string, unknown>, ctx: Ctx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __t: 'User', login: OWNER_LOGIN }) as Node,
    repository: (_n, args, ctx) => {
      const owner = args.owner;
      const name = args.name;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      if (owner !== OWNER_LOGIN) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo ? ({ __t: 'Repository', repo }) as Node : null;
    },
    node: (_n, args, ctx) => {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const parsed = parseGlobalId(id);
      if (!parsed) return null;
      if (parsed.kind === 'repo') {
        const repo = repoByNumericId(ctx.store, Number.parseInt(parsed.parts[0]!, 10));
        return repo ? ({ __t: 'Repository', repo }) as Node : null;
      }
      if (parsed.kind === 'issue') {
        const found = decodeIssueId(ctx.store, id);
        return found ? ({ __t: 'Issue', repo: found.repo, issue: found.issue }) as Node : null;
      }
      if (parsed.kind === 'pull') {
        const found = decodePullId(ctx.store, id);
        return found ? ({ __t: 'PullRequest', repo: found.repo, pull: found.pull }) as Node : null;
      }
      return null;
    },
    __type: (_n, args) => {
      const name = args.name;
      if (typeof name !== 'string') return null;
      const def = TYPE_FIELDS[name];
      if (!def) return null;
      return { __t: '__Type', name, kind: def.kind, fields: def.fields, enumValues: def.enumValues } as Node;
    },
    __schema: () => ({ __t: '__Type', name: 'Query', kind: 'OBJECT', fields: ['viewer', 'repository', 'node'], enumValues: [] }) as Node,
  },
  Mutation: {
    createIssue: (_n, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = decodeRepoId(ctx.store, input.repositoryId);
      if (!repo) throw new Error('Repository not found');
      const created = createIssueInRepo(repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '' });
      if ('error' in created) throw new Error(created.error.message);
      return { __t: 'CreateIssuePayload', repo, issue: created.issue } as Node;
    },
    closeIssue: (_n, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = decodeIssueId(ctx.store, input.issueId);
      if (!found) throw new Error('Issue not found');
      found.issue.state = 'closed';
      found.issue.updated_at = FIXED_TIME;
      return { __t: 'CloseIssuePayload', repo: found.repo, issue: found.issue } as Node;
    },
    createPullRequest: (_n, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = decodeRepoId(ctx.store, input.repositoryId);
      if (!repo) throw new Error('Repository not found');
      const created = createPullInRepo(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if ('error' in created) throw new Error(created.error.message);
      return { __t: 'CreatePullRequestPayload', repo, pull: created.pull } as Node;
    },
    mergePullRequest: (_n, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = decodePullId(ctx.store, input.pullRequestId);
      if (!found) throw new Error('Pull request not found');
      const merged = mergePullSquash(found.repo, found.pull);
      if ('error' in merged) throw new Error(merged.error.message);
      return { __t: 'MergePullRequestPayload', repo: found.repo, pull: found.pull } as Node;
    },
    addComment: (_n, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = decodeIssueId(ctx.store, input.subjectId);
      if (!found) throw new Error('Subject not found');
      const comment = { id: found.repo.nextCommentId++, body: String(input.body ?? ''), user: OWNER_LOGIN, created_at: FIXED_TIME, updated_at: FIXED_TIME };
      found.issue.comments.push(comment);
      found.issue.updated_at = FIXED_TIME;
      return { __t: 'AddCommentPayload', repo: found.repo, issue: found.issue, comment } as Node;
    },
  },
  User: {
    id: (n) => globalId('user', 1000),
    login: (n) => (n as { login: string }).login,
    name: () => 'ada iversen',
    url: () => '',
  },
  Repository: {
    id: (n) => globalId('repo', (n as { repo: Repo }).repo.id),
    databaseId: (n) => (n as { repo: Repo }).repo.id,
    name: (n) => (n as { repo: Repo }).repo.name,
    nameWithOwner: (n) => (n as { repo: Repo }).repo.fullName,
    owner: (n) => ({ __t: 'User', login: (n as { repo: Repo }).repo.owner }) as Node,
    defaultBranchRef: (n) => {
      const repo = (n as { repo: Repo }).repo;
      const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return sha ? ({ __t: 'Ref', name: repo.defaultBranch }) as Node : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (n) => (n as { repo: Repo }).repo.description,
    url: () => '',
    isPrivate: (n) => (n as { repo: Repo }).repo.private,
    createdAt: (n) => (n as { repo: Repo }).repo.created_at,
    updatedAt: (n) => (n as { repo: Repo }).repo.updated_at,
    issue: (n, args) => {
      const { repo } = n as { repo: Repo };
      const num = args.number;
      if (typeof num !== 'number') return null;
      const issue = repo.issues.get(num);
      return issue ? ({ __t: 'Issue', repo, issue }) as Node : null;
    },
    issues: (n, args) => {
      const { repo } = n as { repo: Repo };
      let list = [...repo.issues.values()];
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        list = list.filter((i) => wanted.has(i.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
      list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
      const afterNum = cursorDecode(args.after);
      if (afterNum !== null) list = list.filter((i) => (direction === 'ASC' ? i.number > afterNum : i.number < afterNum));
      const first = typeof args.first === 'number' ? args.first : list.length;
      const page = list.slice(0, first);
      const hasNextPage = list.length > page.length;
      const endCursor = page.length > 0 ? cursorEncode(page[page.length - 1]!.number) : null;
      return { __t: 'IssueConnection', repo, issues: page, hasNextPage, endCursor } as Node;
    },
    pullRequest: (n, args) => {
      const { repo } = n as { repo: Repo };
      const num = args.number;
      if (typeof num !== 'number') return null;
      const pull = repo.pulls.get(num);
      return pull ? ({ __t: 'PullRequest', repo, pull }) as Node : null;
    },
    pullRequests: (n, args) => {
      const { repo } = n as { repo: Repo };
      let list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toUpperCase()));
        list = list.filter((p) => wanted.has(pullStateEnum(p)));
      }
      const first = typeof args.first === 'number' ? args.first : list.length;
      return { __t: 'PullRequestConnection', repo, pulls: list.slice(0, first) } as Node;
    },
  },
  Issue: {
    id: (n) => globalId('issue', (n as { repo: Repo }).repo.id, (n as { issue: Issue }).issue.number),
    number: (n) => (n as { issue: Issue }).issue.number,
    title: (n) => (n as { issue: Issue }).issue.title,
    state: (n) => issueStateEnum((n as { issue: Issue }).issue),
    body: (n) => (n as { issue: Issue }).issue.body,
    url: () => '',
    createdAt: (n) => (n as { issue: Issue }).issue.created_at,
    updatedAt: (n) => (n as { issue: Issue }).issue.updated_at,
    author: (n) => ({ __t: 'User', login: (n as { issue: Issue }).issue.user }) as Node,
    repository: (n) => ({ __t: 'Repository', repo: (n as { repo: Repo }).repo }) as Node,
    labels: () => [],
    comments: () => ({ __t: 'IssueConnection', repo: undefined as unknown as Repo, issues: [], hasNextPage: false, endCursor: null }) as Node,
  },
  PullRequest: {
    id: (n) => globalId('pull', (n as { repo: Repo }).repo.id, (n as { pull: Pull }).pull.number),
    number: (n) => (n as { pull: Pull }).pull.number,
    title: (n) => (n as { pull: Pull }).pull.title,
    body: (n) => (n as { pull: Pull }).pull.body,
    state: (n) => pullStateEnum((n as { pull: Pull }).pull),
    merged: (n) => (n as { pull: Pull }).pull.merged,
    mergeable: (n) => pullMergeable((n as { repo: Repo }).repo, (n as { pull: Pull }).pull),
    headRefName: (n) => (n as { pull: Pull }).pull.headRef,
    baseRefName: (n) => (n as { pull: Pull }).pull.baseRef,
    headRefOid: (n) => resolveRefSha((n as { repo: Repo }).repo, (n as { pull: Pull }).pull.headRef) ?? (n as { pull: Pull }).pull.headSha,
    baseRefOid: (n) => resolveRefSha((n as { repo: Repo }).repo, (n as { pull: Pull }).pull.baseRef) ?? (n as { pull: Pull }).pull.baseSha,
    url: () => '',
    createdAt: (n) => (n as { pull: Pull }).pull.created_at,
    updatedAt: (n) => (n as { pull: Pull }).pull.updated_at,
    mergedAt: (n) => ((n as { pull: Pull }).pull.merged ? FIXED_TIME : null),
    author: (n) => ({ __t: 'User', login: (n as { pull: Pull }).pull.user }) as Node,
    repository: (n) => ({ __t: 'Repository', repo: (n as { repo: Repo }).repo }) as Node,
    files: (n, args) => {
      const { repo, pull } = n as { repo: Repo; pull: Pull };
      const all = pullFilesList(repo, pull).map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, changes: f.changes, status: f.status }));
      const first = typeof args.first === 'number' ? args.first : all.length;
      return { __t: 'FilesConnection', repo, pull, files: all.slice(0, first) } as Node;
    },
  },
  IssueConnection: {
    nodes: (n) => (n as { issues: Issue[]; repo: Repo }).issues.map((issue) => ({ __t: 'Issue', repo: (n as { repo: Repo }).repo, issue }) as Node),
    totalCount: (n) => (n as { issues: Issue[] }).issues.length,
    pageInfo: (n) => ({ __t: 'PageInfo', hasNextPage: (n as { hasNextPage: boolean }).hasNextPage, endCursor: (n as { endCursor: string | null }).endCursor }) as Node,
  },
  PullRequestConnection: {
    nodes: (n) => (n as { pulls: Pull[]; repo: Repo }).pulls.map((pull) => ({ __t: 'PullRequest', repo: (n as { repo: Repo }).repo, pull }) as Node),
    totalCount: (n) => (n as { pulls: Pull[] }).pulls.length,
    pageInfo: () => ({ __t: 'PageInfo', hasNextPage: false, endCursor: null }) as Node,
  },
  FilesConnection: {
    nodes: (n) => (n as { files: { path: string }[] }).files.map((f) => ({ __t: 'ChangedFile', ...f }) as Node),
    totalCount: (n) => (n as { files: unknown[] }).files.length,
  },
  ChangedFile: {
    path: (n) => (n as { path: string }).path,
    additions: (n) => (n as { additions: number }).additions,
    deletions: (n) => (n as { deletions: number }).deletions,
    changes: (n) => (n as { changes: number }).changes,
    status: (n) => (n as { status: string }).status,
  },
  Ref: {
    name: (n) => (n as { name: string }).name,
  },
  PageInfo: {
    hasNextPage: (n) => (n as { hasNextPage: boolean }).hasNextPage,
    endCursor: (n) => (n as { endCursor: string | null }).endCursor,
  },
  __Type: {
    name: (n) => (n as { name: string }).name,
    kind: (n) => (n as { kind: string }).kind,
    description: () => null,
    fields: (n) => (n as { fields: string[] }).fields.map((name) => ({ __t: '__Field', name }) as Node),
    enumValues: (n) => (n as { enumValues: string[] }).enumValues.map((name) => ({ __t: '__EnumValue', name }) as Node),
  },
  __Field: {
    name: (n) => (n as { name: string }).name,
    description: () => null,
  },
  __EnumValue: {
    name: (n) => (n as { name: string }).name,
    description: () => null,
  },
  CreateIssuePayload: {
    issue: (n) => ({ __t: 'Issue', repo: (n as { repo: Repo }).repo, issue: (n as { issue: Issue }).issue }) as Node,
  },
  CloseIssuePayload: {
    issue: (n) => ({ __t: 'Issue', repo: (n as { repo: Repo }).repo, issue: (n as { issue: Issue }).issue }) as Node,
  },
  CreatePullRequestPayload: {
    pullRequest: (n) => ({ __t: 'PullRequest', repo: (n as { repo: Repo }).repo, pull: (n as { pull: Pull }).pull }) as Node,
  },
  MergePullRequestPayload: {
    pullRequest: (n) => ({ __t: 'PullRequest', repo: (n as { repo: Repo }).repo, pull: (n as { pull: Pull }).pull }) as Node,
  },
  AddCommentPayload: {
    commentEdge: (n) => ({ __t: 'CommentEdge', comment: (n as { comment: { id: number; body: string } }).comment, repo: (n as { repo: Repo }).repo, issue: (n as { issue: Issue }).issue }) as Node,
  },
  CommentEdge: {
    node: (n) => ({ __t: 'Comment', comment: (n as { comment: { id: number; body: string } }).comment, repo: (n as { repo: Repo }).repo, issue: (n as { issue: Issue }).issue }) as Node,
  },
  Comment: {
    id: (n) => globalId('comment', (n as { repo: Repo }).repo.id, (n as { issue: Issue }).issue.number, (n as { comment: { id: number } }).comment.id),
    body: (n) => (n as { comment: { body: string } }).comment.body,
  },
};

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && '__t' in (value as Record<string, unknown>);
}

function executeSelection(node: Node, sels: Sel[], ctx: Ctx, path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeName = node.__t === 'Query' || node.__t === 'Mutation' ? node.__t : node.__t;
  const table = RESOLVERS[typeName] ?? {};
  for (const sel of sels) {
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (!frag) continue;
      if (frag.typeCondition && frag.typeCondition !== node.__t) continue;
      Object.assign(out, executeSelection(node, frag.selection, ctx, path));
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition && sel.typeCondition !== node.__t) continue;
      Object.assign(out, executeSelection(node, sel.selection, ctx, path));
      continue;
    }
    const key = sel.alias ?? sel.name;
    const resolver = table[sel.name];
    if (!resolver) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".`, path: [...path, key] });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolver(node, resolveArgs(sel, ctx), ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, key] });
      out[key] = null;
      continue;
    }
    if (sel.selection && value !== null && value !== undefined) {
      if (Array.isArray(value)) {
        out[key] = value.map((item, idx) => (isNode(item) ? executeSelection(item, sel.selection!, ctx, [...path, key, idx]) : item));
      } else if (isNode(value)) {
        out[key] = executeSelection(value, sel.selection, ctx, [...path, key]);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value ?? null;
    }
  }
  return out;
}

function executeOperation(store: Store, op: Operation, variables: Record<string, unknown>, fragments: Map<string, FragmentDef>): { data: JsonObj; errors?: { message: string; path?: (string | number)[] }[] } {
  const ctx: Ctx = { store, vars: { ...variables }, errors: [], fragments };
  for (const def of op.varDefs) {
    if (!(def.name in ctx.vars) && def.defaultValue) ctx.vars[def.name] = resolveValue(def.defaultValue, ctx.vars);
  }
  const root: Node = op.kind === 'mutation' ? { __t: 'Mutation' } : { __t: 'Query' };
  const data = executeSelection(root, op.selection, ctx, []);
  const result: { data: JsonObj; errors?: { message: string; path?: (string | number)[] }[] } = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// ---------------- handler ----------------

export async function handleGraphql(store: Store, req: IncomingMessage, res: ServerResponse, rid: Headers): Promise<void> {
  const buf = await readBody(req);
  const parsed = parseJsonBody(buf);
  if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
    sendJson(res, 400, { errors: [{ message: 'Request body must be a JSON object with query and variables' }] }, rid);
    return;
  }
  const runOne = (entry: unknown): { data: JsonObj; errors?: { message: string; path?: (string | number)[] }[] } | { errors: { message: string }[] } => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return { errors: [{ message: 'Each operation must be an object with a query string' }] };
    const { query, variables, operationName } = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof query !== 'string' || query.trim() === '') return { errors: [{ message: 'Must provide query string.' }] };
    let doc: { operations: Operation[]; fragments: Map<string, FragmentDef> };
    try {
      doc = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    if (doc.operations.length === 0) return { errors: [{ message: 'Must provide an operation.' }] };
    let op: Operation | undefined;
    if (typeof operationName === 'string' && operationName !== '') {
      op = doc.operations.find((o) => o.name === operationName);
      if (!op) return { errors: [{ message: `Unknown operation named "${operationName}".` }] };
    } else {
      op = doc.operations[0];
    }
    const vars = variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {};
    return executeOperation(store, op, vars, doc.fragments);
  };

  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne), rid);
    return;
  }
  sendJson(res, 200, runOne(parsed), rid);
}
