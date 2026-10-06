/**
 * What a runtime must supply to carry HTTP over Iroh: connections that open and
 * accept {@link ExchangeStream}s, and a listener that accepts connections.
 *
 * The Node and browser packages adapt their Iroh bindings to these interfaces;
 * the client and server are written once against them.
 */

import type { ExchangeStream } from './wire.ts';

/** An established Iroh connection that negotiated the `iroh-http/1` ALPN. */
export interface Connection {
  /** The remote endpoint id, authenticated by the QUIC handshake. */
  remoteId(): string;
  /** Open a bidirectional stream for one outbound exchange. */
  openStream(): Promise<ExchangeStream>;
  /** Accept the next inbound exchange's stream. Rejects once the connection closes. */
  acceptStream(): Promise<ExchangeStream>;
  /** Close the connection. Closing an already-closed connection is a no-op. */
  close(): void;
}

/** An inbound connection whose handshake has not completed yet. */
export interface Incoming {
  /** Complete the handshake. */
  connect(): Promise<Connection>;
}

/** Accepts inbound connections for a server. */
export interface Listener {
  /**
   * Wait for the next inbound connection, or `undefined` once the listener
   * closes.
   *
   * May reject instead of resolving `undefined` when closed. The handshake runs
   * separately through {@link Incoming.connect}, so one slow peer does not hold
   * up the next.
   */
  accept(): Promise<Incoming | undefined>;
  /** Stop accepting connections. */
  close(): Promise<void>;
}
