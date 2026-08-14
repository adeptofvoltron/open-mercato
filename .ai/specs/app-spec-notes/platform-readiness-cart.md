# Platform readiness — Storefront Cart

Research notes for `2026-08-13-app-spec-storefront-cart.md`, gathered during the Phase 0 challenger gate.
Feeds the §3 per-workflow "Platform readiness" rows and the §4 gap matrix. Every claim below was verified
against code in this checkout, not assumed.

## Verified: the cart's hardest requirements already have a working precedent

`packages/checkout` runs a **public, unauthenticated, data-bearing, money-handling** API surface today.
It is the closest existing analogue to the storefront cart and should be the reference implementation.

| Cart requirement | Platform capability | Evidence | Gap |
|---|---|---|---|
| Public API, no auth | `requireAuth: false` in route metadata | `packages/checkout/src/modules/checkout/api/pay/[slug]/route.ts:22` | **0** |
| Abuse control on a public route | `rateLimiterService` via DI + `checkRateLimit()` + per-module key builder, **fail-open** | same file, lines 5–10, 33–40; `packages/shared/src/lib/ratelimit/helpers.ts` | **0** |
| ~~**Cart Token in a cookie (amendment A-1)**~~ | ~~`readCheckoutAccessCookie()` + `verifyCheckoutAccessToken()`~~ | — | ❌ **RETRACTED — see the correction block below** |
| **Expiry background job (amendment A-2)** | `transaction-expiry.worker.ts` + the `queue` package worker contract | `packages/checkout/src/modules/checkout/workers/transaction-expiry.worker.ts` | **1** — copy the shape, change the predicate |
| Price *selection* for line snapshots | `catalogPricingService.resolvePrice(rows, context)` / `resolvePriceMany(entries)` | `catalogPricingService.ts:10-11` | **0 for the selection** — ⚠️ but see the correction: these do **not** fetch prices |
| Typed module events | `createModuleEvents({ moduleId, events })` | `packages/checkout/src/modules/checkout/events.ts` | **0** |
| Encryption-aware reads | `findOneWithDecryption` / `findWithDecryption` | used in the public checkout route | **0** |

## ⚠️ Corrections — two claims above were refuted by challenger pass 2 and re-verified in code

**1. A-1 does NOT reuse `packages/checkout`'s pattern.** `signCheckoutAccessToken`
(`packages/checkout/src/modules/checkout/lib/utils.ts:278-290`) is a **stateless HMAC-signed token**:
the payload carries `exp: Date.now() + 3600000`, the cookie is `sameSite: 'strict'`, host-only, and
**nothing is ever stored in the database**. Revocation works only indirectly, by deriving `sessionVersion`
from the link's `passwordHash`.

A-1 needs the opposite: a **stored, hashed, globally unique, 30-day, individually revocable and rotatable**
secret. INV-15's lifecycle (rotate on reconciliation, rotate on login, invalidate on logout) is precisely
what a stateless signed token *cannot* do without a stored per-row version.

Correct precedents for a stored-token-hash lookup: `packages/core/src/modules/sales/api/quotes/public/[token]/route.ts`,
`packages/onboarding`, `packages/enterprise/src/modules/sso/services/scimTokenService.ts`.

Design consequence: the hash must be **deterministic** (HMAC-SHA256 with a server secret). A per-row-salted
hash — the repo's password precedent — makes lookup-by-token a table scan and breaks both the unique index
and INV-11's store-scoped predicate.

**2. `resolvePrice`/`resolvePriceMany` do not load prices.** The caller supplies already-fetched `PriceRow[]`
plus a `PricingContext`. The **fetch** is the step that costs queries, and it is the step that must be batched
and cached for whole-cart drift re-resolution on a public hot path. "One call, not N" is true of the selection
and false of the fetch. `PricingContext` is `{ channelId?, offerId?, userId?, userGroupId?, customerId?,
customerGroupId?, quantity, date }` — note `quantity`, which means re-resolving a line at read time must pass
the *current* quantity or tiered prices appear to drift for a reason unrelated to catalog change.

**Consequence for §1.5:** the "cheaper than they read" framing holds for **A-2 and A-5** (the
`transaction-expiry.worker.ts` shape) and for rate limiting (INV-17), and **not** for A-1. A-12, A-13 and A-14
are new design, not reuse.

> ⚠️ Guard rail found: `packages/cli/src/lib/generators/__tests__/example-public-route-safety.test.ts:14` asserts the
> scaffold carries *"Test-only public probe: do not copy `requireAuth: false` to data-bearing routes."*
> The repo deliberately treats public data routes as a reviewed exception. The cart is exactly such a route,
> so its spec MUST carry an explicit rate-limit + abuse section, or code review will (correctly) block it.

## Finding for architect checkpoint #1 — two concurrency contracts

The platform ships a complete optimistic-locking stack, **default ON**, keyed on `updated_at`:

- `packages/shared/src/lib/crud/optimistic-lock.ts` — guard service, `createOptimisticLockGuardService`, structured 409 `OptimisticLockConflictBody` (line 378-379)
- `optimistic-lock-headers.ts`, `optimistic-lock-store.ts`, `optimistic-lock-command.ts`
- UI side: `surfaceRecordConflict`, the unified conflict bar (`packages/ui/src/backend/conflicts/`)
- AGENTS.md makes it a hard rule for every new user-editable entity, with `OM_OPTIMISTIC_LOCK=off` as the opt-out

SPEC-029 §7.5.2 defines a **parallel, incompatible** mechanism for the same problem:

- integer `version` column, incremented per mutation
- 409 body `{ error: 'version_mismatch', currentVersion: N }` — a different shape from `OptimisticLockConflictBody`
- a bespoke `StorefrontVersionConflictError` in the storefront API client

**This is not automatically wrong.** An integer version is defensible for a high-mutation public cart: monotonic,
no timestamp-precision or clock-skew concerns, and trivially cheap to compare. The platform stack is also built
around `CrudForm` and backoffice routes, neither of which the storefront uses.

**But it must be a recorded decision, not an accident.** Two questions for checkpoint #1:

1. Is the integer `version` justified over the platform's `updated_at` token for this surface — and if so, is that written down anywhere?
2. If kept, should the 409 body at least *match the shape* of `OptimisticLockConflictBody` so clients and logging stay uniform?

This is the "did we overengineer / did we miss a platform capability" question in its sharpest form for this spec.

## Verified: event naming convention (resolves §10 Q-1 partially)

Surveyed the distinct event ids across `packages/*/src/modules/*/events.ts`. (Recount during pass 2:
**420 unique ids across 31 files**, multi-word action ratio **21:3** — my first count of "387 / 19:3" was
low because the glob missed files. The conclusion is unchanged.)

- Entity segment: snake_case is normal (`ai.token_usage.recorded`, `catalog.product_unit_conversion.created`)
- Action segment, multi-word: **snake_case dominates 19:3** (`email_sent`, `status_changed`, `low_stock`, `force_released`, `visibility_changed`, `reservation_shortfall`, …). The only camelCase actions in the entire codebase are three in `packages/checkout` (`customerDataCaptured`, `sessionStarted`, `usageLimitReached`) — a local deviation, not the house style.

**Conclusion:** the App Spec's `ecommerce.cart.line_added` / `line_updated` / `line_removed` match the dominant
convention and need no change. Do not follow `packages/checkout`'s camelCase.

Q-1's remaining half — `ecommerce.cart.*` vs `ecommerce.checkout_session.*` — is a domain question, not a
convention question, and stays with the challenger.

## Modules the cart will touch

| Module | Why | Coupling method (per AGENTS.md → Cross-Module Coupling) |
|---|---|---|
| `catalog` | variant/product lookup, price resolution | DI service (`catalogPricingService`), FK-id + snapshot — no ORM relation |
| `customer_accounts` | authenticated shopper identity, merge-on-login | FK id (`customer_id`), events |
| `events` | the 8 domain events | `createModuleEvents` |
| `queue` | expiry + abandonment sweep workers | worker contract |
| `cache` | store-context and catalog reads on a public hot path | DI, tenant-scoped, tag invalidation |
| `ecommerce` (new, SPEC-029) | owns the aggregate | same module |

No direct ORM relationships between modules — line snapshots hold `variant_id`/`product_id` as plain FK ids
plus denormalized display data, which is exactly the "FK-id + snapshot" pattern AGENTS.md prescribes.

## Still unverified

- Whether `apps/storefront/` needs a cart-specific SSR strategy (SPEC-029 §14 covers app structure, not cart hydration)
- Whether `EcommerceStore.settings.features` (SPEC-029 §7.1) has room for the guest-cart flag without a schema change
- Rate-limit budgets appropriate for a cart (checkout's `checkoutPublicViewRateLimitConfig` is tuned for page views, not per-keystroke quantity updates)
