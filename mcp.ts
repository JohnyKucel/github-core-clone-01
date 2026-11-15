// MCP endpoint at POST /mcp — JSON-RPC 2.0 over Streamable HTTP.
// Modern era (revision 2026-07-28): server/discover, no handshake, no
// session. The legacy initialize handshake is also answered so a
// pre-discover client can connect. Auth is done by app.ts (401 before
// this handler runs). The tools act on the same store as REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { OWNER_LOGIN, type Repo, type Store } from './store.ts';
import { parseJsonBody, readBody, sendJson } from './http.ts';
import {
  createIssueInRepo,
  createPullInRepo,
  issueJson,
  mergePullSquash,
  pullJson,
  repoJson,
} from './rest.ts';

type Headers = Readonly<Record<string, string>>;
type JsonObj = Record<string, unknown>;

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, JsonObj>; required: string[] };
}

// One frozen table: two tools/list calls answer byte-identical JSON.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the repository to create.' },
        description: { type: 'string', description: 'Short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the pull request.' },
        body: { type: 'string', description: 'Body of the pull request.' },
        head: { type: 'string', description: 'Name of the head branch.' },
        base: { type: 'string', description: 'Name of the base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): JsonObj {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id: unknown, code: number, message: string): JsonObj {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function toolOk(id: unknown, value: unknown): JsonObj {
  return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
}
function toolFail(id: unknown, message: string): JsonObj {
  return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true });
}

/** Pick the first present alias for a canonical argument name. */
function pick(args: JsonObj, names: readonly string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return args[name];
  }
  return undefined;
}

function strArg(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numArg(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

/** Resolve owner/repo from arguments, accepting full_name ("owner/repo") as well. */
function resolveRepoArgs(store: Store, args: JsonObj): { repo: Repo } | { error: string } {
  let owner = strArg(pick(args, ['owner', 'owner_login', 'org', 'user', 'login']));
  let repoName = strArg(pick(args, ['repo', 'repository', 'repository_name', 'repo_name']));
  const fullName = strArg(pick(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']));
  if ((!owner || !repoName) && fullName.includes('/')) {
    const [o, r] = fullName.split('/', 2);
    if (!owner) owner = o ?? '';
    if (!repoName) repoName = r ?? '';
  }
  if (!owner || !repoName) return { error: 'owner and repo are required' };
  if (owner !== OWNER_LOGIN) return { error: `Repository not found: ${owner}/${repoName}` };
  const repo = store.getRepo(owner, repoName);
  if (!repo) return { error: `Repository not found: ${owner}/${repoName}` };
  return { repo };
}

function findTool(name: string): ToolDef | undefined {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return TOOLS.find((t) => t.name === name) ?? TOOLS.find((t) => norm.endsWith(t.name.replace(/[^a-z0-9]/g, '')));
}

function callTool(store: Store, id: unknown, params: JsonObj): JsonObj {
  const name = typeof params.name === 'string' ? params.name : '';
  const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? (params.arguments as JsonObj)
    : {};
  const tool = findTool(name);
  if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      return rpcError(id, -32602, `Missing required argument: ${required}`);
    }
  }
  try {
    switch (tool.name) {
      case 'create_repo': {
        const repoName = strArg(pick(args, ['name', 'repo', 'repository']));
        if (!repoName) return rpcError(id, -32602, 'Missing required argument: name');
        if (store.getRepo(OWNER_LOGIN, repoName)) return toolFail(id, `Repository already exists: ${OWNER_LOGIN}/${repoName}`);
        const repo = store.createRepo(OWNER_LOGIN, repoName, strArg(pick(args, ['description', 'body'])));
        const priv = pick(args, ['private', 'is_private']);
        repo.private = priv === true;
        return toolOk(id, repoJson(repo));
      }
      case 'get_repo': {
        const found = resolveRepoArgs(store, args);
        if ('error' in found) return toolFail(id, found.error);
        return toolOk(id, repoJson(found.repo));
      }
      case 'create_issue': {
        const found = resolveRepoArgs(store, args);
        if ('error' in found) return toolFail(id, found.error);
        const title = strArg(pick(args, ['title', 'issue_title']));
        const created = createIssueInRepo(found.repo, { title, body: strArg(pick(args, ['body', 'issue_body', 'description'])) });
        if ('error' in created) return toolFail(id, created.error.message);
        return toolOk(id, issueJson(found.repo, created.issue));
      }
      case 'list_issues': {
        const found = resolveRepoArgs(store, args);
        if ('error' in found) return toolFail(id, found.error);
        const state = strArg(pick(args, ['state', 'status'])).toLowerCase() || 'open';
        let list = [...found.repo.issues.values()];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        list.sort((a, b) => b.number - a.number);
        const value = list.map((i) => issueJson(found.repo, i));
        return toolOk(id, value);
      }
      case 'create_pull_request': {
        const found = resolveRepoArgs(store, args);
        if ('error' in found) return toolFail(id, found.error);
        const created = createPullInRepo(found.repo, {
          title: strArg(pick(args, ['title', 'pr_title'])),
          body: strArg(pick(args, ['body', 'description'])),
          head: strArg(pick(args, ['head', 'head_ref', 'head_branch', 'source_branch'])),
          base: strArg(pick(args, ['base', 'base_ref', 'base_branch', 'target_branch'])),
        });
        if ('error' in created) return toolFail(id, created.error.message);
        return toolOk(id, pullJson(found.repo, created.pull));
      }
      case 'merge_pull_request': {
        const found = resolveRepoArgs(store, args);
        if ('error' in found) return toolFail(id, found.error);
        const number = numArg(pick(args, ['pull_number', 'pull_request_number', 'pr_number', 'number']));
        if (number === null) return rpcError(id, -32602, 'Missing required argument: pull_number');
        const pull = found.repo.pulls.get(number);
        if (!pull) return toolFail(id, `Pull request not found: #${number}`);
        const merged = mergePullSquash(found.repo, pull);
        if ('error' in merged) return toolFail(id, merged.error.message);
        return toolOk(id, { sha: merged.sha, merged: true, message: `Pull Request #${number} successfully merged`, number });
      }
      default:
        return rpcError(id, -32601, `Method not found: ${name}`);
    }
  } catch (err) {
    return toolFail(id, err instanceof Error ? err.message : String(err));
  }
}

function handleRequest(store: Store, body: unknown): { status: number; payload: unknown; empty: boolean } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, payload: rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object'), empty: false };
  }
  const msg = body as JsonObj;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const id = msg.id ?? null;
  const hasId = 'id' in msg && msg.id !== undefined && msg.id !== null;
  if (method === '') {
    return { status: 200, payload: rpcError(id, -32600, 'Invalid Request: missing method'), empty: false };
  }
  // Notifications carry no id and expect no response body.
  if (!hasId) {
    return { status: 202, payload: null, empty: true };
  }
  const params = msg.params !== null && typeof msg.params === 'object' && !Array.isArray(msg.params) ? (msg.params as JsonObj) : {};
  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        payload: rpcResult(id, {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {}, logging: {}, prompts: {}, resources: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: 'GitHub-compatible forge: repositories, issues and pull requests.',
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
        }),
        empty: false,
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return {
        status: 200,
        payload: rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
        empty: false,
      };
    }
    case 'ping':
      return { status: 200, payload: rpcResult(id, {}), empty: false };
    case 'tools/list':
      return { status: 200, payload: rpcResult(id, { tools: TOOLS }), empty: false };
    case 'tools/call':
      return { status: 200, payload: callTool(store, id, params), empty: false };
    case 'resources/list':
      return { status: 200, payload: rpcResult(id, { resources: [] }), empty: false };
    case 'prompts/list':
      return { status: 200, payload: rpcResult(id, { prompts: [] }), empty: false };
    case 'resources/templates/list':
      return { status: 200, payload: rpcResult(id, { resourceTemplates: [] }), empty: false };
    default:
      return { status: 200, payload: rpcError(id, -32601, `Method not found: ${method}`), empty: false };
  }
}

export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse, rid: Headers): Promise<void> {
  const buf = await readBody(req);
  const parsed = parseJsonBody(buf);
  if (parsed === undefined) {
    // Body is not JSON: HTTP 400 with JSON-RPC -32700 (modern transport).
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, rid);
    return;
  }
  if (parsed === null) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, rid);
    return;
  }
  if (Array.isArray(parsed)) {
    // JSON-RPC batch: answer each request in order.
    const answers: unknown[] = [];
    for (const entry of parsed) {
      const out = handleRequest(store, entry);
      if (!out.empty) answers.push(out.payload);
    }
    sendJson(res, 200, answers, rid);
    return;
  }
  const out = handleRequest(store, parsed);
  if (out.empty) {
    res.writeHead(out.status, rid);
    res.end();
    return;
  }
  sendJson(res, out.status, out.payload, rid);
}
