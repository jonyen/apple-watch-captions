import { CaptionSession, OutboundMessage } from "./captionSession";
import { ProviderOptions } from "./providerOptions";
import { Transcript, TranscriptionProvider } from "./transcriptionProvider";
import { TranscriptStore } from "./transcriptStore";

export interface SeqEvent {
  seq: number;
  payload: OutboundMessage;
}

/**
 * Sessions are keyed by user as well as id.
 *
 * Session ids are chosen by clients and are not secret — the phone and the
 * watch agree on a fixed one. Keyed by id alone, anyone who guessed one would
 * read that conversation's captions.
 *
 * Length-prefixed rather than a plain `${userId}:${id}` join: `userId` is
 * server-generated today (so this collision is not reachable in practice),
 * but `id` is client-chosen, and a plain join would let
 * `("alice", "x:evil")` collide with `("alice:x", "evil")`. Prefixing
 * `userId` with its own length makes the split point unambiguous no matter
 * what characters either half contains.
 */
function sessionKey(userId: string, id: string): string {
  return `${userId.length}:${userId}:${id}`;
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
  /** Kept on the record so the sweeps, which iterate, can finalize correctly. */
  userId: string;
  /** The session id without its user prefix, for the same reason. */
  id: string;
}

export interface SessionStoreOptions {
  /** Factory for a fresh provider per session (Deepgram in prod, fake in tests). */
  createProvider: (opts?: ProviderOptions) => TranscriptionProvider;
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
  private readonly createProvider: (opts?: ProviderOptions) => TranscriptionProvider;
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
  feed(
    userId: string,
    id: string,
    pcm: Buffer,
    ephemeral = false,
    providerOpts?: ProviderOptions,
  ): void {
    const session = this.getOrCreate(userId, id, ephemeral, providerOpts);
    session.lastActivity = this.now();
    if (pcm.length > 0) session.caption.handleAudio(pcm);
  }

  /**
   * Route caption lines the client transcribed itself into a session, lazily
   * creating it caption-only on first use — the HTTP mirror of the `/stream`
   * caption frame. Each line goes through `CaptionSession.injectTranscript`,
   * so downstream (the event buffer a viewer drains, the transcript append
   * for finals, finalize on stop/reap) it is indistinguishable from a line a
   * wired provider emitted. A session created here opens no transcription
   * provider — there is no audio to transcribe (see `captionOnlyProvider`);
   * lines injected into an existing audio session share that session's
   * buffer and transcript instead.
   */
  injectCaptions(userId: string, id: string, lines: Transcript[]): void {
    const session = this.getOrCreate(userId, id, false, undefined, true);
    session.lastActivity = this.now();
    for (const line of lines) session.caption.injectTranscript(line);
  }

  /**
   * Events with `seq > since`, and the latest seq. Prunes events the client has
   * already acknowledged (`seq <= since`) so the buffer stays bounded.
   */
  drain(userId: string, id: string, since: number): { events: SeqEvent[]; seq: number } {
    const session = this.sessions.get(sessionKey(userId, id));
    if (!session) return { events: [], seq: since };
    session.events = session.events.filter((e) => e.seq > since);
    return { events: session.events.slice(), seq: session.seq };
  }

  has(userId: string, id: string): boolean {
    return this.sessions.has(sessionKey(userId, id));
  }

  /** Close and remove a session. */
  stop(userId: string, id: string): void {
    const key = sessionKey(userId, id);
    const session = this.sessions.get(key);
    if (!session) return;
    session.caption.close();
    this.sessions.delete(key);
    if (!session.ephemeral) this.transcripts?.finalize(session.userId, session.id);
  }

  /** Close sessions idle longer than the configured timeout. */
  reapIdle(): void {
    const cutoff = this.now() - this.idleTimeoutMs;
    for (const [key, session] of this.sessions) {
      if (session.lastActivity < cutoff) {
        session.caption.close();
        this.sessions.delete(key);
        if (!session.ephemeral) this.transcripts?.finalize(session.userId, session.id);
      }
    }
  }

  /** Close every session (server shutdown). */
  closeAll(): void {
    for (const [, session] of this.sessions) {
      session.caption.close();
      if (!session.ephemeral) this.transcripts?.finalize(session.userId, session.id);
    }
    this.sessions.clear();
  }

  /**
   * True when this session was created live-only. False for a session this
   * store has never seen, so a caller can trust it over its own query string.
   */
  isEphemeral(userId: string, id: string): boolean {
    return this.sessions.get(sessionKey(userId, id))?.ephemeral ?? false;
  }

  private getOrCreate(
    userId: string,
    id: string,
    ephemeral: boolean,
    providerOpts?: ProviderOptions,
    captionOnly = false,
  ): Session {
    const key = sessionKey(userId, id);
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const provider = captionOnly ? captionOnlyProvider() : this.createProvider(providerOpts);
    const session: Session = {
      caption: undefined as unknown as CaptionSession,
      events: [],
      seq: 0,
      lastActivity: this.now(),
      ephemeral,
      userId,
      id,
    };
    // CaptionSession registers provider handlers in its constructor; its outbound
    // messages are buffered here with sequence numbers.
    session.caption = new CaptionSession(provider, (payload: OutboundMessage) => {
      session.seq += 1;
      session.events.push({ seq: session.seq, payload });
      // Skipping `append` is what keeps a live session off disk entirely:
      // `append` is also what creates the file.
      if (payload.type === "caption" && payload.isFinal && !session.ephemeral) {
        this.transcripts?.append(userId, id, payload.text, payload.channel);
      }
    });
    this.sessions.set(key, session);
    return session;
  }
}

/**
 * Stands in for the transcription provider on a session whose captions the
 * client computes itself (`injectCaptions`): there is no audio to transcribe,
 * so nothing should be opened against Deepgram or the Apple sidecar only to
 * idle for the session's whole lifetime. Like `ephemeral`, being caption-only
 * is fixed at creation — audio that later arrives for such a session lands
 * here and is dropped rather than transcribed.
 */
function captionOnlyProvider(): TranscriptionProvider {
  return {
    onTranscript: () => {},
    onReady: () => {},
    onError: () => {},
    sendAudio: () => {},
    close: () => {},
  };
}
