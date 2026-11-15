// The forge's HTTP server: routing + auth. main.ts owns the lifecycle
// (bind ephemeral port, register with the env, poll /done); this file is
// the server, grown module by module:
//   git.ts       smart HTTP: /{owner}/{repo}.git/info/refs, git-upload-pack, git-receive-pack
//   rest.ts      REST v3 under /api/v3
//   graphql.ts   POST /api/graphql
//   mcp.ts       POST /mcp (JSON-RPC 2.0 Streamable HTTP)
//
// Auth: every request except GET /healthz must present
// `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the env sets it in our
// process too). Missing or wrong token -> 401 JSON {message}. A repo
// under any owner other than the token owner (store.OWNER_LOGIN) is 404,
// never 403. Every REST reply carries X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, OWNER_LOGIN } from './store.ts';
import { bearerToken, pathOf, requestId, sendJson } from './http.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

export function createApp(): Server {
  const store = new Store(OWNER_LOGIN);
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot probe: 200 {"ok":true}, no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Everything else needs the suite's bearer <redacted>.
        if (TOKEN === '' || bearerToken(req) !== TOKEN) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }

        const rid = { 'x-github-request-id': requestId() };

        if (method === 'POST' && path === '/api/graphql') {
          await handleGraphql(store, req, res, rid);
          return;
        }
        if (method === 'POST' && path === '/mcp') {
          await handleMcp(store, req, res, rid);
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await handleRest(store, req, res, rid);
          return;
        }
        if (await handleGit(store, req, res, rid)) return;

        sendJson(res, 404, { message: 'Not Found' }, rid);
      } catch (err) {
        // Never leak a stack or HTML: a JSON 500 keeps the server up.
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // response already gone; nothing to do
        }
        process.stderr.write(`[forge] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    })();
  });
}
