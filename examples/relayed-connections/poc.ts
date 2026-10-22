/**
 * Proof of concept: one agent endpoint, one identity, serving every peer on a fixed list. Peers allowed `direct`
 * holepunch to it; peers allowed only `relayed` reach it through the relay without ever learning its IP addresses;
 * everyone else is refused before the handshake.
 *
 * It starts a local iroh-relay, binds the agent and four peers to it with fixed keys, has each peer make an HTTP
 * request, then reports what each peer learned about the agent's addresses and which path its connection uses.
 *
 *   node poc.ts
 *
 * Set IROH_RELAY_BIN to the iroh-relay binary (built from the iroh fork) if it is not at the default path.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Endpoint, EndpointAddr, RelayMode, SecretKey, type Connection } from '@number0/iroh';
import { ALPN, clientFor, serve, type Admission, type IncomingPeer } from '@strangecyan/iroh-http-node';

/** One entry of the fixed list, standing in for what the studio API would say about a device. */
interface EndpointEntry {
  endpointId: string;
  allow: Allowance;
}

/** How the device may connect: through the relay, and directly. */
interface Allowance {
  relayed: boolean;
  direct: boolean;
}

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const RELAY_URL = 'http://127.0.0.1:3340';
const RELAY_BIN = process.env.IROH_RELAY_BIN ?? here('../../../../forks/iroh/target/release/iroh-relay');

/** How long a peer gets to holepunch before its paths are read. */
const SETTLE_MS = 5_000;

/** Fixed keys, so the list's endpoint IDs stay valid: 32 bytes of `seed`. */
const secretKey = (seed: number) => SecretKey.fromBytes(Array.from({ length: 32 }, () => seed));

const AGENT_SEED = 1;
const PEERS = [
  { name: 'trusted', seed: 2, expected: 'direct' },
  { name: 'relayed', seed: 3, expected: 'relayed' },
  { name: 'listed, nothing allowed', seed: 4, expected: 'refused' },
  { name: 'not listed', seed: 5, expected: 'refused' }
] as const;

const normaliseUrl = (url: string) => new URL(url).href;

/** The agent's policy: relayed only through its own relay, and as the list allows. */
function admission(list: EndpointEntry[], peer: IncomingPeer): Admission {
  // Over IP the peer is unknown until the handshake, but it already has an address of ours: nothing is left to hide.
  // Not reached here, since peers only know the agent's relay URL.
  if (peer.kind === 'ip') return 'direct';
  if (peer.kind !== 'relay' || peer.relayUrl === undefined) return 'refuse';
  // On another relay, anyone could have made the key.
  if (normaliseUrl(peer.relayUrl) !== normaliseUrl(RELAY_URL)) return 'refuse';
  const entry = list.find(candidate => candidate.endpointId === peer.endpointId);
  if (entry?.allow.direct) return 'direct';
  if (entry?.allow.relayed) return 'relayed';
  return 'refuse';
}

/**
 * Start the local relay and poll its health check until it answers, failing early if the process exits, which is
 * what a missing binary looks like.
 */
async function startRelay(): Promise<ChildProcess> {
  const relay = spawn(RELAY_BIN, ['--dev', '--config-path', here('./relay.toml')], {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  relay.stderr?.resume();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (relay.exitCode !== null) throw new Error(`iroh-relay exited with ${relay.exitCode}; is ${RELAY_BIN} built?`);
    const healthy = await fetch(`${RELAY_URL}/healthz`).then(
      response => response.ok,
      () => false
    );
    if (healthy) return relay;
    await sleep(100);
  }
  relay.kill();
  throw new Error('iroh-relay did not become healthy');
}

/** An endpoint with a fixed key, on the local relay alone, with no address lookup. */
async function bind(seed: number): Promise<Endpoint> {
  const builder = Endpoint.builder();
  builder.applyMinimal();
  builder.secretKey(secretKey(seed).toBytes());
  builder.alpns([ALPN]);
  builder.relayMode(RelayMode.customFromUrls([RELAY_URL]));
  const endpoint = await builder.bind();
  await endpoint.online();
  return endpoint;
}

/** Wait until the connection selects a direct path, or the time runs out. */
async function settle(connection: Connection) {
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    if (connection.paths().some(path => path.isIp && path.isSelected)) return;
    await sleep(100);
  }
}

interface Outcome {
  peer: string;
  expected: string;
  observed: string;
  response: string;
  selectedPath: string;
  directPaths: number;
  agentAddressesLearned: string[];
}

/**
 * Bind the peer, dial the agent by ID and relay URL alone, and make one request. A refused peer fails either to
 * connect or, once the agent closes the connection, to get a response. An admitted one gets time to holepunch, then
 * its paths and what it learned of the agent's addresses decide whether it went direct.
 */
async function tryPeer(agent: Endpoint, name: string, seed: number, expected: string): Promise<Outcome> {
  const endpoint = await bind(seed);
  const outcome: Outcome = {
    peer: name,
    expected,
    observed: 'refused',
    response: '-',
    selectedPath: '-',
    directPaths: 0,
    agentAddressesLearned: []
  };
  try {
    // Only the agent's ID and relay: the peer starts with no address of the agent's.
    const address = new EndpointAddr(agent.id(), RELAY_URL, []);
    const connection = await endpoint.connect(address, ALPN).catch(() => undefined);
    if (!connection) return outcome;
    const client = clientFor(connection);
    // A refused connection can still complete the client's half of the handshake, then close: the request fails.
    try {
      const response = await client.fetch('/whoami');
      outcome.response = `${response.status} ${await response.text()}`;
    } catch {
      return outcome;
    }
    await settle(connection);
    const paths = connection.paths();
    const selected = paths.find(path => path.isSelected);
    outcome.selectedPath = selected ? `${selected.isIp ? 'ip' : 'relay'} ${selected.remoteAddr}` : 'none';
    outcome.directPaths = paths.filter(path => path.isIp).length;
    outcome.agentAddressesLearned = (await endpoint.remoteAddr(agent.id()))?.directAddresses() ?? [];
    outcome.observed = outcome.directPaths > 0 || outcome.agentAddressesLearned.length > 0 ? 'direct' : 'relayed';
    client.close();
    return outcome;
  } finally {
    await endpoint.close();
  }
}

async function main() {
  // SAFETY: endpoints.json is the fixed list beside this script, written in the EndpointEntry shape.
  const list = JSON.parse(await readFile(here('./endpoints.json'), 'utf8')) as EndpointEntry[];
  const relay = await startRelay();
  try {
    const agent = await bind(AGENT_SEED);
    console.log(`agent ${agent.id().toString()}`);
    console.log(`agent's own direct addresses: ${agent.addr().directAddresses().join(', ') || 'none'}\n`);
    const server = serve(agent, (_request, peer) => new Response(peer.endpointId.slice(0, 8)), {
      admit: peer => {
        const decision = admission(list, peer);
        console.log(`  admit ${peer.kind} ${peer.endpointId?.slice(0, 8) ?? peer.address}: ${decision}`);
        return decision;
      }
    });
    try {
      const outcomes: Outcome[] = [];
      for (const peer of PEERS) {
        console.log(`${peer.name} (${secretKey(peer.seed).public().toString().slice(0, 8)})`);
        outcomes.push(await tryPeer(agent, peer.name, peer.seed, peer.expected));
      }
      console.log();
      console.table(
        outcomes.map(outcome => ({ ...outcome, agentAddressesLearned: outcome.agentAddressesLearned.join(', ') }))
      );
      const failed = outcomes.filter(outcome => outcome.observed !== outcome.expected);
      if (failed.length > 0) {
        console.error(`FAIL: ${failed.map(outcome => outcome.peer).join(', ')} did not behave as expected`);
        process.exitCode = 1;
      } else {
        console.log('PASS: every peer was admitted as the list allows');
      }
    } finally {
      await server[Symbol.asyncDispose]();
    }
  } finally {
    relay.kill();
  }
}

await main();
