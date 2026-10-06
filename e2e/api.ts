/**
 * The shared conformance API and its assertions.
 *
 * `handler` is the TypeScript implementation; `crates/iroh-http/examples/
 * testserver.rs` is the byte-for-byte equivalent in Rust. `conformance()` runs
 * one set of assertions against either, which is what proves the two
 * implementations of `SPEC.md` agree.
 */

import { expect, it } from 'vitest';
import type { Handler } from '@strangecyan/iroh-http-node';

const encoder = new TextEncoder();

/** The minimum a peer must offer for the conformance suite to run. */
export interface ConformanceClient {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

const ping: Handler = () => new Response('pong', { headers: { 'content-type': 'text/plain' } });

// Echoes the request body back, proving streamed uploads arrive intact.
const echo: Handler = async request => {
  const message = new URL(request.url).searchParams.get('msg');
  if (message !== null) return new Response(message);
  return new Response(await request.arrayBuffer());
};

// Reflects the received header list, in order, as JSON.
const reflectHeaders: Handler = request => {
  const pairs: string[][] = [];
  for (const [name, value] of request.headers) pairs.push([name, value]);
  return Response.json(pairs);
};

// Reports the authenticated caller, which no header could prove.
const reportPeer: Handler = (_request, peer) => new Response(peer.endpointId);

// Reports the URL the server reconstructed, authority included.
const reportUri: Handler = request => new Response(request.url);

// Two distinct set-cookie values, which a header map must not join.
const cookies: Handler = () => {
  const headers = new Headers();
  headers.append('set-cookie', 'first=1');
  headers.append('set-cookie', 'second=2');
  return new Response('ok', { headers });
};

// An arbitrary status code, with and without a body: 204, 205, and 304 forbid one.
const status: Handler = request => {
  const code = Number(new URL(request.url).searchParams.get('code') ?? '200');
  const bodyless = code === 204 || code === 205 || code === 304;
  return new Response(bodyless ? null : 'body', { status: code });
};

// A chunked body delivered over time, exercising streamed downloads.
const stream: Handler = request => {
  const count = Number(new URL(request.url).searchParams.get('chunks') ?? '3');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < count; index += 1) {
        controller.enqueue(encoder.encode(`chunk-${String(index)};`));
      }
      controller.close();
    }
  });
  return new Response(body, { headers: { 'content-type': 'text/plain' } });
};

// A body larger than MAX_CHUNK_SIZE, forcing multi-frame transfer.
const large: Handler = request => {
  const size = Number(new URL(request.url).searchParams.get('bytes') ?? String(3 * 1024 * 1024));
  return new Response(new Uint8Array(size).fill(0x78));
};

// Fails after the head is committed, exercising the ERROR body frame.
const failMidway: Handler = () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('partial'));
    },
    pull() {
      throw new Error('deliberate failure');
    }
  });
  return new Response(body);
};

const routes = new Map<string, Handler>([
  ['/ping', ping],
  ['/echo', echo],
  ['/headers', reflectHeaders],
  ['/peer', reportPeer],
  ['/uri', reportUri],
  ['/cookies', cookies],
  ['/status', status],
  ['/stream', stream],
  ['/large', large],
  ['/fail-midway', failMidway]
]);

/** The TypeScript implementation of the conformance API. */
export const handler: Handler = (request, peer) => {
  const route = routes.get(new URL(request.url).pathname);
  return route ? route(request, peer) : new Response('not found', { status: 404 });
};

/**
 * Assertions every peer pairing must satisfy.
 *
 * `peerId` is the endpoint id the *server* should see, which is the dialling
 * endpoint's id.
 */
export function conformance(client: () => ConformanceClient, peerId: () => string): void {
  it('round trips a status, headers, and a body', async () => {
    const response = await client().fetch('/ping');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain');
    await expect(response.text()).resolves.toBe('pong');
  });

  it('returns 404 for an unknown path', async () => {
    const response = await client().fetch('/nowhere');

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe('not found');
  });

  it('carries the query string through to the handler', async () => {
    const response = await client().fetch('/echo?msg=hello');

    await expect(response.text()).resolves.toBe('hello');
  });

  it('preserves a percent-encoded target verbatim', async () => {
    // Decoding is the application's business; the wire must not alter the
    // target. Asserting on the reconstructed URL keeps both peers honest even
    // though their query parsers differ.
    const response = await client().fetch('/uri?msg=hello%20world&flag');

    await expect(response.text()).resolves.toBe(`http://${peerId()}.iroh/uri?msg=hello%20world&flag`);
  });

  it('delivers a request body', async () => {
    const response = await client().fetch('/echo', { method: 'POST', body: 'upload me' });

    await expect(response.text()).resolves.toBe('upload me');
  });

  it('delivers a request body larger than one frame', async () => {
    const payload = 'y'.repeat(3 * 1024 * 1024);
    const response = await client().fetch('/echo', { method: 'POST', body: payload });

    await expect(response.text()).resolves.toBe(payload);
  });

  it('preserves request headers and their lowercase names', async () => {
    const response = await client().fetch('/headers', {
      headers: { 'X-Probe': 'abc', 'X-Trace': 'def' }
    });

    // SAFETY: `/headers` replies with a JSON list of `[name, value]` pairs; the expectations check its contents.
    const pairs = (await response.json()) as [string, string][];
    expect(pairs).toEqual(expect.arrayContaining([['x-probe', 'abc']]));
    expect(pairs).toEqual(expect.arrayContaining([['x-trace', 'def']]));
  });

  it('drops hop-by-hop request headers', async () => {
    const response = await client().fetch('/headers', { headers: { Connection: 'keep-alive' } });

    // SAFETY: `/headers` replies with a JSON list of `[name, value]` pairs.
    const pairs = (await response.json()) as [string, string][];
    expect(pairs.map(([name]) => name)).not.toContain('connection');
  });

  it('keeps repeated response headers separate', async () => {
    const response = await client().fetch('/cookies');

    // `getSetCookie` is the only way to observe repeated values faithfully.
    expect(response.headers.getSetCookie()).toEqual(['first=1', 'second=2']);
  });

  it('exposes the authenticated calling endpoint to the handler', async () => {
    const response = await client().fetch('/peer');

    await expect(response.text()).resolves.toBe(peerId());
  });

  it('reconstructs a request URL whose authority is the caller', async () => {
    const response = await client().fetch('/uri');

    await expect(response.text()).resolves.toBe(`http://${peerId()}.iroh/uri`);
  });

  it.each([201, 400, 404, 418, 500])('round trips status %i', async code => {
    const response = await client().fetch(`/status?code=${String(code)}`);

    expect(response.status).toBe(code);
    await expect(response.text()).resolves.toBe('body');
  });

  it.each([204, 304])('round trips bodyless status %i', async code => {
    const response = await client().fetch(`/status?code=${String(code)}`);

    expect(response.status).toBe(code);
    await expect(response.text()).resolves.toBe('');
  });

  it('streams a chunked response body', async () => {
    const response = await client().fetch('/stream?chunks=5');

    await expect(response.text()).resolves.toBe('chunk-0;chunk-1;chunk-2;chunk-3;chunk-4;');
  });

  it('delivers a response body larger than one frame', async () => {
    const response = await client().fetch('/large?bytes=3000000');

    const body = await response.arrayBuffer();
    expect(body.byteLength).toBe(3_000_000);
    expect(new Uint8Array(body).every(byte => byte === 0x78)).toBe(true);
  });

  it('surfaces a mid-stream body failure as an error, not a clean end', async () => {
    const response = await client().fetch('/fail-midway');

    // The head arrived successfully, so the status is 200 either way.
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
  });

  it('serves concurrent requests over one connection', async () => {
    const peer = client();
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        peer.fetch(`/echo?msg=item-${String(index)}`).then(response => response.text())
      )
    );

    expect(responses).toEqual(Array.from({ length: 12 }, (_, index) => `item-${String(index)}`));
  });

  it('returns the response head before the body completes', async () => {
    // Reading only the first chunk, then cancelling, shows the head did not wait for the body.
    const response = await client().fetch('/stream?chunks=3');
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toBe('chunk-0;');
    await reader?.cancel();
  });
}
