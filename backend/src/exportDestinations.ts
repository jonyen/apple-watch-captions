import { Db } from "./db";
import { seal, open } from "./secretBox";
import { IdentityStore } from "./identityStore";

export type DestinationKind = "notion" | "email";

export interface NotionConfigRow {
  databaseId: string;
  /** Shown in `/app` so a user can tell which workspace they connected. */
  workspaceName?: string;
  /**
   * Set when Notion answered 401 — the user revoked the integration, or the
   * workspace was deleted. The sealed token is kept rather than cleared so
   * `/app` can still name the workspace that needs reconnecting; `getNotion`
   * stops handing it out, which is what stops every later export retrying a
   * credential that will never work again.
   */
  revokedAt?: string;
}

export interface EmailConfigRow {
  address: string;
  /** Unset until the confirmation link is followed. */
  verifiedAt?: string;
}

export interface ListedDestination {
  kind: DestinationKind;
  /** Whether this destination will actually receive transcripts. */
  connected: boolean;
  /** A short human label — workspace name or address. Never a secret. */
  detail: string;
}

/**
 * Where each user's finished transcripts are sent.
 *
 * Secrets are sealed on the way in and opened on the way out, so the only
 * plaintext copy of a Notion token lives in memory for the duration of one
 * export. `list()` is the only method a client's response is built from, and
 * it is deliberately incapable of returning a secret.
 */
export class ExportDestinationStore {
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  putNotion(userId: string, secretToken: string, config: NotionConfigRow): void {
    this.put(userId, "notion", JSON.stringify(config), seal(secretToken, this.key));
  }

  getNotion(userId: string): { token: string; config: NotionConfigRow } | null {
    const row = this.row(userId, "notion");
    if (!row?.secret) return null;
    const config = JSON.parse(row.config) as NotionConfigRow;
    // A revoked connection is not a usable one. Withholding it here is what
    // makes "stop until reconnected" fall out for free — the finalizer and
    // both backfills already skip a user this returns null for.
    if (config.revokedAt) return null;
    return { token: open(row.secret, this.key), config };
  }

  /**
   * Whether a notion row exists at all, regardless of whether it is usable.
   *
   * Distinct from `getNotion`, which withholds a revoked connection. Callers
   * asking "has this user already got one" — rather than "can I export with
   * it" — must use this, or they will treat a revoked connection as an empty
   * slot and overwrite it.
   */
  hasNotion(userId: string): boolean {
    return this.row(userId, "notion") !== null;
  }

  /**
   * Record that Notion rejected this user's token, so `/app` can ask them to
   * reconnect. Idempotent, and a no-op for a user with no connection.
   *
   * `failedToken` scopes the revocation to the credential that actually
   * failed. An export can be in flight for a long time — a boot backfill
   * sweep runs for minutes — and the badge tells the user to reconnect
   * meanwhile. Without this check, the doomed request's late 401 would revoke
   * the fresh connection they just made, and the page would immediately tell
   * them to reconnect again.
   *
   * `putNotion` replaces the whole config blob, so reconnecting clears the
   * flag without any explicit unset — the same replace-not-merge property
   * that stops a re-submitted email address inheriting a prior confirmation.
   */
  markNotionRevoked(userId: string, failedToken?: string): void {
    const row = this.row(userId, "notion");
    if (!row?.secret) return;
    if (failedToken !== undefined && open(row.secret, this.key) !== failedToken) return;
    const config = JSON.parse(row.config) as NotionConfigRow;
    if (config.revokedAt) return;
    config.revokedAt = new Date(this.now()).toISOString();
    this.db
      .prepare("UPDATE export_destinations SET config = ? WHERE user_id = ? AND kind = ?")
      .run(JSON.stringify(config), userId, "notion");
  }

  putEmail(userId: string, config: EmailConfigRow): void {
    this.put(userId, "email", JSON.stringify(config), null);
  }

  getEmail(userId: string): EmailConfigRow | null {
    const row = this.row(userId, "email");
    if (!row) return null;
    return JSON.parse(row.config) as EmailConfigRow;
  }

  list(userId: string): ListedDestination[] {
    const notion = this.row(userId, "notion");
    const email = this.getEmail(userId);
    const out: ListedDestination[] = [];
    if (notion) {
      const config = JSON.parse(notion.config) as NotionConfigRow;
      out.push({
        kind: "notion",
        // Revoked counts as not connected: the row is still here so we can
        // name the workspace, but nothing will be delivered to it again until
        // the user reconnects.
        connected: Boolean(notion.secret) && !config.revokedAt,
        detail: config.workspaceName ?? config.databaseId,
      });
    }
    if (email) {
      out.push({
        kind: "email",
        connected: Boolean(email.verifiedAt),
        detail: email.address,
      });
    }
    return out;
  }

  /**
   * Delete one destination. The **only** `DELETE FROM export_destinations` in
   * the codebase, and the Disconnect guarantee depends on it staying that
   * way: `legacy_notion_resolutions` is a separate table precisely so that
   * removing a row here does not also erase the record that the legacy
   * `NOTION_TOKEN` was already resolved for this user (see
   * `hasResolvedLegacyNotion`). A future bulk cleanup — a retention sweep, a
   * user-deletion path, a maintenance script — that deletes rows directly
   * instead of calling this is fine on its own terms; what it must not do is
   * leave `legacy_notion_resolutions` unconsidered, or the next boot's
   * `adoptLegacyNotionIfUnambiguous` silently re-adopts a workspace the user
   * deliberately disconnected. Route deletions through here, or update the
   * marker table in the same breath.
   */
  remove(userId: string, kind: DestinationKind): boolean {
    const before = this.row(userId, kind);
    if (!before) return false;
    this.db
      .prepare("DELETE FROM export_destinations WHERE user_id = ? AND kind = ?")
      .run(userId, kind);
    return true;
  }

  private put(userId: string, kind: DestinationKind, config: string, secret: string | null): void {
    this.db
      .prepare(
        `INSERT INTO export_destinations (user_id, kind, config, secret, created_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(user_id, kind) DO UPDATE SET config = excluded.config, secret = excluded.secret`,
      )
      .run(userId, kind, config, secret, new Date(this.now()).toISOString());
  }

  private row(userId: string, kind: DestinationKind): { config: string; secret: string | null } | null {
    const row = this.db
      .prepare("SELECT config, secret FROM export_destinations WHERE user_id = ? AND kind = ?")
      .get(userId, kind) as { config: string; secret: string | null } | undefined;
    return row ? { ...row } : null;
  }

  /**
   * Has the legacy `NOTION_TOKEN`/`NOTION_DATABASE_ID` pair already been
   * resolved for this user (adopted, or found already connected)? Backed by
   * its own table (`legacy_notion_resolutions`), never `export_destinations`
   * itself — that row is exactly what `remove(userId, "notion")` deletes,
   * and this must keep answering `true` after that delete, or a user's
   * Disconnect would look identical to "never resolved" and get silently
   * re-adopted on the next boot.
   */
  hasResolvedLegacyNotion(userId: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM legacy_notion_resolutions WHERE user_id = ?").get(userId),
    );
  }

  /** Idempotent: marking an already-marked user is a no-op, not an error. */
  markLegacyNotionResolved(userId: string): void {
    this.db
      .prepare(
        "INSERT INTO legacy_notion_resolutions (user_id, resolved_at) VALUES (?,?) " +
          "ON CONFLICT(user_id) DO NOTHING",
      )
      .run(userId, new Date(this.now()).toISOString());
  }
}

/**
 * Carry a pre-OAuth `NOTION_TOKEN`/`NOTION_DATABASE_ID` pair onto the user who
 * owns the transcripts, so exports keep working across the upgrade. Never
 * overwrites a connection the user has since made through OAuth.
 */
export function adoptLegacyNotion(
  store: ExportDestinationStore,
  userId: string,
  legacy: { token: string; databaseId: string },
): void {
  // `hasNotion`, not `getNotion`: a revoked connection is still the user's
  // own and must never be replaced by the operator's legacy token.
  if (store.hasNotion(userId)) return;
  store.putNotion(userId, legacy.token, { databaseId: legacy.databaseId });
}

export type LegacyNotionAdoption =
  | { outcome: "adopted"; userId: string }
  | { outcome: "already-resolved"; userId: string }
  | { outcome: "ambiguous" }
  | { outcome: "not-configured" }
  /** Something threw on the way; see `adoptLegacyNotionAtBoot`. */
  | { outcome: "failed" };

/**
 * Decide whether the pre-OAuth `NOTION_TOKEN`/`NOTION_DATABASE_ID` pair can
 * be attributed to a user at all, and adopt it if so.
 *
 * Deliberately independent of the flat-transcript migration (`tenantMigration.ts`):
 * that migration ships on a different plan/branch, runs at most once per
 * install, and its result is `null` on every boot after the first (and on
 * any install that started multi-tenant to begin with) — tying this
 * adoption to it would silently skip the exact operators it exists to help.
 * "Exactly one user" is the only condition under which a relay-wide legacy
 * setting maps onto a single destination row unambiguously; zero or several
 * users both leave it to `/app/exports` instead.
 *
 * Runs on every boot, which means it must never re-adopt a user who has
 * since disconnected: once resolved (adopted, or already connected on their
 * own), `hasResolvedLegacyNotion` stays true forever — even after
 * `DELETE /v1/exports/notion` removes the destination row itself — so a
 * user's deliberate Disconnect is never silently undone by a later boot's
 * adoption sweep. `"already-resolved"` (as opposed to `"adopted"`) is what
 * lets a caller tell "nothing happened this boot" from "a row was just
 * written" — which matters for both the disconnect guarantee above and for
 * an operator reading the boot log to decide whether it's safe to unset
 * `NOTION_TOKEN`.
 */
export function adoptLegacyNotionIfUnambiguous(
  identity: IdentityStore,
  destinations: ExportDestinationStore | undefined,
  legacy: { token: string; databaseId: string } | undefined,
): LegacyNotionAdoption {
  if (!legacy || !destinations) return { outcome: "not-configured" };
  const solo = identity.soleUserId();
  if (!solo) return { outcome: "ambiguous" };
  if (destinations.hasResolvedLegacyNotion(solo)) {
    return { outcome: "already-resolved", userId: solo };
  }
  // Same reasoning as above — a revoked row counts as already connected.
  const alreadyConnected = destinations.hasNotion(solo);
  if (!alreadyConnected) {
    adoptLegacyNotion(destinations, solo, legacy);
  }
  destinations.markLegacyNotionResolved(solo);
  return alreadyConnected
    ? { outcome: "already-resolved", userId: solo }
    : { outcome: "adopted", userId: solo };
}

/**
 * `adoptLegacyNotionIfUnambiguous`, wrapped so it cannot stop the relay
 * booting. Call this from the entrypoint; call the unwrapped function only
 * where a throw is something the caller can actually handle.
 *
 * The adoption reaches `getNotion` → `secretBox.open()`, which throws on a bad
 * auth tag, an unrecognized version prefix, or config that will not parse —
 * all reachable in production (`ENCRYPTION_KEY` rotated, a database restored
 * into another environment) and all of them *export* problems. Unwrapped, at
 * module scope, that throw exits the process before `startServer` is ever
 * reached, and Fly restarts it into the same throw: captioning — the actual
 * product — dies for an add-on's broken secret. Same rule, and the same
 * shape, as `finalizer.ts`'s guard around `opts.resolve`: log it and carry
 * on with exports simply not adopted.
 */
export function adoptLegacyNotionAtBoot(
  identity: IdentityStore,
  destinations: ExportDestinationStore | undefined,
  legacy: { token: string; databaseId: string } | undefined,
): LegacyNotionAdoption {
  try {
    return adoptLegacyNotionIfUnambiguous(identity, destinations, legacy);
  } catch (err) {
    console.error(
      "could not adopt the legacy Notion connection (the relay is otherwise unaffected):",
      err,
    );
    return { outcome: "failed" };
  }
}
