/**
 * Shared endpoints in a real browser: the WebAssembly endpoint in a real
 * `SharedWorker`, dialling a Node peer through the n0 relays.
 *
 * Other tabs are iframes of the same origin, which share workers with the test
 * document just as tabs do.
 */

import { afterEach, assert, beforeAll, describe, expect, it, vi } from 'vitest';
import { commands } from 'vitest/browser';
import type { IrohHttpClient } from '@strangecyan/iroh-http-core';
import { connect, createSharedEndpoint, type SharedEndpoint } from '@strangecyan/iroh-http-browser/shared';
import { conformance } from '../api.ts';
import { createTab, startUpload, type Tab } from './tab.ts';

let ticket = '';

beforeAll(async () => {
  ticket = await commands.peerTicket();
});

/** A key of its own per test, so that each test gets a fresh worker. */
function freshKey(): number[] {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)));
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup().catch(() => undefined)));
});

/** Open another tab of this origin, as an iframe. */
async function openTab(): Promise<[Tab, HTMLIFrameElement]> {
  const frame = document.createElement('iframe');
  frame.src = new URL('./tab.html', import.meta.url).href;
  document.body.append(frame);
  cleanups.push(async () => frame.remove());
  await new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
  const tab = frame.contentWindow?.tab;
  assert(tab, 'tab.html did not set up its tab');
  return [tab, frame];
}

/** A tab in the test document itself. */
function localTab(): Tab {
  const tab = createTab();
  cleanups.push(() => tab.close());
  return tab;
}

async function attach(secretKey: readonly number[]): Promise<SharedEndpoint> {
  const endpoint = await createSharedEndpoint({ secretKey: Uint8Array.from(secretKey) });
  cleanups.push(() => endpoint.close());
  return endpoint;
}

async function received(id: string): Promise<number> {
  return (await commands.sinkState(id))?.received ?? 0;
}

/** Wait until the peer is receiving the `/sink` upload `id`. */
async function expectUploading(id: string): Promise<void> {
  await vi.waitFor(async () => expect(await received(id)).toBeGreaterThan(0), { timeout: 15_000 });
}

/** Bytes of the `/sink` upload `id` that the peer receives over `ms` milliseconds. */
async function receivedOver(id: string, ms: number): Promise<number> {
  const before = await received(id);
  await new Promise(resolve => setTimeout(resolve, ms));
  return (await received(id)) - before;
}

/**
 * Wait until the peer's read of the `/sink` upload `id` fails, which only a
 * reset causes: an upload that is merely abandoned leaves the read waiting.
 */
async function expectReset(id: string): Promise<void> {
  await vi.waitFor(async () => expect((await commands.sinkState(id))?.outcome).toBe('failed'), { timeout: 10_000 });
}

describe('shared endpoint conformance', () => {
  let client: IrohHttpClient | undefined = undefined;
  let endpointId = '';

  beforeAll(async () => {
    const endpoint = await createSharedEndpoint({ secretKey: Uint8Array.from(freshKey()) });
    endpointId = endpoint.endpointId();
    client = await connect(endpoint, await commands.peerTicket());
    return () => endpoint.close();
  });

  conformance(
    () => {
      assert(client, 'beforeAll did not connect');
      return client;
    },
    () => endpointId,
    true
  );
});

/** How long a request goes unanswered before its connection times out. */
const LOST_CONNECTION_MS = 30_000;

describe('unshared endpoints, the problem shared endpoints solve', () => {
  it(
    'cut off the first tab when a second tab binds the same key',
    async () => {
      const key = freshKey();
      const [first] = await openTab();
      await first.attachUnshared(key, ticket);
      const id = crypto.randomUUID();
      first.upload(id);
      await expectUploading(id);

      const [second] = await openTab();
      await second.attachUnshared(key, ticket);

      // The relay delivers to one endpoint per id, so from here on the peer's
      // replies reach the second tab. The first tab's request goes unanswered
      // until its connection times out, and its upload stalls soon after.
      const [firstPing, secondPing] = await Promise.allSettled([first.text('/ping'), second.text('/ping')]);
      expect(secondPing).toEqual({ status: 'fulfilled', value: 'pong' });
      expect(firstPing).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ message: 'connection lost' })
      });
      await vi.waitFor(async () => expect(await receivedOver(id, 1_000)).toBe(0), { timeout: 15_000 });
      await expect(second.text('/ping')).resolves.toBe('pong');
    },
    LOST_CONNECTION_MS * 3
  );
});

describe('shared endpoint', () => {
  it('shares one endpoint between tabs using the same key', async () => {
    const key = freshKey();
    const [first] = await openTab();
    const [second] = await openTab();

    const firstId = await first.attach(key, ticket);
    const secondId = await second.attach(key, ticket);

    expect(secondId).toBe(firstId);
    await expect(first.text('/peer')).resolves.toBe(firstId);
    await expect(second.text('/peer')).resolves.toBe(firstId);
  });

  it('keeps a tab connected while another tab with the same key comes and goes', async () => {
    // The same steps cut off the first tab when each binds its own endpoint;
    // see the unshared suite above.
    const key = freshKey();
    const [staying] = await openTab();
    await staying.attach(key, ticket);
    const id = crypto.randomUUID();
    staying.upload(id);
    await expectUploading(id);

    const [visiting, frame] = await openTab();
    await visiting.attach(key, ticket);
    await expect(visiting.text('/ping')).resolves.toBe('pong');
    await expect(staying.text('/ping')).resolves.toBe('pong');
    expect(await receivedOver(id, 1_000)).toBeGreaterThan(0);

    frame.remove();

    expect(await receivedOver(id, 1_000)).toBeGreaterThan(0);
    await expect(staying.text('/ping')).resolves.toBe('pong');
    expect((await commands.sinkState(id))?.outcome).toBe('open');
  });

  it('resets the exchanges of a tab that closes, and only that tab', async () => {
    const key = freshKey();
    const [closing] = await openTab();
    const [staying] = await openTab();
    await closing.attach(key, ticket);
    await staying.attach(key, ticket);
    const doomed = crypto.randomUUID();
    const surviving = crypto.randomUUID();
    closing.upload(doomed);
    staying.upload(surviving);
    await expectUploading(doomed);
    await expectUploading(surviving);

    await closing.close();

    await expectReset(doomed);
    expect(await receivedOver(surviving, 1_000)).toBeGreaterThan(0);
    expect((await commands.sinkState(surviving))?.outcome).toBe('open');
    await expect(closing.text('/ping')).rejects.toThrow('The shared endpoint is closed');
    await expect(staying.text('/ping')).resolves.toBe('pong');
  });

  it('resets an exchange whose fetch is aborted', async () => {
    const endpoint = await attach(freshKey());
    const client = await connect(endpoint, ticket);
    const id = crypto.randomUUID();
    const abort = new AbortController();
    startUpload(client, id, abort.signal);
    await expectUploading(id);

    abort.abort(new Error('cancelled'));

    await expectReset(id);
  });

  it('keeps working for a tab after another tab closes', async () => {
    const key = freshKey();
    const first = localTab();
    const second = localTab();
    await first.attach(key, ticket);
    await second.attach(key, ticket);

    await first.close();

    await expect(second.text('/ping')).resolves.toBe('pong');
  });

  it('rejects a tab asking for different relays', async () => {
    const key = freshKey();
    await attach(key);

    await expect(createSharedEndpoint({ secretKey: Uint8Array.from(key), relay: 'staging' })).rejects.toThrow(
      'different relay configuration'
    );
  });

  it('binds again after binding fails', async () => {
    const key = freshKey();

    await expect(
      createSharedEndpoint({ secretKey: Uint8Array.from(key), relay: { urls: ['not a url'] } })
    ).rejects.toThrow();
    const endpoint = await attach(key);

    await expect((await connect(endpoint, ticket)).fetch('/ping').then(response => response.text())).resolves.toBe(
      'pong'
    );
  });

  it('refuses inbound connections', async () => {
    const endpoint = await attach(freshKey());

    await expect(commands.dialFromNode(await endpoint.ticket())).resolves.toContain('refused');
  });

  it('does not accept inbound exchanges on a connection', async () => {
    const endpoint = await attach(freshKey());
    const connection = await endpoint.connect(ticket);

    await expect(connection.acceptStream()).rejects.toThrow('do not accept inbound exchanges');
  });

  it('rejects calls once the endpoint is closed', async () => {
    const endpoint = await attach(freshKey());
    const client = await connect(endpoint, ticket);

    await endpoint.close();

    await expect(client.fetch('/ping')).rejects.toThrow('The shared endpoint is closed');
    await expect(endpoint.connect(ticket)).rejects.toThrow('The shared endpoint is closed');
  });
});
