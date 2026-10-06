/**
 * HTTP over Iroh in browsers, backed by WebAssembly.
 *
 * The WebAssembly module supplies endpoints, connections, and streams that
 * match the transport interfaces of `@strangecyan/iroh-http-core`, which owns
 * the framing, client, and server shared with Node peers.
 *
 * @module
 */

import initWasm, {
  createEndpoint as createWasmEndpoint,
  getAddressFromString as parseTicket,
  type IrohHttpAddress,
  type IrohHttpEndpoint
} from './wasm/iroh_http_browser.js';
import { IrohHttpClient, IrohHttpServer, type Handler } from '@strangecyan/iroh-http-core';

export * from '@strangecyan/iroh-http-core';
export type { IrohHttpAddress, IrohHttpEndpoint };

let initialization: Promise<void> | undefined = undefined;

/** Initialize the WebAssembly module. Every other API calls this first, so calling it directly is optional. */
export function init(): Promise<void> {
  initialization ??= initWasm().then(() => undefined);
  return initialization;
}

/** One custom relay and its optional authentication token. */
export interface BrowserRelayConfig {
  url: string;
  authToken?: string;
}

/** Custom relay URLs sharing one optional authentication token. */
export interface BrowserRelayUrls {
  urls: readonly string[];
  authToken?: string;
}

/** Custom relays, each with its own optional authentication token. */
export interface BrowserRelayList {
  relays: readonly BrowserRelayConfig[];
}

/** Relay configuration used when creating a browser endpoint. */
export type BrowserRelay = 'default' | 'staging' | BrowserRelayUrls | BrowserRelayList;

/** Options for {@link createEndpoint}. */
export interface EndpointOptions {
  /** Production relays by default, staging relays, or a custom relay list. */
  relay?: BrowserRelay;
  /** Optional stable 32-byte Iroh secret key. */
  secretKey?: Uint8Array;
}

/** Create and bind a browser Iroh endpoint configured for HTTP over Iroh. */
export async function createEndpoint(options: EndpointOptions = {}): Promise<IrohHttpEndpoint> {
  await init();
  const relay = options.relay ?? 'default';
  if (relay === 'default' || relay === 'staging') {
    return await createWasmEndpoint(relay, [], [], options.secretKey);
  }

  const relays = 'relays' in relay ? relay.relays : relay.urls.map(url => ({ url, authToken: relay.authToken }));
  return await createWasmEndpoint(
    'custom',
    relays.map(({ url }) => url),
    relays.map(({ authToken }) => authToken ?? ''),
    options.secretKey
  );
}

/** Parse an Iroh endpoint ticket into a dialable address. */
export async function getAddressFromString(ticket: string): Promise<IrohHttpAddress> {
  await init();
  return parseTicket(ticket);
}

/** Connect to a remote endpoint address and return an HTTP client. */
export async function connect(endpoint: IrohHttpEndpoint, address: IrohHttpAddress): Promise<IrohHttpClient> {
  return new IrohHttpClient(await endpoint.connect(address));
}

/**
 * Serve `handler` on `endpoint`, taking ownership of its accept loop.
 *
 * Disposing the server stops accepting, closes active connections, and closes
 * the endpoint.
 */
export function serve(endpoint: IrohHttpEndpoint, handler: Handler): IrohHttpServer {
  return new IrohHttpServer(endpoint, handler);
}
