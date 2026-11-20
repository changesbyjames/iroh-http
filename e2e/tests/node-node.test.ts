/**
 * Node to Node: both peers use the TypeScript implementation.
 */

import { afterAll, assert, beforeAll, describe, expect, it, vi } from 'vitest';
import { connect, serve, type IrohHttpClient, type IrohHttpServer } from '@strangecyan/iroh-http-node';
import type { Endpoint } from '@number0/iroh';
import { conformance, handler } from '../api.ts';
import { bind } from '../peers.ts';

interface NodePeers {
  server: IrohHttpServer;
  serverEndpoint: Endpoint;
  clientEndpoint: Endpoint;
  client: IrohHttpClient;
}

describe('node to node', () => {
  let peers: NodePeers | undefined = undefined;
  const connected = (): NodePeers => {
    assert(peers, 'beforeAll did not connect the peers');
    return peers;
  };

  beforeAll(async () => {
    const serverEndpoint = await bind();
    const server = serve(serverEndpoint, handler);
    const clientEndpoint = await bind();
    // Relays are disabled locally, so the address is used directly rather than
    // a ticket, which would wait for a home relay that never arrives.
    const client = await connect(clientEndpoint, serverEndpoint.addr());
    peers = { server, serverEndpoint, clientEndpoint, client };
  });

  afterAll(async () => {
    const { server, clientEndpoint, client } = connected();
    client.close();
    await clientEndpoint.close();
    await server[Symbol.asyncDispose]();
  });

  conformance(
    () => connected().client,
    () => connected().clientEndpoint.id().toString()
  );

  it('aborts native header and body waits without closing the connection', async () => {
    const arrived = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const body = new TransformStream<Uint8Array, Uint8Array>();
    const writer = body.writable.getWriter();
    const serverEndpoint = await bind();
    const server = serve(serverEndpoint, async (request, peer) => {
      const path = new URL(request.url).pathname;
      if (path === '/delayed-headers') {
        arrived.resolve();
        await gate.promise;
        return new Response('too late');
      }
      if (path === '/stalled-body') return new Response(body.readable);
      return handler(request, peer);
    });
    const clientEndpoint = await bind();
    const client = await connect(clientEndpoint, serverEndpoint.addr());

    try {
      const headerAbort = new AbortController();
      const headerReason = new Error('cancel native header wait');
      const rejectedHeaders = expect(client.fetch('/delayed-headers', { signal: headerAbort.signal })).rejects.toBe(
        headerReason
      );
      await arrived.promise;
      headerAbort.abort(headerReason);
      await rejectedHeaders;
      await expect((await client.fetch('/ping')).text()).resolves.toBe('pong');
      gate.resolve();

      const bodyAbort = new AbortController();
      const response = await client.fetch('/stalled-body', { signal: bodyAbort.signal });
      const reader = response.body!.getReader();
      await writer.write(new TextEncoder().encode('first'));
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
      const rejectedRead = expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
      bodyAbort.abort();
      await rejectedRead;
      await expect(reader.read()).rejects.toBe(bodyAbort.signal.reason);
      await expect((await client.fetch('/ping')).text()).resolves.toBe('pong');
    } finally {
      gate.resolve();
      // The abandoned exchange cancelled the body, which errors its writer.
      await writer.close().catch(() => undefined);
      client.close();
      await clientEndpoint.close();
      await server[Symbol.asyncDispose]();
    }
  });

  it.each(['cancels the response body', 'aborts the fetch'])(
    'releases a streaming handler when the client %s',
    async departure => {
      const cancelled = Promise.withResolvers<DOMException>();
      const aborted = Promise.withResolvers<DOMException>();
      const serverEndpoint = await bind();
      // An event stream with a heartbeat. The native bindings deliver a stop
      // only once the read in flight returns, so a Node client's departure
      // reaches the server with the next bytes the server sends.
      const server = serve(serverEndpoint, request => {
        request.signal.addEventListener('abort', () => aborted.resolve(request.signal.reason), { once: true });
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise(resolve => setTimeout(resolve, 50));
            controller.enqueue(new TextEncoder().encode(': beat\n\n'));
          },
          cancel: reason => cancelled.resolve(reason)
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      });
      const clientEndpoint = await bind();
      const client = await connect(clientEndpoint, serverEndpoint.addr());

      try {
        const abort = new AbortController();
        const response = await client.fetch('/events', { signal: abort.signal });
        const reader = response.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe(': beat\n\n');
        // Long enough that the next read is waiting in the bindings.
        await new Promise(resolve => setTimeout(resolve, 10));

        if (departure === 'aborts the fetch') abort.abort();
        else await reader.cancel();

        const reason = await aborted.promise;
        expect(reason).toMatchObject({ name: 'AbortError', message: 'The peer abandoned the exchange' });
        await expect(cancelled.promise).resolves.toBe(reason);
        // Only that exchange is abandoned.
        await expect((await client.fetch('/events')).body!.getReader().read()).resolves.toMatchObject({ done: false });
      } finally {
        client.close();
        await clientEndpoint.close();
        await server[Symbol.asyncDispose]();
      }
    }
  );

  it('releases a streaming handler with nothing to send when the connection closes', async () => {
    const cancelled = Promise.withResolvers<DOMException>();
    const aborted = Promise.withResolvers<DOMException>();
    const serverEndpoint = await bind();
    // One event and then nothing, so no write is attempted after the client has gone.
    const server = serve(serverEndpoint, request => {
      request.signal.addEventListener('abort', () => aborted.resolve(request.signal.reason), { once: true });
      const body = new ReadableStream<Uint8Array>({
        start: controller => controller.enqueue(new TextEncoder().encode('data: first\n\n')),
        cancel: reason => cancelled.resolve(reason)
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const clientEndpoint = await bind();
    const client = await connect(clientEndpoint, serverEndpoint.addr());

    try {
      const response = await client.fetch('/events');
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n');

      client.close();

      const reason = await aborted.promise;
      expect(reason).toMatchObject({ name: 'AbortError' });
      await expect(cancelled.promise).resolves.toBe(reason);
    } finally {
      client.close();
      await clientEndpoint.close();
      await server[Symbol.asyncDispose]();
    }
  });

  it('aborts the request signal of a handler still running when the server is disposed', async () => {
    const arrived = Promise.withResolvers<AbortSignal>();
    const serverEndpoint = await bind();
    const server = serve(serverEndpoint, async request => {
      arrived.resolve(request.signal);
      // Answers only once told the exchange was abandoned.
      await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
      return new Response('too late');
    });
    const clientEndpoint = await bind();
    const client = await connect(clientEndpoint, serverEndpoint.addr());

    try {
      const rejected = expect(client.fetch('/wait')).rejects.toThrow();
      const signal = await arrived.promise;
      expect(signal.aborted).toBe(false);

      // Disposal waits for exchanges in flight, so it returning shows the handler was released.
      await server[Symbol.asyncDispose]();

      expect(signal.aborted).toBe(true);
      await rejected;
    } finally {
      client.close();
      await clientEndpoint.close();
      await server[Symbol.asyncDispose]();
    }
  });

  it('does not abort the request signal of an exchange that completes', async () => {
    const signals: AbortSignal[] = [];
    const serverEndpoint = await bind();
    const server = serve(serverEndpoint, request => {
      signals.push(request.signal);
      return new Response('done');
    });
    const clientEndpoint = await bind();
    const client = await connect(clientEndpoint, serverEndpoint.addr());

    try {
      await expect((await client.fetch('/done')).text()).resolves.toBe('done');
      // A later exchange on the connection shows the first has fully settled.
      await expect((await client.fetch('/done')).text()).resolves.toBe('done');
      expect(signals[0].aborted).toBe(false);
    } finally {
      client.close();
      await clientEndpoint.close();
      await server[Symbol.asyncDispose]();
    }
  });

  it('aborts a native upload stalled on its source', async () => {
    const reading = Promise.withResolvers<void>();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      { pull: () => reading.resolve(), cancel: cancelled },
      { highWaterMark: 0 }
    );
    const abort = new AbortController();
    const reason = new Error('cancel native upload');
    const init = { method: 'POST', body, duplex: 'half' as const, signal: abort.signal };
    const rejected = expect(connected().client.fetch('/echo', init)).rejects.toBe(reason);

    await reading.promise;
    abort.abort(reason);
    await rejected;
    expect(cancelled).toHaveBeenCalledWith(reason);
    await expect((await connected().client.fetch('/ping')).text()).resolves.toBe('pong');
  });
});
