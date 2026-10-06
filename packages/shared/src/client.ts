import type { Connection } from './transport.ts';
import { ORIGIN_SUFFIX, readResponseHead, writeRequest, type PeerInfo } from './wire.ts';

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

  /** Issue a request over the connection. Mirrors the global `fetch`. */
  async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
    // A relative target needs an origin before `Request` will accept it.
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(input, `http://${this.peer.endpointId}${ORIGIN_SUFFIX}/`), init);

    const stream = await this.connection.openStream();
    try {
      // The request is uploaded concurrently, so that a server may begin
      // responding before the body has finished. Reading the response head is
      // raced against a send failure: one before the head is accepted (an
      // oversized request head, say) rejects with that error instead of
      // waiting for a response that will never come, while one after it is
      // ignored, because a late send failure cannot invalidate a response head
      // that has already been accepted. A completed send never settles the
      // race, and `Promise.race` handles whichever promise loses.
      const sendFailure = writeRequest(stream, request).then(() => new Promise<never>(() => undefined));
      const completeResponse = await Promise.race([readResponseHead(stream), sendFailure]);
      return await completeResponse();
    } catch (error) {
      await stream.reset();
      throw error;
    }
  }

  /** Close the underlying connection. */
  close(): void {
    this.connection.close();
  }
}
