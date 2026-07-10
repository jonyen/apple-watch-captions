import WebSocket from "ws";

/** Subset of a WebSocket the streaming providers depend on (keeps them testable). */
export interface StreamingSocketLike {
  send(data: Buffer | string): void;
  close(): void;
  on(event: string, cb: (...args: any[]) => void): unknown;
}

export type StreamingSocketFactory = (
  url: string,
  headers: Record<string, string>,
) => StreamingSocketLike;

export const defaultSocketFactory: StreamingSocketFactory = (url, headers) =>
  new WebSocket(url, { headers }) as unknown as StreamingSocketLike;
