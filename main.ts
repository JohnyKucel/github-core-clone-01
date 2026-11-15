// Entry lifecycle for the make.fun trial harness: this process is the
// contestant side of a two-process handshake. It starts the forge on a
// kernel-chosen port, tells the grading env where to find it, and then
// waits until the env reports the trial finished. Nothing here scores:
// the forge itself lives in app.ts. The only promises this file makes
// are the ones wire.ts defines: register once, poll /done, exit 0.
//
//   * Without MAKEFUN_ENV_URL there is no env to talk to: fail fast.
//   * Port 0 lets the kernel pick; 8080 belongs to the env, never bind it.
//   * Register: 200 or 409 means go on; 400/405 are contract breaks and
//     end the process; anything else is retried, the env may be booting.
//   * /done answers immediately either way, so poll with backoff.
//   * On done: shut the server down and leave with status 0.

import { createApp } from "./app.ts";

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
if (envOrigin.length === 0) {
  process.stderr.write("[entry] MAKEFUN_ENV_URL missing, no env to register with\n");
  process.exit(1); // no env
}

const REQUEST_BUDGET_MS = 30_000;
const BACKOFF_START_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

function pause(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds));
}

function backoffFor(failures: number): number {
  const doubled = BACKOFF_START_MS * 2 ** Math.min(failures, 8);
  return doubled > BACKOFF_CEILING_MS ? BACKOFF_CEILING_MS : doubled;
}

async function announce(port: number): Promise<void> {
  let failures = 0;
  while (true) {
    try {
      const answer = await fetch(`${envOrigin}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) {
        throw new Error(`register refused with HTTP ${answer.status}: ${await answer.text()}`);
      }
    } catch (problem) {
      if (problem instanceof Error && problem.message.startsWith("register refused with HTTP ")) throw problem;
    }
    await pause(backoffFor(failures));
    failures += 1;
  }
}

async function awaitCompletion(): Promise<void> {
  let failures = 0;
  while (true) {
    try {
      const answer = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(REQUEST_BUDGET_MS) });
      if (answer.ok) {
        const payload = (await answer.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // No answer yet, or the request timed out: the trial is not over.
    }
    await pause(backoffFor(failures));
    failures += 1;
  }
}

async function run(): Promise<void> {
  const server = createApp(); // the forge
  await new Promise<void>((ready, failed) => {
    server.once("error", failed);
    server.listen(0, () => ready());
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") throw new Error("the server did not bind a TCP port");
  process.stdout.write(`[entry] bound to port ${bound.port}\n`);
  await announce(bound.port);
  process.stdout.write("[entry] registered, waiting for the trial to finish\n");
  await awaitCompletion();
  server.close(); // shut the forge down
  process.stdout.write("[entry] trial done\n");
}

try {
  await run();
  process.exit(0); // done
} catch (problem) {
  process.stderr.write(`[entry] ${problem instanceof Error ? problem.message : String(problem)}\n`);
  process.exit(1); // failed
}
