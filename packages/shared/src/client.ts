import type { Connection } from './transport.ts';
import { ORIGIN_SUFFIX, readResponseHead, writeRequest, type ExchangeStream, type PeerInfo } from './wire.ts';

/**
 * A `fetch`-shaped client bound to one Iroh connection.
 *
 * Each call opens its own bidirectional QUIC stream, so requests are
 * independent and may be issued concurrently.
 */
export class IrohHttpClient {
  constructor(private readonly connection: Connection) {}

  /** The remote endpoint this client is connected to. */
  get peer(): PeerInfo {
    return { endpointId: this.connection.remoteId() };
  }

  /** Issue a request over the connection. Aborting its signal cancels only this exchange. */
  async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
    // A relative target needs an origin before `Request` will accept it.
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(input, `http://${this.peer.endpointId}${ORIGIN_SUFFIX}/`), init);

    const signal = request.signal;
    signal.throwIfAborted();
    const cancellation = new AbortController();

    let stream: ExchangeStream | undefined = undefined;
    let uploadEnded = false;
    let responseEnded = false;
    let onAbort = () => undefined;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const complete = () => {
      // An early response may finish while the request is still uploading.
      if (uploadEnded && responseEnded) cleanup();
    };
    const reset = () => {
      // Reset failures must neither hide the original error nor go unobserved.
      stream?.reset().catch(() => undefined);
    };
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        cancellation.abort(signal.reason);
        reject(signal.reason);
        reset();
        cleanup();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      const opening = this.connection.openStream().then(opened => {
        stream = opened;
        // Opening cannot be interrupted. Dispose of a stream delivered after
        // fetch has already rejected, without starting a request on it.
        if (signal.aborted) {
          reset();
          signal.throwIfAborted();
        }
        return opened;
      });
      const opened = await Promise.race([opening, aborted]);
      // The request is uploaded concurrently, so that a server may begin
      // responding before the body has finished. Reading the response head is
      // raced against a send failure: one before the head is accepted (an
      // oversized request head, say) rejects with that error instead of
      // waiting for a response that will never come, while one after it is
      // ignored, because a late send failure cannot invalidate a response head
      // that has already been accepted. A completed send never settles the
      // race, and `Promise.race` handles whichever promise loses.
      const sendFailure = writeRequest(opened, request, cancellation.signal)
        .finally(() => {
          uploadEnded = true;
          complete();
        })
        .then(() => new Promise<never>(() => undefined));
      const completeResponse = await Promise.race([
        readResponseHead(opened, cancellation.signal, () => {
          responseEnded = true;
          complete();
        }),
        sendFailure,
        aborted
      ]);
      return await Promise.race([completeResponse(), aborted]);
    } catch (error) {
      // Also cancel an upload waiting on its source when headers fail.
      cancellation.abort(signal.aborted ? signal.reason : error);
      cleanup();
      reset();
      throw signal.aborted ? signal.reason : error;
    }
  }

  /** Close the underlying connection. */
  close(): void {
    this.connection.close();
  }
}
