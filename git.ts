// git smart HTTP: /{owner}/{repo}.git/info/refs, git-upload-pack, git-receive-pack.
// Node 22 stdlib only (node:crypto, node:zlib). No git binary at runtime.
//   upload-pack: protocol v2 when the client sends `Git-Protocol: version=2`
//     (advertisement "version 2", ls-refs, fetch with want/have/done + sideband),
//     v0 fallback ("# service=git-upload-pack" preamble, side-band-64k).
//   receive-pack: v0 only, advertises report-status, side-band-64k, delete-refs;
//     every update must fast-forward, per ref.
// Auth is checked by app.ts before this handler runs; the suite client sends
// Authorization: Bearer on every git request, so there is no 401-challenge flow.
// Determinism: no wall clock anywhere; pack object order is sorted by oid.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FIXED_TIME,
  isAncestor,
  objectSha,
  parseCommit,
  parseTree,
  type GitObject,
  type ObjType,
  type Repo,
  type Store,
} from './store.ts';
import { pathOf, queryOf, readBody, sendJson, sendRaw } from './http.ts';

export const ZERO_OID = '0'.repeat(40);
const AGENT = 'forge-git/1.0';
/** Max bytes of pack data in one sideband packet (pkt-line 65520 - 4 header - 1 band byte). */
const SIDEBAND_CHUNK = 65515;

type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

// ---------------------------------------------------------------- pkt-line

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > 65516) throw new Error('pkt-line payload too large');
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pkt(item));
  }
  return Buffer.concat(parts);
}

/**
 * Decode pkt-lines from the front of `buf`. Stops at the first 4 bytes that are
 * not a hex length (the raw pack that follows a receive-pack flush) and returns
 * the rest untouched.
 */
function decodePktStream(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len < 4 || len > 65520) throw new Error(`invalid pkt-line length ${len}`);
    if (off + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: buf.subarray(off) };
}

function packetTexts(packets: readonly Packet[]): string[] {
  const out: string[] = [];
  for (const p of packets) if (p.kind === 'data') out.push(p.payload.toString('utf8'));
  return out;
}

/** Split decoded packets into sections at flush/delim boundaries (data lines only). */
function packetSections(packets: readonly Packet[]): string[][] {
  const sections: string[][] = [];
  let current: string[] = [];
  for (const p of packets) {
    if (p.kind === 'data') current.push(p.payload.toString('utf8'));
    else if (p.kind === 'flush' || p.kind === 'delim') {
      sections.push(current);
      current = [];
    }
  }
  if (current.length) sections.push(current);
  return sections;
}

// ---------------------------------------------------------------- packfile

const TYPE_CODE: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile v2 from plain objects (no deltas), objects sorted by oid. */
function writePack(objects: readonly GitObject[]): Buffer {
  const list = [...objects].sort((a, b) => {
    const ah = objectSha(a.type, a.data);
    const bh = objectSha(b.type, b.data);
    return ah < bh ? -1 : ah > bh ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset, end);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (off >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[off++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (off >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[off++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (off >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[off++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (off + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, off, off + literal);
      off += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read a packfile v2/v3, resolving OFS_DELTA and REF_DELTA (thin-pack bases come
 * from `resolveBase`, i.e. objects already in the repo). Returns oid -> object.
 * Throws on any structural problem, size mismatch or bad trailer checksum.
 */
function readPack(pack: Buffer, resolveBase: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new Error('pack entry has no size header');
    let byte = pack[offset];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack entry size varint is truncated');
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack entry size varint is too long');
    }
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      if (offset >= trailerStart) throw new Error('ofs-delta has no base offset');
      byte = pack[offset];
      let value = byte & 0x7f;
      offset += 1;
      while (byte & 0x80) {
        if (offset >= trailerStart) throw new Error('ofs-delta base offset is truncated');
        byte = pack[offset++];
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      if (value <= 0 || value > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${value}`);
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== size) {
      throw new Error(`pack entry at ${entryOffset} declares ${size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: ObjType; data: Buffer; oid: string } => {
    const cached = (entry as RawPackEntry & { resolved?: { type: ObjType; data: Buffer; oid: string } }).resolved;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor held locally`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = objectSha(type, data);
    const out = { type, data, oid };
    (entry as RawPackEntry & { resolved?: { type: ObjType; data: Buffer; oid: string } }).resolved = out;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

// ---------------------------------------------------------------- refs

interface RefLine {
  name: string;
  oid: string;
}

function sortedRefs(repo: Repo): RefLine[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function headRefName(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function headOid(repo: Repo): string | undefined {
  return repo.refs.get(headRefName(repo));
}

/** Peel an annotated tag to its commit, following tag->tag chains. */
function peelToCommit(repo: Repo, oid: string): string | undefined {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = repo.objects.get(current);
    if (!obj) return undefined;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return undefined;
    const { headers } = parseCommit(obj.data);
    const target = headers.get('object')?.[0];
    if (!target) return undefined;
    current = target;
  }
  return undefined;
}

/** Parse a tag object's target (oid + type) without following it. */
function tagTarget(repo: Repo, oid: string): { oid: string; type: string } | undefined {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return undefined;
  const { headers } = parseCommit(obj.data);
  const target = headers.get('object')?.[0];
  const type = headers.get('type')?.[0];
  if (!target || !type) return undefined;
  return { oid: target, type };
}

function committerTimestamp(data: Buffer): number | undefined {
  const { headers } = parseCommit(data);
  const committer = headers.get('committer')?.[0] ?? '';
  const m = / (\d+) [+-]\d{4}$/.exec(committer);
  return m ? Number(m[1]) : undefined;
}

// ---------------------------------------------------------------- reachability walk

interface WalkResult {
  /** Every object the walk collected (commits, trees, blobs, tags). */
  objects: Map<string, GitObject>;
  /** Commits included by the walk. */
  commits: Set<string>;
  /** Commits at the depth/since boundary (their parents were cut). */
  boundary: Set<string>;
  /** Each included commit's shortest distance in generations from a root. */
  distances: Map<string, number>;
}

interface WalkOptions {
  /** Include at most this many commit generations from the roots (want = generation 1). */
  maxDepth?: number;
  /** Commits whose parents must not be traversed (old shallow boundaries). Only when no maxDepth. */
  cutBelow?: Set<string>;
  /** Do not traverse parents of commits at or before this unix time. Only when no maxDepth. */
  sinceCut?: number;
}

function walkObjects(repo: Repo, roots: readonly string[], opts: WalkOptions): WalkResult {
  const objects = new Map<string, GitObject>();
  const commits = new Set<string>();
  const boundary = new Set<string>();
  const distances = new Map<string, number>();
  const seenCommit = new Set<string>();

  const addObject = (oid: string): GitObject => {
    const existing = objects.get(oid);
    if (existing) return existing;
    const obj = repo.objects.get(oid);
    if (!obj) throw new Error(`object ${oid} is missing`);
    objects.set(oid, obj);
    return obj;
  };
  const addTree = (oid: string): void => {
    const obj = addObject(oid);
    if (obj.type !== 'tree') throw new Error(`object ${oid} is not a tree`);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '160000') continue; // gitlink: a commit this repo does not hold
      const child = addObject(entry.sha);
      if (child.type === 'tree') addTree(entry.sha);
    }
  };

  const queue: Array<[string, number]> = [];
  const enqueue = (oid: string, dist: number): void => {
    if (!distances.has(oid)) distances.set(oid, dist);
    if (!seenCommit.has(oid)) queue.push([oid, dist]);
  };
  for (const root of roots) {
    const obj = repo.objects.get(root);
    if (!obj) throw new Error(`object ${root} is missing`);
    if (obj.type === 'commit') enqueue(root, 0);
    else if (obj.type === 'tag') {
      addObject(root);
      const target = tagTarget(repo, root);
      if (!target) throw new Error(`tag ${root} has no target`);
      if (target.type === 'commit') enqueue(target.oid, 0);
      else if (target.type === 'tree') addTree(target.oid);
      else addObject(target.oid);
    } else if (obj.type === 'tree') addTree(root);
    else addObject(root);
  }

  let qi = 0;
  while (qi < queue.length) {
    const [oid, dist] = queue[qi++]!;
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    const obj = addObject(oid);
    if (obj.type !== 'commit') continue;
    commits.add(oid);
    const { headers } = parseCommit(obj.data);
    const tree = headers.get('tree')?.[0];
    if (tree) addTree(tree);
    const depthCut = opts.maxDepth !== undefined && dist >= opts.maxDepth - 1;
    const shallowCut = opts.maxDepth === undefined && (opts.cutBelow?.has(oid) ?? false);
    let sinceCut = false;
    if (opts.maxDepth === undefined && opts.sinceCut !== undefined) {
      const ts = committerTimestamp(obj.data);
      sinceCut = ts !== undefined && ts <= opts.sinceCut;
    }
    if (depthCut || sinceCut) boundary.add(oid);
    if (depthCut || shallowCut || sinceCut) continue;
    for (const parent of headers.get('parent') ?? []) {
      enqueue(parent, dist + 1);
    }
  }
  return { objects, commits, boundary, distances };
}

interface FetchPlan {
  packObjects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowList: readonly string[],
  depth: number | undefined,
  deepenSince: number | undefined,
  deepenNot: readonly string[],
  deepenRelative: boolean,
): FetchPlan {
  for (const want of wants) if (!repo.objects.has(want)) throw new Error(`want ${want} is not known`);
  const oldBoundaries = new Set(shallowList);
  const extraHaves: string[] = [];
  for (const ref of deepenNot) {
    const sha = repo.refs.get(ref);
    if (sha) extraHaves.push(sha);
  }
  const heldOids = [...haves, ...extraHaves].filter((oid) => repo.objects.has(oid));
  const held = walkObjects(repo, heldOids, { cutBelow: oldBoundaries });
  // --deepen N (deepen-relative): N more generations below the client's
  // current shallow boundary, not N from the wants. The boundary sits
  // d0 generations below the wants, so the absolute depth is d0 + N + 1.
  let effectiveDepth = depth;
  if (deepenRelative && depth !== undefined) {
    const probe = walkObjects(repo, wants, {});
    let d0: number | undefined;
    for (const boundaryOid of oldBoundaries) {
      const d = probe.distances.get(boundaryOid);
      if (d !== undefined && (d0 === undefined || d < d0)) d0 = d;
    }
    if (d0 !== undefined) effectiveDepth = d0 + depth + 1;
  }
  const wanted = walkObjects(repo, wants, {
    maxDepth: effectiveDepth,
    cutBelow: oldBoundaries,
    sinceCut: deepenSince,
  });
  const packObjects: GitObject[] = [];
  for (const [oid, obj] of wanted.objects) {
    if (!held.objects.has(oid)) packObjects.push(obj);
  }
  let shallow: string[];
  let unshallow: string[];
  if (depth !== undefined || deepenSince !== undefined) {
    shallow = [...wanted.boundary].sort();
    unshallow = [...oldBoundaries].filter((oid) => wanted.commits.has(oid) && !wanted.boundary.has(oid)).sort();
  } else {
    shallow = [...oldBoundaries].filter((oid) => wanted.commits.has(oid)).sort();
    unshallow = [];
  }
  const acks: string[] = [];
  for (const have of haves) {
    const obj = repo.objects.get(have);
    if (!obj || obj.type !== 'commit') continue;
    for (const want of wants) {
      const wantCommit = repo.objects.get(want)?.type === 'tag' ? peelToCommit(repo, want) : want;
      if (wantCommit && isAncestor(repo, have, wantCommit)) {
        acks.push(have);
        break;
      }
    }
  }
  return { packObjects, shallow, unshallow, acks };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pack.length; off += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + SIDEBAND_CHUNK));
    out.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) out.push(pkt(Buffer.from([1])));
  return out;
}

// ---------------------------------------------------------------- advertisements

function v0Capabilities(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): string {
  const common = `symref=HEAD:${headRefName(repo)} agent=${AGENT}`;
  if (service === 'git-upload-pack') {
    // multi_ack_detailed is required by real git for v0 fetches over
    // stateless (smart HTTP) RPC: without it fetch-pack dies with
    // "the option '--stateless-rpc' requires 'multi_ack_detailed'".
    // deepen-relative / deepen-since / deepen-not gate git's --deepen,
    // --shallow-since and --shallow-exclude the same way.
    return `${common} side-band-64k thin-pack ofs-delta shallow multi_ack multi_ack_detailed deepen-relative deepen-since deepen-not`;
  }
  return `${common} report-status side-band-64k delete-refs ofs-delta thin-pack`;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = v0Capabilities(repo, service);
  const refs = sortedRefs(repo);
  const head = headOid(repo) ?? ZERO_OID;
  const lines: (string | 'flush')[] = [`# service=${service}\n`, 'flush'];
  let first = true;
  const emit = (line: string): void => {
    lines.push(first ? `${line}\0${caps}\n` : `${line}\n`);
    first = false;
  };
  emit(`${head} HEAD`);
  for (const ref of refs) {
    emit(`${ref.oid} ${ref.name}`);
    const peeled = peelToCommit(repo, ref.oid);
    if (peeled !== undefined && peeled !== ref.oid) lines.push(`${peeled} ${ref.name}^{}\n`);
  }
  lines.push('flush');
  return pktLines(lines);
}

function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    `agent=${AGENT}\n`,
    'object-format=sha1\n',
    'flush',
  ]);
}

// ---------------------------------------------------------------- ls-refs (v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: (string | 'flush')[] = [];
  const head = headOid(repo);
  const passes = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (args.symrefs && passes('HEAD')) {
    if (head !== undefined) lines.push(`${head} HEAD symref-target:${headRefName(repo)}\n`);
    else if (args.unborn) lines.push(`unborn HEAD symref-target:${headRefName(repo)}\n`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!passes(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = peelToCommit(repo, ref.oid);
      if (peeled !== undefined && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return pktLines(lines);
}

// ---------------------------------------------------------------- fetch

function fetchErrorResponse(protocol: 2 | 0, message: string): Buffer {
  const err = pkt(Buffer.concat([Buffer.from([3]), Buffer.from(`ERR ${message}\n`, 'utf8')]));
  if (protocol === 2) {
    return Buffer.concat([
      pkt('acknowledgments\n'),
      pkt('NAK\n'),
      PKT_DELIM,
      pkt('packfile\n'),
      err,
      PKT_FLUSH,
    ]);
  }
  return Buffer.concat([pkt('NAK\n'), err, PKT_FLUSH]);
}

function fetchResponse(
  repo: Repo,
  protocol: 2 | 0,
  wants: readonly string[],
  haves: readonly string[],
  shallowList: readonly string[],
  depth: number | undefined,
  deepenSince: number | undefined,
  deepenNot: readonly string[],
  done: boolean,
  deepenRelative: boolean,
): Buffer {
  let plan: FetchPlan;
  try {
    plan = planFetch(repo, wants, haves, shallowList, depth, deepenSince, deepenNot, deepenRelative);
  } catch (err) {
    return fetchErrorResponse(protocol, err instanceof Error ? err.message : String(err));
  }
  const pack = writePack(plan.packObjects);
  const packSection = (parts: Buffer[]): Buffer[] => {
    if (plan.shallow.length || plan.unshallow.length) {
      parts.push(pkt('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pkt('packfile\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(PKT_FLUSH);
    return parts;
  };
  if (protocol === 2) {
    // Real upload-pack v2 (upload-pack.c): when the client sent `done` (or no
    // haves at all) there is NO acknowledgments section — the response goes
    // straight to shallow-info/packfile. An ack section only answers a
    // negotiation round (haves, no done): ACKs or NAK, then `ready` + DELIM
    // when every want is already reachable from the haves (ok_to_give_up),
    // in which case the pack follows; otherwise FLUSH and no pack.
    if (haves.length && !done) {
      const ready =
        wants.length > 0 &&
        wants.every((want) => {
          const tip = repo.objects.get(want)?.type === 'tag' ? peelToCommit(repo, want) : want;
          return tip !== undefined && plan.acks.some((ack) => isAncestor(repo, ack, tip));
        });
      const parts: Buffer[] = [pkt('acknowledgments\n')];
      if (plan.acks.length) {
        for (const ack of plan.acks) parts.push(pkt(`ACK ${ack}\n`));
      } else {
        parts.push(pkt('NAK\n'));
      }
      if (ready) {
        parts.push(pkt('ready\n'));
        parts.push(PKT_DELIM);
        return Buffer.concat(packSection(parts));
      }
      parts.push(PKT_FLUSH);
      return Buffer.concat(parts);
    }
    return Buffer.concat(packSection([]));
  }
  // v0 (upload-pack.c / fetch-pack.c find_common): the shallow list is sent
  // during receive_needs, BEFORE any ACK/NAK, as its own section terminated
  // by a flush — and only when the request asked to deepen. A request that
  // ends after the wants section (no haves, no done: the shallow probe of a
  // --depth clone) is answered with that section alone: no ACK/NAK, no pack.
  // A negotiation round (haves, no done) answers the shallow section, then
  // one ACK (or NAK), then ends. A `done` round answers the shallow section,
  // one ACK (or NAK), then the sideband pack.
  const deepenRequested = depth !== undefined || deepenSince !== undefined || deepenNot.length > 0;
  const shallowSection: Buffer[] = [];
  if (deepenRequested) {
    for (const oid of plan.shallow) shallowSection.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) shallowSection.push(pkt(`unshallow ${oid}\n`));
    shallowSection.push(PKT_FLUSH);
  }
  const ackLine = plan.acks.length ? pkt(`ACK ${plan.acks[plan.acks.length - 1]}\n`) : pkt('NAK\n');
  if (haves.length === 0 && !done) return Buffer.concat(shallowSection);
  if (!done) return Buffer.concat([...shallowSection, ackLine, PKT_FLUSH]);
  return Buffer.concat([...shallowSection, ackLine, ...sidebandPackets(pack), PKT_FLUSH]);
}

function parseV2Command(body: Buffer): { command: string; args: string[] } {
  const { packets, rest } = decodePktStream(body);
  if (rest.length) throw new Error('trailing bytes after the pkt-line request');
  const sections = packetSections(packets);
  const head = sections[0] ?? [];
  if (!head.length || !head[0]!.startsWith('command=')) throw new Error('request has no command line');
  const command = head[0]!.slice('command='.length).trim();
  const args = (sections[1] ?? []).map((line) => line.replace(/\n$/, ''));
  return { command, args };
}

function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const { command, args } = parseV2Command(body);
  if (command === 'ls-refs') {
    const parsed: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const arg of args) {
      if (arg === 'peel') parsed.peel = true;
      else if (arg === 'symrefs') parsed.symrefs = true;
      else if (arg === 'unborn') parsed.unborn = true;
      else if (arg.startsWith('ref-prefix ')) parsed.prefixes.push(arg.slice('ref-prefix '.length));
    }
    return lsRefsResponse(repo, parsed);
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    const deepenNot: string[] = [];
    let depth: number | undefined;
    let deepenSince: number | undefined;
    let deepenRelative = false;
    let done = false;
    for (const arg of args) {
      if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
      else if (arg.startsWith('deepen-since ')) deepenSince = Number(arg.slice(13).trim());
      else if (arg.startsWith('deepen-not ')) deepenNot.push(arg.slice(11).trim());
      else if (arg === 'deepen-relative') deepenRelative = true;
      else if (arg === 'done') done = true;
      // thin-pack, no-progress, ofs-delta, filter: accepted, no action needed
    }
    if (!wants.length) throw new Error('fetch with no want lines');
    if (depth !== undefined && (!Number.isFinite(depth) || depth < 1)) throw new Error(`bad deepen ${depth}`);
    return fetchResponse(repo, 2, wants, haves, shallow, depth, deepenSince, deepenNot, done, deepenRelative);
  }
  throw new Error(`unknown v2 command ${command}`);
}

function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = decodePktStream(body);
  if (rest.length) throw new Error('trailing bytes after the pkt-line request');
  const sections = packetSections(packets);
  if (!sections.length) throw new Error('empty upload-pack request');
  const wants: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let deepenSince: number | undefined;
  const deepenNot: string[] = [];
  let deepenRelative = false;
  for (const line of sections[0] ?? []) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) {
      const oid = text.slice(5).split(' ')[0]!;
      wants.push(oid);
      if (text.includes(' deepen-relative')) deepenRelative = true;
    } else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
    else if (text.startsWith('deepen-since ')) deepenSince = Number(text.slice(13).trim());
    else if (text.startsWith('deepen-not ')) deepenNot.push(text.slice(11).trim());
  }
  const haves: string[] = [];
  let done = false;
  for (const line of sections[1] ?? []) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text === 'done') done = true;
  }
  if (!wants.length) throw new Error('fetch with no want lines');
  if (depth !== undefined && (!Number.isFinite(depth) || depth < 1)) throw new Error(`bad deepen ${depth}`);
  return fetchResponse(repo, 0, wants, haves, shallow, depth, deepenSince, deepenNot, done, deepenRelative);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function pushReport(unpackOk: boolean, unpackDetail: string, results: { ref: string; ok: boolean; reason: string }[]): Buffer {
  const inner: (string | 'flush')[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const r of results) inner.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  inner.push('flush');
  const innerBytes = pktLines(inner);
  const parts: Buffer[] = [];
  for (let off = 0; off < innerBytes.length; off += SIDEBAND_CHUNK) {
    const chunk = innerBytes.subarray(off, Math.min(innerBytes.length, off + SIDEBAND_CHUNK));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = decodePktStream(body);
  const sections = packetSections(packets);
  const commands: PushCommand[] = [];
  for (const line of sections[0] ?? []) {
    const text = line.replace(/\n$/, '').split('\0')[0]!;
    const parts = text.split(' ');
    if (parts.length < 3) throw new Error(`bad receive-pack command line ${JSON.stringify(text.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid)) {
      throw new Error('receive-pack command has a bad object id');
    }
    if (!ref.startsWith('refs/')) throw new Error(`receive-pack command has a bad ref ${JSON.stringify(ref)}`);
    commands.push({ oldOid, newOid, ref });
  }
  if (!commands.length) throw new Error('receive-pack with no commands');

  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  if (rest.length) {
    let unpacked: Map<string, GitObject>;
    try {
      unpacked = readPack(rest, (oid) => repo.objects.get(oid));
    } catch (err) {
      const results = commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpacker error' }));
      return pushReport(false, err instanceof Error ? err.message : String(err), results);
    }
    for (const [oid, obj] of unpacked) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
  } else if (updatesRef) {
    const results = commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpacker error' }));
    return pushReport(false, 'missing packfile', results);
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  let moved = false;
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    let ok = true;
    let reason = '';
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        ok = false;
        reason = 'remote ref does not exist';
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        ok = false;
        reason = 'old value mismatch';
      }
    } else if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        ok = false;
        reason = 'already exists';
      } else {
        const obj = repo.objects.get(cmd.newOid);
        if (!obj) {
          ok = false;
          reason = `unable to read ${cmd.newOid}`;
        } else if (cmd.ref.startsWith('refs/heads/') && obj.type !== 'commit') {
          ok = false;
          reason = 'not a commit';
        }
      }
    } else {
      // Update.
      if (current === undefined) {
        ok = false;
        reason = 'old value mismatch';
      } else if (cmd.oldOid !== current) {
        ok = false;
        reason = 'old value mismatch';
      } else {
        const obj = repo.objects.get(cmd.newOid);
        if (!obj) {
          ok = false;
          reason = `unable to read ${cmd.newOid}`;
        } else if (cmd.ref.startsWith('refs/heads/') && obj.type !== 'commit') {
          ok = false;
          reason = 'not a commit';
        } else if (cmd.ref.startsWith('refs/tags/')) {
          if (cmd.newOid !== current) {
            ok = false;
            reason = 'already exists';
          }
        } else if (!isAncestor(repo, current, cmd.newOid)) {
          ok = false;
          reason = 'non-fast-forward';
        }
      }
    }
    if (ok) {
      if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
      else repo.refs.set(cmd.ref, cmd.newOid);
      moved = true;
    }
    results.push({ ref: cmd.ref, ok, reason });
  }
  if (moved) repo.pushed_at = FIXED_TIME;
  return pushReport(true, 'ok', results);
}

// ---------------------------------------------------------------- routing

export async function handleGit(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  rid: Readonly<Record<string, string>>,
): Promise<boolean> {
  const path = pathOf(req);
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (!match) return false;
  let owner: string;
  let repoName: string;
  try {
    owner = decodeURIComponent(match[1]!);
    repoName = decodeURIComponent(match[2]!);
  } catch {
    return false;
  }
  const rest = match[3] ?? '';
  const method = req.method ?? 'GET';
  const isInfoRefs = method === 'GET' && rest === '/info/refs';
  const isUploadPack = method === 'POST' && rest === '/git-upload-pack';
  const isReceivePack = method === 'POST' && rest === '/git-receive-pack';
  if (!isInfoRefs && !isUploadPack && !isReceivePack) return false;

  // A repository under any other owner is 404, never 403; a push cannot invent one.
  if (owner !== store.ownerLogin) {
    sendJson(res, 404, { message: 'Not Found' }, rid);
    return true;
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' }, rid);
    return true;
  }

  try {
    if (isInfoRefs) {
      const service = queryOf(req).get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 404, { message: 'Not Found' }, rid);
        return true;
      }
      const isV2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
      const body = isV2 ? v2Advertisement() : v0Advertisement(repo, service);
      sendRaw(res, 200, body, `application/x-${service}-advertisement`);
      return true;
    }
    const body = await readBody(req);
    if (isUploadPack) {
      const isV2 = req.headers['git-protocol'] === 'version=2';
      const out = isV2 ? handleUploadPackV2(repo, body) : handleUploadPackV0(repo, body);
      sendRaw(res, 200, out, 'application/x-git-upload-pack-result');
      return true;
    }
    // receive-pack is v0 only.
    const out = handleReceivePack(repo, body);
    sendRaw(res, 200, out, 'application/x-git-receive-pack-result');
    return true;
  } catch (err) {
    // A malformed request must not take the server down; the suite proves it stays up.
    try {
      sendJson(res, 400, { message: err instanceof Error ? err.message : 'Bad Request' }, rid);
    } catch {
      // Response already gone; nothing to do.
    }
    return true;
  }
}
