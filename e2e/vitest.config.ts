import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { closeRelayPeer, commands } from './browser/commands.ts';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['tests/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          // Each file owns real endpoints and, for the Rust suite, a child process.
          fileParallelism: false
        }
      },
      {
        // The browser package locates its WebAssembly and worker beside its
        // own modules, which pre-bundling would move.
        optimizeDeps: { exclude: ['@strangecyan/iroh-http-browser'] },
        plugins: [
          {
            name: 'relay-peer',
            configureVitest({ vitest }) {
              vitest.onClose(closeRelayPeer);
            }
          }
        ],
        test: {
          name: 'browser',
          include: ['browser/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
            commands
          }
        }
      }
    ]
  }
});
