/**
 * The shared worker behind {@link createSharedEndpoint}.
 *
 * Owns one Iroh endpoint and every connection and stream opened on it, on
 * behalf of each tab attached to it. The endpoint lives as long as the worker.
 * Inbound connections are always refused.
 *
 * @module
 */

import { createEndpoint, getAddressFromString, type EndpointOptions, type IrohHttpEndpoint } from './index.ts';
import type { IrohHttpConnection, IrohHttpStream } from './wasm/iroh_http_browser.js';
import type { SharedCall, SharedInput, SharedOp, SharedOutput, SharedReply } from './shared-protocol.ts';

/** The endpoint bound in this worker, and the relays it was bound with. */
interface Binding {
  endpoint: Promise<IrohHttpEndpoint>;
  relay: string;
}

/** One tab's attachment: its endpoint, and the connections and streams it owns. */
interface Session {
  endpoint: Promise<IrohHttpEndpoint> | undefined;
  connections: Map<number, IrohHttpConnection>;
  streams: Map<number, IrohHttpStream>;
}

let binding: Binding | undefined = undefined;
let nextHandle = 0;

/** Refuse every inbound connection until the endpoint closes. */
async function refuseInbound(endpoint: IrohHttpEndpoint): Promise<void> {
  for (;;) {
    const incoming = await endpoint.accept();
    if (!incoming) return;
    incoming.refuse();
  }
}

/** Share the bound endpoint, or bind one if there is none. */
function bind(options: EndpointOptions): Promise<IrohHttpEndpoint> {
  // The worker is named for the secret key alone, so a tab asking for other
  // relays would otherwise silently get these ones.
  const relay = JSON.stringify(options.relay ?? 'default');
  if (binding) {
    if (binding.relay !== relay) {
      throw new Error('This secret key is already bound with a different relay configuration');
    }
    return binding.endpoint;
  }

  const bound: Binding = { endpoint: createEndpoint(options), relay };
  binding = bound;
  bound.endpoint
    .then(
      endpoint => refuseInbound(endpoint),
      () => {
        // Let the next tab try binding again.
        if (binding === bound) binding = undefined;
      }
    )
    .catch(() => undefined);
  return bound.endpoint;
}

function endpointOf(session: Session): Promise<IrohHttpEndpoint> {
  if (!session.endpoint) throw new Error('The session is not attached');
  return session.endpoint;
}

function lookup<T>(handles: Map<number, T>, handle: number): T {
  const value = handles.get(handle);
  if (value === undefined) throw new Error('The connection or stream is closed');
  return value;
}

/** Name a connection or stream with a handle. */
function store<T>(handles: Map<number, T>, value: T): number {
  nextHandle += 1;
  handles.set(nextHandle, value);
  return nextHandle;
}

type Operations = {
  [Op in SharedOp]: (session: Session, input: SharedInput<Op>) => Promise<SharedOutput<Op>>;
};

const operations: Operations = {
  attach: async (session, options) => {
    if (session.endpoint) throw new Error('The session is already attached');
    const endpoint = bind(options);
    session.endpoint = endpoint;
    return (await endpoint).endpointId();
  },
  detach: async session => {
    // Cleared first, so that a connection or stream still opening is
    // discarded rather than stored after the cleanup below.
    session.endpoint = undefined;
    const streams = [...session.streams.values()];
    const connections = [...session.connections.values()];
    session.streams.clear();
    session.connections.clear();
    for (const connection of connections) connection.close();
    await Promise.all(streams.map(stream => stream.reset()));
    return undefined;
  },
  ticket: async session => await (await endpointOf(session)).ticket(),
  connect: async (session, { ticket }) => {
    const endpoint = await endpointOf(session);
    const connection = await endpoint.connect(await getAddressFromString(ticket));
    // The session may have detached during the handshake.
    if (!session.endpoint) {
      connection.close();
      throw new Error('The session is closed');
    }
    return { connection: store(session.connections, connection), remoteId: connection.remoteId() };
  },
  openStream: async (session, { connection }) => {
    const stream = await lookup(session.connections, connection).openStream();
    if (!session.endpoint) {
      await stream.reset();
      throw new Error('The session is closed');
    }
    return store(session.streams, stream);
  },
  closeConnection: async (session, { connection }) => {
    session.connections.get(connection)?.close();
    return undefined;
  },
  write: async (session, { stream, bytes }) => {
    await lookup(session.streams, stream).write(bytes);
    return undefined;
  },
  readExact: async (session, { stream, size }) => await lookup(session.streams, stream).readExact(size),
  finish: async (session, { stream }) => {
    await lookup(session.streams, stream).finish();
    return undefined;
  },
  stop: async (session, { stream }) => {
    await session.streams.get(stream)?.stop();
    return undefined;
  },
  reset: async (session, { stream }) => {
    await session.streams.get(stream)?.reset();
    return undefined;
  },
  release: async (session, { handle }) => {
    // Dropping the last reference lets wasm-bindgen free the object, and Iroh
    // then closes a connection that nothing else holds.
    session.connections.delete(handle);
    session.streams.delete(handle);
    return undefined;
  }
};

function perform<Op extends SharedOp>(session: Session, op: Op, input: SharedInput<Op>): Promise<SharedOutput<Op>> {
  const operation: Operations[Op] = operations[op];
  return operation(session, input);
}

function reply(port: MessagePort, message: SharedReply, transfer: Transferable[]): void {
  port.postMessage(message, transfer);
}

function serveSession(port: MessagePort): void {
  const session: Session = { endpoint: undefined, connections: new Map(), streams: new Map() };
  port.addEventListener('message', (event: MessageEvent<SharedCall>) => {
    const { id, op, input } = event.data;
    perform(session, op, input).then(
      // wasm-bindgen returns bytes in a buffer of their own, so it can be
      // transferred rather than copied.
      output => reply(port, { id, output }, output instanceof Uint8Array ? [output.buffer] : []),
      (error: Error | string) => reply(port, { id, error: error instanceof Error ? error.message : error }, [])
    );
  });
  port.start();
}

globalThis.addEventListener('connect', event => {
  if (!(event instanceof MessageEvent)) return;
  for (const port of event.ports) serveSession(port);
});
