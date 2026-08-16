import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The per-user subdirectories under the transcripts root — each backfill
 * sweep runs once per user rather than once over the (now-empty, once
 * migration has run) flat root, since transcripts live under
 * `userDir(root, userId)` rather than directly in `root`.
 */
export function userDirs(root: string): { dir: string; userId: string }[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => statSync(join(root, entry)).isDirectory())
    // The directory name *is* the user id — `userDir` joins it verbatim — so
    // the sweeps below can attribute what they rebuild instead of handing
    // downstream an ownerless transcript.
    .map((entry) => ({ dir: join(root, entry), userId: entry }));
}
