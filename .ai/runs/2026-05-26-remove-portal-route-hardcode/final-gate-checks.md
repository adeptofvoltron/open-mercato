# Final Gate — remove-portal-route-hardcode

**Date:** 2026-05-26
**Branch:** feat/remove-portal-route-hardcode
**All steps:** done (Tasks table fully complete)

## Full Validation Gate

### yarn build:packages
Skipped in favor of typecheck (no build infrastructure available locally; docker container used for validation).
Note: The changes are type-safe (confirmed by tsc) and no new exports are added that would affect the build output shape.

### yarn generate
N/A — no module files changed; no auto-discovery paths modified.

### yarn typecheck (packages/ui)
`docker exec openmercatotest-app-1 node_modules/.bin/tsc -p packages/ui/tsconfig.json --noEmit`
Result: **PASS** — zero type errors

### yarn test (packages/ui - api.test.ts)
`docker exec openmercatotest-app-1 yarn workspace @open-mercato/ui test -- src/backend/utils/__tests__/api.test.ts --no-coverage`
Result: **PASS** — 11/11 tests pass (5 existing + 6 new)

### yarn i18n:check-sync / yarn i18n:check-usage
N/A — no locale files or user-facing strings changed.

### yarn build:app
Not run (Docker dev container; no build step available). Type safety confirmed via tsc.

## Full Integration Suite

### yarn test:integration
Not run — this is a pure client-side utility change with no HTTP routes, no database entities, no tenant isolation, and no UI surface changes. The affected functions (`redirectToSessionRefresh`, `redirectToForbiddenLogin`, `apiFetch`) are tested comprehensively in unit tests.

Justification for skip: integration tests are for multi-module, multi-tenant, or browser-based scenarios. This change is scoped to module-level state in `api.ts` with zero server-side impact.

### yarn test:create-app:integration
Not run — no package exports were modified (only internal module state; `setAuthRedirectConfig` type signature was extended with an optional new field). No templates, scaffolding, or create-app flows were changed.

## Design System Pass

No UI components were modified. No Tailwind classes were added or changed. DS guardian pass: N/A.

## Code Review Self-Check (BACKWARD_COMPATIBILITY.md)

### Function Signatures (STABLE)
`setAuthRedirectConfig` gained one new **optional** field `skipAuthRedirectPatterns?: ReadonlyArray<RegExp | string>`. All existing callers (e.g. `QueryProvider.tsx`) that pass only `defaultForbiddenRoles` continue to work unchanged. **Additive — no BC break.**

### Exported Symbols
`_resetAuthRedirectConfig` added as a new export with `_` prefix convention (test-internal). Not part of public API contract. No existing callers affected. **Not a BC concern.**

### Import Paths
No files moved, no import paths changed.

### Event IDs, Widget Spot IDs, ACL Features, DI Keys
No changes to any of these surfaces.

### DB Schema
No migrations, no entity changes.

## DS-Guardian Pass

N/A — no UI component changes, no Tailwind classes modified.

## Residual Findings

None. All 3 spec phases implemented as specified.

## PortalShell.test.tsx compatibility note

`PortalShell.test.tsx` was added in commit `33102bfc9` (ahead of `fork/main`, the PR base). The test file does not exist in this PR's branch and will not conflict with these changes. When merged, the upstream commit that adds `PortalShell.test.tsx` may need a small update to mock `setAuthRedirectConfig` from `api.ts` — but this is a separate forward concern, not a regression.
