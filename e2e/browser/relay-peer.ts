/**
 * A Node peer for the browser suite, reachable through the n0 relays.
 *
 * Browsers cannot dial a peer directly, so unlike the rest of the suite this
 * needs the network. The peer serves the conformance API, plus `/sink`, which
 * reads a request body that the browser tests keep streaming, and records how
 * the upload ends.
 */

import { Endpoint, EndpointTicket } from '@number0/iroh';
import { ALPN, connect, serve, type Handler } from '@strangecyan/iroh-http-node';
import { handler } from '../api.ts';

/**
 * One `/sink?id=…` upload as the peer saw it. A reset exchange fails the read,
 * while one that is merely abandoned stays open.
 */
export interface SinkState {
  received: number;
  outcome: 'open' | 'ended' | 'failed';
}

async function bindRelayed(): Promise<Endpoint> {
  const builder = Endpoint.builder();
  builder.applyN0();
  builder.alpns([ALPN]);
  return await builder.bind();
}

const sinks = new Map<string, SinkState>();

// Count the upload until it ends, which a clean end or a reset decides; the
// reply is only sent then, so a tab that keeps uploading never receives one.
const sink: Handler = async request => {
  const state: SinkState = { received: 0, outcome: 'open' };
  sinks.set(new URL(request.url).searchParams.get('id') ?? '', state);
  try {
    for await (const chunk of request.body ?? []) state.received += chunk.byteLength;
    state.outcome = 'ended';
  } catch {
    state.outcome = 'failed';
  }
  return new Response(null, { status: 204 });
};

let endpoint: Promise<Endpoint> | undefined = undefined;
let ticket: Promise<string> | undefined = undefined;

/** Start the peer on first use, and return its ticket. */
export function peerTicket(): Promise<string> {
  ticket ??= (async () => {
    endpoint = bindRelayed();
    const bound = await endpoint;
    serve(bound, (request, caller) =>
      new URL(request.url).pathname === '/sink' ? sink(request, caller) : handler(request, caller)
    );
    await bound.online();
    return EndpointTicket.fromAddr(bound.addr()).toString();
  })();
  return ticket;
}

/** How the `/sink?id=…` upload stands, if it has started. */
export function sinkState(id: string): SinkState | undefined {
  return sinks.get(id);
}

/** Close the peer if it was started, since its endpoint keeps Node running. */
export async function closeRelayPeer(): Promise<void> {
  await (await endpoint)?.close();
}

/** Dial `target` from a fresh Node endpoint, reporting how the attempt ended. */
export async function dialFromNode(target: string): Promise<string> {
  const dialer = await bindRelayed();
  try {
    const client = await connect(dialer, EndpointTicket.fromString(target).endpointAddr());
    client.close();
    return 'connected';
  } catch (error) {
    return String(error);
  } finally {
    await dialer.close();
  }
}
