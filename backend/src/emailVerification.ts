import { randomBytes } from "crypto";
import { Db } from "./db";

/** How long a confirmation link stays valid. */
export const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60_000;

/**
 * Pending email confirmations.
 *
 * This token is what proves someone controls the address a transcript will
 * be mailed to. An unverified address makes the relay a remailer; a verified
 * but wrong address is a privacy incident the user cannot undo.
 *
 * A user has at most one outstanding verification: minting a new one drops
 * any previous, so a mistyped address cannot be confirmed later by an old
 * link sitting in someone's inbox.
 */
export class EmailVerificationStore {
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  mint(userId: string, address: string): string {
    // Dead rows are garbage the instant they go dead, and nothing else purges
    // them, so the state space would otherwise only ever grow. Sweep first,
    // against the injected clock (not SQLite's own time functions) so test
    // clock injection still governs expiry.
    const stamp = new Date(this.now()).toISOString();
    this.db.prepare("DELETE FROM email_verifications WHERE expires_at <= ?").run(stamp);
    // Only one verification may be outstanding per user: minting a new one
    // drops any previous, so a mistyped address cannot be confirmed later by
    // an old link sitting in someone's inbox.
    this.db.prepare("DELETE FROM email_verifications WHERE user_id = ?").run(userId);
    const token = randomBytes(32).toString("base64url");
    this.db
      .prepare(
        "INSERT INTO email_verifications (token, user_id, address, expires_at) VALUES (?,?,?,?)",
      )
      .run(token, userId, address, new Date(this.now() + EMAIL_TOKEN_TTL_MS).toISOString());
    return token;
  }

  /**
   * Drop any outstanding verification for this user, e.g. because the
   * destination it would confirm was just deleted — otherwise a still-valid
   * link, followed afterward, recreates the destination already verified.
   */
  deleteForUser(userId: string): void {
    this.db.prepare("DELETE FROM email_verifications WHERE user_id = ?").run(userId);
  }

  /**
   * The user and address this token was minted for, or null. Consumes the
   * token either way — deleted before the expiry check runs, so an expired
   * token cannot be retried by calling consume again.
   */
  consume(token: string): { userId: string; address: string } | null {
    const row = this.db
      .prepare("SELECT user_id, address, expires_at FROM email_verifications WHERE token = ?")
      .get(token) as { user_id: string; address: string; expires_at: string } | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM email_verifications WHERE token = ?").run(token);
    if (Date.parse(row.expires_at) <= this.now()) return null;
    return { userId: row.user_id, address: row.address };
  }
}
