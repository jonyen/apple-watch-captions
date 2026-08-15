import { randomUUID, randomBytes, createHash, randomInt } from "crypto";
import { Db } from "./db";

export interface Principal {
  userId: string;
  deviceId: string;
}

export type DeviceKind = "watch" | "phone" | "mac";

export interface RegisteredDevice {
  deviceId: string;
  userId: string;
  /** The plaintext token. Returned once, at registration, and never stored. */
  token: string;
}

export interface IdentityStoreOptions {
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

export type ClaimResult =
  | { ok: true; fromUserId: string; toUserId: string }
  | { ok: false; reason: "unknown" | "expired" | "consumed" };

/** How long a pairing code stays claimable. */
export const PAIRING_CODE_TTL_MS = 10 * 60_000;

/**
 * How stale `last_seen_at` must be before `resolve` bothers rewriting it.
 * `/v1/audio` is polled roughly once per second per device while
 * captioning; `last_seen_at` is a liveness hint, not an audit log, so it
 * only needs to be accurate to within this window.
 */
const LAST_SEEN_THROTTLE_MS = 5 * 60_000;

/**
 * Users, devices, and the pairing codes that merge them.
 *
 * Devices authenticate with an opaque bearer token of which only a SHA-256 is
 * kept, so a database leak yields no working credentials. There is no password
 * and no sign-in: an app registers itself on first launch, which is what keeps
 * the setup burden off an audience that should not have to manage an account.
 */
export class IdentityStore {
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    opts: IdentityStoreOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Create a brand-new user owning a single fresh device. */
  registerDevice(kind: DeviceKind): RegisteredDevice {
    const userId = randomUUID();
    this.db
      .prepare("INSERT INTO users (id, created_at) VALUES (?, ?)")
      .run(userId, this.timestamp());
    return this.addDeviceToUser(userId, kind);
  }

  /** Attach another device to a user that already exists. */
  addDeviceToUser(userId: string, kind: DeviceKind): RegisteredDevice {
    const deviceId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    this.db
      .prepare(
        "INSERT INTO devices (id, user_id, kind, token_hash, created_at) VALUES (?,?,?,?,?)",
      )
      .run(deviceId, userId, kind, hashToken(token), this.timestamp());
    return { deviceId, userId, token };
  }

  /**
   * The principal a token belongs to, or null. Also stamps `last_seen_at`,
   * which is the only liveness signal available for a device that holds no
   * connection open — but only when the stored value is missing or older
   * than `LAST_SEEN_THROTTLE_MS`. Without the throttle, this would be a
   * SQLite write on every poll of `/v1/audio`, which happens roughly once a
   * second per device while captioning.
   */
  resolve(token: string | undefined): Principal | null {
    if (!token) return null;
    const row = this.db
      .prepare("SELECT id, user_id, last_seen_at FROM devices WHERE token_hash = ?")
      .get(hashToken(token)) as { id: string; user_id: string; last_seen_at: string | null } | undefined;
    if (!row) return null;
    const staleSince = this.now() - LAST_SEEN_THROTTLE_MS;
    const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : NaN;
    // An unparseable stored value (corrupt row, hand-edited data) must count
    // as stale rather than as fresh — otherwise a NaN comparison against
    // `staleSince` is always false and the row would never refresh again.
    if (Number.isNaN(lastSeen) || lastSeen <= staleSince) {
      this.db
        .prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?")
        .run(this.timestamp(), row.id);
    }
    return { userId: row.user_id, deviceId: row.id };
  }

  /**
   * A short code the user reads off the phone and types on the watch.
   *
   * Six digits rather than something longer because it is entered with a
   * Digital Crown, one digit at a time. The short TTL is what makes that
   * length safe: 10 minutes of a single-use code is not a guessable target.
   */
  issuePairingCode(userId: string): { code: string; expiresAt: string } {
    const expiresAt = new Date(this.now() + PAIRING_CODE_TTL_MS).toISOString();
    // Consumed and expired rows are garbage the instant they go dead, and
    // nothing else purges them, so the code space would otherwise only ever
    // shrink. Sweep dead rows first — compared against the injected clock, not
    // SQLite's own time functions, so test clock injection still governs
    // expiry — which also means every row left afterward is live, so the
    // plain lookup below only ever matches a real collision.
    // Two statements rather than one `... WHERE consumed_at IS NOT NULL OR
    // expires_at <= ?`: SQLite plans that OR as a full scan regardless of
    // indexing (see `db.ts`), and this runs on the single writer every other
    // request queues behind. Split, each half is an indexed search.
    this.db.prepare("DELETE FROM pairing_codes WHERE consumed_at IS NOT NULL").run();
    this.db.prepare("DELETE FROM pairing_codes WHERE expires_at <= ?").run(this.timestamp());
    // Retry on the astronomically unlikely collision with a still-live code
    // rather than letting the unique constraint surface as a 500.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const existing = this.db
        .prepare("SELECT code FROM pairing_codes WHERE code = ?")
        .get(code);
      if (existing) continue;
      this.db
        .prepare("INSERT INTO pairing_codes (code, user_id, expires_at) VALUES (?,?,?)")
        .run(code, userId, expiresAt);
      return { code, expiresAt };
    }
    throw new Error("could not allocate a pairing code");
  }

  /**
   * Move the claiming device onto the code's user and retire the user it came
   * from. The device's token is untouched — only what it resolves to changes,
   * so a watch mid-pairing never has to accept a new credential over a channel
   * it cannot report a failure on.
   *
   * Returns the two user ids so the caller can move the abandoned user's
   * transcripts. This store does no filesystem work.
   */
  claimPairingCode(code: string, claimant: Principal): ClaimResult {
    const row = this.db
      .prepare("SELECT user_id, expires_at, consumed_at FROM pairing_codes WHERE code = ?")
      .get(code) as
      | { user_id: string; expires_at: string; consumed_at: string | null }
      | undefined;

    if (!row) return { ok: false, reason: "unknown" };
    if (row.consumed_at) return { ok: false, reason: "consumed" };
    if (Date.parse(row.expires_at) <= this.now()) return { ok: false, reason: "expired" };

    const toUserId = row.user_id;
    const fromUserId = claimant.userId;
    const stamp = this.timestamp();

    if (fromUserId === toUserId) {
      this.db
        .prepare("UPDATE pairing_codes SET consumed_at = ? WHERE code = ?")
        .run(stamp, code);
      return { ok: true, fromUserId, toUserId };
    }

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE devices SET user_id = ? WHERE id = ?")
        .run(toUserId, claimant.deviceId);
      this.db
        .prepare("UPDATE pairing_codes SET consumed_at = ? WHERE code = ?")
        .run(stamp, code);
      // Any device still on the old user keeps it alive; only a user with
      // nothing left pointing at it is deleted.
      const remaining = this.db
        .prepare("SELECT count(*) AS n FROM devices WHERE user_id = ?")
        .get(fromUserId) as { n: number };
      if (remaining.n === 0) {
        this.db.prepare("DELETE FROM users WHERE id = ?").run(fromUserId);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    return { ok: true, fromUserId, toUserId };
  }

  /**
   * The id of the one user in this database, or null if there are zero or
   * more than one. Used only to attribute a relay-wide legacy setting (the
   * pre-OAuth `NOTION_TOKEN`) onto a user when doing so is unambiguous —
   * `LIMIT 2` is enough to tell "exactly one" from every other count without
   * scanning the whole table.
   */
  soleUserId(): string | null {
    const rows = this.db.prepare("SELECT id FROM users LIMIT 2").all() as { id: string }[];
    return rows.length === 1 ? rows[0]!.id : null;
  }

  protected timestamp(): string {
    return new Date(this.now()).toISOString();
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
