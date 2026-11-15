// Shared in-memory store for the forge. Single process, no persistence:
// the trial runs one suite pass per process, and the store dies with it.
// DETERMINISM: the suite's state export must be byte-identical across two
// runs of the same instance, so NOTHING in this store may carry wall-clock
// time. All generated timestamps use FIXED_TIME. Client-supplied commit
// contents (author/committer lines inside pushed objects) pass through
// untouched — the suite replays identical inputs, so they stay identical.
// Our own generated commits (contents API, squash merges) also use a fixed
// git timestamp (FIXED_GIT_TIME).

import { createHash } from 'node:crypto';

export const FIXED_TIME = '2026-01-01T00:00:00Z';
export const FIXED_GIT_TIME = 1700000000; // seconds since epoch, +0000
export const OWNER_LOGIN = 'adaiversen'; // login the suite token names (kit wire.ts SCENARIO_SEED is fixed: viewer id 1000, "ada iversen", adaiversen@example.invalid). Repos created via POST /user/repos belong to this login; any other owner is 404, never 403.

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  /** Raw content bytes, WITHOUT the "<type> <len>\0" header. */
  data: Buffer;
}

export function objectSha(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`, 'latin1');
  h.update(data);
  return h.digest('hex');
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  created_at: string;
  updated_at: string;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  mergeable: boolean;
  mergeCommitSha: string | null;
  user: string;
  created_at: string;
  updated_at: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  fullName: string;
  description: string;
  defaultBranch: string;
  private: boolean;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  /** refname (e.g. "refs/heads/main") -> commit sha */
  refs: Map<string, string>;
  /** sha -> object */
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  nextIssue: number;
  pulls: Map<number, Pull>;
  nextPull: number;
  labels: Map<string, Label>;
  nextLabelId: number;
  nextCommentId: number;
}

export class Store {
  repos: Map<string, Repo> = new Map(); // "owner/name" -> Repo
  nextRepoId = 1;
  ownerLogin: string;

  constructor(ownerLogin: string) {
    this.ownerLogin = ownerLogin;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      fullName: `${owner}/${name}`,
      description,
      defaultBranch: 'main',
      private: false,
      created_at: FIXED_TIME,
      updated_at: FIXED_TIME,
      pushed_at: FIXED_TIME,
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      nextIssue: 1,
      pulls: new Map(),
      nextPull: 1,
      labels: new Map(),
      nextLabelId: 1,
      nextCommentId: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }
}

// ---------- git object helpers (shared by git.ts and rest.ts) ----------

/** Parse a commit object's content into headers + message. */
export function parseCommit(data: Buffer): { headers: Map<string, string[]>; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const headers = new Map<string, string[]>();
  let current = '';
  for (const line of head.split('\n')) {
    if (line.startsWith(' ') && current) {
      const arr = headers.get(current)!;
      arr[arr.length - 1] += '\n' + line;
      continue;
    }
    const i = line.indexOf(' ');
    if (i === -1) continue;
    current = line.slice(0, i);
    const arr = headers.get(current) ?? [];
    arr.push(line.slice(i + 1));
    headers.set(current, arr);
  }
  return { headers, message };
}

/** Parse a tree object's entries: { mode, name, sha(hex) } in order. */
export function parseTree(data: Buffer): { mode: string; name: string; sha: string }[] {
  const out: { mode: string; name: string; sha: string }[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0x00, sp);
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, sha });
    off = nul + 21;
  }
  return out;
}

/** Serialise tree entries back to a tree object body. */
export function buildTree(entries: { mode: string; name: string; sha: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build a commit object body. parents: list of parent shas (hex). */
export function buildCommit(opts: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${opts.author} ${FIXED_GIT_TIME} +0000`);
  lines.push(`committer ${opts.committer} ${FIXED_GIT_TIME} +0000`);
  return Buffer.from(lines.join('\n') + '\n\n' + opts.message, 'utf8');
}

/** Resolve a ref to a sha, following nothing (refs store commit shas directly). */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

/** Default-branch head sha, if the repo has any commit. */
export function headSha(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** Is `ancestor` reachable from `descendant` (walk commit parents)? */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const sha = stack.pop()!;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    const { headers } = parseCommit(obj.data);
    for (const p of headers.get('parent') ?? []) stack.push(p);
  }
  return false;
}
