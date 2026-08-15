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

  // The whole /v1/exports/* surface (Tasks 5-7) shipped fully built and fully
  // tested against `startServer` directly, and unreachable in production:
  // nothing in index.ts ever passed any of these eight options, so an
  // unconfigured-looking StartServerOptions object satisfied every route
  // test while the entrypoint constructed something else entirely. One test
  // per option, so a single dropped wire fails on its own line rather than
  // hiding in a passing composite assertion.
  const entrypoint = read("src/index.ts");
  const callStart = entrypoint.indexOf("startServer({");
  const callEnd = entrypoint.indexOf("});", callStart);
  // Sliced to just the call site, not the whole file: without this, a test
  // for (say) `sendEmail` would pass merely because that identifier appears
  // *somewhere* in index.ts — as the variable's own declaration — even if it
  // were never actually threaded into the options object below.
  const startServerCall = entrypoint.slice(callStart, callEnd);

  it.each([
    ["destinations", "destinations,"],
    ["oauthStates", "oauthStates,"],
    ["notionOAuth", "notionOAuth: config.notionOAuth,"],
    ["exchangeNotionCode", "exchangeNotionCode,"],
    ["findNotionDatabase", "findNotionDatabase,"],
    ["emailVerifications", "emailVerifications,"],
    ["sendEmail", "sendEmail,"],
    ["publicBaseUrl", "publicBaseUrl: config.publicBaseUrl,"],
  ])("wires %s into the startServer call", (_name, needle) => {
    expect(startServerCall).toContain(needle);
  });

  // RESEND_API_KEY is a bearer credential for the whole relay's mail sending
  // — it belongs in `fly secrets`, never committed to fly.toml. EMAIL_FROM
  // and PUBLIC_BASE_URL are not secrets (a From address and this deploy's own
  // public origin), so they belong in `[env]` like TRUST_PROXY_HEADERS above.
  it("adds the non-secret email/public-URL settings to the Fly config", () => {
    const toml = read("fly.toml");
    expect(toml).toMatch(/^\s*EMAIL_FROM\s*=/m);
    expect(toml).toMatch(/^\s*PUBLIC_BASE_URL\s*=/m);
  });

  it("never commits the Resend API key to the Fly config", () => {
    // Matches an actual assignment, not a comment mentioning the name (e.g.
    // one pointing the reader at `fly secrets set` instead) — the point is
    // that no value for it is ever written to this file, which is checked
    // into git, not that the string never appears.
    expect(read("fly.toml")).not.toMatch(/^\s*RESEND_API_KEY\s*=/m);
  });
});
