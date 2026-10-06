/**
 * HTTP over Iroh, independent of any one runtime's Iroh bindings.
 *
 * The wire codec implements `SPEC.md`; the client and server are written
 * against the small {@link Connection} and {@link Listener} interfaces that the
 * Node and browser packages adapt their bindings to.
 *
 * @module
 */

export {
  ALPN,
  HEAD_PREFIX_SIZE,
  BODY_PREFIX_SIZE,
  MAX_HEAD_SIZE,
  MAX_CHUNK_SIZE,
  ERROR_CODE,
  BodyTag,
  ORIGIN_SUFFIX,
  IrohHttpError,
  encodeHeaders,
  decodeHeaders,
  writeRequest,
  readRequest,
  writeResponse,
  readResponse,
  type ExchangeStream,
  type PeerInfo,
  type Handler
} from './wire.ts';
export type { Connection, Incoming, Listener } from './transport.ts';
export { IrohHttpClient } from './client.ts';
export { IrohHttpServer, serveExchange } from './server.ts';
