/**
 * The `iroh-http/1` wire codec: `SPEC.md` implemented against a minimal
 * byte-stream interface.
 */

/** ALPN used by every HTTP over Iroh endpoint: `iroh-http/1`, as bytes. */
export const ALPN: number[] = Array.from(new TextEncoder().encode('iroh-http/1'));

/** Byte length of the head frame's length prefix. */
export const HEAD_PREFIX_SIZE = 4;
/** Byte length of a body frame header: one tag byte and a `u32` length. */
export const BODY_PREFIX_SIZE = 5;
/** Maximum encoded head frame size, in bytes. */
export const MAX_HEAD_SIZE = 1024 * 1024;
/** Maximum body frame payload size, in bytes. */
export const MAX_CHUNK_SIZE = 1024 * 1024;
/** QUIC error code used to reset a stream or close a connection. */
export const ERROR_CODE = 1n;

/** Body frame tags. */
export const BodyTag = {
  Data: 0x00,
  End: 0x01,
  Error: 0x02
} as const;

/** Synthetic origin suffix used to build absolute URLs for `Request`. */
export const ORIGIN_SUFFIX = '.iroh';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const EMPTY = new Uint8Array(0);

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);

/** An error raised while framing or parsing an Iroh HTTP exchange. */
export class IrohHttpError extends Error {
  override readonly name = 'IrohHttpError';
}

/**
 * The byte-stream pair one exchange runs over.
 *
 * Transports implement this over a single Iroh bidirectional QUIC stream. The
 * codec awaits each write before issuing the next, so writes never overlap.
 */
export interface ExchangeStream {
  /** Write every byte of `bytes`. */
  write(bytes: Uint8Array): Promise<void>;
  /**
   * Read exactly `size` bytes, or reject if the stream ends first. A `size` of
   * zero must resolve with an empty array without waiting on the stream.
   */
  readExact(size: number): Promise<Uint8Array>;
  /** Close the send side cleanly, signalling end of stream to the peer. */
  finish(): Promise<void>;
  /**
   * Ask the peer to stop sending; the receive side is abandoned.
   *
   * Must reject any read in flight and any read after it, and resolve
   * promptly: never wait for a pending read, nor for the peer. May be called
   * more than once, and after the stream has failed. Zero-length reads are
   * exempt: `readExact(0)` still resolves with an empty array.
   */
  stop(): Promise<void>;
  /**
   * Abort the whole exchange in both directions.
   *
   * Must reject any read or write in flight and any after it, and resolve
   * promptly, under the same rules as {@link ExchangeStream.stop}; zero-length
   * reads are likewise exempt.
   */
  reset(): Promise<void>;
}

/** Identity of the peer on the other end of an exchange. */
export interface PeerInfo {
  /** The remote Iroh endpoint id, authenticated by the QUIC handshake. */
  readonly endpointId: string;
}

/** A request handler. Mirrors the shape of a `fetch` handler. */
export type Handler = (request: Request, peer: PeerInfo) => Response | Promise<Response>;

interface RequestHead {
  method: string;
  target: string;
  headers: [string, string][];
}

interface ResponseHead {
  status: number;
  headers: [string, string][];
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

/** Encode a header list, dropping hop-by-hop fields and lowercasing names. */
export function encodeHeaders(headers: Headers): [string, string][] {
  const pairs: [string, string][] = [];
  // Iteration lowercases and sorts names, but collapses repeated `set-cookie`
  // values into one comma-joined value, so those are recovered separately.
  for (const [name, value] of headers) {
    if (HOP_BY_HOP.has(name) || name === 'set-cookie') continue;
    pairs.push([name, value]);
  }
  for (const value of headers.getSetCookie()) pairs.push(['set-cookie', value]);
  return pairs;
}

/** Rebuild a `Headers` from a wire header list, preserving repeated fields. */
export function decodeHeaders(pairs: readonly (readonly [string, string])[]): Headers {
  const headers = new Headers();
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    headers.append(lower, value);
  }
  return headers;
}

async function writeHead(stream: ExchangeStream, head: RequestHead | ResponseHead): Promise<void> {
  const payload = encoder.encode(JSON.stringify(head));
  if (payload.byteLength > MAX_HEAD_SIZE) {
    throw new IrohHttpError(`Head frame exceeds ${MAX_HEAD_SIZE} bytes`);
  }
  const frame = new Uint8Array(HEAD_PREFIX_SIZE + payload.byteLength);
  frame.set(u32(payload.byteLength), 0);
  frame.set(payload, HEAD_PREFIX_SIZE);
  await stream.write(frame);
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- Head frames are untrusted JSON; parseRequestHead and parseResponseHead check them.
async function readHead(stream: ExchangeStream): Promise<unknown> {
  const length = readU32(await stream.readExact(HEAD_PREFIX_SIZE), 0);
  if (length > MAX_HEAD_SIZE) {
    throw new IrohHttpError(`Head frame exceeds ${MAX_HEAD_SIZE} bytes`);
  }
  const payload = await stream.readExact(length);
  try {
    return JSON.parse(decoder.decode(payload));
  } catch (cause) {
    throw new IrohHttpError('Head frame is not valid JSON', { cause });
  }
}

/*
 * Head frames arrive as untrusted JSON from the peer, so the parsers below are
 * the wire boundary: they narrow raw JSON values into the head types above.
 */
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- Wire boundary for untrusted head JSON. */

function parseHeaders(value: unknown): [string, string][] {
  if (!Array.isArray(value)) throw new IrohHttpError('Head headers must be an array');
  return value.map((pair: unknown): [string, string] => {
    // Each entry must be exactly a `[name, value]` pair of strings.
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new IrohHttpError('Each header must be a name and value pair');
    }
    const [name, headerValue] = pair;
    if (typeof name !== 'string' || typeof headerValue !== 'string') {
      throw new IrohHttpError('Header names and values must be strings');
    }
    return [name, headerValue];
  });
}

/** Head fields as received, before their types are checked. */
interface RawHead {
  method?: unknown;
  target?: unknown;
  status?: unknown;
  headers?: unknown;
}

function parseHeadObject(value: unknown): RawHead {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new IrohHttpError('Head frame must be a JSON object');
  }
  return value;
}

/** Require a non-empty method and an origin-form target, as `SPEC.md` does. */
function parseRequestHead(value: unknown): RequestHead {
  const { method, target, headers } = parseHeadObject(value);
  if (typeof method !== 'string' || method.length === 0) {
    throw new IrohHttpError('Request head is missing a method');
  }
  if (typeof target !== 'string' || !target.startsWith('/')) {
    throw new IrohHttpError('Request target must be an origin-form path');
  }
  return { method, target, headers: parseHeaders(headers) };
}

function parseResponseHead(value: unknown): ResponseHead {
  const { status, headers } = parseHeadObject(value);
  if (typeof status !== 'number' || !Number.isInteger(status)) {
    throw new IrohHttpError('Response status must be an integer');
  }
  return { status, headers: parseHeaders(headers) };
}

/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

function bodyFrame(tag: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(BODY_PREFIX_SIZE + payload.byteLength);
  frame[0] = tag;
  frame.set(u32(payload.byteLength), 1);
  frame.set(payload, BODY_PREFIX_SIZE);
  return frame;
}

/** Encode an `ERROR` message, truncated on a char boundary to the spec's 1 MiB frame limit. */
function errorPayload(message: string): Uint8Array {
  const bytes = encoder.encode(message);
  let end = Math.min(bytes.byteLength, MAX_CHUNK_SIZE);
  // Back off over UTF-8 continuation bytes so the cut lands on a char boundary.
  while (end < bytes.byteLength && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

/** Write source chunks, cancelling a stalled source when the exchange aborts. */
async function writeBodyChunks(
  stream: ExchangeStream,
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): Promise<void> {
  const reader = body.getReader();
  const onAbort = () => {
    // Cancelling releases a stalled read immediately, even if the source's
    // own cancellation takes longer or fails.
    reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    // Split each source chunk into bounded frames, until EOF or cancellation.
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      for (let offset = 0; offset < value.byteLength; offset += MAX_CHUNK_SIZE) {
        await stream.write(bodyFrame(BodyTag.Data, value.subarray(offset, offset + MAX_CHUNK_SIZE)));
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/**
 * Stream a body as body frames, terminating with `END` or `ERROR`.
 *
 * The send side is finished either way, per `SPEC.md`, unless aborted.
 */
async function writeBody(
  stream: ExchangeStream,
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  try {
    if (body) await writeBodyChunks(stream, body, signal);
    await stream.write(bodyFrame(BodyTag.End, EMPTY));
  } catch (cause) {
    // A cancelled exchange must not try to send an in-band body error.
    if (signal?.aborted) throw signal.reason;
    // The head is already committed, so the failure has to travel in-band.
    const message = cause instanceof Error ? cause.message : String(cause);
    try {
      await stream.write(bodyFrame(BodyTag.Error, errorPayload(message)));
    } catch {
      // The stream is already unusable; the peer will see a truncated body.
    }
  }
  await stream.finish();
}

/** Read one body frame, returning `null` at a clean `END`. */
async function readBodyFrame(stream: ExchangeStream): Promise<Uint8Array | null> {
  const header = await stream.readExact(BODY_PREFIX_SIZE);
  const tag = header[0];
  const length = readU32(header, 1);

  if (tag === BodyTag.End) {
    if (length !== 0) throw new IrohHttpError('END frame must have zero length');
    return null;
  }

  if (length > MAX_CHUNK_SIZE) {
    throw new IrohHttpError(`Body frame exceeds ${MAX_CHUNK_SIZE} bytes`);
  }

  if (tag === BodyTag.Error) {
    throw new IrohHttpError(`Remote body failed: ${decoder.decode(await stream.readExact(length))}`);
  }

  if (tag !== BodyTag.Data) throw new IrohHttpError(`Unknown body frame tag ${String(tag)}`);
  return length === 0 ? EMPTY : await stream.readExact(length);
}

interface BodyReadOptions {
  onEnd?: () => void;
  onSettled?: () => void;
  signal?: AbortSignal;
}

/**
 * Read body frames into a `ReadableStream`, surfacing `ERROR` as a failure.
 *
 * `onEnd` runs only at a clean `END`; `onSettled` also runs on error or cancel.
 */
function readBody(stream: ExchangeStream, options: BodyReadOptions = {}): ReadableStream<Uint8Array> {
  let settled = false;
  let onAbort = () => undefined;
  const settle = () => {
    if (settled) return;
    settled = true;
    options.signal?.removeEventListener('abort', onAbort);
    options.onSettled?.();
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        // Error the body itself so queued data and pending reads both reject
        // with the caller's reason, rather than a transport reset error.
        controller.error(options.signal?.reason);
        settle();
      };
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener('abort', onAbort, { once: true });
    },
    // Framing errors settle the body just as EOF or cancellation does.
    async pull(controller) {
      try {
        // Empty frames are skipped; terminal frames close, and cancellation
        // discards a read that completes after the body was settled.
        while (!settled) {
          const chunk = await readBodyFrame(stream);
          // Cancellation or abort may have settled the body during the read.
          if (settled) return;
          if (!chunk) {
            options.onEnd?.();
            settle();
            controller.close();
            return;
          }
          // A zero-length DATA frame is legal but must not be enqueued, because
          // an empty chunk is indistinguishable from backpressure to consumers.
          if (chunk.byteLength > 0) {
            controller.enqueue(chunk);
            return;
          }
        }
      } catch (error) {
        if (!settled) {
          controller.error(error);
          settle();
        }
      }
    },
    async cancel() {
      settle();
      await stream.stop();
    }
  });
}

/**
 * Consume the body frames of a message that cannot carry a body.
 *
 * Reading the terminal frame, rather than resetting, leaves the peer's write of
 * `END` succeeding and keeps the exchange a clean close on both sides.
 */
async function drainBody(stream: ExchangeStream): Promise<void> {
  while ((await readBodyFrame(stream)) !== null);
}

/** True for methods that cannot carry a body. */
function isBodyless(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

/** Write a `Request` to an exchange stream as a request head and body. */
export async function writeRequest(
  stream: ExchangeStream,
  request: Request,
  signal: AbortSignal = request.signal
): Promise<void> {
  signal.throwIfAborted();
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  await writeHead(stream, {
    method,
    target: `${url.pathname}${url.search}`,
    headers: encodeHeaders(request.headers)
  });
  await writeBody(stream, isBodyless(method) ? null : request.body, signal);
}

/** `RequestInit` for a streamed request body. */
interface StreamingRequestInit extends RequestInit {
  // Required by Node and Chrome when a stream is a request body, and not yet
  // part of the DOM `RequestInit` type.
  duplex: 'half';
}

/**
 * A request read off an exchange, together with the state of its body on the
 * wire.
 *
 * @internal Used by `serveExchange`; not part of the public API.
 */
export interface ReceivedRequest {
  readonly request: Request;
  /**
   * True once the body has been read through its `END` frame, whoever read
   * it: the handler, a clone, or a response streaming it back.
   */
  readonly bodyEnded: () => boolean;
}

/**
 * Read a request from an exchange stream, tracking whether its body is read to
 * the end.
 *
 * @internal Used by `serveExchange`; call {@link readRequest} instead.
 */
export async function receiveRequest(stream: ExchangeStream, peer: PeerInfo): Promise<ReceivedRequest> {
  const { method, target, headers } = parseRequestHead(await readHead(stream));
  const url = `http://${peer.endpointId}${ORIGIN_SUFFIX}${target}`;
  const init: RequestInit = { method, headers: decodeHeaders(headers) };

  if (isBodyless(method.toUpperCase())) {
    await drainBody(stream);
    return { request: new Request(url, init), bodyEnded: () => true };
  }

  const progress = { ended: false };
  const body = readBody(stream, {
    onEnd: () => {
      progress.ended = true;
    }
  });
  const streaming: StreamingRequestInit = { ...init, body, duplex: 'half' };
  return { request: new Request(url, streaming), bodyEnded: () => progress.ended };
}

/**
 * Read a request from an exchange stream.
 *
 * The returned `Request` has a synthetic origin derived from the peer's
 * endpoint id, so that `request.url` is absolute and identifies the caller.
 */
export async function readRequest(stream: ExchangeStream, peer: PeerInfo): Promise<Request> {
  const { request } = await receiveRequest(stream, peer);
  return request;
}

/** Write a `Response` to an exchange stream as a response head and body. */
export async function writeResponse(stream: ExchangeStream, response: Response): Promise<void> {
  await writeHead(stream, {
    status: response.status,
    headers: encodeHeaders(response.headers)
  });
  await writeBody(stream, response.body);
}

/**
 * Read and validate a response head, leaving its body frames unread.
 *
 * Resolves to a function that reads the body and builds the `Response`, so a
 * caller can tell the head being accepted apart from the response being ready.
 *
 * @internal Used by `IrohHttpClient`; call {@link readResponse} instead.
 */
export async function readResponseHead(
  stream: ExchangeStream,
  signal?: AbortSignal,
  onSettled: () => void = () => undefined
): Promise<() => Promise<Response>> {
  const { status, headers } = parseResponseHead(await readHead(stream));

  if (status < 200 || status > 599) {
    // Informational responses are not expressible in version 1 of the wire
    // protocol, and `Response` cannot represent them either.
    throw new IrohHttpError(`Response status ${String(status)} is out of range 200-599`);
  }

  const decoded = decodeHeaders(headers);
  return async () => {
    // `Response` forbids a body on these statuses, so the frames are drained.
    if (status === 204 || status === 205 || status === 304) {
      try {
        await drainBody(stream);
      } finally {
        onSettled();
      }
      return new Response(null, { status, headers: decoded });
    }
    return new Response(readBody(stream, { signal, onSettled }), { status, headers: decoded });
  };
}

/** Read a response from an exchange stream. */
export async function readResponse(stream: ExchangeStream): Promise<Response> {
  const completeResponse = await readResponseHead(stream);
  return await completeResponse();
}
