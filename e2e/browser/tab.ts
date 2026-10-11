/**
 * What one tab does with a shared endpoint, so that tests can drive it in the
 * test document or in an iframe standing in for another tab.
 */

import { connect as connectUnshared, createEndpoint, getAddressFromString } from '@strangecyan/iroh-http-browser';
import { connect, createSharedEndpoint } from '@strangecyan/iroh-http-browser/shared';
import type { IrohHttpClient } from '@strangecyan/iroh-http-core';

const encoder = new TextEncoder();

/** One tab's view of a shared endpoint and its client for the relay peer. */
export interface Tab {
  /** Attach with `secretKey` and connect to the relay peer, returning the endpoint id. */
  attach(secretKey: readonly number[], ticket: string): Promise<string>;
  /** As {@link Tab.attach}, but binding an endpoint of the tab's own. */
  attachUnshared(secretKey: readonly number[], ticket: string): Promise<string>;
  /** Fetch `path` from the relay peer and return its body. */
  text(path: string): Promise<string>;
  /** Start a `/sink` upload that never ends. */
  upload(id: string): void;
  close(): Promise<void>;
}

/** An endpoint, shared or not. */
interface Closable {
  close(): Promise<void>;
}

/** Fields set once the tab has attached. */
interface Attached {
  endpoint: Closable;
  client: IrohHttpClient;
}

/** `RequestInit` with `duplex`, which streaming a request body requires. */
interface StreamingRequestInit extends RequestInit {
  duplex: 'half';
}

declare global {
  interface Window {
    /** Set by `tab.html`. */
    tab?: Tab;
  }
}

/**
 * Stream a request body to the relay peer's `/sink?id=…` until the exchange
 * fails. The peer reads until the body ends, so no response ever arrives.
 */
export function startUpload(client: IrohHttpClient, id: string, signal?: AbortSignal): void {
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise(resolve => setTimeout(resolve, 100));
      controller.enqueue(encoder.encode('chunk;'));
    }
  });
  const init: StreamingRequestInit = { method: 'POST', body, duplex: 'half', signal };
  client.fetch(`/sink?id=${id}`, init).catch(() => undefined);
}

export function createTab(): Tab {
  let attached: Attached | undefined = undefined;
  const current = (): Attached => {
    if (!attached) throw new Error('The tab is not attached');
    return attached;
  };

  return {
    async attach(secretKey, ticket) {
      // The key is rebuilt here so that it belongs to this tab's realm.
      const endpoint = await createSharedEndpoint({ secretKey: Uint8Array.from(secretKey) });
      attached = { endpoint, client: await connect(endpoint, ticket) };
      return endpoint.endpointId();
    },
    async attachUnshared(secretKey, ticket) {
      const endpoint = await createEndpoint({ secretKey: Uint8Array.from(secretKey) });
      attached = { endpoint, client: await connectUnshared(endpoint, await getAddressFromString(ticket)) };
      return endpoint.endpointId();
    },
    async text(path) {
      return await (await current().client.fetch(path)).text();
    },
    upload(id) {
      startUpload(current().client, id);
    },
    async close() {
      await current().endpoint.close();
    }
  };
}
