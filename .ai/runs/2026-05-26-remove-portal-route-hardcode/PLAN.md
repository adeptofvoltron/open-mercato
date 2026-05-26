---
slug: remove-portal-route-hardcode
date: 2026-05-26
branch: feat/remove-portal-route-hardcode
---

# Execution Plan — remove-portal-route-hardcode

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` and fill the `Commit` column with the short SHA. The first row whose `Status` is not `done` is the resume point for `auto-continue-pr`. Step ids are immutable once a Step has a commit.

| Phase | Step | Title | Status | Commit |
|-------|------|-------|--------|--------|
| 1 | 1.1 | Extend api.ts: add registry, helper, test-reset export, update setAuthRedirectConfig, remove hardcoded checks | done | d3d184e0f |
| 2 | 2.1 | Register portal pattern at module scope in PortalShell.tsx | done | d724249c4 |
| 3 | 3.1 | Add test teardown hooks and 6 new test cases to api.test.ts | done | cbfb88f80 |

## Goal

Remove the hardcoded portal URL regex from `packages/ui/src/backend/utils/api.ts` and replace with a configurable `skipAuthRedirectPatterns` registry. The portal module self-registers its pattern at module scope in `PortalShell.tsx`.

## Scope

- `packages/ui/src/backend/utils/api.ts` — extend config, add helper, remove hardcoded checks
- `packages/ui/src/portal/PortalShell.tsx` — register portal URL pattern at module scope
- `packages/ui/src/backend/utils/__tests__/api.test.ts` — add teardown hooks and 6 new test cases

## Non-Goals

- No HTTP route changes
- No database or entity changes
- No changes to other files in the codebase
- No changes to existing test behavior (all existing tests must continue to pass)

## Risks

- Phase 1 alone (removing the hardcoded check without Phase 2) breaks portal auth — both phases ship in the same atomic PR
- `SKIP_AUTH_REDIRECT_PATTERNS` is shared module state — test isolation requires `_resetAuthRedirectConfig()` teardown in tests

## Source spec

`.ai/specs/2026-05-26-remove-portal-route-hardcode-api-ts.md`

## Implementation Plan

### Phase 1 — Extend `api.ts`

**Step 1.1** — Extend api.ts: add registry, helper, test-reset export, update setAuthRedirectConfig, remove hardcoded checks

1. Add `let SKIP_AUTH_REDIRECT_PATTERNS: Array<RegExp | string> = []` after `DEFAULT_FORBIDDEN_ROLES`.
2. Add `_resetAuthRedirectConfig()` export:
   ```ts
   export function _resetAuthRedirectConfig() {
     DEFAULT_FORBIDDEN_ROLES = ['admin']
     SKIP_AUTH_REDIRECT_PATTERNS = []
   }
   ```
3. Add private `isSkippedAuthRedirectRoute(pathname: string): boolean` helper.
4. Extend `setAuthRedirectConfig` with `skipAuthRedirectPatterns` (append semantics).
5. In `redirectToSessionRefresh`: replace hardcoded regex check with `isSkippedAuthRedirectRoute(window.location.pathname)`.
6. In `redirectToForbiddenLogin`: same replacement.
7. In `apiFetch`: replace `const onPortalRoute = /\/[^/]+\/portal(\/|$)/.test(pathname)` with `const onSkippedRoute = isSkippedAuthRedirectRoute(pathname)` and update both guard conditions atomically.

### Phase 2 — Register portal pattern in `PortalShell.tsx`

**Step 2.1** — Register portal pattern at module scope in PortalShell.tsx

1. Add import: `import { setAuthRedirectConfig } from '../backend/utils/api'`
2. Add at module scope (after imports, outside component function):
   ```ts
   setAuthRedirectConfig({ skipAuthRedirectPatterns: [/\/[^/]+\/portal(\/|$)/] })
   ```

### Phase 3 — Test coverage in `api.test.ts`

**Step 3.1** — Add test teardown hooks and 6 new test cases to api.test.ts

1. Import `_resetAuthRedirectConfig` and `setAuthRedirectConfig` in the test file.
2. Add `beforeEach`/`afterEach` calling `_resetAuthRedirectConfig()`.
3. Add 6 new test cases:
   - Portal 401 skips redirect after RegExp pattern registered
   - Portal 401 redirects when no pattern registered  
   - Backoffice 401 still redirects after portal pattern registered
   - String pattern via `startsWith`
   - Append semantics — two calls accumulate patterns
   - 403 on portal route skips forbidden redirect
