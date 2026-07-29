import { CaptionSession, OutboundMessage } from "./captionSession";
import { TranscriptionProvider } from "./transcriptionProvider";
import { TranscriptStore } from "./transcriptStore";

export interface SeqEvent {
  seq: number;
  payload: OutboundMessage;
}

interface Session {
  caption: CaptionSession;
  events: SeqEvent[];
  seq: number;
  lastActivity: number;
  /**
   * Live-only: the relay keeps no transcript for this session. Fixed when the
   * session is created, so no later request can change what a conversation
   * already in progress does with what it hears.
   */
  ephemeral: boolean;
}

export interface SessionStoreOptions {
  /** Factory for a fresh provider per session (Deepgram in prod, fake in tests). */
  createProvider: () => TranscriptionProvider;
  /** Close sessions with no activity for this long. Defaults to 15s. */
  /**
   * How long a session may go without audio before it is finalized. Long
   * enough that lowering your wrist mid-conversation does not end the
   * session — the watch resumes into the same transcript when it comes back.
   */
  idleTimeoutMs?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** Optional persistence for final captions. */
  transcripts?: TranscriptStore;
}

/**
 * Per-session state for the HTTP transport. Each session wraps a CaptionSession
 * whose outbound messages are buffered with monotonic sequence numbers, so a
 * client can poll for events newer than the last sequence it has seen.
 */
export class SessionStore {
  private sessions = new Map<string, Session>();
  private readonly createProvider: () => TranscriptionProvider;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private readonly transcripts?: TranscriptStore;

  constructor(opts: SessionStoreOptions) {
    this.createProvider = opts.createProvider;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.transcripts = opts.transcripts;
  }

  /**
   * Feed audio (may be empty) for a session, lazily creating it on first use.
   * `ephemeral` is honoured only on creation — see `Session.ephemeral`.
   */
  feed(id: string, pcm: Buffer, ephemeral = false): void {
    const session = this.getOrCreate(id, ephemeral);
    session.lastActivity = this.now();
    if (pcm.length > 0) session.caption.handleAudio(pcm);
  }

  /**
   * Events with `seq > since`, and the latest seq. Prunes events the client has
   * already acknowledged (`seq <= since`) so the buffer stays bounded.
   */
  drain(id: string, since: number): { events: SeqEvent[]; seq: number } {
    const session = this.sessions.get(id);
    if (!session) return { events: [], seq: since };
    session.events = session.events.filter((e) => e.seq > since);
    return { events: session.events.slice(), seq: session.seq };
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  /** Close and remove a session. */
  stop(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.caption.close();
    this.sessions.delete(id);
    if (!session.ephemeral) this.transcripts?.finalize(id);
  }

  /** Close sessions idle longer than the configured timeout. */
  reapIdle(): void {
    const cutoff = this.now() - this.idleTimeoutMs;
    for (const [id, session] of this.sessions) {
      if (session.lastActivity < cutoff) {
        session.caption.close();
        this.sessions.delete(id);
        if (!session.ephemeral) this.transcripts?.finalize(id);
      }
    }
  }

  /** Close every session (server shutdown). */
  closeAll(): void {
    for (const [id, session] of this.sessions) {
      session.caption.close();
      if (!session.ephemeral) this.transcripts?.finalize(id);
    }
    this.sessions.clear();
  }

  /**
   * True when this session was created live-only. False for a session this
   * store has never seen, so a caller can trust it over its own query string.
   */
  isEphemeral(id: string): boolean {
    return this.sessions.get(id)?.ephemeral ?? false;
  }

  private getOrCreate(id: string, ephemeral: boolean): Session {
    const existing = this.sessions.get(id);
    if (existing) return existing;

    const provider = this.createProvider();
    const session: Session = {
      caption: undefined as unknown as CaptionSession,
      events: [],
      seq: 0,
      lastActivity: this.now(),
      ephemeral,
    };
    // CaptionSession registers provider handlers in its constructor; its outbound
    // messages are buffered here with sequence numbers.
    session.caption = new CaptionSession(provider, (payload: OutboundMessage) => {
      session.seq += 1;
      session.events.push({ seq: session.seq, payload });
      // Skipping `append` is what keeps a live session off disk entirely:
      // `append` is also what creates the file.
      if (payload.type === "caption" && payload.isFinal && !session.ephemeral) {
        this.transcripts?.append(id, payload.text, payload.channel);
      }
    });
    this.sessions.set(id, session);
    return session;
  }
}
