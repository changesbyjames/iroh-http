/**
 * Node to Rust: a TypeScript client against the Rust server.
 *
 * This is the test that actually proves cross-language conformance, because the
 * assertions are the same ones `node-node.test.ts` runs.
 */

import { afterAll, assert, beforeAll, describe } from 'vitest';
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
});
