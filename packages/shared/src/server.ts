import type { Connection, Incoming, Listener } from './transport.ts';
import { receiveRequest, writeResponse, type ExchangeStream, type Handler, type PeerInfo } from './wire.ts';

/** Run the handler, turning a thrown error into a `500`. */
async function respond(handler: Handler, request: Request, peer: PeerInfo): Promise<Response> {
  try {
    return await handler(request, peer);
  } catch {
    // Details stay local rather than leaking to the caller.
    return new Response('Internal Server Error', { status: 500 });
  }
}

/**
 * Serve one accepted exchange: read the request, run the handler, write the
 * response.
 *
 * A request that cannot be parsed resets the exchange, because no status can
 * honestly be attributed to it. A handler that throws becomes a `500`, since
 * nothing has been written yet and a status is still available.
 *
 * The exchange is complete once the response is written. A handler must read
 * the request body before its response finishes, for instance by awaiting it
 * or by streaming it into the response. Whatever is still unread then is
 * abandoned: the receive side is stopped, so a peer still uploading is told to
 * stop rather than left blocked on flow control, and reads still pending on the
 * body or its clones fail.
 */
export async function serveExchange(stream: ExchangeStream, handler: Handler, peer: PeerInfo): Promise<void> {
  // The peer violated `SPEC.md`, or the stream failed. Answering `500` would
  // imply a well-formed request was received and understood.
  const received = await receiveRequest(stream, peer).catch(() => null);
  if (!received) {
    await stream.reset();
    return;
  }

  const response = await respond(handler, received.request, peer);
  try {
    await writeResponse(stream, response);
  } catch {
    // Resetting aborts both directions, so no unread request body survives it.
    await stream.reset();
    return;
  }
  // Judged on the wire rather than on `request.body`, which a clone or a
  // released reader can leave unlocked and unread without it being consumed.
  if (!received.bodyEnded()) {
    await stream.stop().catch(() => undefined);
  }
}

/**
 * Serves a handler on a listener, owning its accept loop.
 *
 * Every accepted connection is served concurrently, and every bidirectional
 * stream on a connection is one independent exchange. Disposing the server
 * stops accepting, closes active connections, closes the listener, and waits
 * for in-flight exchanges to settle.
 */
export class IrohHttpServer implements AsyncDisposable {
  /**
   * Settles when the server stops accepting connections: resolves once the
   * listener closes, and rejects if accepting fails before disposal. Exchanges
   * already in flight keep running until the server is disposed.
   */
  readonly closed: Promise<void>;
  private readonly connections = new Set<Connection>();
  private readonly tasks = new Set<Promise<void>>();
  private stopping = false;
  private disposal: Promise<void> | undefined = undefined;

  constructor(
    private readonly listener: Listener,
    private readonly handler: Handler
  ) {
    this.closed = this.run();
    // Observing `closed` is optional; dispose still reports the failure.
    this.closed.catch(() => undefined);
  }

  [Symbol.asyncDispose](): Promise<void> {
    this.disposal ??= this.dispose();
    return this.disposal;
  }

  /** Accept connections until the listener closes, rejecting if accepting fails. */
  private async run(): Promise<void> {
    try {
      while (!this.stopping) {
        const incoming = await this.listener.accept();
        if (!incoming) return;
        this.track(this.serveConnection(incoming));
      }
    } catch (error) {
      // Accept failing because disposal closed the listener is a clean stop.
      if (!this.stopping) throw error;
    }
  }

  /** Serve exchanges on one connection until the peer stops opening streams or goes away. */
  private async serveConnection(incoming: Incoming): Promise<void> {
    // A failed handshake only rejects that incoming connection.
    const connection = await incoming.connect().catch(() => null);
    if (!connection) return;
    if (this.stopping) {
      connection.close();
      return;
    }

    this.connections.add(connection);
    const peer: PeerInfo = { endpointId: connection.remoteId() };
    try {
      for (;;) {
        const stream = await connection.acceptStream().catch(() => null);
        if (!stream || this.stopping) return;
        this.track(serveExchange(stream, this.handler, peer));
      }
    } finally {
      this.connections.delete(connection);
    }
  }

  private track(task: Promise<void>): void {
    const tracked = task.catch(() => undefined).finally(() => this.tasks.delete(tracked));
    this.tasks.add(tracked);
  }

  private async dispose(): Promise<void> {
    this.stopping = true;
    const closing = this.listener.close();
    for (const connection of this.connections) connection.close();

    // Settle everything before reporting, so a failure never orphans an exchange.
    const [loop, close] = await Promise.allSettled([this.closed, closing]);
    await Promise.all(this.tasks);

    // An accept failure is the root cause of any close failure that follows it.
    if (loop.status === 'rejected') throw loop.reason;
    if (close.status === 'rejected') throw close.reason;
  }
}
