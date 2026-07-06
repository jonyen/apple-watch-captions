import {
  appendFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  existsSync,
} from "fs";
import { join, basename } from "path";

export interface TranscriptSegment {
  /** ISO timestamp the final caption arrived. */
  at: string;
  text: string;
}

export interface FinalizedTranscript {
  /** Base filename (without extension) identifying this transcript. */
  name: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  segments: TranscriptSegment[];
}

export interface TranscriptStoreOptions {
  dir: string;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** Called when a session with at least one segment ends (summary hook). */
  onFinalize?: (t: FinalizedTranscript) => void;
}

interface ActiveTranscript {
  name: string;
  startedAt: string;
  segments: TranscriptSegment[];
}

/**
 * Persists final captions as one JSONL file per session under `dir`,
 * appending line-by-line so a crash loses at most the in-flight caption.
 * Sessions with no final captions produce no file.
 */
export class TranscriptStore {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly onFinalize?: (t: FinalizedTranscript) => void;
  private active = new Map<string, ActiveTranscript>();

  constructor(opts: TranscriptStoreOptions) {
    this.dir = opts.dir;
    this.now = opts.now ?? (() => Date.now());
    this.onFinalize = opts.onFinalize;
  }

  /** Record a final caption for a session, creating its file on first use. */
  append(sessionId: string, text: string): void {
    try {
      const at = new Date(this.now()).toISOString();
      let entry = this.active.get(sessionId);
      if (!entry) {
        mkdirSync(this.dir, { recursive: true });
        entry = { name: transcriptName(at, sessionId), startedAt: at, segments: [] };
        this.active.set(sessionId, entry);
      }
      entry.segments.push({ at, text });
      appendFileSync(join(this.dir, `${entry.name}.jsonl`), JSON.stringify({ at, text }) + "\n");
    } catch (err) {
      console.error("transcript append failed:", err);
    }
  }

  /** Session ended: hand the collected transcript to the finalize hook. */
  finalize(sessionId: string): void {
    const entry = this.active.get(sessionId);
    if (!entry) return;
    this.active.delete(sessionId);
    this.onFinalize?.({
      name: entry.name,
      sessionId,
      startedAt: entry.startedAt,
      endedAt: new Date(this.now()).toISOString(),
      segments: entry.segments,
    });
  }

  /** Finalize every active session (server shutdown). */
  finalizeAll(): void {
    for (const id of [...this.active.keys()]) this.finalize(id);
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
      return {
        name,
        startedAt: segments[0]?.at ?? nameToIso(name),
        segmentCount: segments.length,
        preview: segments
          .map((s) => s.text)
          .join(" ")
          .slice(0, 120),
        hasSummary: existsSync(join(dir, `${name}.summary.md`)),
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
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return null;
  const file = join(dir, `${name}.jsonl`);
  if (!existsSync(file)) return null;
  const summaryFile = join(dir, `${name}.summary.md`);
  return {
    name,
    segments: readSegments(file),
    summary: existsSync(summaryFile) ? readFileSync(summaryFile, "utf8") : null,
  };
}

/** Write a generated summary next to its transcript. */
export function writeSummary(dir: string, name: string, summary: string): void {
  writeFileSync(join(dir, `${name}.summary.md`), summary);
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
