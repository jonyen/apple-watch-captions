import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Reads the deployment wiring rather than exercising it.
 *
 * `trustProxyHeaders` shipped fully implemented and fully unit-tested in
 * `server.ts`, and completely unreachable: nothing ever passed it. Every test
 * that existed constructed `startServer` itself, so all of them passed while
 * the production entrypoint never set the flag and `fly.toml` never set the
 * variable it comes from. The gap is between three files, not inside any one
 * of them, and it is not one a unit test can be positioned to see.
 *
 * So these assert on the text of the entrypoint and the deployment config.
 * That is a weak kind of test — a rename would satisfy it while breaking the
 * wiring, and it cannot prove the value arrives. It is here because the
 * alternative on offer was no check at all: booting `index.ts` needs real
 * API keys, a writable volume and a listening port, which is why the mistake
 * survived twelve reviews. Read it as a spelling check on a wire that is
 * otherwise invisible, not as a test of behavior.
 */
const backend = join(import.meta.dirname, "..");
const read = (name: string) => readFileSync(join(backend, name), "utf8");

describe("deployment wiring", () => {
  it("passes the configured trustProxyHeaders through to the server", () => {
    expect(read("src/index.ts")).toContain("trustProxyHeaders: config.trustProxyHeaders");
  });

  // On Fly, `http_service` terminates the client connection, so without this
  // every registration in the world shares one bucket and ten requests from
  // anyone close registration — the only way to get a credential — for an
  // hour.
  it("turns proxy-header trust on in the Fly config", () => {
    expect(read("fly.toml")).toMatch(/^\s*TRUST_PROXY_HEADERS\s*=\s*"true"\s*$/m);
  });
});
