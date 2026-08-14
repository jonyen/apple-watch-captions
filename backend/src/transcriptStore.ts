import {
  appendFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from "fs";
import { join, basename } from "path";
import { parseSummary } from "./summaryPrompt";

export interface TranscriptSegment {
  /** ISO timestamp the final caption arrived. */
  at: string;
  text: string;
  channel?: number;
}

export interface FinalizedTranscript {
  /** Base filename (without extension) identifying this transcript. */
  name: string;
  /** Who this transcript belongs to. */
  userId: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  segments: TranscriptSegment[];
  /** True when this transcript was reopened rather than started fresh. */
  resumed?: boolean;
}

export interface TranscriptStoreOptions {
  /** Directory transcripts are written under, one subdirectory per user. */
  root: string;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** Called when a session with at least one segment ends (summary hook). */
  onFinalize?: (t: FinalizedTranscript) => void;
}

interface ActiveTranscript {
  userId: string;
  sessionId: string;
  name: string;
  startedAt: string;
  segments: TranscriptSegment[];
  /** Set when the entry came from `reopen` rather than a first append. */
  resumed?: boolean;
}

/**
 * Where one user's transcripts live.
 *
 * `userId` reaches the filesystem as a path segment, so it is validated the
 * same way `isSafeName` guards transcript names one level down: no `..`, no
 * path separator, no null byte. User ids are server-generated UUIDs today —
 * this rejection path is not reachable in practice — but the check must not
 * depend on that remaining true.
 */
export function userDir(root: string, userId: string): string {
  if (!isSafeUserId(userId)) {
    throw new Error(`unsafe userId for transcript directory: ${JSON.stringify(userId)}`);
  }
  return join(root, userId);
}

function isSafeUserId(userId: string): boolean {
  return (
    userId.length > 0 &&
    !userId.includes("..") &&
    !userId.includes("/") &&
    !userId.includes("\\") &&
    !userId.includes("\0")
  );
}

/**
 * Persists final captions as one JSONL file per session under
 * `userDir(root, userId)`, appending line-by-line so a crash loses at most
 * the in-flight caption. Sessions with no final captions produce no file.
 */
export class TranscriptStore {
  private readonly root: string;
  private readonly now: () => number;
  private readonly onFinalize?: (t: FinalizedTranscript) => void;
  private active = new Map<string, ActiveTranscript>();

  constructor(opts: TranscriptStoreOptions) {
    this.root = opts.root;
    this.now = opts.now ?? (() => Date.now());
    this.onFinalize = opts.onFinalize;
  }

  /**
   * Sessions are keyed by user as well as id — the same length-prefixed
   * construction `sessionStore.ts` uses for the same reason: `userId` is
   * server-generated today, but `id` is client-chosen, and a plain
   * `${userId}:${id}` join would let `("alice", "x:evil")` collide with
   * `("alice:x", "evil")`.
   */
  private key(userId: string, sessionId: string): string {
    return `${userId.length}:${userId}:${sessionId}`;
  }

  /** Record a final caption for a session, creating its file on first use. */
  append(userId: string, sessionId: string, text: string, channel?: number): void {
    try {
      const dir = userDir(this.root, userId);
      const at = new Date(this.now()).toISOString();
      const key = this.key(userId, sessionId);
      let entry = this.active.get(key);
      if (!entry) {
        mkdirSync(dir, { recursive: true });
        entry = { userId, sessionId, name: transcriptName(at, sessionId), startedAt: at, segments: [] };
        this.active.set(key, entry);
      }
      const segment = { at, text, ...(channel !== undefined ? { channel } : {}) };
      entry.segments.push(segment);
      appendFileSync(join(dir, `${entry.name}.jsonl`), JSON.stringify(segment) + "\n");
    } catch (err) {
      console.error("transcript append failed:", err);
    }
  }

  /**
   * The transcript a live session is writing to, or undefined before its first
   * caption. The watch stores this so it can resume the session later.
   */
  activeName(userId: string, sessionId: string): string | undefined {
    return this.active.get(this.key(userId, sessionId))?.name;
  }

  /**
   * Bind a session to an existing transcript so its captions append there
   * instead of starting a new one. Unknown or unsafe names are ignored, and
   * the session falls back to a normal new transcript. Only ever looks inside
   * the calling user's own directory, so a resume can never bind to (or
   * disclose the existence of) another user's transcript.
   */
  reopen(userId: string, sessionId: string, name: string): void {
    if (!isSafeName(name)) return;
    let dir: string;
    try {
      dir = userDir(this.root, userId);
    } catch {
      return;
    }
    const file = join(dir, `${name}.jsonl`);
    if (!existsSync(file)) return;
    const segments = readSegments(file);
    this.active.set(this.key(userId, sessionId), {
      userId,
      sessionId,
      name,
      startedAt: segments[0]?.at ?? new Date(this.now()).toISOString(),
      segments,
      resumed: true,
    });
  }

  /** Session ended: hand the collected transcript to the finalize hook. */
  finalize(userId: string, sessionId: string): void {
    const key = this.key(userId, sessionId);
    const entry = this.active.get(key);
    if (!entry) return;
    this.active.delete(key);
    this.onFinalize?.({
      name: entry.name,
      userId,
      sessionId,
      startedAt: entry.startedAt,
      endedAt: new Date(this.now()).toISOString(),
      segments: entry.segments,
      ...(entry.resumed ? { resumed: true } : {}),
    });
  }

  /** Finalize every active session (server shutdown). */
  finalizeAll(): void {
    for (const entry of [...this.active.values()]) this.finalize(entry.userId, entry.sessionId);
  }
}

/** `2026-07-06T01-02-03Z_<session>`; filesystem-safe, sorts chronologically. */
function transcriptName(isoStart: string, sessionId: string): string {
  const ts = isoStart.replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  const safeId = sessionId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64) || "session";
  return `${ts}_${safeId}`;
}

export interface TranscriptSummary {
  name: string;
  startedAt: string;
  segmentCount: number;
  preview: string;
  hasSummary: boolean;
  /** Topic line from the summary, when one was generated. */
  title?: string;
}

/** List stored transcripts, newest first. */
export function listTranscripts(dir: string): TranscriptSummary[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse()
    .map((f) => {
      const name = basename(f, ".jsonl");
      const segments = readSegments(join(dir, f));
      const summaryFile = join(dir, `${name}.summary.md`);
      const hasSummary = existsSync(summaryFile);
      const title = hasSummary
        ? parseSummary(readFileSync(summaryFile, "utf8")).title
        : undefined;
      return {
        name,
        startedAt: segments[0]?.at ?? nameToIso(name),
        segmentCount: segments.length,
        preview: segments
          .map((s) => s.text)
          .join(" ")
          .slice(0, 120),
        hasSummary,
        ...(title ? { title } : {}),
      };
    });
}

export interface TranscriptDetail {
  name: string;
  segments: TranscriptSegment[];
  summary: string | null;
}

/** Read one stored transcript (and its summary, if generated). Null if absent. */
export function readTranscript(dir: string, name: string): TranscriptDetail | null {
  // The name is client-supplied: only accept names our writer produces.
  if (!isSafeName(name)) return null;
  const file = join(dir, `${name}.jsonl`);
  if (!existsSync(file)) return null;
  const summaryFile = join(dir, `${name}.summary.md`);
  return {
    name,
    segments: readSegments(file),
    summary: existsSync(summaryFile) ? readFileSync(summaryFile, "utf8") : null,
  };
}

/**
 * Forget a stored transcript: its captions, its summary, and its export
 * marker. False when the name is unsafe or no transcript is there. The Notion
 * page, if one was exported, is left alone — it is the archive, and the only
 * way back from a delete.
 */
export function deleteTranscript(dir: string, name: string): boolean {
  if (!isSafeName(name)) return false;
  const file = join(dir, `${name}.jsonl`);
  if (!existsSync(file)) return false;
  // Dropping the marker with the captions keeps the export backfill sweep from
  // seeing a half-deleted transcript.
  for (const suffix of [".jsonl", ".summary.md", ".notion.json"]) {
    rmSync(join(dir, `${name}${suffix}`), { force: true });
  }
  return true;
}

/** Write a generated summary next to its transcript. */
export function writeSummary(dir: string, name: string, summary: string): void {
  writeFileSync(join(dir, `${name}.summary.md`), summary);
}

export interface ExportMarker {
  /** Notion page the transcript was exported to. */
  pageId: string;
  url: string;
  exportedAt?: string;
  /**
   * How many segments have already been written to the page, so a resumed
   * session appends only what is new instead of duplicating the transcript.
   */
  exportedSegments?: number;
  /** The page's Summary toggle, replaced when the summary is regenerated. */
  summaryToggleId?: string;
}

/**
 * Records that a transcript reached Notion, so a retry sweep can tell which
 * transcripts still need exporting after a crash or an outage.
 */
export function writeExportMarker(
  dir: string,
  name: string,
  marker: Omit<ExportMarker, "exportedAt">,
): void {
  const body: ExportMarker = { ...marker, exportedAt: new Date().toISOString() };
  writeFileSync(join(dir, `${name}.notion.json`), JSON.stringify(body));
}

/**
 * Whether a transcript has reached Notion yet, and where it landed. Null when
 * there is no such transcript.
 *
 * A client that just ended a session polls this to find out when the export
 * finishes — the summary and the Notion write both happen after the session
 * closes, so the page does not exist yet when the last caption arrives. Kept
 * separate from `readTranscript` because polling that would ship every caption
 * back on each attempt.
 */
export function readExportStatus(dir: string, name: string): ExportStatus | null {
  if (!isSafeName(name)) return null;
  const file = join(dir, `${name}.jsonl`);
  if (!existsSync(file)) return null;

  const marker = readExportMarker(dir, name);
  if (!marker) {
    // Say whether waiting is even worth it. A transcript under the content
    // floor is never summarized or exported, so a client polling for its page
    // would otherwise wait out its whole window on something that will never
    // arrive. Read from the file rather than remembered, so a resumed session
    // that grows past the floor starts reporting eligible.
    const chars = readSegments(file).reduce((n, s) => n + s.text.length, 0);
    return { exported: false, eligible: chars >= MIN_TRANSCRIPT_CHARS };
  }

  const summaryFile = join(dir, `${name}.summary.md`);
  const title = existsSync(summaryFile)
    ? parseSummary(readFileSync(summaryFile, "utf8")).title
    : undefined;
  return {
    exported: true,
    eligible: true,
    url: marker.url,
    ...(marker.exportedAt ? { exportedAt: marker.exportedAt } : {}),
    ...(title ? { title } : {}),
  };
}

/** Below this many characters a transcript is not summarized or exported. */
export const MIN_TRANSCRIPT_CHARS = 40;

export interface ExportStatus {
  exported: boolean;
  /**
   * Whether this transcript can ever be exported. False for one below the
   * content floor — the signal that tells a waiting client to stop waiting.
   */
  eligible: boolean;
  /** The Notion page, once there is one. */
  url?: string;
  exportedAt?: string;
  /** Topic from the summary, so a caller can name the transcript. */
  title?: string;
}

/** The export marker for a transcript, or null if it has never been exported. */
export function readExportMarker(dir: string, name: string): ExportMarker | null {
  if (!isSafeName(name)) return null;
  const file = join(dir, `${name}.notion.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ExportMarker;
  } catch {
    // A truncated marker means the export never completed: treat as unexported.
    return null;
  }
}

/**
 * Rebuild the finalized shape from what's on disk, for the backfill sweeps that
 * work from stored transcripts rather than a live session.
 *
 * `userId` defaults to `""`: the backfill sweeps still walk a single flat
 * directory handed to them by their caller (Task 12 moves them onto
 * per-user directories) and have no user to attribute a rebuilt transcript
 * to. Callers that do know the owner should pass it.
 */
export function rebuildFinalized(
  name: string,
  segments: TranscriptSegment[],
  userId = "",
): FinalizedTranscript {
  return {
    name,
    userId,
    sessionId: name.slice(name.indexOf("_") + 1),
    startedAt: segments[0]?.at ?? "",
    endedAt: segments.at(-1)?.at ?? segments[0]?.at ?? "",
    segments,
  };
}

/** Only accept names our writer produces — these reach the filesystem. */
function isSafeName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

function readSegments(file: string): TranscriptSegment[] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TranscriptSegment);
  } catch (err) {
    console.error("transcript read failed:", err);
    return [];
  }
}

/** Recover a start time from the filename for legacy/partial files. */
function nameToIso(name: string): string {
  const ts = name.split("_")[0] ?? "";
  return ts.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})Z/, "$1:$2:$3Z");
}
