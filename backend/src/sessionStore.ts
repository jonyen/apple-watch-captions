import { CaptionSession, OutboundMessage } from "./captionSession";
import { ProviderOptions } from "./providerOptions";
import { Transcript, TranscriptionProvider } from "./transcriptionProvider";
import { TranscriptStore } from "./transcriptStore";
import { TrainingCapture } from "./trainingCapture";

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
  /** Factory for a fresh provider per session (the configured backend in prod, fake in tests). */
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
  /**
   * Optional; when set, every non-ephemeral, audio-bearing session's raw PCM
   * is saved for later fine-tuning. Caption-only sessions (`injectCaptions`)
   * never see this — there is no audio — and neither do ephemeral ones: they
   * are the relay's "off the record" mode, and saving their audio to disk
   * would defeat the point.
   */
  trainingCapture?: TrainingCapture;
  /** The provider name recorded in a captured session's meta.json when a request doesn't pick one explicitly. */
  defaultProviderName?: string;
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
  private readonly trainingCapture?: TrainingCapture;
  private readonly defaultProviderName: string;

  constructor(opts: SessionStoreOptions) {
    this.createProvider = opts.createProvider;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.transcripts = opts.transcripts;
    this.trainingCapture = opts.trainingCapture;
    this.defaultProviderName = opts.defaultProviderName ?? "apple";
  }

  /**
   * Tears down everything a session's end can trigger, in the order that
   * makes the finalize race impossible: the caller has already awaited
   * `session.caption.close()` — the provider's own bounded graceful
   * shutdown — so every transcript the provider was ever going to emit has
   * already landed via the `send` callback (and thus `transcripts.append`)
   * before any of this runs.
   *
   * Ephemeral sessions skip the live transcript/training-capture path
   * entirely (nothing was ever appended for them to finalize) but archived
   * audio — `feedArchive`, an orthogonal capability wired regardless of a
   * session's live-transcript mode — still gets a chance to finalize; it is
   * a no-op when nothing was ever archived for this session.
   */
  private async finalizeSession(userId: string, id: string, session: Session): Promise<void> {
    if (!session.ephemeral) {
      // Finalizing a transcript only fires the training-capture write when
      // the session had at least one final line (`TranscriptStore.finalize`
      // skips its `onFinalize` hook otherwise) — so a session with captured
      // audio but zero finals would otherwise leave its staged audio behind
      // forever. `discardIfPending` runs right after unconditionally to
      // clean that up; it is a no-op once the hook above already claimed
      // the session.
      this.transcripts?.finalize(userId, id);
      this.trainingCapture?.discardIfPending(userId, id);
    }
    await this.trainingCapture?.archiveFinalize(userId, id);
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
   * Feed raw PCM into a session's audio-archive — the on-device-kept-session
   * path (`POST /v1/audio-archive`), pure storage with no transcription
   * provider ever opened for it. Orthogonal to `feed`/`injectCaptions`:
   * whatever mode the session is already in (or, lazily creating it here,
   * the caption-only no-op-provider mode — this call alone must never open
   * a real transcription provider), the bytes go straight to
   * `TrainingCapture.archiveAudio`, never through `CaptionSession` or any
   * provider, and never into the visible transcript history. A no-op when
   * training capture isn't configured, or once a session is known to be
   * ephemeral (the relay's off-the-record mode — capturing its audio to
   * disk, archived or not, would defeat the point).
   */
  feedArchive(userId: string, id: string, pcm: Buffer): void {
    const session = this.getOrCreate(userId, id, false, undefined, true);
    session.lastActivity = this.now();
    if (pcm.length > 0 && !session.ephemeral) {
      this.trainingCapture?.archiveAudio(userId, id, pcm);
    }
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

  /**
   * Close and remove a session. Awaits the provider's own bounded graceful
   * shutdown before finalizing anything — see `finalizeSession` — so the
   * true final transcript (the Apple provider's finish/done handshake in
   * particular) is never orphaned into a fresh, never-finalized file the
   * way it was before this awaited.
   */
  async stop(userId: string, id: string): Promise<void> {
    const key = sessionKey(userId, id);
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    await session.caption.close();
    await this.finalizeSession(session.userId, session.id, session);
  }

  /** Close sessions idle longer than the configured timeout. */
  async reapIdle(): Promise<void> {
    const cutoff = this.now() - this.idleTimeoutMs;
    const toReap: Session[] = [];
    for (const [key, session] of this.sessions) {
      if (session.lastActivity < cutoff) {
        toReap.push(session);
        this.sessions.delete(key);
      }
    }
    // Concurrent, not sequential: each session's wait is independently
    // bounded by its own provider, and reaping a batch of idle sessions must
    // not take the sum of their bounds.
    await Promise.all(
      toReap.map(async (session) => {
        await session.caption.close();
        await this.finalizeSession(session.userId, session.id, session);
      }),
    );
  }

  /** Close every session (server shutdown). */
  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      sessions.map(async (session) => {
        await session.caption.close();
        await this.finalizeSession(session.userId, session.id, session);
      }),
    );
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
    // Caption-only and ephemeral sessions never capture audio for training:
    // the former has none (there is nothing to save), and the latter is the
    // relay's "off the record" mode, where saving raw audio to disk would
    // defeat the point.
    const onAudio =
      this.trainingCapture && !captionOnly && !ephemeral
        ? (chunk: Buffer) => {
            const provider = providerOpts?.provider ?? this.defaultProviderName;
            this.trainingCapture!.audio(userId, id, provider, chunk);
          }
        : undefined;
    // CaptionSession registers provider handlers in its constructor; its outbound
    // messages are buffered here with sequence numbers.
    session.caption = new CaptionSession(
      provider,
      (payload: OutboundMessage) => {
        session.seq += 1;
        session.events.push({ seq: session.seq, payload });
        // Skipping `append` is what keeps a live session off disk entirely:
        // `append` is also what creates the file.
        if (payload.type === "caption" && payload.isFinal && !session.ephemeral) {
          this.transcripts?.append(userId, id, payload.text, payload.channel);
        }
      },
      onAudio,
    );
    this.sessions.set(key, session);
    return session;
  }
}

/**
 * Stands in for the transcription provider on a session whose captions the
 * client computes itself (`injectCaptions`): there is no audio to transcribe,
 * so nothing should be opened against the Apple sidecar (or any backend) only to
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
    close: async () => {},
  };
}
