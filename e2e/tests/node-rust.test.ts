/**
 * Node to Rust: a TypeScript client against the Rust server.
 *
 * This is the test that actually proves cross-language conformance, because the
 * assertions are the same ones `node-node.test.ts` runs.
 */

import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest';
import { connect, getAddressFromString, type IrohHttpClient } from '@strangecyan/iroh-http-node';
import type { Endpoint } from '@number0/iroh';
import { conformance } from '../api.ts';
import { bind, startRustPeer, type RustPeer } from '../peers.ts';

interface RustPeers {
  peer: RustPeer;
  clientEndpoint: Endpoint;
  client: IrohHttpClient;
}

// The server side is `crates/iroh-http/examples/testserver.rs`, the Rust
// equivalent of `handler` in `../api.ts`.
describe('node to rust', () => {
  let peers: RustPeers | undefined = undefined;
  const connected = (): RustPeers => {
    assert(peers, 'beforeAll did not connect the peers');
    return peers;
  };

  beforeAll(async () => {
    const peer = await startRustPeer();
    const clientEndpoint = await bind();
    const client = await connect(clientEndpoint, getAddressFromString(peer.ticket));
    peers = { peer, clientEndpoint, client };
  });

  afterAll(async () => {
    const { peer, clientEndpoint, client } = connected();
    client.close();
    await clientEndpoint.close();
    await peer[Symbol.asyncDispose]();
  });

  conformance(
    () => connected().client,
    () => connected().clientEndpoint.id().toString()
  );

  it('cancels an upload waiting on its source once the server answers without reading it', async () => {
    const cancelled = Promise.withResolvers<Error>();
    const body = new ReadableStream<Uint8Array>({ cancel: reason => cancelled.resolve(reason) });
    const init = { method: 'POST', body, duplex: 'half' as const };

    const response = await connected().client.fetch('/ping', init);

    await expect(response.text()).resolves.toBe('pong');
    // Nothing is ever written to the upload, so only the server stopping it can end it.
    await expect(cancelled.promise).resolves.toMatchObject({ name: 'AbortError' });
  });
});
