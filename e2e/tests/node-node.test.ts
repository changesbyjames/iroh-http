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
      await writer.close();
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
