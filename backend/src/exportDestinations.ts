import { Db } from "./db";
import { seal, open } from "./secretBox";
import { IdentityStore } from "./identityStore";

export type DestinationKind = "notion" | "email";

export interface NotionConfigRow {
  databaseId: string;
  /** Shown in `/app` so a user can tell which workspace they connected. */
  workspaceName?: string;
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
    return {
      token: open(row.secret, this.key),
      config: JSON.parse(row.config) as NotionConfigRow,
    };
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
        connected: Boolean(notion.secret),
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
  if (store.getNotion(userId)) return;
  store.putNotion(userId, legacy.token, { databaseId: legacy.databaseId });
}

export type LegacyNotionAdoption =
  | { outcome: "adopted"; userId: string }
  | { outcome: "ambiguous" }
  | { outcome: "not-configured" };

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
 */
export function adoptLegacyNotionIfUnambiguous(
  identity: IdentityStore,
  destinations: ExportDestinationStore | undefined,
  legacy: { token: string; databaseId: string } | undefined,
): LegacyNotionAdoption {
  if (!legacy || !destinations) return { outcome: "not-configured" };
  const solo = identity.soleUserId();
  if (!solo) return { outcome: "ambiguous" };
  adoptLegacyNotion(destinations, solo, legacy);
  return { outcome: "adopted", userId: solo };
}
