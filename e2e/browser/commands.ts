/**
 * Commands the browser suite runs in Node, where the relay peer lives.
 */

import type { BrowserCommand } from 'vitest/node';
import type { SinkState } from './relay-peer.ts';

type RelayPeerModule = typeof import('./relay-peer.ts');

/**
 * Load the peer through Node at run time. `@number0/iroh` names a `main` that
 * does not exist, which Node tolerates but Vite's config bundler does not.
 */
async function peerModule(): Promise<RelayPeerModule> {
  const specifier = new URL('./relay-peer.ts', import.meta.url).href;
  // SAFETY: `specifier` is this module's sibling `relay-peer.ts`.
  return (await import(specifier)) as RelayPeerModule;
}

declare module 'vitest/browser' {
  interface BrowserCommands {
    /** A ticket for the relay peer. */
    peerTicket: () => Promise<string>;
    /** How the relay peer's `/sink?id=…` upload stands, if it has started. */
    sinkState: (id: string) => Promise<SinkState | undefined>;
    /** Dial `ticket` from Node, reporting how the attempt ended. */
    dialFromNode: (ticket: string) => Promise<string>;
  }
}

const peerTicket: BrowserCommand<[]> = async () => await (await peerModule()).peerTicket();
const sinkState: BrowserCommand<[id: string]> = async (_context, id) => (await peerModule()).sinkState(id);
const dialFromNode: BrowserCommand<[ticket: string]> = async (_context, ticket) =>
  await (await peerModule()).dialFromNode(ticket);

export const commands = { peerTicket, sinkState, dialFromNode };

/** Close the relay peer, if a command started it. */
export async function closeRelayPeer(): Promise<void> {
  await (await peerModule()).closeRelayPeer();
}
