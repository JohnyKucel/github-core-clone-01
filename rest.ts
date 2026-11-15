// REST v3 API under /api/v3.
// Pure Node stdlib. Shares the store with git.ts / graphql.ts / mcp.ts.
// Auth is done by app.ts before this handler runs; every reply here is
// JSON and carries the X-GitHub-Request-Id header passed in as `rid`.
// Timestamps are FIXED_TIME (store.ts) for replay determinism.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FIXED_TIME,
  OWNER_LOGIN,
  buildCommit,
  buildTree,
  isAncestor,
  objectSha,
  parseCommit,
  parseTree,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { parseJsonBody, pathOf, queryOf, readBody, sendJson } from './http.ts';

type Headers = Readonly<Record<string, string>>;
type JsonObj = Record<string, unknown>;

const AUTHOR = `${OWNER_LOGIN} <${OWNER_LOGIN}@example.invalid>`;
const SHA40 = /^[0-9a-f]{40}$/i;

export function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Opaque Relay-style global ids (GraphQL + REST node_id). */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return b64([kind, ...parts.map(String)].join(':'));
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function userJson(login: string): JsonObj {
  return { login, id: 1000, node_id: globalId('user', 1000), avatar_url: '', gravatar_id: '', url: '', html_url: '', type: 'User', site_admin: false };
}

export function labelJson(label: Label): JsonObj {
  return { id: label.id, node_id: globalId('label', label.id), name: label.name, color: label.color, description: label.description, default: false };
}

export function repoJson(repo: Repo): JsonObj {
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('repo', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    html_url: '',
    url: '',
    clone_url: '',
    git_url: '',
    ssh_url: '',
  };
}

export function issueJson(repo: Repo, issue: Issue): JsonObj {
  return {
    id: issue.id,
    node_id: globalId('issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { id: 0, name, color: 'ededed', description: '' };
    }),
    user: userJson(issue.user),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    html_url: '',
    url: '',
    comments_url: '',
  };
}

// ---------- unified issue/PR numbering (GitHub shares one sequence per repo) ----------

const unifiedNext = new WeakMap<Repo, number>();

function allocNumber(repo: Repo): number {
  const next = unifiedNext.get(repo) ?? 1;
  unifiedNext.set(repo, next + 1);
  repo.nextIssue = Math.max(repo.nextIssue, next + 1);
  repo.nextPull = Math.max(repo.nextPull, next + 1);
  return next;
}

// ---------- git tree helpers (shared with graphql.ts / mcp.ts) ----------

/** Flatten a commit's tree to path -> {sha, mode}. Empty map when unresolvable. */
export function flattenTree(repo: Repo, commitSha: string): Map<string, { sha: string; mode: string }> {
  const out = new Map<string, { sha: string; mode: string }>();
  const commit = repo.objects.get(commitSha);
  if (!commit || commit.type !== 'commit') return out;
  const treeSha = parseCommit(commit.data).headers.get('tree')?.[0];
  if (!treeSha) return out;
  const walk = (tree: string, prefix: string): void => {
    const obj = repo.objects.get(tree);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') walk(entry.sha, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, { sha: entry.sha, mode: entry.mode });
    }
  };
  walk(treeSha, '');
  return out;
}

/** Build (and store) nested trees for a flat path map; returns the root tree sha. */
export function buildTreeFromMap(repo: Repo, files: Map<string, { sha: string; mode: string }>): string {
  const build = (prefix: string): string => {
    const direct: { mode: string; name: string; sha: string }[] = [];
    const subdirs = new Map<string, string[]>();
    for (const path of files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        const f = files.get(path)!;
        direct.push({ mode: f.mode, name: rest, sha: f.sha });
      } else {
        const dir = rest.slice(0, slash);
        const list = subdirs.get(dir) ?? [];
        list.push(path);
        subdirs.set(dir, list);
      }
    }
    for (const [dir, paths] of [...subdirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      void paths;
      direct.push({ mode: '40000', name: dir, sha: build(`${prefix}${dir}/`) });
    }
    // Git tree order: entries sorted by name, directories as if suffixed with '/'.
    direct.sort((a, b) => {
      const an = a.mode === '40000' ? `${a.name}/` : a.name;
      const bn = b.mode === '40000' ? `${b.name}/` : b.name;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const data = buildTree(direct);
    const sha = objectSha('tree', data);
    repo.objects.set(sha, { type: 'tree', data });
    return sha;
  };
  return build('');
}

/** Tree sha of a commit, or null. */
export function commitTreeSha(repo: Repo, commitSha: string): string | null {
  const commit = repo.objects.get(commitSha);
  if (!commit || commit.type !== 'commit') return null;
  return parseCommit(commit.data).headers.get('tree')?.[0] ?? null;
}

/** Resolve a branch name or a raw commit sha to a commit sha. */
export function resolveRefSha(repo: Repo, ref: string): string | undefined {
  if (SHA40.test(ref) && repo.objects.has(ref)) return ref;
  return repo.refs.get(`refs/heads/${ref}`);
}

/**
 * Apply a change to a branch's file map and commit it.
 * `mutate` edits the flat map in place. When the branch ref does not exist
 * yet, the parent is the default branch tip (or none for an unborn repo).
 */
export function commitTreeChange(
  repo: Repo,
  opts: { branch: string; message: string; mutate: (files: Map<string, { sha: string; mode: string }>) => void },
): { commitSha: string } {
  const ref = `refs/heads/${opts.branch}`;
  let parent = repo.refs.get(ref);
  if (!parent && opts.branch !== repo.defaultBranch) parent = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const files = parent ? flattenTree(repo, parent) : new Map<string, { sha: string; mode: string }>();
  opts.mutate(files);
  const treeSha = buildTreeFromMap(repo, files);
  const body = buildCommit({ tree: treeSha, parents: parent ? [parent] : [], author: AUTHOR, committer: AUTHOR, message: opts.message });
  const sha = objectSha('commit', body);
  repo.objects.set(sha, { type: 'commit', data: body });
  repo.refs.set(ref, sha);
  repo.updated_at = FIXED_TIME;
  repo.pushed_at = FIXED_TIME;
  return { commitSha: sha };
}

/** Line multiset diff counts, for pull file stats. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const count = (text: string): Map<string, number> => {
    const m = new Map<string, number>();
    if (text === '') return m;
    for (const line of text.split('\n')) m.set(line, (m.get(line) ?? 0) + 1);
    return m;
  };
  const oldLines = count(oldText);
  const newLines = count(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newLines) additions += Math.max(0, n - (oldLines.get(line) ?? 0));
  for (const [line, n] of oldLines) deletions += Math.max(0, n - (newLines.get(line) ?? 0));
  return { additions, deletions };
}

function blobText(repo: Repo, sha: string): string {
  const obj = repo.objects.get(sha);
  return obj && obj.type === 'blob' ? obj.data.toString('utf8') : '';
}

export interface PullFileEntry {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

/** Diff between a pull's recorded base and its live head tip. */
export function pullFilesList(repo: Repo, pull: Pull): PullFileEntry[] {
  const headSha = resolveRefSha(repo, pull.headRef) ?? pull.headSha;
  const base = flattenTree(repo, pull.baseSha);
  const head = flattenTree(repo, headSha);
  const out: PullFileEntry[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && h && b.sha === h.sha) continue;
    if (!b && h) {
      const { additions } = lineDiff('', blobText(repo, h.sha));
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, sha: h.sha });
    } else if (b && !h) {
      const { deletions } = lineDiff(blobText(repo, b.sha), '');
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, sha: b.sha });
    } else if (b && h) {
      const { additions, deletions } = lineDiff(blobText(repo, b.sha), blobText(repo, h.sha));
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions, sha: h.sha });
    }
  }
  return out;
}

/** True when the head and the current base tip both changed the same path differently. */
export function pullHasConflict(repo: Repo, pull: Pull): boolean {
  const headSha = resolveRefSha(repo, pull.headRef) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!baseTip || headSha === baseTip) return false;
  if (isAncestor(repo, headSha, baseTip)) return false;
  const base = flattenTree(repo, pull.baseSha);
  const head = flattenTree(repo, headSha);
  const cur = flattenTree(repo, baseTip);
  for (const [path, h] of head) {
    const b = base.get(path);
    if (b?.sha === h.sha) continue;
    const c = cur.get(path);
    if (c && c.sha !== b?.sha && c.sha !== h.sha) return true;
  }
  for (const [path, b] of base) {
    if (head.has(path)) continue;
    const c = cur.get(path);
    if (c && c.sha !== b.sha) return true;
  }
  return false;
}

export function pullMergeable(repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  return pullHasConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

export function pullJson(repo: Repo, pull: Pull): JsonObj {
  const headSha = resolveRefSha(repo, pull.headRef) ?? pull.headSha;
  const baseSha = resolveRefSha(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: globalId('pull', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    merged_at: pull.merged ? FIXED_TIME : null,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? !pullHasConflict(repo, pull) : null,
    mergeable_state: pullMergeable(repo, pull).toLowerCase(),
    draft: false,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha, user: userJson(repo.owner), repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha, user: userJson(repo.owner), repo: repoJson(repo) },
    user: userJson(pull.user),
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    labels: [],
    milestone: null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.state === 'closed' ? pull.updated_at : null,
    html_url: '',
    url: '',
  };
}

// ---------- shared domain operations (used by graphql.ts / mcp.ts) ----------

export function createIssueInRepo(
  repo: Repo,
  input: { title: string; body?: string; labels?: unknown },
): { issue: Issue } | { error: { status: number; message: string } } {
  const rawLabels = input.labels;
  const names: string[] = [];
  if (Array.isArray(rawLabels)) {
    for (const entry of rawLabels) {
      const name = typeof entry === 'string' ? entry : (entry as JsonObj)?.name;
      if (typeof name !== 'string') continue;
      if (!repo.labels.has(name)) return { error: { status: 422, message: `Validation Failed: label "${name}" does not exist` } };
      names.push(name);
    }
  }
  const number = allocNumber(repo);
  const issue: Issue = {
    id: repo.id * 1_000_000 + number,
    number,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: names,
    user: OWNER_LOGIN,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    comments: [],
  };
  repo.issues.set(number, issue);
  return { issue };
}

export function createPullInRepo(
  repo: Repo,
  input: { title: string; body?: string; head: string; base: string },
): { pull: Pull } | { error: { status: number; message: string } } {
  const headSha = resolveRefSha(repo, input.head);
  if (!headSha) return { error: { status: 422, message: `Validation Failed: head branch "${input.head}" does not exist` } };
  const baseSha = resolveRefSha(repo, input.base);
  if (!baseSha) return { error: { status: 422, message: `Validation Failed: base branch "${input.base}" does not exist` } };
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
      return { error: { status: 422, message: 'Validation Failed: a pull request already exists for this head and base' } };
    }
  }
  const number = allocNumber(repo);
  const pull: Pull = {
    id: repo.id * 1_000_000 + 500_000 + number,
    number,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    headRef: input.head,
    headSha,
    baseRef: input.base,
    baseSha,
    mergeable: true,
    mergeCommitSha: null,
    user: OWNER_LOGIN,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  };
  repo.pulls.set(number, pull);
  return { pull };
}

/** Squash-merge a pull: squash commit (tree = head tree, parent = base tip) on the default branch. */
export function mergePullSquash(repo: Repo, pull: Pull): { sha: string } | { error: { status: number; message: string } } {
  if (pull.state !== 'open') return { error: { status: 405, message: 'Pull request is already closed' } };
  if (pullHasConflict(repo, pull)) return { error: { status: 405, message: 'Merge conflict: the pull request cannot be merged' } };
  const headSha = resolveRefSha(repo, pull.headRef) ?? pull.headSha;
  const tree = commitTreeSha(repo, headSha);
  if (!tree) return { error: { status: 405, message: 'Merge conflict: head commit has no tree' } };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const body = buildCommit({
    tree,
    parents: baseTip ? [baseTip] : [],
    author: AUTHOR,
    committer: AUTHOR,
    message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`,
  });
  const sha = objectSha('commit', body);
  repo.objects.set(sha, { type: 'commit', data: body });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.updated_at = FIXED_TIME;
  repo.updated_at = FIXED_TIME;
  repo.pushed_at = FIXED_TIME;
  return { sha };
}

// ---------- handler plumbing ----------

function errJson(res: ServerResponse, status: number, message: string, rid: Headers): void {
  sendJson(res, status, { message }, rid);
}

function decodeSeg(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function segments(path: string): string[] {
  return path.split('/').filter((s) => s !== '').map(decodeSeg);
}

function getRepo(store: Store, owner: string, name: string): Repo | undefined {
  if (owner !== OWNER_LOGIN) return undefined;
  return store.getRepo(owner, name);
}

function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false }> {
  return readBody(req).then((buf) => {
    if (buf.length === 0) return { ok: true as const, value: {} };
    const parsed = parseJsonBody(buf);
    if (parsed === undefined) return { ok: false as const };
    return { ok: true as const, value: parsed };
  });
}

function bodyObj(value: unknown): JsonObj {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObj) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function intQuery(q: URLSearchParams, name: string, fallback: number): number {
  const raw = q.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Build a GitHub-style Link header for a paginated list. */
function linkHeader(req: IncomingMessage, path: string, q: URLSearchParams, page: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return null;
  const host = req.headers.host ?? 'localhost';
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(q);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `http://${host}${path}?${params.toString()}`;
  };
  const parts: string[] = [];
  if (page > 1) {
    parts.push(`<${urlFor(1)}>; rel="first"`);
    parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  }
  if (page < totalPages) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  parts.push(`<${urlFor(totalPages)}>; rel="last"`);
  return parts.join(', ');
}

function paginate<T>(items: T[], q: URLSearchParams): { page: T[]; total: number; pageNum: number; perPage: number } {
  const perPage = Math.min(100, intQuery(q, 'per_page', 30));
  const pageNum = intQuery(q, 'page', 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, pageNum, perPage };
}

function sendPage<T>(req: IncomingMessage, res: ServerResponse, rid: Headers, items: T[], q: URLSearchParams): void {
  const { page, total, pageNum, perPage } = paginate(items, q);
  const link = linkHeader(req, pathOf(req), q, pageNum, perPage, total);
  sendJson(res, 200, page, link ? { ...rid, link } : rid);
}

/** Walk a commit's tree to a directory path; returns its entries or null. */
function dirEntries(repo: Repo, commitSha: string, dirPath: string): { mode: string; name: string; sha: string }[] | null {
  const commit = repo.objects.get(commitSha);
  if (!commit || commit.type !== 'commit') return null;
  let treeSha = parseCommit(commit.data).headers.get('tree')?.[0];
  if (!treeSha) return null;
  if (dirPath !== '') {
    for (const seg of dirPath.split('/')) {
      const obj = repo.objects.get(treeSha);
      if (!obj || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((e) => e.name === seg && e.mode === '40000');
      if (!entry) return null;
      treeSha = entry.sha;
    }
  }
  const obj = repo.objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return null;
  return parseTree(obj.data);
}

/** Resolve ?ref= (branch name or sha) to a commit sha, defaulting to the default branch. */
function refCommit(repo: Repo, ref: string | null): string | undefined {
  if (!ref) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return resolveRefSha(repo, ref);
}

function listCommits(repo: Repo, tip: string, limit = 30): { sha: string; message: string }[] {
  const out: { sha: string; message: string }[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0 && out.length < limit) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    const { headers, message } = parseCommit(obj.data);
    out.push({ sha, message });
    for (const p of headers.get('parent') ?? []) queue.push(p);
  }
  return out;
}

// ---------- the handler ----------

export async function handleRest(store: Store, req: IncomingMessage, res: ServerResponse, rid: Headers): Promise<void> {
  const method = req.method ?? 'GET';
  const path = pathOf(req);
  const q = queryOf(req);
  const segs = segments(path);
  // segs[0..1] are 'api','v3' for every route handled here.
  const rest = segs.slice(2);

  const needBody = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
  let body: unknown = {};
  if (needBody) {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      errJson(res, 400, 'Invalid JSON body', rid);
      return;
    }
    body = parsed.value;
  }
  const input = bodyObj(body);

  // GET /api/v3/ — root.
  if (rest.length === 0) {
    if (method !== 'GET') {
      errJson(res, 404, 'Not Found', rid);
      return;
    }
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      authorizations_url: '/api/v3/authorizations',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
      rate_limit_url: '/api/v3/rate_limit',
      meta_url: '/api/v3/meta',
    }, { ...rid, 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') {
      errJson(res, 404, 'Not Found', rid);
      return;
    }
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true, git_ssh_url: '' }, rid);
    return;
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    sendJson(res, 200, { ...userJson(OWNER_LOGIN), name: 'ada iversen', email: 'adaiversen@example.invalid', public_repos: store.listRepos().length, followers: 0, following: 0 }, rid);
    return;
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      sendPage(req, res, rid, store.listRepos().map(repoJson), q);
      return;
    }
    if (method === 'POST') {
      const name = str(input.name).trim();
      if (!name) {
        errJson(res, 422, 'Validation Failed: name is required', rid);
        return;
      }
      if (store.getRepo(OWNER_LOGIN, name)) {
        errJson(res, 422, `Validation Failed: repository "${name}" already exists`, rid);
        return;
      }
      const repo = store.createRepo(OWNER_LOGIN, name, str(input.description));
      repo.private = input.private === true;
      sendJson(res, 201, repoJson(repo), rid);
      return;
    }
    errJson(res, 404, 'Not Found', rid);
    return;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1]!;
    const name = rest[2]!;
    const repo = getRepo(store, owner, name);
    const tail = rest.slice(3);

    if (!repo) {
      errJson(res, 404, 'Not Found', rid);
      return;
    }

    // /repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo), rid);
        return;
      }
      if (method === 'PATCH') {
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.private = input.private;
        if (typeof input.default_branch === 'string' && input.default_branch) repo.defaultBranch = input.default_branch;
        repo.updated_at = FIXED_TIME;
        sendJson(res, 200, repoJson(repo), rid);
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        res.writeHead(204, rid);
        res.end();
        return;
      }
      errJson(res, 404, 'Not Found', rid);
      return;
    }

    // /repos/{o}/{r}/git/refs[/heads/{branch}]
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = str(input.ref);
        const sha = str(input.sha);
        if (!ref.startsWith('refs/heads/') || !SHA40.test(sha) || !repo.objects.has(sha)) {
          errJson(res, 422, 'Validation Failed: ref and a known commit sha are required', rid);
          return;
        }
        if (repo.refs.has(ref)) {
          errJson(res, 422, `Validation Failed: ref "${ref}" already exists`, rid);
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: 'commit' }, url: '' }, rid);
        return;
      }
      if (method === 'GET') {
        if (tail.length === 2) {
          const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' }, url: '' }));
          sendJson(res, 200, all, rid);
          return;
        }
        if (tail.length === 4 && tail[2] === 'heads') {
          const sha = repo.refs.get(`refs/heads/${tail[3]}`);
          if (!sha) {
            errJson(res, 404, 'Not Found', rid);
            return;
          }
          sendJson(res, 200, { ref: `refs/heads/${tail[3]}`, object: { sha, type: 'commit' }, url: '' }, rid);
          return;
        }
      }
      errJson(res, 404, 'Not Found', rid);
      return;
    }

    // /repos/{o}/{r}/branches[/{branch}]
    if (tail[0] === 'branches') {
      if (method === 'GET' && tail.length === 1) {
        const list = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }));
        sendJson(res, 200, list, rid);
        return;
      }
      if (method === 'GET' && tail.length === 2) {
        const sha = repo.refs.get(`refs/heads/${tail[1]}`);
        if (!sha) {
          errJson(res, 404, 'Not Found', rid);
          return;
        }
        sendJson(res, 200, { name: tail[1], commit: { sha, url: '' }, protected: false }, rid);
        return;
      }
      errJson(res, 404, 'Not Found', rid);
      return;
    }

    // /repos/{o}/{r}/commits
    if (tail[0] === 'commits' && tail.length === 1) {
      if (method !== 'GET') {
        errJson(res, 404, 'Not Found', rid);
        return;
      }
      const tip = refCommit(repo, q.get('sha'));
      if (!tip) {
        sendJson(res, 200, [], rid);
        return;
      }
      const commits = listCommits(repo, tip).map(({ sha, message }) => ({
        sha,
        commit: { message, author: { name: OWNER_LOGIN, email: `${OWNER_LOGIN}@example.invalid`, date: FIXED_TIME }, committer: { name: OWNER_LOGIN, email: `${OWNER_LOGIN}@example.invalid`, date: FIXED_TIME } },
        author: userJson(OWNER_LOGIN),
        committer: userJson(OWNER_LOGIN),
        parents: [],
        url: '',
      }));
      sendPage(req, res, rid, commits, q);
      return;
    }

    // /repos/{o}/{r}/contents/{path...}
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (method === 'GET') {
        const tip = refCommit(repo, q.get('ref'));
        if (!tip) {
          errJson(res, 404, 'Not Found', rid);
          return;
        }
        if (filePath === '') {
          const entries = dirEntries(repo, tip, '') ?? [];
          sendJson(res, 200, entries.map((e) => contentEntryJson(repo, e, '')), rid);
          return;
        }
        const files = flattenTree(repo, tip);
        const file = files.get(filePath);
        if (file) {
          const blob = repo.objects.get(file.sha);
          const bytes = blob?.data ?? Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: bytes.length,
            name: filePath.split('/').pop(),
            path: filePath,
            content: bytes.toString('base64'),
            sha: file.sha,
            url: '',
            html_url: '',
            download_url: null,
          }, rid);
          return;
        }
        const entries = dirEntries(repo, tip, filePath);
        if (entries) {
          sendJson(res, 200, entries.map((e) => contentEntryJson(repo, e, filePath)), rid);
          return;
        }
        errJson(res, 404, 'Not Found', rid);
        return;
      }
      if (method === 'PUT') {
        const contentB64 = str(input.content);
        if (!contentB64 || typeof input.message !== 'string') {
          errJson(res, 422, 'Validation Failed: message and content are required', rid);
          return;
        }
        const branch = str(input.branch) || repo.defaultBranch;
        const bytes = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        const tip = repo.refs.get(`refs/heads/${branch}`) ?? (branch === repo.defaultBranch ? undefined : repo.refs.get(`refs/heads/${repo.defaultBranch}`));
        const current = tip ? flattenTree(repo, tip).get(filePath) : undefined;
        const givenSha = str(input.sha);
        if (current) {
          if (!givenSha || givenSha.toLowerCase() !== current.sha.toLowerCase()) {
            errJson(res, 409, 'Conflict: sha does not match the current file (stale sha)', rid);
            return;
          }
        } else if (givenSha) {
          errJson(res, 409, 'Conflict: sha supplied but the file does not exist', rid);
          return;
        }
        const isUpdate = Boolean(current);
        const blobSha = objectSha('blob', bytes);
        repo.objects.set(blobSha, { type: 'blob', data: bytes });
        const { commitSha } = commitTreeChange(repo, {
          branch,
          message: input.message as string,
          mutate: (files) => {
            files.set(filePath, { sha: blobSha, mode: '100644' });
          },
        });
        sendJson(res, isUpdate ? 200 : 201, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: bytes.length, type: 'file', encoding: 'base64' },
          commit: { sha: commitSha, message: input.message },
        }, rid);
        return;
      }
      if (method === 'DELETE') {
        const branch = str(input.branch) || repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) {
          errJson(res, 404, 'Not Found', rid);
          return;
        }
        const current = flattenTree(repo, tip).get(filePath);
        if (!current) {
          errJson(res, 404, 'Not Found', rid);
          return;
        }
        const givenSha = str(input.sha);
        if (givenSha && givenSha.toLowerCase() !== current.sha.toLowerCase()) {
          errJson(res, 409, 'Conflict: sha does not match the current file (stale sha)', rid);
          return;
        }
        const { commitSha } = commitTreeChange(repo, {
          branch,
          message: typeof input.message === 'string' ? input.message : 'Delete file',
          mutate: (files) => {
            files.delete(filePath);
          },
        });
        sendJson(res, 200, { commit: { sha: commitSha }, content: null }, rid);
        return;
      }
      errJson(res, 404, 'Not Found', rid);
      return;
    }

    // /repos/{o}/{r}/labels
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map(labelJson), rid);
        return;
      }
      if (method === 'POST' && tail.length === 1) {
        const name = str(input.name).trim();
        if (!name) {
          errJson(res, 422, 'Validation Failed: name is required', rid);
          return;
        }
        const existing = repo.labels.get(name);
        if (existing) {
          sendJson(res, 201, labelJson(existing), rid);
          return;
        }
        const label: Label = {
          id: repo.nextLabelId++,
          name,
          color: typeof input.color === 'string' && input.color ? String(input.color).replace(/^#/, '') : 'ededed',
          description: str(input.description),
        };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(label), rid);
        return;
      }
      errJson(res, 404, 'Not Found', rid);
      return;
    }

    // /repos/{o}/{r}/issues[/{n}[/comments]]
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = (q.get('state') ?? 'open').toLowerCase();
          const sort = (q.get('sort') ?? 'created').toLowerCase();
          const direction = (q.get('direction') ?? 'desc').toLowerCase();
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          void sort;
          sendPage(req, res, rid, list.map((i) => issueJson(repo, i)), q);
          return;
        }
        if (method === 'POST') {
          const title = str(input.title).trim();
          if (!title) {
            errJson(res, 422, 'Validation Failed: title is required', rid);
            return;
          }
          const created = createIssueInRepo(repo, { title, body: str(input.body), labels: input.labels });
          if ('error' in created) {
            errJson(res, created.error.status, created.error.message, rid);
            return;
          }
          sendJson(res, 201, issueJson(repo, created.issue), rid);
          return;
        }
        errJson(res, 404, 'Not Found', rid);
        return;
      }
      const num = Number.parseInt(tail[1]!, 10);
      const issue = Number.isInteger(num) ? repo.issues.get(num) : undefined;
      if (!issue) {
        errJson(res, 404, 'Not Found', rid);
        return;
      }
      if (tail.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue), rid);
          return;
        }
        if (method === 'PATCH') {
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          if (typeof input.state === 'string' && (input.state === 'open' || input.state === 'closed')) issue.state = input.state;
          if (Array.isArray(input.labels)) {
            const names: string[] = [];
            for (const entry of input.labels) {
              const labelName = typeof entry === 'string' ? entry : (entry as JsonObj)?.name;
              if (typeof labelName !== 'string' || !repo.labels.has(labelName)) {
                errJson(res, 422, `Validation Failed: label "${String(labelName)}" does not exist`, rid);
                return;
              }
              names.push(labelName);
            }
            issue.labels = names;
          }
          issue.updated_at = FIXED_TIME;
          sendJson(res, 200, issueJson(repo, issue), rid);
          return;
        }
        errJson(res, 404, 'Not Found', rid);
        return;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: globalId('comment', repo.id, issue.number, c.id), body: c.body, user: userJson(c.user), created_at: c.created_at, updated_at: c.updated_at, html_url: '', url: '' })), rid);
          return;
        }
        if (method === 'POST') {
          const commentBody = str(input.body);
          if (!commentBody) {
            errJson(res, 422, 'Validation Failed: body is required', rid);
            return;
          }
          const comment = { id: repo.nextCommentId++, body: commentBody, user: OWNER_LOGIN, created_at: FIXED_TIME, updated_at: FIXED_TIME };
          issue.comments.push(comment);
          issue.updated_at = FIXED_TIME;
          sendJson(res, 201, { id: comment.id, node_id: globalId('comment', repo.id, issue.number, comment.id), body: comment.body, user: userJson(comment.user), created_at: comment.created_at, updated_at: comment.updated_at, html_url: '', url: '' }, rid);
          return;
        }
        errJson(res, 404, 'Not Found', rid);
        return;
      }
      errJson(res, 404, 'Not Found', rid);
      return;
    }

    // /repos/{o}/{r}/pulls[/{n}[/files|merge]]
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = (q.get('state') ?? 'open').toLowerCase();
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.number - a.number);
          sendPage(req, res, rid, list.map((p) => pullJson(repo, p)), q);
          return;
        }
        if (method === 'POST') {
          const title = str(input.title).trim();
          const head = str(input.head).trim();
          const base = str(input.base).trim() || repo.defaultBranch;
          if (!title || !head) {
            errJson(res, 422, 'Validation Failed: title and head are required', rid);
            return;
          }
          const created = createPullInRepo(repo, { title, body: str(input.body), head, base });
          if ('error' in created) {
            errJson(res, created.error.status, created.error.message, rid);
            return;
          }
          sendJson(res, 201, pullJson(repo, created.pull), rid);
          return;
        }
        errJson(res, 404, 'Not Found', rid);
        return;
      }
      const num = Number.parseInt(tail[1]!, 10);
      const pull = Number.isInteger(num) ? repo.pulls.get(num) : undefined;
      if (!pull) {
        errJson(res, 404, 'Not Found', rid);
        return;
      }
      if (tail.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull), rid);
          return;
        }
        errJson(res, 404, 'Not Found', rid);
        return;
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        sendJson(res, 200, pullFilesList(repo, pull), rid);
        return;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        const merged = mergePullSquash(repo, pull);
        if ('error' in merged) {
          errJson(res, merged.error.status, merged.error.message, rid);
          return;
        }
        sendJson(res, 200, { sha: merged.sha, merged: true, message: `Pull Request #${pull.number} successfully merged` }, rid);
        return;
      }
      errJson(res, 404, 'Not Found', rid);
      return;
    }

    errJson(res, 404, 'Not Found', rid);
    return;
  }

  errJson(res, 404, 'Not Found', rid);
}

function contentEntryJson(repo: Repo, entry: { mode: string; name: string; sha: string }, dirPath: string): JsonObj {
  const isDir = entry.mode === '40000';
  const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
  let size = 0;
  if (!isDir) {
    const obj = repo.objects.get(entry.sha);
    size = obj?.data.length ?? 0;
  }
  return {
    type: isDir ? 'dir' : 'file',
    encoding: isDir ? undefined : 'base64',
    size,
    name: entry.name,
    path,
    sha: entry.sha,
    url: '',
    html_url: '',
    download_url: isDir ? null : '',
  };
}
