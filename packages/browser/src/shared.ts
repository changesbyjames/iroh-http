/**
 * One Iroh endpoint per secret key, shared by every tab and window of an origin.
 *
 * Iroh admits one endpoint per id to a relay at a time, so a second tab binding
 * the same secret key disconnects the first. Here a `SharedWorker`, named for
 * the key, owns the endpoint instead, and every tab reaches it through a
 * `MessagePort`. Each tab still runs its own {@link IrohHttpClient}; only the
 * byte streams beneath it are forwarded to the worker.
 *
 * The endpoint lives as long as the worker, which the browser ends once no tab
 * of the origin uses it. Closing a shared endpoint resets that tab's exchanges
 * and closes its connections. A tab that goes away without closing leaves its
 * exchanges to run until the peer ends them or the worker ends.
 *
 * A shared endpoint is outbound only: the worker refuses every inbound
 * connection.
 *
 * @module
 */

import { IrohHttpClient, type Connection, type ExchangeStream } from '@strangecyan/iroh-http-core';
import type { BrowserRelay } from './index.ts';
import type { SharedCall, SharedInput, SharedOp, SharedOutput, SharedReply } from './shared-protocol.ts';

/** Options for {@link createSharedEndpoint}. */
export interface SharedEndpointOptions {
  /** The 32-byte Iroh secret key that every tab sharing the endpoint uses. */
  secretKey: Uint8Array;
  /**
   * Production relays by default, staging relays, or a custom relay list. Every
   * tab sharing a secret key must ask for the same relays.
   */
  relay?: BrowserRelay;
  /**
   * Start the shared worker, for bundlers that cannot follow the default
   * `new URL('./shared-worker.js', import.meta.url)`. It must load
   * `@strangecyan/iroh-http-browser/shared-worker` as a module worker with the
   * given name, which is what makes tabs using the same key share it.
   */
  worker?: (name: string) => SharedWorker;
}

interface PendingCall {
  resolve: (output: SharedOutput<SharedOp>) => void;
  reject: (error: Error) => void;
}

function startWorker(name: string): SharedWorker {
  return new SharedWorker(new URL('./shared-worker.js', import.meta.url), { type: 'module', name });
}

/** Calls into the shared worker over one tab's port. */
class WorkerPort {
  private nextId = 0;
  private readonly pending = new Map<number, PendingCall>();
  private failure: Error | undefined = undefined;
  /** Tells the worker about handles the tab can no longer reach. */
  readonly releases = new FinalizationRegistry<number>(handle => {
    this.call('release', { handle }).catch(() => undefined);
  });

  constructor(private readonly port: MessagePort) {
    port.addEventListener('message', (event: MessageEvent<SharedReply>) => this.settle(event.data));
    port.start();
  }

  call<Op extends SharedOp>(op: Op, input: SharedInput<Op>, transfer: Transferable[] = []): Promise<SharedOutput<Op>> {
    if (this.failure) return Promise.reject(this.failure);
    this.nextId += 1;
    const id = this.nextId;
    const call: SharedCall<Op> = { id, op, input };
    return new Promise<SharedOutput<Op>>((resolve, reject) => {
      this.pending.set(id, {
        // SAFETY: the worker answers each call id with that call's output.
        resolve: output => resolve(output as SharedOutput<Op>),
        reject
      });
      this.port.postMessage(call, transfer);
    });
  }

  /**
   * Detach from the worker, which abandons this tab's exchanges. Calls still
   * pending, and every call after, reject at once.
   */
  async detach(): Promise<void> {
    if (this.failure) return;
    const detaching = this.call('detach', undefined);
    const detachId = this.nextId;
    this.failure = new Error('The shared endpoint is closed');
    for (const [id, call] of this.pending) {
      if (id === detachId) continue;
      this.pending.delete(id);
      call.reject(this.failure);
    }
    // A worker that has already gone has nothing left to detach.
    await detaching.catch(() => undefined);
    this.fail(this.failure);
  }

  /** Reject every call, now and from now on. */
  fail(error: Error): void {
    this.failure ??= error;
    for (const call of this.pending.values()) call.reject(this.failure);
    this.pending.clear();
    this.port.close();
  }

  private settle(message: SharedReply): void {
    const call = this.pending.get(message.id);
    if (!call) return;
    this.pending.delete(message.id);
    if ('error' in message) call.reject(new Error(message.error));
    else call.resolve(message.output);
  }
}

/** An {@link ExchangeStream} whose QUIC stream lives in the shared worker. */
class SharedExchangeStream implements ExchangeStream {
  constructor(
    private readonly port: WorkerPort,
    private readonly stream: number
  ) {}

  async write(bytes: Uint8Array): Promise<void> {
    // The caller keeps its buffer, so a copy is transferred rather than it.
    const copy = bytes.slice();
    await this.port.call('write', { stream: this.stream, bytes: copy }, [copy.buffer]);
  }

  async readExact(size: number): Promise<Uint8Array> {
    if (size === 0) return new Uint8Array(0);
    return await this.port.call('readExact', { stream: this.stream, size });
  }

  async finish(): Promise<void> {
    await this.port.call('finish', { stream: this.stream });
  }

  async stop(): Promise<void> {
    // Failure means the stream is already gone, which is what stopping wants.
    await this.port.call('stop', { stream: this.stream }).catch(() => undefined);
  }

  async reset(): Promise<void> {
    await this.port.call('reset', { stream: this.stream }).catch(() => undefined);
  }
}

/** A {@link Connection} whose QUIC connection lives in the shared worker. */
class SharedConnection implements Connection {
  constructor(
    private readonly port: WorkerPort,
    private readonly connection: number,
    private readonly remote: string
  ) {}

  remoteId(): string {
    return this.remote;
  }

  async openStream(): Promise<ExchangeStream> {
    const handle = await this.port.call('openStream', { connection: this.connection });
    const stream = new SharedExchangeStream(this.port, handle);
    this.port.releases.register(stream, handle);
    return stream;
  }

  acceptStream(): Promise<ExchangeStream> {
    return Promise.reject(new Error('Shared endpoints do not accept inbound exchanges'));
  }

  close(): void {
    this.port.call('closeConnection', { connection: this.connection }).catch(() => undefined);
  }
}

/** A tab's handle on an endpoint shared through a `SharedWorker`. */
export interface SharedEndpoint extends AsyncDisposable {
  /** The endpoint's id, in base32 form. */
  endpointId(): string;
  /** A dialable ticket for the endpoint. */
  ticket(): Promise<string>;
  /** Connect to the endpoint named by a ticket. */
  connect(ticket: string): Promise<Connection>;
  /**
   * Detach this tab, resetting its exchanges in flight and closing its
   * connections. Other tabs keep using the endpoint.
   */
  close(): Promise<void>;
}

class SharedWorkerEndpoint implements SharedEndpoint {
  constructor(
    private readonly port: WorkerPort,
    private readonly id: string
  ) {}

  endpointId(): string {
    return this.id;
  }

  async ticket(): Promise<string> {
    return await this.port.call('ticket', undefined);
  }

  async connect(ticket: string): Promise<Connection> {
    const { connection: handle, remoteId } = await this.port.call('connect', { ticket });
    const connection = new SharedConnection(this.port, handle, remoteId);
    this.port.releases.register(connection, handle);
    return connection;
  }

  async close(): Promise<void> {
    await this.port.detach();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

async function workerName(secretKey: Uint8Array): Promise<string> {
  // The name is visible to devtools, so it carries a digest rather than the key.
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', secretKey.slice()));
  return `iroh-http:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Whether this browser can share endpoints between tabs. */
export function isSharedEndpointSupported(): boolean {
  return 'SharedWorker' in globalThis;
}

/**
 * Attach to the endpoint for `secretKey`, binding it in a shared worker if no
 * other tab of this origin has yet.
 *
 * Where {@link isSharedEndpointSupported} is false, this rejects; fall back to
 * `createEndpoint`, which binds the endpoint in the tab.
 */
export async function createSharedEndpoint(options: SharedEndpointOptions): Promise<SharedEndpoint> {
  if (!isSharedEndpointSupported()) throw new Error('Shared endpoints need SharedWorker');

  const name = await workerName(options.secretKey);
  const worker = (options.worker ?? startWorker)(name);
  const port = new WorkerPort(worker.port);
  worker.addEventListener('error', () => port.fail(new Error('The shared worker failed to start')));

  try {
    const id = await port.call('attach', { secretKey: options.secretKey, relay: options.relay });
    return new SharedWorkerEndpoint(port, id);
  } catch (error) {
    await port.detach();
    throw error;
  }
}

/** Connect to the endpoint named by a ticket and return an HTTP client. */
export async function connect(endpoint: SharedEndpoint, ticket: string): Promise<IrohHttpClient> {
  return new IrohHttpClient(await endpoint.connect(ticket));
}
