/**
 * An in-memory {@link ExchangeStream} pair, for testing the wire codec without
 * a network.
 */

import type { ExchangeStream } from '@strangecyan/iroh-http-core';

/** Records what a peer did to its end of the exchange. */
export interface StreamRecord {
  finished: boolean;
  stopped: boolean;
  reset: boolean;
}

class Buffer {
  private bytes = new Uint8Array(0);
  private ended = false;
  private failure: Error | undefined = undefined;
  private wake: (() => void) | undefined = undefined;

  push(bytes: Uint8Array): void {
    const next = new Uint8Array(this.bytes.byteLength + bytes.byteLength);
    next.set(this.bytes, 0);
    next.set(bytes, this.bytes.byteLength);
    this.bytes = next;
    this.notify();
  }

  end(): void {
    this.ended = true;
    this.notify();
  }

  fail(error: Error): void {
    this.failure ??= error;
    this.notify();
  }

  /** Wait until `size` bytes are buffered, failing if the stream fails or ends first. */
  async readExact(size: number): Promise<Uint8Array> {
    for (;;) {
      if (this.failure) throw this.failure;
      if (this.bytes.byteLength >= size) {
        const taken = this.bytes.subarray(0, size);
        this.bytes = this.bytes.subarray(size);
        return taken;
      }
      if (this.ended) throw new Error('Stream ended before the read completed');
      await new Promise<void>(resolve => {
        this.wake = resolve;
      });
    }
  }

  private notify(): void {
    this.wake?.();
    this.wake = undefined;
  }
}

/** Settles one direction's `stopped`: whether its reader gave it up. */
class Departure {
  private settle: (gone: boolean) => void = () => undefined;
  readonly settled = new Promise<boolean>(resolve => {
    this.settle = resolve;
  });

  /** The reader stopped reading, or reset the exchange. */
  leave(): void {
    this.settle(true);
  }

  /** The writer finished or reset its own send side. */
  end(): void {
    this.settle(false);
  }
}

/** One side's view of a direction pair: what it reads, what it writes, and who gave up on which. */
interface Directions {
  inbound: Buffer;
  outbound: Buffer;
  /** Whether this side gave up on what the peer sends. */
  left: Departure;
  /** Whether the peer gave up on what this side sends. */
  departed: Departure;
}

function endpoint({ inbound, outbound, left, departed }: Directions, record: StreamRecord): ExchangeStream {
  return {
    write(bytes) {
      if (record.reset) return Promise.reject(new Error('Stream was reset'));
      // Copied because callers reuse their frame buffers.
      outbound.push(new Uint8Array(bytes));
      return Promise.resolve();
    },
    readExact(size) {
      return size === 0 ? Promise.resolve(new Uint8Array(0)) : inbound.readExact(size);
    },
    finish() {
      record.finished = true;
      outbound.end();
      departed.end();
      return Promise.resolve();
    },
    stop() {
      record.stopped = true;
      inbound.fail(new Error('Stream read was cancelled'));
      left.leave();
      return Promise.resolve();
    },
    reset() {
      record.reset = true;
      outbound.fail(new Error('Stream was reset'));
      inbound.fail(new Error('Stream was reset'));
      departed.end();
      left.leave();
      return Promise.resolve();
    },
    stopped() {
      return departed.settled;
    }
  };
}

/** Two connected in-memory exchange streams and what each side did. */
export interface StreamPair {
  client: ExchangeStream;
  server: ExchangeStream;
  clientRecord: StreamRecord;
  serverRecord: StreamRecord;
}

/** Create two connected in-memory exchange streams and their records. */
export function createStreamPair(): StreamPair {
  const toServer = new Buffer();
  const toClient = new Buffer();
  const clientRecord: StreamRecord = { finished: false, stopped: false, reset: false };
  const serverRecord: StreamRecord = { finished: false, stopped: false, reset: false };

  const clientLeft = new Departure();
  const serverLeft = new Departure();

  return {
    client: endpoint({ inbound: toClient, outbound: toServer, left: clientLeft, departed: serverLeft }, clientRecord),
    server: endpoint({ inbound: toServer, outbound: toClient, left: serverLeft, departed: clientLeft }, serverRecord),
    clientRecord,
    serverRecord
  };
}
