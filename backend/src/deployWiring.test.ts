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
  // Fix round 1: this literal moved from index.ts into serverOptions.ts's
  // `buildServerOptions` when that function was extracted (Important 2), so
  // the check follows it there.
  it("passes the configured trustProxyHeaders through to the server", () => {
    expect(read("src/serverOptions.ts")).toContain("trustProxyHeaders: config.trustProxyHeaders");
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
  // nothing in index.ts ever passed any of the export-destination options,
  // so an unconfigured-looking StartServerOptions object satisfied every
  // route test while the entrypoint constructed something else entirely.
  //
  // Fix round 1, Important 2: this file used to assert each of those eight
  // options as a flat substring inside a literal `startServer({...})` call
  // here. That could pass with an *inverted* gate, a value pinned to
  // `undefined`, or a shorthand bound to the wrong variable — a textual
  // check can't tell "correctly gated" from "present" — which is exactly how
  // Important 1 (Notion OAuth offered with nowhere to store the connection)
  // shipped undetected. That behavioral coverage now lives in
  // `serverOptions.test.ts`, which calls the real gating function
  // (`buildServerOptions`) against fake configs and asserts on what it
  // returns.
  //
  // What's left here is the one thing a behavioral unit test of
  // `buildServerOptions` cannot see on its own: whether `index.ts` actually
  // calls it with the real config and feeds its result straight to the real
  // `startServer`, rather than building it and discarding the result (or
  // constructing some other, unrelated options object instead).
  it("builds startServer's options from the loaded config via buildServerOptions", () => {
    expect(read("src/index.ts")).toMatch(/const options = buildServerOptions\(config,/);
  });

  it("passes buildServerOptions's result to startServer, not a separate object", () => {
    expect(read("src/index.ts")).toMatch(/startServer\(options\)/);
  });

  // Final review, Important 1: the legacy-Notion adoption runs at module
  // scope in `index.ts` and reaches `secretBox.open()`, which throws on a bad
  // auth tag or an unknown version prefix. Unguarded, that is a boot loop
  // that takes captioning down for an export reason. The guard lives in
  // `adoptLegacyNotionAtBoot` (behaviour covered in `server.exports.test.ts`);
  // what no unit test can see is which of the two functions the entrypoint
  // actually calls, since nothing in the suite boots `index.ts`.
  it("adopts the legacy Notion config through the boot-safe wrapper, never the throwing one", () => {
    const source = read("src/index.ts");
    expect(source).toMatch(/adoptLegacyNotionAtBoot\(identity, options\.destinations,/);
    expect(source).not.toMatch(/adoptLegacyNotionIfUnambiguous\(identity/);
  });

  // PUBLIC_BASE_URL is not a secret (this deploy's own public origin), so it
  // belongs in `[env]` like TRUST_PROXY_HEADERS above, and has one correct
  // default (the app's own fly.dev hostname).
  it("adds the non-secret PUBLIC_BASE_URL setting to the Fly config", () => {
    expect(read("fly.toml")).toMatch(/^\s*PUBLIC_BASE_URL\s*=/m);
  });

  // Fix round 1, Minor 1: EMAIL_FROM is not a secret either, but unlike
  // PUBLIC_BASE_URL it has no correct default — it must be an address on a
  // domain verified with Resend. Shipping any committed value here would let
  // setting only the RESEND_API_KEY secret look like a complete
  // configuration when it isn't: every send would fail at Resend instead of
  // the feature just staying off (`buildServerOptions` gates `sendEmail` on
  // both `resendApiKey` and `emailFrom` together).
  it("ships no default EMAIL_FROM value, so RESEND_API_KEY alone can't half-enable email export", () => {
    expect(read("fly.toml")).not.toMatch(/^\s*EMAIL_FROM\s*=/m);
  });

  it("never commits the Resend API key to the Fly config", () => {
    // Matches an actual assignment, not a comment mentioning the name (e.g.
    // one pointing the reader at `fly secrets set` instead) — the point is
    // that no value for it is ever written to this file, which is checked
    // into git, not that the string never appears.
    expect(read("fly.toml")).not.toMatch(/^\s*RESEND_API_KEY\s*=/m);
  });
});
