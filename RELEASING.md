# Releasing

One GitHub Release publishes four artifacts at the same version:

- `@strangecyan/iroh-http-core` to npm
- `@strangecyan/iroh-http-node` to npm
- `@strangecyan/iroh-http-browser` to npm
- `iroh-http` to crates.io

Prerelease GitHub Releases are intentionally not published.

## One-time setup

1. Confirm the npm account or organization owns the `@strangecyan` scope and
   permits public package publication.
2. Add an npm automation or granular access token as the GitHub repository
   secret `NPM_TOKEN`. It must be allowed to publish all three scoped packages.
3. Add a crates.io API token as the GitHub repository secret
   `CARGO_REGISTRY_TOKEN`. It must be allowed to publish `iroh-http`.
4. Create the protected GitHub environments `npm` and `crates-io` if release
   approvals or environment-scoped secrets are desired. The workflow references
   both environments.

The npm publish job requests `id-token: write` and npm publishes with
`--provenance`, so npm associates each package with its GitHub Actions build.

## Prepare a release

1. Choose one version and update it in:
   - root `package.json`
   - all three package `package.json` files
   - `[workspace.package]` in `Cargo.toml`
2. Run `pnpm install` to update `pnpm-lock.yaml`, and run Cargo once to update
   `Cargo.lock` if needed. Internal dependencies use `workspace:*`, which
   `pnpm publish` rewrites to the release version.
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
3. publishes core before the two npm transports;
4. publishes `iroh-http` to crates.io in a separate job.

After the workflow succeeds, verify all four registry pages and npm provenance.
Registry publication is immutable: if a job partially succeeds, inspect the
registries before retrying rather than reusing the version.
