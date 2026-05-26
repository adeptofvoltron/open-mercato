# Checkpoint 1 — Steps 1.1..3.1

**Checkpoint index:** 1
**Steps covered:** 1.1, 2.1, 3.1 (SHA d3d184e0f..cbfb88f80)
**Touched packages:** `packages/ui`
**Date:** 2026-05-26

## Steps covered

| Step | SHA | Title |
|------|-----|-------|
| 1.1 | d3d184e0f | Extend api.ts: add registry, helper, test-reset export, update setAuthRedirectConfig, remove hardcoded checks |
| 2.1 | d724249c4 | Register portal pattern at module scope in PortalShell.tsx |
| 3.1 | cbfb88f80 | Add test teardown hooks and 6 new test cases to api.test.ts |

## Targeted validation

### TypeScript typecheck

Command: `docker exec openmercatotest-app-1 node_modules/.bin/tsc -p packages/ui/tsconfig.json --noEmit`
Result: **PASS** — no type errors (empty output)

### Unit tests: api.test.ts

Command: `docker exec openmercatotest-app-1 yarn workspace @open-mercato/ui test -- src/backend/utils/__tests__/api.test.ts --no-coverage`
Result: **PASS** — 11 tests pass (5 existing + 6 new)

```
PASS src/backend/utils/__tests__/api.test.ts
  apiFetch
    ✓ throws ForbiddenError when backend returns ACL hints (20 ms)
    ✓ throws ForbiddenError when ACL hints are missing (2 ms)
    ✓ does not redirect on login page and returns 403 payload (2 ms)
    ✓ returns 401 payload when unauthorized redirect is disabled (2 ms)
    ✓ throws UnauthorizedError for 401 responses by default (2 ms)
    ✓ returns 401 response without redirect when RegExp portal pattern is registered (2 ms)
    ✓ throws UnauthorizedError for portal 401 when no pattern is registered (1 ms)
    ✓ still throws UnauthorizedError for backoffice 401 after portal pattern is registered (1 ms)
    ✓ returns 401 response without redirect when string pattern matches via startsWith (2 ms)
    ✓ accumulates patterns across two setAuthRedirectConfig calls (append semantics) (1 ms)
    ✓ returns 403 response without flash or redirect when portal pattern is registered (1 ms)
Tests: 11 passed, 11 total
```

### Full ui test suite (in docker with my changes)

Command: `docker exec openmercatotest-app-1 yarn workspace @open-mercato/ui test`
Result: **138 suites PASS, 1 suite FAIL** (PortalShell.test.tsx with 2 failures)

**Note on PortalShell.test.tsx failures:** This test file (`packages/ui/src/portal/__tests__/PortalShell.test.tsx`) was **added in commit `33102bfc9`** which is ahead of `fork/main` (the base for this PR). The test does NOT exist in `fork/main`:

```
$ git show fork/main:packages/ui/src/portal/__tests__/
PortalContext.test.tsx   (only this file present)
```

The docker container had both my `fork/main`-based `PortalShell.tsx` AND the `HEAD`-branch `PortalShell.test.tsx`, causing a compatibility mismatch. This is not a regression introduced by this PR — it's a test that will be merged separately from upstream.

### i18n check
N/A — no user-facing strings or locale files changed.

### yarn generate / build:packages / db:generate
N/A — no module structure, entities, or generated files changed.

## UI verification

No UI surface changes — this is a pure utility/logic change. No Playwright tests needed.
Playwright checks skipped: no frontend/backend pages, widgets, or TSX components changed (PortalShell.tsx import-only module-scope addition).

## Decisions

None.
