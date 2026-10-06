/**
 * Node to Node: both peers use the TypeScript implementation.
 */

import { afterAll, assert, beforeAll, describe } from 'vitest';
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
});
