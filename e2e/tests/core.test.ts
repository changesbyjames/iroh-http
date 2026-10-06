/**
 * Unit coverage for the wire codec, with no network involved.
 *
 * These are the cases that are awkward to provoke through two real peers,
 * because they require sending bytes no conformant implementation would send.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  HEAD_PREFIX_SIZE,
  MAX_HEAD_SIZE,
  readResponse,
  serveExchange,
  writeRequest,
  type Handler
} from '@strangecyan/iroh-http-core';
import { createStreamPair } from '../streams.ts';

const peer = { endpointId: 'test-endpoint' };
const encoder = new TextEncoder();

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
