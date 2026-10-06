import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const expectedPackages = [
  ['packages/shared/package.json', '@strangecyan/iroh-http-core'],
  ['packages/node/package.json', '@strangecyan/iroh-http-node'],
  ['packages/browser/package.json', '@strangecyan/iroh-http-browser']
];

/** Whether a value parsed from package.json is a non-empty string. */
function isNonEmptyString(value) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- package.json is untrusted JSON read at this I/O boundary.
  return typeof value === 'string' && value !== '';
}

const tag = process.argv.slice(2).find(argument => /^v\d/.test(argument));
if (!tag?.startsWith('v')) {
  throw new Error('Expected a release tag in the form v<version>');
}
const version = tag.slice(1);

const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
if (rootPackage.version !== version) {
  throw new Error(`Root version ${rootPackage.version} does not match ${tag}`);
}
if (!isNonEmptyString(rootPackage.repository?.url)) {
  throw new Error('Root package.json must set repository.url');
}

const packages = new Map();
for (const [path, expectedName] of expectedPackages) {
  // Each manifest must have the expected name, version, and repository, and be publishable.
  const manifest = JSON.parse(await readFile(resolve(root, path), 'utf8'));
  if (manifest.name !== expectedName) {
    throw new Error(`${path} is named ${manifest.name}; expected ${expectedName}`);
  }
  if (manifest.version !== version) {
    throw new Error(`${manifest.name} version ${manifest.version} does not match ${tag}`);
  }
  if (manifest.private === true) {
    throw new Error(`${manifest.name} is private and cannot be published`);
  }
  if (manifest.publishConfig?.access !== 'public') {
    throw new Error(`${manifest.name} must set publishConfig.access to public`);
  }
  // npm provenance rejects a package whose repository differs from the one that built it.
  if (manifest.repository?.url !== rootPackage.repository.url) {
    throw new Error(
      `${manifest.name} repository.url ${manifest.repository?.url} does not match ${rootPackage.repository.url}`
    );
  }
  if (!isNonEmptyString(manifest.repository?.directory)) {
    throw new Error(`${manifest.name} must set repository.directory`);
  }
  packages.set(manifest.name, manifest);
}

for (const manifest of packages.values()) {
  // Packages published together must depend on each other through the workspace,
  // which pnpm rewrites to the release version on publish.
  for (const [dependency, dependencyVersion] of Object.entries(manifest.dependencies ?? {})) {
    if (packages.has(dependency) && dependencyVersion !== 'workspace:*') {
      throw new Error(`${manifest.name} depends on ${dependency} at ${dependencyVersion}; expected workspace:*`);
    }
  }
}

const cargo = await readFile(resolve(root, 'Cargo.toml'), 'utf8');
const workspacePackage = cargo.match(/\[workspace\.package\][\s\S]*?\nversion = "([^"]+)"/);
if (workspacePackage?.[1] !== version) {
  throw new Error(`Cargo workspace version ${workspacePackage?.[1] ?? 'missing'} does not match ${tag}`);
}

console.log(`Release ${tag} is internally consistent.`);
