// Shared HTTP helpers for the forge's handlers.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** Read the full request body as a Buffer (no size cap needed: trial bodies are small). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; returns null when the body is not valid JSON. */
export function parseJsonBody(buf: Buffer): unknown {
  if (buf.length === 0) return null;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return undefined; // undefined = malformed JSON (distinct from JSON null)
  }
}

/** Answer with a JSON body. `headers` go beside the JSON ones. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** Answer with raw bytes (git smart HTTP). */
export function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** Non-empty request id for every REST reply (X-GitHub-Request-Id). */
export function requestId(): string {
  return randomUUID();
}

/** The path of a request URL, or '/' when it does not parse. */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Query params of a request URL. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Bearer token from the Authorization header, or ''. */
export function bearerToken(req: IncomingMessage): string {
  const h = req.headers.authorization ?? '';
  if (typeof h !== 'string') return '';
  const m = /^Bearer\s+(.+)$/.exec(h.trim());
  return m ? m[1] : '';
}
