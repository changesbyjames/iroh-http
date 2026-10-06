# Releasing

One GitHub Release publishes three npm packages at the same version:

- `@strangecyan/iroh-http-core` to npm
- `@strangecyan/iroh-http-node` to npm
- `@strangecyan/iroh-http-browser` to npm

The `iroh-http` Rust crate is also published at that version when the GitHub
repository variable `PUBLISH_CRATE` is set to `true`. It is disabled by default.

Prerelease GitHub Releases are intentionally not published.

## One-time setup

1. Confirm the npm account or organization owns the `@strangecyan` scope and
   permits public package publication.
2. Configure a GitHub Actions trusted publisher in the npm settings of each
   package, using these exact values:
   - Organization or user: `changesbyjames`
   - Repository: `iroh-http`
   - Workflow filename: `release.yml`
   - Environment name: `npm`
   - Enable direct publishing with `npm publish`.
3. To publish the Rust crate as well, add a crates.io API token as the GitHub
   repository secret `CARGO_REGISTRY_TOKEN` and set the repository variable
   `PUBLISH_CRATE` to `true`. The token must be allowed to publish `iroh-http`.
4. Create the protected GitHub environments `npm` and `crates-io` if release
   approvals or environment-scoped secrets are desired. The workflow references
   both environments.

The npm publish job uses GitHub OIDC with `id-token: write` and npm CLI 11.19.0.
It publishes the tarballs packed by pnpm with provenance. npm publication does
not require an `NPM_TOKEN` repository secret. The repository and packages must
be public for provenance.

### Registering new npm packages

npm requires a package to exist before a trusted publisher can be configured.
For new names, sign in locally with `npm login` and use
[`npm stage publish`](https://docs.npmjs.com/staged-publishing/) to register each
name with an unapproved bootstrap version, such as `0.0.0-bootstrap`. npm creates
a public placeholder package, making the package settings available. Configure
the trusted publisher above, then reject the bootstrap stage; do not approve it.
Use a different version for the actual release because staged versions reserve
their version numbers.

This one-time registration uses an interactive npm session. Release versions
are published from GitHub Actions through OIDC. Trusted publisher setup requires
2FA, and a new configuration must complete its first successful publish within
48 hours. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Prepare a release

1. Choose one version and update it in:
   - root `package.json`
   - all three package `package.json` files
   - `[workspace.package]` in `Cargo.toml`
2. Run `pnpm install` to update `pnpm-lock.yaml`, and run Cargo once to update
   `Cargo.lock` if needed. Internal dependencies use `workspace:*`, which
   `pnpm pack` rewrites to the release version.
3. Run the complete release gate:

   ```sh
   pnpm ready
   ```

4. Commit and push the version changes.

## Publish

Create a non-prerelease GitHub Release tagged `v<version>`, for example
`v0.1.0`. `.github/workflows/release.yml` then:

1. checks that the tag, npm manifests, internal workspace dependencies, and Cargo
   workspace version agree;
2. runs the complete release gate;
3. packs the built packages with pnpm and publishes core before the two npm
   transports using npm and OIDC;
4. publishes `iroh-http` to crates.io in a separate job if `PUBLISH_CRATE` is
   `true`.

After the workflow succeeds, verify the published registry pages and npm
provenance. Allow time for npm's publish-time scanning before versions become
installable.

Registry publication is immutable. On a partial-release retry, the npm job
skips versions already visible in the registry. Inspect all three registry
entries before retrying and never move a tag after any package has published.
