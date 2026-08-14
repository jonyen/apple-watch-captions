import { randomUUID, randomBytes, createHash } from "crypto";
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
   * connection open.
   */
  resolve(token: string | undefined): Principal | null {
    if (!token) return null;
    const row = this.db
      .prepare("SELECT id, user_id FROM devices WHERE token_hash = ?")
      .get(hashToken(token)) as { id: string; user_id: string } | undefined;
    if (!row) return null;
    this.db
      .prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?")
      .run(this.timestamp(), row.id);
    return { userId: row.user_id, deviceId: row.id };
  }

  protected timestamp(): string {
    return new Date(this.now()).toISOString();
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
