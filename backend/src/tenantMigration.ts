import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "fs";
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
 * Suffixes a transcript ever writes, per `transcriptStore.ts`'s own delete
 * path (`deleteTranscript`'s `[".jsonl", ".summary.md", ".notion.json"]`).
 *
 * This is an allowlist, not a denylist, on purpose: the earlier version of
 * this migration excluded only `settings.json` by name and swept up
 * everything else loose at the root — which silently included
 * `identity.db` itself. `index.ts` opens the identity database (creating
 * the file) before running this migration, so an exclusion list has to name
 * every non-transcript file that can legitimately sit at the root, and that
 * list grows the moment SQLite's on-disk shape changes (e.g. `-journal` file
 * mid-transaction, or `-wal`/`-shm` sidecars if journal mode ever changes
 * from the default). An allowlist of what a transcript actually looks like
 * needs no such list: `identity.db` and every one of its possible sidecars
 * simply never match a transcript suffix, so they can never be swept,
 * regardless of what shape SQLite's on-disk files take.
 */
const TRANSCRIPT_SUFFIXES = [".jsonl", ".summary.md", ".notion.json"];

/**
 * Move transcripts written before the relay was multi-tenant under a user of
 * their own.
 *
 * Runs at boot and no-ops once the flat root is empty of loose transcript
 * files (only per-user directories, and non-transcript files like
 * `identity.db`, remain), so it is safe on every start. The token is
 * returned rather than logged here, leaving the decision about what reaches
 * the logs to the caller.
 *
 * A brand-new user is only minted after confirming there is something to
 * adopt — `userDir` is resolved for the new user, and any per-file move
 * failure is logged and skipped rather than thrown, so a single bad entry
 * cannot abort the sweep. A file left behind this way is not retried into
 * the same adopted user on the next boot: from that boot's perspective it is
 * just another loose transcript at the root, so it gets swept into a
 * *second*, freshly minted user rather than joining the first. Rare (the
 * per-file operation here is a same-volume `renameSync`, which does not fail
 * under ordinary conditions) but worth knowing before relying on this being
 * a single clean adoption.
 */
export function migrateFlatTranscripts(
  root: string,
  identity: IdentityStore,
): MigrationResult | null {
  if (!existsSync(root)) return null;

  const loose = readdirSync(root).filter((entry) =>
    TRANSCRIPT_SUFFIXES.some((suffix) => entry.endsWith(suffix)),
  );
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
    // Unlike `moveTranscripts` in `server.ts`, this does not check for a
    // same-named file already at the destination before renaming over it.
    // That check matters there because the destination directory can
    // already hold files (an existing user being merged into by pairing);
    // here the destination is always a directory for a user id that was
    // just minted by `identity.registerDevice` above, so it is guaranteed
    // empty — there is nothing a same-named entry could collide with.
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
