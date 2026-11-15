# github-core-clone-01 — a GitHub-compatible git forge

A standalone git forge in one Node 22 process, standard library only, no
`git` binary, no UI, no outside service. Entry for the make.fun bounty
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01)
("Build a GitHub-compatible git forge").

## What it serves

| Route | Surface |
| --- | --- |
| `GET /healthz` | Boot probe: `200 {"ok":true}` |
| `/<owner>/<repo>.git/...` | Git smart HTTP: `info/refs`, `git-upload-pack` (protocol v2 + v0 fallback), `git-receive-pack` (v0) |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, merges |
| `POST /api/graphql` | GitHub GraphQL v4 for the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over Streamable HTTP (JSON-RPC 2.0) |
| anything else | `404 {"message":"Not Found"}` |

Every API call takes `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a
missing or wrong token is `401`. A repository under any owner other than
the token owner is `404`, never `403`.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entry↔env lifecycle (bind an ephemeral port, register it
with `$MAKEFUN_ENV_URL`, poll `/done`, exit 0). The server lives in
`app.ts` and its modules; all state is in memory, so nothing persists
past the process — by design, the trial runs one suite pass per process.

## Layout

- `main.ts` — lifecycle, unchanged from the kit starter.
- `app.ts` — routing + auth; dispatches to the modules below.
- `store.ts` — in-memory store (repos, git objects, refs, issues, pulls,
  labels) plus git object helpers. Deterministic: no wall-clock time
  anywhere the suite can read (`FIXED_TIME`, `FIXED_GIT_TIME`).
- `http.ts` — shared JSON/raw body helpers.
- `git.ts` — pkt-line codec, packfile read/write (ofs/ref deltas,
  thin-pack completion), upload-pack v2, receive-pack v0 with
  fast-forward enforcement.
- `rest.ts` — REST v3.
- `graphql.ts` — hand-rolled GraphQL parser + executor.
- `mcp.ts` — MCP initialize / tools/list / tools/call.

## Local grading

The kit ships the sealed suite; the local runner grades the same checks:

```sh
MAKEFUN_SHOP_TOKEN=test-token-123 node --experimental-strip-types local-server.mjs 8901
node --experimental-strip-types <kit>/sdk/run.ts --url http://127.0.0.1:8901 --token test-token-123 --perf
```

Local result (15 Nov 2026, same machine): **120/120 checks,
feature 600, agent 200, perf 167–171, score 967–971** (reference forge
scores ~917–921). A full trial through the kit env
(`program/env/server.mjs` + `main.ts`) exits 0 with the same 120/120.

## License

MIT.
