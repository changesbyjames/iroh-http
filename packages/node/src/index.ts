/**
 * HTTP over Iroh for the native Iroh 1.0 Node.js bindings.
 *
 * @module
 */

import type {
  BiStream,
  Endpoint,
  EndpointAddr,
  Incoming as NativeIncoming,
  Connection as NativeConnection
} from '@number0/iroh';
import { EndpointTicket } from '@number0/iroh';
import {
  ALPN,
  ERROR_CODE,
  IrohHttpClient,
  IrohHttpServer,
  type Connection,
  type ExchangeStream,
  type Handler,
  type Listener
} from '@strangecyan/iroh-http-core';

export * from '@strangecyan/iroh-http-core';

/**
 * The most bytes handed to one native write. An abandoned native write runs to
 * completion, so this bounds what can still reach the peer after a reset.
 */
const WRITE_CHUNK_SIZE = 64 * 1024;

/**
 * Race a native call against cancellation of its direction.
 *
 * The native call cannot be interrupted, only abandoned, so its eventual
 * failure is observed here rather than surfacing as an unhandled rejection.
 */
async function cancellable<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const pending = call();
  pending.catch(() => undefined);
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    // Long-lived streams make many calls, so each listener is removed again.
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * An {@link ExchangeStream} over one bidirectional stream of a native Iroh
 * connection. The bindings marshal bytes as number arrays, so every read and
 * write converts.
 *
 * The bindings hold a lock per direction for the whole of a read or write, and
 * `stop` and `reset` take the same lock, so they would wait behind a read
 * stalled on a silent peer, or a write blocked on flow control. As in the
 * WebAssembly crate, cancellation is signalled first so that pending and later
 * calls reject at once; the native `stop` and `reset` are issued without being
 * awaited, and reach the peer once the abandoned call returns or the
 * connection closes.
 *
 * An abandoned call still runs to completion. Writes are therefore split into
 * native calls of at most {@link WRITE_CHUNK_SIZE} bytes, and cancellation is
 * checked between them, so after `reset` at most one chunk beyond what was
 * already sent can reach the peer before the reset does. No such bound exists
 * for reads: the native `stop` waits behind a stalled read until more bytes
 * arrive or the connection closes, and only then reaches the peer.
 */
class NodeExchangeStream implements ExchangeStream {
  private readonly sendCancel = new AbortController();
  private readonly recvCancel = new AbortController();

  constructor(private readonly streams: BiStream) {}

  async write(bytes: Uint8Array): Promise<void> {
    // An empty write makes no native call, but must still reject once reset.
    this.sendCancel.signal.throwIfAborted();
    for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK_SIZE) {
      const chunk = bytes.subarray(offset, offset + WRITE_CHUNK_SIZE);
      await cancellable(this.sendCancel.signal, () => this.streams.send.writeAll(Array.from(chunk)));
    }
  }

  async readExact(size: number): Promise<Uint8Array> {
    if (size === 0) return new Uint8Array(0);
    return Uint8Array.from(await cancellable(this.recvCancel.signal, () => this.streams.recv.readExact(size)));
  }

  async finish(): Promise<void> {
    await cancellable(this.sendCancel.signal, () => this.streams.send.finish());
  }

  async stop(): Promise<void> {
    if (this.recvCancel.signal.aborted) return;
    this.recvCancel.abort(new Error('Stream read was stopped'));
    // Failure means the stream is already gone, which is what stopping wants.
    this.streams.recv.stop(ERROR_CODE).catch(() => undefined);
  }

  async reset(): Promise<void> {
    await this.stop();
    if (this.sendCancel.signal.aborted) return;
    this.sendCancel.abort(new Error('Stream was reset'));
    this.streams.send.reset(ERROR_CODE).catch(() => undefined);
  }
}

function adaptConnection(connection: NativeConnection): Connection {
  return {
    remoteId: () => connection.remoteId().toString(),
    openStream: async () => new NodeExchangeStream(await connection.openBi()),
    acceptStream: async () => new NodeExchangeStream(await connection.acceptBi()),
    close: () => {
      try {
        connection.close(ERROR_CODE, []);
      } catch {
        // The connection is already closed.
      }
    }
  };
}

/**
 * How an inbound connection is let in.
 *
 * - `direct`: accepted with holepunching, so the peer learns this endpoint's
 *   direct addresses and the connection may leave the relay.
 * - `relayed`: accepted without NAT traversal, so this endpoint never
 *   advertises its addresses or probes the peer's, and the connection stays on
 *   the path it arrived on.
 * - `refuse`: refused before the handshake.
 */
export type Admission = 'direct' | 'relayed' | 'refuse';

/** Where an inbound connection came from, known before its handshake. */
export interface IncomingPeer {
  /** How the connection arrived. */
  readonly kind: 'ip' | 'relay' | 'custom';
  /**
   * The remote endpoint id, for connections through a relay: the relay
   * authenticated it. Over IP it is unknown until the handshake.
   */
  readonly endpointId?: string;
  /** The relay URL, for connections through a relay. */
  readonly relayUrl?: string;
  /** The remote `ip:port`, for direct connections. */
  readonly address?: string;
}

/** Options for {@link serve}. */
export interface ServeOptions {
  /**
   * Decide how each inbound connection is let in, before its handshake. It runs
   * per connection, so a slow decision does not hold up the next. Defaults to
   * admitting every connection `direct`.
   */
  readonly admit?: (peer: IncomingPeer) => Admission | Promise<Admission>;
}

/**
 * Where `incoming` came from. The bindings report the kind as a string, so any
 * kind other than `ip` or `relay` is treated as a custom transport.
 */
async function incomingPeer(incoming: NativeIncoming): Promise<IncomingPeer> {
  const remote = await incoming.remoteAddr();
  const kind = remote.kind === 'ip' || remote.kind === 'relay' ? remote.kind : 'custom';
  if (kind === 'relay') return { kind, endpointId: remote.endpointId, relayUrl: remote.addr };
  if (kind === 'ip') return { kind, address: remote.addr };
  return { kind };
}

/** Admit `incoming` as `admit` decides, and complete its handshake. */
async function admitIncoming(incoming: NativeIncoming, admit: NonNullable<ServeOptions['admit']>): Promise<Connection> {
  const peer = await incomingPeer(incoming);
  // A decision that fails refuses the connection, rather than leaving it waiting, and still rejects the handshake.
  const decided = Promise.resolve(peer).then(admit);
  decided.catch(() => incoming.refuse()).catch(() => undefined);
  const admission = await decided;
  if (admission === 'refuse') {
    await incoming.refuse();
    throw new Error('The connection was refused');
  }
  const accepting = admission === 'relayed' ? await incoming.acceptWithoutNatTraversal() : await incoming.accept();
  const connection = adaptConnection(await accepting.connect());
  // The relay authenticated the id the decision was made on, and the handshake the id the connection
  // is from: they match unless something is badly wrong, and then it must not be served.
  if (peer.endpointId !== undefined && connection.remoteId() !== peer.endpointId) {
    connection.close();
    throw new Error('The handshake authenticated a different endpoint than the relay');
  }
  return connection;
}

const admitDirect = (): Admission => 'direct';

function adaptListener(endpoint: Endpoint, options: ServeOptions): Listener {
  const admit = options.admit ?? admitDirect;
  return {
    accept: async () => {
      const incoming = await endpoint.acceptNext();
      if (!incoming) return undefined;
      return { connect: () => admitIncoming(incoming, admit) };
    },
    close: () => endpoint.close()
  };
}

/** Connect to a remote endpoint address and return an HTTP client. */
export async function connect(endpoint: Endpoint, address: EndpointAddr): Promise<IrohHttpClient> {
  return clientFor(await endpoint.connect(address, ALPN));
}

/**
 * An HTTP client over a native connection that negotiated the `iroh-http/1`
 * ALPN, for callers that also want the connection itself, such as its paths.
 */
export function clientFor(connection: NativeConnection): IrohHttpClient {
  return new IrohHttpClient(adaptConnection(connection));
}

/**
 * Serve `handler` on `endpoint`, taking ownership of its accept loop.
 *
 * `options.admit` decides how each inbound connection is let in: with
 * holepunching, relayed without revealing this endpoint's addresses, or not at
 * all. Disposing the server stops accepting, closes active connections, and
 * closes the endpoint.
 */
export function serve(endpoint: Endpoint, handler: Handler, options: ServeOptions = {}): IrohHttpServer {
  return new IrohHttpServer(adaptListener(endpoint, options), handler);
}

/** Parse an endpoint ticket into a dialable address. */
export function getAddressFromString(ticket: string): EndpointAddr {
  return EndpointTicket.fromString(ticket).endpointAddr();
}

/** Options for {@link getTicket}. */
export interface TicketOptions {
  /**
   * Wait for a home relay first, so that the ticket is dialable from peers that
   * cannot reach a direct address. Defaults to `true`; pass `false` when relays
   * are disabled, otherwise this never resolves.
   */
  readonly online?: boolean;
}

/** A dialable ticket for `endpoint`. */
export async function getTicket(endpoint: Endpoint, options: TicketOptions = {}): Promise<string> {
  if (options.online !== false) await endpoint.online();
  return EndpointTicket.fromAddr(endpoint.addr()).toString();
}
