# Agent notes

The TypeScript workspace uses pnpm workspaces. Packages compile with `tsc`; the
browser package first runs `wasm-pack` via `packages/browser/scripts/build-wasm.ts`.
The end-to-end suite in `e2e/` runs on Vitest.

## Review Checklist

- [ ] Run `pnpm install` after pulling remote changes and before getting started.
- [ ] Run `pnpm build` before type checking or testing; packages consume each other's `dist`.
- [ ] Run `pnpm check` (oxfmt, oxlint, and `tsc`) and `pnpm test` to validate changes.
- [ ] Run `pnpm format` to apply formatting. Lint rules live in `oxlint.config.ts` and `tools/oxlint`.
- [ ] Run `pnpm ready` for the full release gate, including Cargo checks.
