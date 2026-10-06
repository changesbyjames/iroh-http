/**
 * Unit coverage for the wire codec, with no network involved.
 *
 * These are the cases that are awkward to provoke through two real peers,
 * because they require sending bytes no conformant implementation would send.
 */

import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  HEAD_PREFIX_SIZE,
  MAX_HEAD_SIZE,
  IrohHttpClient,
  readResponse,
  serveExchange,
  writeRequest,
  writeResponse,
  type ExchangeStream,
  type Handler
} from '@strangecyan/iroh-http-core';
import { createStreamPair } from '../streams.ts';

const peer = { endpointId: 'test-endpoint' };
const encoder = new TextEncoder();

describe('IrohHttpClient abort', () => {
  it.each(['init', 'request'])('rejects a pre-aborted %s signal without opening a stream', async source => {
    const pair = createStreamPair();
    const openStream = vi.fn(async () => pair.client);
    const http = new IrohHttpClient({
      remoteId: () => peer.endpointId,
      openStream,
      acceptStream: openStream,
      close() {}
    });
    const abort = new AbortController();
    const reason = new Error('already cancelled');
    abort.abort(reason);

    const pending =
      source === 'init'
        ? http.fetch('/', { signal: abort.signal })
        : http.fetch(new Request('http://peer.iroh/', { signal: abort.signal }));

    await expect(pending).rejects.toBe(reason);
    expect(openStream).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'])('abandons an opening stream that later %ss', async outcome => {
    const pair = createStreamPair();
    const opening = Promise.withResolvers<ExchangeStream>();
    const openStream = vi.fn(() => opening.promise);
    const write = vi.spyOn(pair.client, 'write');
    const http = new IrohHttpClient({
      remoteId: () => peer.endpointId,
      openStream,
      acceptStream: openStream,
      close() {}
    });
    const abort = new AbortController();
    const reason = new Error('cancelled while opening');
    const rejected = expect(http.fetch('/', { signal: abort.signal })).rejects.toBe(reason);

    abort.abort(reason);
    await rejected;
    if (outcome === 'resolve') {
      opening.resolve(pair.client);
      await vi.waitFor(() => expect(pair.clientRecord.reset).toBe(true));
    } else {
      opening.reject(new Error('late opening failure'));
      await opening.promise.catch(() => undefined);
    }
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects while awaiting headers and resets the exchange', async () => {
    const pair = createStreamPair();
    const arrived = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const openStream = async () => pair.client;
    const http = new IrohHttpClient({
      remoteId: () => peer.endpointId,
      openStream,
      acceptStream: openStream,
      close() {}
    });
    const serving = serveExchange(
      pair.server,
      async () => {
        arrived.resolve();
        await gate.promise;
        return new Response('too late');
      },
      peer
    );
    const abort = new AbortController();
    const reason = new Error('cancelled before headers');
    const rejected = expect(http.fetch('/', { signal: abort.signal })).rejects.toBe(reason);

    try {
      await arrived.promise;
      abort.abort(reason);
      await rejected;
      expect(pair.clientRecord.reset).toBe(true);
    } finally {
      gate.resolve();
      await serving;
    }
  });

  it('cancels an upload stalled on its source', async () => {
    const pair = createStreamPair();
    const reading = Promise.withResolvers<void>();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      { pull: () => reading.resolve(), cancel: cancelled },
      { highWaterMark: 0 }
    );
    const openStream = async () => pair.client;
    const http = new IrohHttpClient({
      remoteId: () => peer.endpointId,
      openStream,
      acceptStream: openStream,
      close() {}
    });
    const abort = new AbortController();
    const reason = new Error('cancelled upload');
    const init = { method: 'POST', body, duplex: 'half' as const, signal: abort.signal };
    const rejected = expect(http.fetch('/', init)).rejects.toBe(reason);

    await reading.promise;
    abort.abort(reason);
    await rejected;
    expect(cancelled).toHaveBeenCalledWith(reason);
    expect(pair.clientRecord.reset).toBe(true);
    await vi.waitFor(() => expect(body.locked).toBe(false));
  });

  it('abandons a stalled write and observes its late failure', async () => {
    const pair = createStreamPair();
    const writing = Promise.withResolvers<void>();
    const write = vi.spyOn(pair.client, 'write').mockImplementationOnce(() => writing.promise);
    const openStream = async () => pair.client;
    const http = new IrohHttpClient({
      remoteId: () => peer.endpointId,
      openStream,
      acceptStream: openStream,
      close() {}
    });
    const abort = new AbortController();
    const reason = new Error('cancelled write');
    const rejected = expect(http.fetch('/', { signal: abort.signal })).rejects.toBe(reason);

    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    abort.abort(reason);
    await rejected;
    expect(pair.clientRecord.reset).toBe(true);
    writing.reject(new Error('late write failure'));
    await writing.promise.catch(() => undefined);
  });

  it('cancels a stalled upload when the response head fails', async () => {
    const pair = createStreamPair();
    const reading = Promise.withResolvers<void>();
    const cancelled = vi.fn(async () => {
      throw new Error('source cancellation failed');
    });
    const body = new ReadableStream<Uint8Array>(
      { pull: () => reading.resolve(), cancel: cancelled },
      { highWaterMark: 0 }
    );
    const openStream = async () => pair.client;
    const http = new IrohHttpClient({
      remoteId: () => peer.endpointId,
      openStream,
      acceptStream: openStream,
      close() {}
    });
    const init = { method: 'POST', body, duplex: 'half' as const };
    const rejected = expect(http.fetch('/', init)).rejects.toThrow(/out of range/);

    await reading.promise;
    await pair.server.write(headFrame(encoder.encode(JSON.stringify({ status: 999, headers: [] }))));
    await rejected;
    expect(cancelled).toHaveBeenCalledWith(expect.any(Error));
    expect(pair.clientRecord.reset).toBe(true);
    await vi.waitFor(() => expect(body.locked).toBe(false));
  });

  it.each([204, 205, 304])('aborts while draining a bodyless %i response', async status => {
    const pair = createStreamPair();
    const openStream = async () => pair.client;
    const http = new IrohHttpClient({
      remoteId: () => peer.endpointId,
      openStream,
      acceptStream: openStream,
      close() {}
    });
    const abort = new AbortController();
    const reason = new Error('cancel bodyless drain');
    const rejected = expect(http.fetch('/', { signal: abort.signal })).rejects.toBe(reason);

    await pair.server.write(headFrame(encoder.encode(JSON.stringify({ status, headers: [] }))));
    // Let the head arrive; no END frame follows, so completion stays pending.
    await new Promise(resolve => setImmediate(resolve));
    abort.abort(reason);
    await rejected;
    expect(pair.clientRecord.reset).toBe(true);
  });

  it.each([new Error('cancelled body'), 'watch closed', 0])(
    'rejects pending and future body reads with %s',
    async reason => {
      const pair = createStreamPair();
      const body = new TransformStream<Uint8Array, Uint8Array>();
      const writer = body.writable.getWriter();
      const serving = writeResponse(pair.server, new Response(body.readable));
      const openStream = async () => pair.client;
      const http = new IrohHttpClient({
        remoteId: () => peer.endpointId,
        openStream,
        acceptStream: openStream,
        close() {}
      });
      const abort = new AbortController();

      try {
        const response = await http.fetch('/', { signal: abort.signal });
        const reader = response.body!.getReader();
        await writer.write(encoder.encode('first'));
        expect((await reader.read()).value).toEqual(encoder.encode('first'));
        const rejected = expect(reader.read()).rejects.toBe(reason);
        abort.abort(reason);
        await rejected;
        await expect(reader.read()).rejects.toBe(reason);
        expect(pair.clientRecord.reset).toBe(true);
      } finally {
        await writer.close();
        await serving;
      }
    }
  );

  it('discards buffered response bytes on abort', async () => {
    const pair = createStreamPair();
    const body = new TransformStream<Uint8Array, Uint8Array>();
    const writer = body.writable.getWriter();
    const serving = writeResponse(pair.server, new Response(body.readable));
    const openStream = async () => pair.client;
    const http = new IrohHttpClient({
      remoteId: () => peer.endpointId,
      openStream,
      acceptStream: openStream,
      close() {}
    });
    const abort = new AbortController();
    const reason = new Error('discard queued data');

    try {
      const response = await http.fetch('/', { signal: abort.signal });
      await writer.write(encoder.encode('buffered'));
      await new Promise(resolve => setImmediate(resolve));
      abort.abort(reason);
      await expect(response.body!.getReader().read()).rejects.toBe(reason);
    } finally {
      await writer.close();
      await serving;
    }
  });

  it.each(['end', 'cancel', 'error', 'bodyless'])(
    'removes abort listeners when the response reaches %s',
    async outcome => {
      // Exercise all terminal paths, including responses that forbid a body.
      const pair = createStreamPair();
      const openStream = async () => pair.client;
      const http = new IrohHttpClient({
        remoteId: () => peer.endpointId,
        openStream,
        acceptStream: openStream,
        close() {}
      });
      const signalGetter = vi.spyOn(Request.prototype, 'signal', 'get');
      const abort = new AbortController();

      try {
        // Finish or cancel the response, then verify a later abort is inert.
        const pending = http.fetch('/', { signal: abort.signal });
        const requestSignal: AbortSignal = signalGetter.mock.results[0].value;
        await writeResponse(
          pair.server,
          new Response(outcome === 'bodyless' ? null : 'ok', { status: outcome === 'bodyless' ? 204 : 200 })
        );
        const response = await pending;
        if (outcome === 'cancel') await response.body!.cancel();
        else if (outcome === 'error') {
          await pair.client.reset();
          await expect(response.text()).rejects.toThrow();
        } else await response.text();

        await vi.waitFor(() => expect(getEventListeners(requestSignal, 'abort')).toHaveLength(0));
        abort.abort();
        if (outcome !== 'error') expect(pair.clientRecord.reset).toBe(false);
      } finally {
        signalGetter.mockRestore();
      }
    }
  );

  it('keeps cancellation active when the response ends before the upload', async () => {
    const pair = createStreamPair();
    const reading = Promise.withResolvers<void>();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      { pull: () => reading.resolve(), cancel: cancelled },
      { highWaterMark: 0 }
    );
    const openStream = async () => pair.client;
    const http = new IrohHttpClient({
      remoteId: () => peer.endpointId,
      openStream,
      acceptStream: openStream,
      close() {}
    });
    const abort = new AbortController();
    const reason = new Error('cancel remaining upload');
    const init = { method: 'POST', body, duplex: 'half' as const, signal: abort.signal };
    const pending = http.fetch('/', init);
    await reading.promise;
    await writeResponse(pair.server, new Response('early response'));
    await expect((await pending).text()).resolves.toBe('early response');

    abort.abort(reason);
    expect(cancelled).toHaveBeenCalledWith(reason);
    expect(pair.clientRecord.reset).toBe(true);
    await vi.waitFor(() => expect(body.locked).toBe(false));
  });
});

/** Frame a raw head payload, bypassing the encoder's own validation. */
function headFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(HEAD_PREFIX_SIZE + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength);
  frame.set(payload, HEAD_PREFIX_SIZE);
  return frame;
}

describe('serveExchange', () => {
  it('resets the exchange when the head is not valid JSON', async () => {
    const { client, server, serverRecord } = createStreamPair();
    const handler = vi.fn<Handler>();

    await client.write(headFrame(encoder.encode('{not json')));
    await serveExchange(server, handler, peer);

    expect(handler).not.toHaveBeenCalled();
    expect(serverRecord.reset).toBe(true);
    // A 500 would wrongly imply a well-formed request was understood.
    await expect(readResponse(client)).rejects.toThrow();
  });

  it('resets the exchange when the request target is not origin-form', async () => {
    const { client, server, serverRecord } = createStreamPair();
    const handler = vi.fn<Handler>();

    await client.write(headFrame(encoder.encode(JSON.stringify({ method: 'GET', target: 'nope', headers: [] }))));
    await serveExchange(server, handler, peer);

    expect(handler).not.toHaveBeenCalled();
    expect(serverRecord.reset).toBe(true);
  });

  it('resets the exchange when a header pair is malformed', async () => {
    const { client, server, serverRecord } = createStreamPair();
    const handler = vi.fn<Handler>();

    await client.write(headFrame(encoder.encode(JSON.stringify({ method: 'GET', target: '/', headers: [['only']] }))));
    await serveExchange(server, handler, peer);

    expect(handler).not.toHaveBeenCalled();
    expect(serverRecord.reset).toBe(true);
  });

  it('refuses a head frame larger than the limit without allocating it', async () => {
    const { client, server, serverRecord } = createStreamPair();
    const handler = vi.fn<Handler>();

    // Only the prefix is written; a conformant reader must reject before it
    // waits for a payload this large.
    const prefix = new Uint8Array(HEAD_PREFIX_SIZE);
    new DataView(prefix.buffer).setUint32(0, MAX_HEAD_SIZE + 1);
    await client.write(prefix);
    await serveExchange(server, handler, peer);

    expect(handler).not.toHaveBeenCalled();
    expect(serverRecord.reset).toBe(true);
  });

  it('answers 500 when the handler throws, keeping the exchange clean', async () => {
    const { client, server, serverRecord } = createStreamPair();

    const request = new Request('http://peer.iroh/boom');
    await writeRequest(client, request);
    await serveExchange(
      server,
      () => {
        throw new Error('handler exploded');
      },
      peer
    );

    // A well-formed request was understood, so a status is owed.
    const response = await readResponse(client);
    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe('Internal Server Error');
    expect(serverRecord.reset).toBe(false);
    expect(serverRecord.finished).toBe(true);
  });

  it('passes the peer identity and reconstructed URL to the handler', async () => {
    const { client, server } = createStreamPair();

    await writeRequest(client, new Request('http://ignored.example/things?q=1'));
    await serveExchange(
      server,
      (request, received) => {
        expect(received).toEqual(peer);
        expect(request.url).toBe('http://test-endpoint.iroh/things?q=1');
        return new Response('ok');
      },
      peer
    );

    await expect((await readResponse(client)).text()).resolves.toBe('ok');
  });
});

describe('readResponse', () => {
  it('rejects an informational status, which version 1 cannot express', async () => {
    const { client, server } = createStreamPair();

    await server.write(headFrame(encoder.encode(JSON.stringify({ status: 100, headers: [] }))));

    await expect(readResponse(client)).rejects.toThrow(/out of range/);
  });

  it('rejects a status outside the valid range', async () => {
    const { client, server } = createStreamPair();

    await server.write(headFrame(encoder.encode(JSON.stringify({ status: 999, headers: [] }))));

    await expect(readResponse(client)).rejects.toThrow(/out of range/);
  });

  it('rejects an END frame carrying a payload length', async () => {
    const { client, server } = createStreamPair();

    await server.write(headFrame(encoder.encode(JSON.stringify({ status: 200, headers: [] }))));
    const bogus = new Uint8Array(5);
    bogus[0] = 0x01;
    new DataView(bogus.buffer).setUint32(1, 7);
    await server.write(bogus);

    const response = await readResponse(client);
    await expect(response.text()).rejects.toThrow(/END frame/);
  });

  it('rejects an unknown body frame tag', async () => {
    const { client, server } = createStreamPair();

    await server.write(headFrame(encoder.encode(JSON.stringify({ status: 200, headers: [] }))));
    const bogus = new Uint8Array(5);
    bogus[0] = 0x7f;
    await server.write(bogus);

    const response = await readResponse(client);
    await expect(response.text()).rejects.toThrow(/tag 127/);
  });

  it('treats a truncated body as a failure rather than a clean end', async () => {
    const { client, server } = createStreamPair();

    await server.write(headFrame(encoder.encode(JSON.stringify({ status: 200, headers: [] }))));
    // One DATA frame, then the stream ends with no terminal frame.
    const data = new Uint8Array(5 + 4);
    data[0] = 0x00;
    new DataView(data.buffer).setUint32(1, 4);
    data.set(encoder.encode('part'), 5);
    await server.write(data);
    await server.finish();

    const response = await readResponse(client);
    await expect(response.text()).rejects.toThrow();
  });

  it("cancelling a response body stops the peer's send side", async () => {
    const { client, server, clientRecord } = createStreamPair();

    await server.write(headFrame(encoder.encode(JSON.stringify({ status: 200, headers: [] }))));
    const data = new Uint8Array(5 + 4);
    data[0] = 0x00;
    new DataView(data.buffer).setUint32(1, 4);
    data.set(encoder.encode('part'), 5);
    await server.write(data);

    const response = await readResponse(client);
    await response.body?.cancel();

    expect(clientRecord.stopped).toBe(true);
  });
});
