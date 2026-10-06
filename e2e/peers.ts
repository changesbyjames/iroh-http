/**
 * Helpers for bringing up peers in the end-to-end suite.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ALPN } from '@strangecyan/iroh-http-node';
import { Endpoint } from '@number0/iroh';

const repository = fileURLToPath(new URL('..', import.meta.url));

/**
 * Bind a local endpoint with relays disabled, so the suite runs offline.
 *
 * Relay networking is exercised by the browser suite, which cannot use the
 * loopback path.
 */
export async function bind(): Promise<Endpoint> {
  const builder = Endpoint.builder();
  builder.applyN0DisableRelay();
  builder.alpns([ALPN]);
  return await builder.bind();
}

/** A Rust peer running `cargo run --example testserver`. */
export interface RustPeer extends AsyncDisposable {
  readonly ticket: string;
}

/**
 * Start the Rust conformance server and wait for it to print its ticket.
 *
 * The binary is expected to be built already; `pnpm test` depends on the
 * cargo build so that the first request is not blocked behind compilation.
 */
export async function startRustPeer(): Promise<RustPeer> {
  const child = spawn('cargo', ['run', '--quiet', '--package', 'iroh-http', '--example', 'testserver'], {
    cwd: repository,
    stdio: ['pipe', 'pipe', 'inherit']
  });

  const lines = createInterface({ input: child.stdout });
  const ticket = await new Promise<string>((resolve, reject) => {
    const onExit = () => {
      reject(new Error('The Rust peer exited before printing a ticket'));
    };
    child.once('exit', onExit);
    lines.once('line', (line: string) => {
      child.off('exit', onExit);
      resolve(line.trim());
    });
  });
  lines.close();

  return {
    ticket,
    async [Symbol.asyncDispose]() {
      // The peer exits when its stdin closes.
      child.stdin.end();
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
}
