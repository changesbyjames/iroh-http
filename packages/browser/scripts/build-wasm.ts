import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const generated = resolve(packageRoot, 'src/wasm');

// The wasm crate is a Cargo workspace member, so it already builds into the workspace's target/.
// wasm32 C dependencies need an LLVM clang; Apple's clang cannot target wasm.
const env: NodeJS.ProcessEnv = { ...process.env };
const clang = ['/opt/homebrew/opt/llvm/bin/clang', '/usr/local/opt/llvm/bin/clang'].find(existsSync);
if (env.CC_wasm32_unknown_unknown === undefined && clang !== undefined) {
  env.CC_wasm32_unknown_unknown = clang;
}

const result = spawnSync(
  'wasm-pack',
  [
    'build',
    'wasm',
    '--target',
    'web',
    '--out-dir',
    '../src/wasm',
    '--out-name',
    'iroh_http_browser',
    '--release',
    '--no-pack'
  ],
  { cwd: packageRoot, env, stdio: 'inherit' }
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`wasm-pack exited with code ${result.status ?? 'unknown'}`);

// tsc emits dist/index.js, which imports the wasm-bindgen glue beside it.
rmSync(resolve(packageRoot, 'dist'), { recursive: true, force: true });
cpSync(generated, resolve(packageRoot, 'dist/wasm'), {
  recursive: true,
  filter: source => !source.endsWith('.gitignore')
});
