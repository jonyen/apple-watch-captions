import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "fs";
import { join } from "path";
import { IdentityStore } from "./identityStore";
import { userDir } from "./transcriptStore";

export interface MigrationResult {
  userId: string;
  /** Printed once at boot so the operator can adopt their existing installs. */
  token: string;
  moved: number;
}

/**
 * Move transcripts written before the relay was multi-tenant under a user of
 * their own.
 *
 * Runs at boot and no-ops once the flat root is empty of loose files (only
 * per-user directories remain), so it is safe on every start. The token is
 * returned rather than logged here, leaving the decision about what reaches
 * the logs to the caller.
 *
 * A brand-new user is only minted after confirming there is something to
 * adopt — `userDir` is resolved for the new user, and any per-file move
 * failure is logged and skipped rather than thrown, so a single bad entry
 * cannot abort the sweep or leave the identity store pointing at a user with
 * zero files actually moved.
 */
export function migrateFlatTranscripts(
  root: string,
  identity: IdentityStore,
): MigrationResult | null {
  if (!existsSync(root)) return null;

  const loose = readdirSync(root).filter((entry) => {
    if (entry === "settings.json") return false;
    return statSync(join(root, entry)).isFile();
  });
  const settingsFile = join(root, "settings.json");
  const hasSettings = existsSync(settingsFile);

  if (loose.length === 0) {
    // Settings alone are still worth clearing, but they do not justify
    // minting a user nobody owns.
    if (hasSettings) rmSync(settingsFile, { force: true });
    return null;
  }

  const adopted = identity.registerDevice("mac");
  const dir = userDir(root, adopted.userId);
  mkdirSync(dir, { recursive: true });

  let moved = 0;
  for (const entry of loose) {
    try {
      renameSync(join(root, entry), join(dir, entry));
      moved += 1;
    } catch (err) {
      console.error(`could not migrate ${entry}:`, err);
    }
  }

  // Settings now live on the phone and are delivered over WatchConnectivity.
  if (hasSettings) rmSync(settingsFile, { force: true });

  return { userId: adopted.userId, token: adopted.token, moved };
}
