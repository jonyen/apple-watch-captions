import { randomBytes } from "crypto";
import { Db } from "./db";
import { NOTION_VERSION } from "./notionExporter";

/**
 * Find a database to export into, using the token just granted.
 *
 * A normal (non-template) Notion integration never returns a database id
 * from the token exchange — the user picks pages to share on the consent
 * screen instead, and `/v1/search` is the only way to discover what that
 * granted. `Notion-Version` matches `notionExporter.ts`'s `createRequest`
 * (the same header, imported from the same constant) so the two never drift
 * apart. Injectable `fetchImpl`, matching `createCodeExchange`, so this stays
 * testable without a network.
 */
export function createDatabaseFinder(
  fetchImpl: typeof fetch = fetch,
): (accessToken: string) => Promise<{ id: string; title?: string } | null> {
  return async (accessToken) => {
    const res = await fetchImpl("https://api.notion.com/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Notion-Version": NOTION_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({ filter: { value: "database", property: "object" } }),
    } as RequestInit);
    if (!res.ok) {
      throw new Error(`notion database search failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as {
      results?: { id: string; title?: { plain_text: string }[] }[];
    };
    const found = body.results?.[0];
    if (!found) return null;
    return {
      id: found.id,
      title: found.title?.map((t) => t.plain_text).join("") || undefined,
    };
  };
}

export interface NotionOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Must match the URI registered with the Notion integration exactly. */
  redirectUri: string;
}

/** How long a user has to finish the Notion consent screen. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

/**
 * The `state` values handed to Notion and expected back.
 *
 * This is the CSRF defence for the whole flow, not a formality. Without it an
 * attacker can hand a victim a callback URL carrying the attacker's own
 * authorization code; the relay would bind the attacker's Notion workspace to
 * the victim's account and every transcript the victim records afterwards
 * would be delivered to the attacker.
 */
export class OAuthStateStore {
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  mint(userId: string): string {
    // Dead rows are garbage the instant they go dead, and nothing else purges
    // them, so the state space would otherwise only ever grow. Sweep first,
    // against the injected clock (not SQLite's own time functions) so test
    // clock injection still governs expiry.
    this.db
      .prepare("DELETE FROM oauth_states WHERE expires_at <= ?")
      .run(new Date(this.now()).toISOString());
    const state = randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO oauth_states (state, user_id, expires_at) VALUES (?,?,?)")
      .run(state, userId, new Date(this.now() + OAUTH_STATE_TTL_MS).toISOString());
    return state;
  }

  /**
   * The user who began this flow, or null. Consumes the state either way —
   * deleted before the expiry check runs, so an expired state cannot be
   * retried by calling consume again.
   */
  consume(state: string): string | null {
    const row = this.db
      .prepare("SELECT user_id, expires_at FROM oauth_states WHERE state = ?")
      .get(state) as { user_id: string; expires_at: string } | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
    if (Date.parse(row.expires_at) <= this.now()) return null;
    return row.user_id;
  }
}

export function authorizeUrl(config: NotionOAuthConfig, state: string): string {
  const url = new URL("https://api.notion.com/v1/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("owner", "user");
  url.searchParams.set("state", state);
  return url.toString();
}

export interface ExchangeResult {
  accessToken: string;
  databaseId?: string;
  workspaceName?: string;
}

export type ExchangeCode = (code: string) => Promise<ExchangeResult>;

/**
 * Trade an authorization code for an access token.
 *
 * The client secret is sent with HTTP Basic auth and never leaves the server,
 * which is the whole reason this exchange happens here rather than in a
 * client.
 */
export function createCodeExchange(
  config: NotionOAuthConfig,
  fetchImpl: typeof fetch = fetch,
): ExchangeCode {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  return async (code) => {
    const res = await fetchImpl("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
      }),
    });
    if (!res.ok) {
      throw new Error(`notion token exchange failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as {
      access_token: string;
      workspace_name?: string;
      duplicated_template_id?: string;
    };
    return {
      accessToken: body.access_token,
      ...(body.duplicated_template_id ? { databaseId: body.duplicated_template_id } : {}),
      ...(body.workspace_name ? { workspaceName: body.workspace_name } : {}),
    };
  };
}
