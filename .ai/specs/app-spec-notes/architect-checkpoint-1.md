# Architect Checkpoint #1 — Storefront Cart App Spec

Scope: §3 workflows, §3.5 UI, §4 gap analysis. Two questions only — missed platform capabilities, and overengineering. Domain model not re-reviewed.

**Verdict: RE-MAP NEEDED.** Not because the domain work is wrong — it is unusually good — but because §4 scores several rows against a platform that already ships the capability, and one row (WF-4) is scored as *ROI-blocking* on a premise that is factually false in this repo. §4.1's 13 and §4.2's WF-4 5 both move.

---

## Part A — Missed platform capabilities

Ordered by how much they change §4.

### A1. `customer_accounts` already ships every storefront auth endpoint. A-14 is mostly already built.

This is the checkpoint's largest finding, and it invalidates §3.7's WF-4 row and §4.2's WF-4 score.

`packages/core/src/modules/customer_accounts/` exposes, all as `metadata = { requireAuth: false }` HTTP routes that do their own customer check:

| Capability | Endpoint | File |
|---|---|---|
| Login | `POST /api/customer_accounts/login` | `packages/core/src/modules/customer_accounts/api/login.ts` |
| Logout | `POST /api/customer_accounts/portal/logout` | `.../api/portal/logout.ts` |
| Session read ("me") | `GET /api/customer_accounts/portal/profile` | `.../api/portal/profile.ts` |
| Registration + email verify | `POST …/signup`, `POST …/email/verify` | `.../api/signup.ts`, `.../api/email/verify.ts` |
| Password reset | `POST …/password/reset-request`, `…/reset-confirm` | `.../api/password/*.ts` |
| Passwordless login | `POST …/magic-link/request`, `…/magic-link/verify` | `.../api/magic-link/*.ts` |
| JWT refresh | `POST …/portal/sessions-refresh` | `.../api/portal/sessions-refresh.ts` |
| Feature check | `POST …/portal/feature-check` | `.../api/portal/feature-check.ts` |

Session mechanics (`packages/core/src/modules/customer_accounts/services/customerSessionService.ts`): opaque 32-byte `crypto.randomBytes` token, **only the SHA-256 hash persisted**, 30-day TTL (`CUSTOMER_SESSION_TTL_DAYS`), max 5 concurrent sessions per user, individually revocable. Two cookies, set at `api/login.ts:144-157`:

```ts
res.cookies.set('customer_auth_token',    jwt,      { httpOnly: true, path: '/', sameSite: 'lax', secure: …, maxAge: 60*60*8 })
res.cookies.set('customer_session_token', rawToken, { httpOnly: true, path: '/', sameSite: 'lax', secure: …, maxAge: 60*60*24*30 })
```

No `Domain=` anywhere in the repo (`COOKIE_DOMAIN`/`cookieDomain` — zero hits), so cookies are host-only. There is **no CORS handler in the repo at all**; `packages/ui/agentic/standalone-guide.md:272-291` states the posture: *"Primary CSRF defense: SameSite=lax + same-origin deployment… Never accept cross-origin POSTs."*

**Consequences for the App Spec:**

1. **A-14's "add customer auth endpoints (login/logout/session)" should be struck.** What survives A-14 is: (a) resolving SPEC-029 Open Question #1 to `CustomerUser` — a decision with zero code, (b) the reconciliation endpoint, which belongs in the ecommerce module regardless, (c) storefront login/signup UI. That is not "platform + app"; it is app-only plus a one-line spec decision.
2. **§3.7's "WF-4 — Completes? No. No trigger exists" is wrong.** The trigger exists today: a successful `POST /api/customer_accounts/login` sets both cookies; the storefront then calls the reconciliation endpoint. WF-4 is not blocked and should not be gated.
3. **Q-15 answers itself.** `requireCustomerAuth` (`lib/customerAuth.ts:144`) is an *API* helper usable on any route, and it accepts `Authorization: Bearer <jwt>` as well as the cookie (`customerAuth.ts:83-101`). What is portal-only is `requireCustomerFeatures` *page metadata*, enforced in `apps/mercato/src/app/(frontend)/[...slug]/page.tsx:64-97`. So "API is platform-guarded, page protection is the storefront's own concern" is correct — but it is a documentation line, not an open question.
4. **A-9's same-site topology already has a working precedent**, not just a requirement: `apps/mercato/src/proxy.ts` + `apps/mercato/src/lib/customDomainResolver.ts` implement Host→org custom-domain routing, and the code comments note that `/api/*` deliberately bypasses the proxy and resolves the tenant from `Host` in the route handlers. Same-origin/reverse-proxied works unmodified; cross-origin does not and is prohibited. A-9 should cite this rather than assert it.
5. **New design obligation, not in the spec:** `magic-link/verify.ts:80-93` and `invitations/accept.ts:77-90` set the same two cookies as login. So §1.4.7's reconciliation trigger must be *"any customer session establishment"*, not *"login"* — otherwise a magic-link shopper silently loses their guest cart.

### A2. `packages/scheduler` exists and is the sanctioned way to run WF-5 and WF-6. The spec never mentions it.

`packages/scheduler` (`@open-mercato/scheduler`) is a DB-backed `ScheduledJob` system: cron **and** interval, BullMQ repeatable-job sync in async mode, a local polling fallback, execution history, a `requireFeature` RBAC gate, and a backoffice admin UI at `backend/config/scheduled-jobs/`. `api/targets/route.ts` auto-discovers **every module's `workers[].queue`** and every registered command as a schedulable target — so a cart sweep worker becomes merchant-schedulable for free.

Registration is a call in `setup.ts` (`packages/scheduler/.../services/schedulerService.ts:38`, `ScheduleRegistration` upserted on a stable UUID), guarded by `container.hasRegistration('schedulerService')` — see `packages/core/src/modules/integrations/setup.ts:41` for the house guard, and `packages/ai-assistant/src/modules/ai_assistant/setup.ts` (`ensurePendingActionCleanupSchedule`, `stableScheduleUuid`) for the best end-to-end precedent.

`packages/queue/AGENTS.md` explicitly forbids the alternative: *"Never implement custom job queues or polling loops."* `EnqueueOptions` is `{ delayMs?: number }` — the queue has no cron.

**Correction to the readiness note:** `packages/checkout/src/modules/checkout/workers/transaction-expiry.worker.ts` is **not** the precedent the spec treats it as — nothing ever enqueues it. Grep for `checkout-transaction-expiry` returns only its own two lines. Same for `customer-accounts-cleanup-sessions` / `cleanupExpiredTokens`. Copying its shape reproduces an orphan. The correct model is `packages/ai-assistant/src/modules/ai_assistant/workers/ai-token-usage-prune.ts` (batched deletes, env-tuned retention, exported testable core `runTokenUsagePrune()` separate from the handler) **plus** its `setup.ts` schedule registration.

Also: `packages/core/AGENTS.md:313` — *"MUST execute domain mutations through commands from workers"*. The abandonment scanner stamping `abandoned_at` must go through a command, not `em.nativeUpdate`, or it bypasses audit/events/cache invalidation — which would also silently break the `cart.abandoned` emission WF-5 exists for.

Net effect on §4: neutral on commits (registration folds into each worker's commit) but it removes a design risk and delivers `settings.cart.abandonmentThresholdHours` cadence control the merchant can actually see.

### A3. `sales/lib/calculations.ts` is a callable, extensible service — not just an arithmetic reference. §1.4.8's normalization table is already implemented there.

INV-5a says the cart "follows" `packages/core/src/modules/sales/lib/calculations.ts`. It should say **calls** it. Exports (`calculations.ts:406-453`):

```ts
export const salesCalculations: SalesCalculationRegistry
export async function calculateLine(opts: CalculateLineOptions): Promise<SalesLineCalculationResult>
export async function calculateDocumentTotals(opts: CalculateDocumentOptions): Promise<SalesDocumentCalculationResult>
export function registerSalesLineCalculator(hook, opts?): () => void
export function registerSalesTotalsCalculator(hook, opts?): () => void
export function rebuildDocumentResult(params): SalesDocumentCalculationResult
```

`buildBaseLineResult` (`calculations.ts:78-125`) already implements every row of §1.4.8's "Money normalization" table:

| §1.4.8 row | Already in `buildBaseLineResult` |
|---|---|
| derive net when only gross present | `unitPriceGross / (1 + taxRate)` where `taxRate = toNumber(line.taxRate)/100` |
| `tax_amount` null → derive | `round(netSubtotal * max(taxRate,0))` when not explicit |
| net == gross **and** rate > 0 (the seed's shape, Q-14/Q-17) | the `#2457` branch: *"when tax was not supplied explicitly and the rate-derived tax is zero but the gross total already embeds tax… derive the tax from the net/gross delta"* |
| `adjustments` (reserved, `[]` in cart scope) | `resolveAdjustmentAmounts()` — already handles rate-based and amount-based adjustments with per-adjustment tax rates |

So the resolver's arithmetic half is an import, and the extension seam for promotions later is `registerSalesLineCalculator` rather than a new `adjustments` pipeline. This is worth ~1 commit off §4.1's "Cart Line Resolver — 3".

### A4. The platform has **no** minor-unit money representation. `CartLine`/`CartTotals` integer minor units contradict INV-5a and guarantee cart ≠ order at handover.

Every money column in the platform is `numeric(18,4)` decimal-string. `packages/core/src/modules/sales/data/entities.ts`: `unit_price_net`, `unit_price_gross`, `subtotal_net_amount`, `subtotal_gross_amount`, `tax_total_amount`, `grand_total_gross_amount` — all `precision: 18, scale: 4`. `calculations.ts`'s `round()` is `Math.round((v + EPSILON) * 1e4) / 1e4` — 4 dp, never minor units.

Repo-wide, the only minor-unit code is `packages/gateway-stripe/src/modules/gateway_stripe/__tests__/shared.test.ts` — a conversion at the Stripe API boundary. `currencies.decimal_places` (`packages/core/src/modules/currencies/data/entities.ts:33`) exists for *display formatting*, not storage.

§1.4.3 specifies `line_total_net_amount` / `subtotal_net_amount` as **`integer (minor units)`**, and INV-5/INV-13 build the whole money model on round-once-to-minor-units. That means:

- The cart computes a subtotal at 2 dp; the `sales` order it becomes recomputes at 4 dp from the same inputs. They will disagree on qty×fractional-price lines. **This is exactly the defect INV-5a exists to prevent**, reintroduced by INV-5.
- INV-13's caveat *"`subtotal_net + tax ≠ subtotal_gross` is expected"* is an artifact of minor-unit rounding, not a domain fact. At 4 dp it largely disappears.
- The cart must invent a minor-unit rounding helper and a currency-exponent lookup the platform does not have.

Cheaper and correct: store `numeric(18,4)` decimal strings like every other money surface, and let `calculateLine`/`calculateDocumentTotals` own rounding. INV-5 collapses to "arithmetic is `calculations.ts`". *(Flagged as a capability miss with a §4 consequence, not as a domain re-litigation — the challenger passes optimized this model against an assumption about the platform that does not hold.)*

### A5. `auth/lib/tokenHash.ts` is the shared, production-hardened deterministic-hash helper A-1 needs. A-1 is Low, not Medium.

`packages/core/src/modules/auth/lib/tokenHash.ts` — 39 lines, two exports, already imported cross-package as `@open-mercato/core/modules/auth/lib/tokenHash`:

```ts
export function generateAuthToken(): string { return randomBytes(32).toString('hex') }
export function hashAuthToken(rawToken: string): string {
  return createHmac('sha256', resolveTokenSecret()).update(rawToken).digest('hex')
}
```

`resolveTokenSecret()` reads `AUTH_TOKEN_SECRET || AUTH_SECRET || NEXTAUTH_SECRET || JWT_SECRET` and **throws in production** if none is set. That is exactly A-1's "deterministic keyed hash, server secret".

The store/lookup/rotate half has 6+ precedents, not the 3 the spec cites — and the spec's three are **not one pattern**:

| Cited precedent | Reality |
|---|---|
| `sales/api/quotes/public/[token]` | ✅ deterministic HMAC via `hashAuthToken`; but the raw token is `crypto.randomUUID()` (122 bits, and the route validates `z.string().uuid()`), stored in a nullable column `sales_quotes.acceptance_token`, revoked implicitly by nulling it (`sales/commands/documents.ts:5059-5063`). No TTL on the token itself. |
| `onboarding` | ⚠️ deterministic but **unkeyed** SHA-256, via a *private, unexported* `hashToken` (`packages/onboarding/.../lib/service.ts:186-188`). Different helper. |
| `enterprise/sso/scimTokenService` | ❌ **per-row-salted bcrypt — deliberately non-deterministic.** Lookup is prefix-fan-out + `compare()` loop. Structurally incompatible with the other two. Citing it as a precedent for a deterministic-hash lookup is a mistake. |

The precedent the spec should cite instead — the only one with hash + TTL + usage limit + explicit consume path — is **`message_access_tokens`**: `packages/core/src/modules/messages/lib/email-sender.ts:140-158` (`createMessageAccessToken`), `lib/tokenConsumption.ts`, `commands/tokens.ts`, entity `data/entities.ts:234-250`. And, closer still, **`CustomerSessionService`** (A1) is a 30-day, hash-at-rest, rotatable, revocable, per-user-capped token on the very identity surface the cart binds to.

The `packages/checkout` retraction is **confirmed correct**: `signCheckoutAccessToken` (`packages/checkout/.../lib/utils.ts:278-291`) is stateless, unstored, `exp: Date.now() + 3600000`, cookie `sameSite: 'strict', maxAge: 3600` (`api/pay/[slug]/verify-password/route.ts:49-58`). Good catch, keep it.

**Score: A-1 Medium → Low; §4.1 "Cart Token — 2" → 1.**

### A6. The canonical-JSON claim is right, the source is wrong, and the commit is worth more than the spec credits.

Verified: **no** canonical-JSON helper in `packages/shared/src/lib/**`. `packages/shared/src/lib/json.ts` is types only (`JsonPrimitive`, `JsonValue`) — the natural home. Two independent module-local copies exist:

- `packages/search/src/vector/services/checksum.ts` — the one the spec cites. `stableStringify` is indeed unexported, but `computeChecksum` **is** public API at `@open-mercato/search/vector`, so "the only one is module-local and unexported" is imprecise. It also sorts with `localeCompare` (ICU-locale-sensitive → not actually deterministic across environments) and serializes `undefined` as `'null'`.
- `packages/core/src/modules/shipping_carriers/lib/shipment-idempotency.ts` — `stableSerialize`, **the better implementation**: drops `undefined` entries, codepoint sort. Its own doc comment already describes it as a general fingerprint helper.

Promote `stableSerialize`, not the search one. And the commit pays for itself beyond the cart: `packages/core/src/modules/payment_gateways/lib/payment-operation-idempotency.ts:33` hashes a request payload with plain `JSON.stringify`, so **two semantically identical payment requests with different JSON key order produce different idempotency keys** — a live defect a shared helper fixes. Keep the 1 commit; raise its priority.

### A7. A-12/A-12a's idempotency store has a direct copyable precedent. It is not "new design, not reuse".

The spec says *"A-12, A-13 and A-14 are new design, not reuse."* For A-12 that is only half true.

- **HTTP `Idempotency-Key` request replay, end to end:** `packages/checkout/src/modules/checkout/api/pay/[slug]/submit/route.ts` — reads the header (line 312-317), enforces 16–128 chars, catches the unique-index violation via `isIdempotencyConflict()` (line 188), and **replays the stored response** (lines 375-479). Entity unique key `['organizationId','tenantId','linkId','idempotencyKey']` (`data/entities.ts:275-276`).
- **A side table with claim/resolve/release, keyed on a request hash** — literally A-12a's shape: `packages/core/src/modules/shipping_carriers/lib/shipment-idempotency.ts` (`computeShipmentRequestHash`, `findShipmentIdempotencyClaim`, `claimShipmentIdempotency`, `resolveShipmentIdempotency`, `releaseShipmentIdempotency`, `ShipmentIdempotencyConflictError` with a `Symbol.for()` cross-bundle marker) over table `carrier_shipment_idempotency_keys`.
- Three more: `payment_gateways/lib/payment-operation-idempotency.ts` (10-min lease), `messages/commands/messages.ts` (partial unique index + unique-violation race recovery), `wms/lib/inventoryIdempotency.ts` (key builders).

There is no *shared* helper (confirmed — nothing in `packages/shared`, and `packages/queue` has no dedup: `EnqueueOptions` is `{ delayMs? }` only). But A-12a is copy-adapt from a working implementation, not invention.

### A8. `clientBroadcast: true` on the three line events is inert for a guest cart. Multi-tab sync needs no server work at all.

`packages/events/src/modules/events/api/stream/route.ts:19` — `export const metadata = { GET: { requireAuth: true } }`, and per `packages/events/AGENTS.md` delivery is filtered by tenant / organization / `recipientUserId` / `recipientRoleId`, with *"Missing `tenantId` in event payload means no delivery"*. The portal bridge (`packages/core/src/modules/customer_accounts/api/portal/events/stream.ts`) requires a customer session.

**Neither bridge has an audience concept for a Cart Token bearer.** So the flags are decorative for the guest path regardless of the `@open-mercato/*` import ban — Q-16's premise is right but its stated cause is wrong.

The behaviour §3.5 actually wants ("second tab removes a line → refresh") is *same-browser* sync, for which the browser ships `BroadcastChannel`: zero server work, zero import, no auth model. Q-16 closes as "use BroadcastChannel; drop `clientBroadcast` from the three line events (or keep it for backoffice observation only, where the audience model does apply)".

### A9. Rate limiting: adopt, do not invent. INV-17's mechanism is a two-line const.

`packages/shared/src/lib/ratelimit/` — `checkRateLimit(service, config, key, errorMessage)` returns a ready 429 with `Retry-After`/`X-RateLimit-*` or `null`; `readEndpointRateLimitConfig(envPrefix, defaults)` gives env-tunability (`RATE_LIMIT_{PREFIX}_POINTS|_DURATION|_BLOCK_DURATION`) for free. DI key `rateLimiterService` (`packages/shared/src/lib/di/container.ts:42`, registered `packages/core/src/bootstrap.ts:209`); also `getCachedRateLimiterService()` for pre-container use.

Best call site to copy — an unauthenticated public POST that also pairs the CSRF guard: `packages/core/src/modules/sales/api/quotes/accept/route.ts` (`validateSameOriginMutationRequest` + `SALES_QUOTES_ACCEPT` bucket, 10 pts / 60 s / 300 s block). Dual-bucket (per-IP + per-identity, with `delete()` on success) at `packages/core/src/modules/auth/lib/rateLimitCheck.ts` — that is the shape for "per token **and** per IP" in INV-17.

Existing prefixes to model budgets on: `CUSTOMER_LOGIN(_IP)`, `CUSTOMER_SIGNUP(_IP)`, `SALES_QUOTES_ACCEPT`, `DIRECTORY_ORG_LOOKUP`. Q-11 becomes "pick numbers", not "design a mechanism". Note `RATE_LIMIT_TRUST_PROXY_DEPTH` defaults to **0**, meaning `getClientIp()` returns `null` and everything falls into the shared `RATE_LIMIT_FALLBACK_KEY = 'global'` bucket unless deployment sets it — a real operational trap for a per-IP cart limit, worth one sentence in the spec.

### A10. Cache: the hot-path pattern the resolver needs already exists, with a two-tier tag convention.

DI key is **`cache`**, not `cacheService` (`packages/core/src/bootstrap.ts:123`; `packages/cache/AGENTS.md` is stale on this, and also documents an `invalidateTag()` that does not exist — the real method is `deleteByTags(tags: string[])`). Closest structural match to §1.4.8's "the fetch is the expensive one" problem: `packages/core/src/modules/customer_accounts/services/domainMappingService.ts` `resolveByHostname()` — optional-cache injection, `ttl` + **two-tier tags** (`domain_routing` plus `domain_routing:<hostname>`) so invalidation can be surgical or wholesale. The batched price fetch should be modelled on it. Not a commit change; a design shortcut §4 should name.

### A11. Minor, but worth recording

- `sales` models document lines as **first-class rows** with their own sub-resource route factory (`packages/core/src/modules/sales/lib/makeSalesLineRoute.ts`, used by `api/order-lines/` and `api/quote-lines/`), not as a jsonb snapshot array. The factory is backoffice-shaped (`features: {view, manage}`, custom fields, command prefix) so it is not directly reusable for a public guest cart — but it is worth one line in §0's rejected-alternatives that the platform's own money-bearing lines went the other way. Not a re-litigation; §0 is settled.
- `packages/cli/src/lib/generators/__tests__/example-public-route-safety.test.ts` (already in the readiness note) will make code review scrutinize `requireAuth: false` on data-bearing routes. With A9's pattern adopted this is satisfied, not just argued.

---

## Part B — Overengineering

### B1. A-11 is not an amendment. Strike it from §1.5 and from Q-12's blocking set.

SPEC-029 **§7.5.2 already specifies exactly what A-11 asks for**:

> `{ version: 3, lines: […] }` … `If session.version !== request.version → 409 Conflict { error: 'version_mismatch', currentVersion: 4 }`

and §14.3 already ships `class StorefrontVersionConflictError extends StorefrontApiError { constructor(public currentVersion: number) }` with `if (res.status === 409) { … throw new StorefrontVersionConflictError(json.currentVersion) }`. So "the storefront keeps body `version`" and "§14.3 parses that" are the parent's current text, not a change to it.

The genuine delta is: add `code: 'optimistic_lock_conflict'` and `expectedVersion` to a 409 body in an unimplemented spec. That is additive, zero-cost, and needs no upstream decision.

The *substance* of A-11 — that the storefront diverges from the platform's `updated_at` optimistic-lock contract and nothing enforces the divergence — is a valuable finding and should stay. But it belongs in a "Recorded divergences" note, not in "Required amendments to SPEC-029", and **not in Q-12**, which currently reads as three upstream blockers when it is really one and a half.

**Cheaper route:** demote A-11 to a documented divergence; Q-12 shrinks to A-13 + A-14.

### B2. A-13's cost is a spec edit, not "Medium — upstream decision".

A-13 removes `cart_review` from `checkout_storefront_v1` and moves workflow-instance creation to the first transition out of `open`. Real conflict, right call. But the artifact is a seeded workflow definition in SPEC-029 §19.3 that does not exist in code, in a section the parent itself brackets: §19.5 — *"**Phase 3 implementation MUST wait for that documentation**… The data model and API contracts are defined here as a forward reference."* The parent has already flagged §19 as provisional and invited exactly this revision.

**Cheaper route:** A-13 stays, cost → Low. It still needs the parent author's sign-off, so it stays in Q-12 — but as a review item, not a design blocker.

### B3. A-17 + the `POST /sessions/:id/checkout` endpoint: two amendments for an endpoint the cart does not own and that §1.2 excludes from scope.

A-17 records that `POST /sessions/:id/checkout` **displaces** the parent's `POST /sessions/:id/transition`, while simultaneously assigning ownership of that endpoint to Checkout. So the App Spec is amending a parent endpoint it does not own, in a phase it declares out of scope, to emit one event.

**Cheaper route:** leave `POST /sessions/:id/transition` intact. The cart phase (a) exports a named precondition check the transition calls, and (b) emits `ecommerce.cart.checkout_started` from a subscriber on the `open → locked` transition, which also clears `abandoned_at`. Same KPI numerator, same `abandoned_at` clearing, no displaced parent endpoint. **A-17 disappears; A-12 loses its fourth bullet** and becomes purely the three line sub-resources — which is the part that is genuinely necessary and genuinely new.

If the reviewer prefers the dedicated endpoint, it should be added by SPEC-029 Phase 3 as an additive route, not recorded here as a displacement.

### B4. `/cart/reconcile` as a route is not justified. A dialog on `/cart` is.

§1.4.7 makes adoption **"the dominant path"** — no UI at all. The reconcile *choice* surface fires only on (a) currency conflict and (b) INV-14 overflow on merge. Both are rare, both are strictly modal ("pick one, then continue"), and both arise **inside** an interaction that already has the shopper on a page.

A dedicated route costs three states the spec does not budget: landing on `/cart/reconcile` with no pending reconciliation, landing on it after the conflict was already resolved in another tab, and landing on it unauthenticated. §3.5's own table already mandates `Escape`-cancel/`Cmd+Enter` dialog semantics elsewhere.

**Cheaper route:** `ReconcileChoice` renders as a blocking dialog on `/cart`, driven by the reconciliation endpoint's `409`-style response. **A-16 drops to one route (`/cart`) + the `cart/` component folder.** No commit saving (still inside §3.5's 3), but three fewer failure states and one fewer route to protect.

### B5. Cutting WF-7 is the wrong call. It costs ~1 commit and it is the only merchant-visible surface.

§3.6's argument is *"every metric is answerable from the event stream"*. In this repo that is true for a **developer writing a subscriber** and false for a **merchant**:

- `packages/core/src/modules/audit_logs/` has **no `subscribers/` directory** — it is command/mutation-driven. There is no persisted, browsable event log.
- `packages/events/src/modules/events/api/route.ts` returns event *definitions*, not occurrences.
- So a merchant, or the support agent taking "my cart is broken" / "it says my cart is empty but I added things", has **no surface at all**.

And the cost is not what §3.6 implies. A read-only backoffice list in this codebase is a `makeCrudRoute` list plus a page.meta — `packages/checkout/src/modules/checkout/backend/checkout/transactions/page.meta.ts` is **14 lines**, and its API route is **74**. A-7 (`ecommerce.checkout.view`) is one line in `acl.ts` regardless of WF-7, and SPEC-029 §12.3 already has a `view`/`manage` pair convention (`ecommerce.stores.view`, `ecommerce.storefront.view`) that a read-only checkout feature fits.

**Restore WF-7 at 1 commit**, read-only, filtered to `status='open'` by default. It is the cheapest insurance in the whole plan: WF-4's reconciliation conflicts and WF-5's `abandoned_at` marks are precisely the states support gets called about, and both are otherwise invisible. §3.6's follow-on ("if it stays cut, A-7 and the Store Operator persona go with it") then does not fire, and §1.4.6/§2 stay coherent as written.

### B6. `settings.cart` is a TypeScript type edit, not a commit.

SPEC-029 §7.1 declares `settings | jsonb`; §7.1.1 is a TS type over that column. Adding a `cart` section is a type change plus defaults — no migration, no schema. §4.1 scoring it as its own commit alongside the entity commit is generous; fold it.

(The spec's *reasoning* for A-6 is right: `features` is a closed set of six booleans and cannot hold `openTtlDays`. Only the cost is off.)

### B7. Things that are correctly scoped — do not cut these

For balance, several items that look expensive and are not overengineering:

- **A-12's three line sub-resources.** The parent's whole-array PATCH genuinely cannot carry per-line intent, and the two-mutation-surface argument against keeping both is correct.
- **A-1's stored token.** The retraction of the `packages/checkout` precedent is right; a stateless token cannot do INV-15's rotation/revocation. Only the *cost* was overstated (A5).
- **The canonical-JSON promotion.** Justified, and it fixes a live bug elsewhere (A6).
- **INV-17.** A public, unauthenticated, row-creating endpoint with no rate limit is not a deferred item. Mechanism is free (A9); keep the invariant.
- **INV-11's store-scoped predicate**, INV-16, and A-8. Non-negotiable on a public multi-tenant surface.

---

## Part C — Commit re-score

### §4.1 Shared foundation: **13 → 10**

| Item | §4 | Revised | Reason |
|---|---|---|---|
| Session entity + migration (A-1, A-3, A-5, A-10) | 1 | 1 | — |
| `settings.cart` + defaults (A-6) | 1 | **0** | jsonb type edit; folds into the entity commit (B6) |
| Cart Line Resolver | 3 | **2** | arithmetic + normalization delegate to `calculateLine`/`calculateDocumentTotals` (A3). Remaining: variant/scope validation, batched+cached price **fetch**, currency check, snapshot assembly |
| Canonical `line_attributes` helper → `packages/shared` | 1 | 1 | correct; promote `stableSerialize`, not the search copy (A6) |
| Line sub-resources + `Idempotency-Key` store | 3 | 3 | sub-resources are real work; idempotency half is copy-adapt (A7). Net unchanged |
| Cart Token | 2 | **1** | `hashAuthToken`/`generateAuthToken` import + `CustomerSessionService` shape (A5) |
| Rate limiting wiring | 1 | 1 | cross-cutting pass over ~6 routes + OpenAPI 429 schemas (A9) |
| Event catalogue (9 events) | 1 | 1 | drop `clientBroadcast` on the three line events (A8) |
| **Subtotal** | **13** | **10** | |

### §4.2 Per-workflow

| WF | §4 | Revised | Reason |
|---|---|---|---|
| WF-1 | 2 | 2 | — |
| WF-2 | 3 | 3 | drift computation + batched price fetch is the real cost; cache pattern exists (A10) but the batching is new |
| WF-3 | 2 | 2 | — |
| **WF-4** | **5, blocks ROI** | **3, NOT blocked** | auth endpoints exist (A1). Remaining: reconciliation endpoint + `merged` handling (2), storefront login/session UI (1). Reconcile choice is a dialog, not a route (B4) |
| WF-5 | 1 | 1 | worker + `schedulerService.register()` in `setup.ts` (A2) |
| WF-6 | 1 + ? | 1 + ? | unchanged; Q-10 (retention/GDPR) is a genuine open compliance item |
| §3.5 UI | 3 | 3 | one route instead of two (B4) |
| **WF-7 (restored)** | cut | **+1** | read-only backoffice list (B5) |

### Corrected totals

| | §4.3 | Revised |
|---|---|---|
| First increment (foundation + WF-1/2/3 + UI) | 23 | **20** |
| WF-5 | 1 | 1 |
| WF-4 | 5, **gated on A-14** | **3, ungated** |
| WF-6 | 1 + unknown, gated on Q-10 | 1 + unknown, gated on Q-10 (unchanged) |
| WF-7 | — (cut) | 1 |
| **Total scored** | **30** | **26** |

**Platform-scoped commits: 2 → 1.** Only the canonical-JSON helper remains `platform`. A-14's auth half no longer exists (A1).

---

## Part D — Phasing

**§4.3's first slice is not the cheapest one that delivers measurable value, and its dependency accounting is incomplete.**

§3.7 names only SPEC-029 **Phase 1** (store context resolver) as the cross-cutting blocker. But the 3 UI commits in the first increment additionally require:

- **SPEC-029 Phase 4** — `apps/storefront/` does not exist. The cart components sit inside a Next.js app, layout, and design system that Phase 4 delivers (SPEC-029 §26, items 20-30).
- **SPEC-029 Phase 2** — WF-1 starts at "PDP → Add to cart". There is no PDP without the Phase 2 public catalog APIs and the Phase 4 PDP components.

So the "23-commit first increment" cannot ship until SPEC-029 Phases 1, 2 **and** 4 land. That is not a small correction — it is most of the parent spec.

**Recommended first slice — API-only, 15 commits:**

> Foundation (10) + WF-1/2/3 **API surface** (~4 of their 7, excluding drawer/badge/`CartPage`/`CartLineRow`) + WF-5 (1)

Why this is the right cut:

1. **It depends only on SPEC-029 Phase 1 + `catalog`** — both of which are either the parent's first sprint or already built. No Phase 2, no Phase 4, no `apps/storefront/`.
2. **It is verifiable without a UI.** Integration tests against the HTTP surface prove the invariants that actually carry risk — INV-2's identity key, INV-5a's arithmetic, INV-6's server-derived money, INV-7a's replay-before-version ordering, INV-11's store scoping, INV-12's single open cart. Those are where the four challenger passes concentrated, and none of them needs a browser.
3. **It delivers the §1.2 leading indicator immediately.** `cart.created`, `line_added`, `abandoned` flow the moment WF-5 is in; cart survival rate is computable against `last_activity_at`. §4.3 currently places WF-5 *after* the first increment even though it costs 1 commit and is the thing that closes the §1.1 flywheel — **pull WF-5 into slice 1**.
4. **It de-risks the expensive unknown early.** The batched, cached price **fetch** (§1.4.8's own correction — "the fetch is the expensive one") is the piece most likely to be mis-estimated. Hitting it in slice 1, without UI work in flight, is where it costs least.

**Then:** slice 2 = the 3 UI commits + WF-1/2/3's client halves, landing with SPEC-029 Phase 4. Slice 3 = WF-4 (3, now ungated — it can even move ahead of the UI slice since its endpoint is server-side). WF-6 stays last and stays gated on Q-10, correctly.

**WF-7 (1 commit) belongs in slice 1 or 2, not "cut"** — it is backoffice, so it depends on neither Phase 2 nor Phase 4, and it is the only way anyone but a developer can observe the carts slice 1 produces.

---

## Open items handed back

| Item | Change |
|---|---|
| Q-12 | Shrinks to A-13 (review item) + A-14 (decision only — the endpoints exist). A-11 leaves the blocking set entirely (B1) |
| Q-15 | Closes: `requireCustomerAuth` is an API helper usable anywhere and accepts Bearer; only `requireCustomerFeatures` *page metadata* is portal-bound (A1) |
| Q-16 | Closes: neither SSE bridge has an audience model for a Cart Token bearer. Use `BroadcastChannel` (A8) |
| Q-11 | Downgrades to "pick numbers" — mechanism, env plumbing and dual-bucket pattern all exist. Add a note on `RATE_LIMIT_TRUST_PROXY_DEPTH=0` (A9) |
| Q-14 / Q-17 | Largely closed: `buildBaseLineResult`'s `#2457` branch already derives tax from the net/gross delta for exactly the seed's `net == gross` + `rate > 0` shape (A3). The seed is still worth fixing, but it no longer blocks the demo |
| **New** | §1.4.3's `integer (minor units)` contradicts the platform's universal `numeric(18,4)` and INV-5a. Needs a decision before implementation (A4) |
| **New** | The reconciliation trigger must cover magic-link and invitation-accept logins, not just `POST /login` (A1) |
