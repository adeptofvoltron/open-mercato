# Phase 1 draft — Workflows & ROI (Storefront Cart)

Moves into §3 of `2026-08-13-app-spec-storefront-cart.md` once the Phase 0 gate closes.

Personas per §2: **Guest Shopper**, **Authenticated Shopper**, **Store Operator**.
Platform-readiness rows draw on `platform-readiness-cart.md`; gap scores are provisional until §4.

> **Synced to spec v3.** Changes since the first draft: the line mutation surface is now intent-bearing
> sub-resources with an `Idempotency-Key` header (A-12), not a whole-array replace; "merge" is now
> **Cart Reconciliation** and covers supersede; WF-4 gains a hard dependency on A-14 (the parent has
> **no storefront login endpoint at all**); A-1's cost is **Medium**, not Low; every workflow inherits
> INV-17 (rate limiting is a requirement, not a deferred budget); and the cart phase is plain CRUD,
> not a workflow step (A-13).

---

## WF-1: Add the first item — cart creation

**Journey:** shopper on a product page → selects variant → Add to cart → session created in `open` + Cart Token issued + line resolved and persisted → cart badge and drawer reflect the line

**ROI:** this is the top of the entire cart funnel — every unit of the §1.2 conversion metric starts here. A failure at this step is not a degraded experience, it is a lost order with no trace.

**Key personas:** Guest Shopper (or Authenticated Shopper — identical flow, different owner claim)

**Boundaries:**
- Starts when: the shopper submits an add-to-cart action for a resolved variant
- Ends when: the server returns a persisted cart with `version`, totals, and (for guests) a Cart Token cookie
- NOT this workflow: product browsing and variant selection (SPEC-029 Phase 2); anything after `open`

**Edge cases:**
1. Guest carts disabled on the store (`allowGuestCart=false`, A-6) → redirect to login, preserve the intended variant so add-to-cart completes after auth → *risk if unhandled: the shopper logs in and lands on an empty cart, having lost their intent*
2. Variant unpublished or outside `catalog_scope` between page render and add → Cart Line Resolver rejects with a typed error, no partial line persisted → *risk: a line pointing at a non-purchasable variant, discovered at checkout*
3. No price for the store's bound `price_kind_id` → reject at the resolver, do not fall back to another price kind → *risk: silently charging a B2B price on a B2C store*
4. Retry after a lost response → same client-supplied `line_id` → idempotent upsert, `version` unchanged (INV-7a) → *risk: double-add, the C-3 defect*
5. Concurrent add from two tabs → `version` conflict on the second → 409, client re-fetches and replays → *risk: one add silently lost*

**Platform readiness (per step):**

| Step | Platform capability | Gap? | Notes |
|---|---|---|---|
| Public unauthenticated endpoint | `requireAuth: false` route metadata | **no** | Precedent: `packages/checkout/.../pay/[slug]/route.ts:22` |
| Abuse control | `rateLimiterService` (DI) + `checkRateLimit` | **no** | Mechanism free; **INV-17 makes it mandatory**, budgets in Q-11 |
| Store context from Host | SPEC-029 §6.3 resolver | **yes — parent** | Phase 1 of SPEC-029, unimplemented |
| **Line sub-resource endpoints** | — | **yes — new (A-12)** | The parent's only mutation is a whole-array replace that cannot carry `line_id`, `line_attributes` or per-line intent |
| Fetch candidate `PriceRow[]` | query engine | **small** | ⚠️ the expensive step — `resolvePrice*` does **not** fetch |
| Select price from rows | `catalogPricingService.resolvePriceMany` | **no** | Cart Line Resolver §1.4.8 wraps it |
| Round `numeric(16,4)` → minor units | — | **small** | Half-up, once, in the resolver (INV-5) |
| Canonicalize `line_attributes` | — | **yes — new** | No shared canonical-JSON helper exists in `packages/shared`; one must be promoted |
| Issue Cart Token cookie | stored-token-hash pattern | **medium** | A-1 — **not** the `packages/checkout` cookie (that is stateless HMAC, unstored, 1h). Precedents: `sales/api/quotes/public/[token]`, `scimTokenService` |
| Persist + emit `cart.created`, `cart.line_added` | `createModuleEvents` | **no** | |

---

## WF-2: Review and modify the cart

**Journey:** shopper opens the cart → sees lines, quantities, subtotal in the store's `tax_mode`, and any drift advisories → changes a quantity or removes a line → totals recompute → shopper proceeds or leaves

**ROI:** removes the two mechanical reasons shoppers abandon at the cart step — inability to correct a mistake, and distrust of a number they cannot explain. Directly moves cart→checkout conversion.

**Key personas:** Guest Shopper, Authenticated Shopper

**Boundaries:**
- Starts when: the cart is opened (drawer or page)
- Ends when: the shopper leaves the cart with their intended contents persisted
- NOT this workflow: entering addresses, choosing shipping, applying discounts (all post-`open` or out of scope)

**Edge cases:**
1. Price drifted since add (INV-9) → per-line advisory `price_changed_since_added` + `current_unit_price_amount`, snapshot untouched → *risk: shopper discovers the change at payment — the highest-abandonment moment (Q-6)*
2. Variant became unavailable → `availability_status` advisory, line stays visible and removable → *risk: an unactionable error blocking the whole cart*
3. Quantity set to 0 → treated as remove (INV-3), not stored → *risk: a zero line poisoning totals*
4. Quantity beyond the INV-14 bound → clamp with an explicit message → *risk: unbounded jsonb growth on a public endpoint*
5. Two tabs open, one removes a line → the other receives `cart.line_removed` via `clientBroadcast` and refreshes → *risk: a stale tab writing back a removed line*

**Platform readiness:**

| Step | Platform capability | Gap? | Notes |
|---|---|---|---|
| Read cart, store-scoped (INV-11) | query engine + tenant scoping | **no** | |
| Drift computation on read | `resolvePriceMany` (batch, one call) | **no** | Never per-line N+1 |
| Recompute totals server-side (INV-6) | plain domain logic | **small** | |
| Multi-tab sync | DOM Event Bridge + `clientBroadcast: true` | **no** | `events` package |
| Optimistic locking | body `version` per SPEC-029 §7.5.2 | **decision** | A-11 — diverges from the platform `updated_at` contract |

---

## WF-3: Return to an existing cart

**Journey:** shopper closes the tab / returns days later / opens the store on another device → cart is still there with its contents → continues where they left off

**ROI:** **the workflow the whole spec exists for.** Cart survival rate is the leading indicator in §1.2; this is the only workflow that moves it directly. Under SPEC-029 as written this workflow does not exist at all — `sessionStorage` is lost on tab close.

**Key personas:** Guest Shopper (same device, via Cart Token), Authenticated Shopper (any device, via `customer_user_id`)

**Boundaries:**
- Starts when: a returning shopper loads the storefront
- Ends when: their prior cart contents are displayed and mutable
- NOT this workflow: the merge that happens if they log in holding a second cart (WF-4)

**Edge cases:**
1. Cart Token present but the cart expired (INV-10) → clear the cookie, start fresh, tell the shopper rather than showing an empty cart silently → *risk: shopper believes the store lost their order*
2. Token presented against a different store (`?storeSlug=` override, SPEC-029 §6.3) → store-scoped lookup predicate rejects it (INV-11) → *risk: cross-tenant cart exposure — a root-AGENTS.md "Never"*
3. Authenticated shopper with an `open` cart on device A opens device B → same cart via `customer_user_id`, guaranteed single by INV-12 → *risk: two divergent carts, neither authoritative*
4. Cart abandoned then returned to → `abandoned_at` cleared, `cart.recovered` emitted once (edge-triggered) → *risk: recovery attribution counting carts nobody recovered*
5. Shopper logs out on a shared device → token invalidated, cart unreachable from that browser (INV-15) → *risk: the next person on that device sees a stranger's cart*

**Platform readiness:**

| Step | Platform capability | Gap? | Notes |
|---|---|---|---|
| Cookie survives tab close | A-1 cookie (not `sessionStorage`) | **small** | The core amendment |
| Cross-origin cookie transport | — | **decision** | A-9: same-site proxy topology recommended; also fixes `Host` resolution |
| No shared-cache replay | `cache: 'no-store'` on session endpoints | **small** | A-9 — otherwise Next's shared cache serves one shopper's cart to another |
| Cross-device lookup by owner | indexed `customer_user_id` | **small** | A-3 |

---

## WF-4: Reconcile the guest cart on authentication

> Renamed from "merge": the workflow has two legitimate outcomes — **merge** (lines transferred) and
> **supersede** (shopper chooses one cart, nothing transfers). Calling both "merge" was what left the
> currency-conflict path without a terminal state.

**Journey:** shopper with a guest cart authenticates → carts are reconciled into one → contents preserved or explicitly chosen → token rotated

**ROI:** login is a high-abandonment moment precisely because shoppers expect to lose their cart. Preserving it converts a drop-off point into a continuation. Measured by guest→account merge rate.

**Key personas:** Guest Shopper becoming Authenticated Shopper

**Boundaries:**
- Starts when: authentication succeeds while a non-empty guest cart token is present
- Ends when: one cart remains, owned by `customer_user_id`, with a rotated token and `cart.merged` emitted
- NOT this workflow: logout; the ordinary cross-device return (WF-3)

**Edge cases:**
1. Both carts non-empty with colliding lines → quantities summed per INV-2's identity key, capped by INV-14 → *risk: the same product twice in one cart*
2. Currencies differ → **no merge**, guest cart preserved, shopper offered an explicit choice (§1.4.7) → *risk: silently discarding a cart, the worst §1.2 outcome*
3. Guest cart empty → no-op, **no event** → *risk: merge-rate metric inflating toward 100%*
4. Login occurs while the account cart is `locked` (mid-checkout) → merge forbidden by INV-1, deferred until checkout resolves → *risk: mutating a session whose totals are being charged*
5. Merge interrupted mid-write → absorbed cart must end at `merged` with `merged_into_session_id`, or not at all → *risk: two carts both claiming to be authoritative*

**Platform readiness:**

| Step | Platform capability | Gap? | Notes |
|---|---|---|---|
| **Storefront login endpoint** | — | **yes — blocking (A-14)** | SPEC-029 leaves storefront customer login **explicitly undecided** (Open Question #1, line 1837); §12.1 defines no auth endpoint and §14.1 no login route. Without it this workflow has no trigger. |
| Customer session cookie on the store host | — | **yes (A-14 + A-9)** | Same same-site topology the Cart Token needs |
| Reconciliation endpoint | — | **yes — new** | Where `cart.merged` is emitted |
| Reconcile transaction | domain logic + `merged` status | **medium** | A-10 adds the status and the worker-predicate exclusions |
| Token rotation / invalidation | stored-token-hash | **small** | INV-15 — needs A-1's per-row revocation, which a stateless token cannot do |
| `cart.merged` event with `outcome` + `linesTransferred` | `createModuleEvents` | **no** | |

> **Highest-complexity workflow in the set, and the only one with a blocking upstream dependency.**
> It should almost certainly become its own feature spec, and it cannot be scheduled until Q-12 (A-14)
> is decided upstream.

---

## WF-5: Detect abandonment, emit the recovery signal

**Journey:** cart goes quiet past the store threshold → scanner stamps `abandoned_at` → `cart.abandoned` emitted with contents and value → a recovery campaign (out of scope) consumes it

**ROI:** creates the observation that closes the §1.1 flywheel. Without it, abandoned intent is invisible and unrecoverable. The event payload is the deliverable; the campaign is someone else's.

**Key personas:** system; Store Operator as the consumer of the resulting analysis

**Boundaries:**
- Starts when: `last_activity_at` crosses the store's abandonment threshold
- Ends when: `abandoned_at` is stamped and the event emitted
- NOT this workflow: sending recovery email; expiry (WF-6)

**Edge cases:**
1. Scanner runs repeatedly over the same cart → `abandoned_at` makes the emit edge-triggered, exactly once → *risk: re-mailing the same shopper every tick*
2. Guest cart with no `email` → abandonment is still recorded; recoverability is a separate question (Q-7) → *risk: assuming every abandoned cart is contactable*
3. Threshold shorter than realistic browsing pauses → near-100% abandonment, no signal → *risk: a metric that carries no information (§1.2 threshold/TTL coupling)*
4. Cart abandoned then expires → `expired` wins; do not emit `recovered` → *risk: recovery counting dead carts*
5. Merchant changes the threshold with carts in flight → define whether existing carts re-derive → *risk: a step change in the metric mistaken for a behavior change*

**Platform readiness:**

| Step | Platform capability | Gap? | Notes |
|---|---|---|---|
| Scheduled scanner | `queue` worker contract | **no** | Precedent: `transaction-expiry.worker.ts` |
| Stamp + emit once | `abandoned_at` | **small** | A-5 |
| Per-store threshold | `EcommerceStore.settings` | **small** | Same amendment family as A-6 |

---

## WF-6: Expire the cart

**Journey:** cart passes its TTL → worker transitions it to `expired` → it stops being reachable and stops accepting mutations

**ROI:** protects against zombie carts converting against month-stale pricing, and bounds the growth of a table fed by an unauthenticated public endpoint. Prevents loss rather than creating gain — but the loss it prevents is mispriced orders.

**Key personas:** system

**Boundaries:**
- Starts when: `expires_at` passes
- Ends when: status is `expired`
- NOT this workflow: deletion or PII erasure — **the worker does not delete** (Q-10)

**Edge cases:**
1. Cart expires mid-session in an open tab → next mutation returns a typed expiry error, client starts fresh with an explanation → *risk: silent failures the shopper reads as a broken site*
2. Merchant shortens the store TTL → decide whether existing `expires_at` re-derives → *risk: mass unexpected expiry*
3. Expired cart still holds `email` → retention/erasure rule needed (Q-10) → *risk: a compliance gap this spec authors, not inherits*
4. Expiry racing a checkout transition → INV-1 and INV-10 must not both fire → *risk: a session both expiring and locking*

**Platform readiness:**

| Step | Platform capability | Gap? | Notes |
|---|---|---|---|
| Scheduled expiry | `queue` worker | **no** | Copy `transaction-expiry.worker.ts` shape |
| Retention / erasure | encryption + GDPR helpers | **open** | Q-10 — no rule yet |

---

## WF-7 (candidate — recommend CUT or defer): Store Operator inspects carts

**Journey:** operator opens a cart list in the backoffice → filters by abandoned/value → opens one to answer a support question

**ROI:** weak as stated. Supports abandonment analysis and support handling, but does not move any §1.2 metric on its own, and every metric here is answerable from events and analytics without a UI.

**Honest assessment for the Phase 1 reality check:** this is the only workflow in the set that fails the skill's own rule — *"if a workflow doesn't move a KPI or enable one that does, cut it."* It also drags in a backoffice page, an ACL feature (A-7) and list/filter UI for a need no one has voiced.

**Recommendation:** cut from this App Spec; revisit when a merchant asks. If cut, A-7 (`ecommerce.checkout.view`) and the Store Operator persona's read path leave with it — worth checking §2 and §1.4.6 stay coherent after removal.

---

## Summary for the reality check

| WF | Moves which §1.2 metric | Complete end-to-end? | Provisional size |
|---|---|---|---|
| WF-1 Add first item | conversion (entry) | yes, given A-12 | medium |
| WF-2 Review/modify | conversion | yes, given A-12 | medium |
| WF-3 Return to cart | **survival** (leading) | yes, given A-1/A-9 | medium |
| WF-4 Reconcile on auth | merge rate | **no — A-14 undecided upstream** | **large** |
| WF-5 Abandonment signal | abandonment rate | yes, given A-5 | small |
| WF-6 Expiry | none directly (loss prevention) | **no — Q-10 retention unresolved** | small |
| WF-7 Operator view | none | n/a | **cut candidate** |

**Reality-check flags — two workflows do not currently complete:**

- **WF-4 has no trigger.** The parent leaves storefront customer login explicitly undecided and defines no auth endpoint or route. Until A-14 is decided upstream (Q-12), this is a design, not a workflow. It is also the workflow carrying the guest→account merge metric.
- **WF-6 cannot complete** until Q-10 has an answer. A worker that marks rows `expired` forever, on records holding email, is not a finished workflow for an EU-market platform.
- **WF-1..WF-4 all depend on SPEC-029 Phase 1** (store context resolver), which is unimplemented. Nothing here ships standalone — this shapes §7 phasing more than anything else.
- **Three amendments need upstream decisions, not local ones** (Q-12): A-11 (concurrency contract), A-13 (workflow instance creation), A-14 (customer auth). A-13 in particular determines whether add-to-cart is a CRUD write or a workflow transition — i.e. whether WF-1 and WF-2 are even shaped correctly as written.
- Every workflow assumes A-9's deployment topology. Unresolved, WF-3 fails silently in production rather than loudly in review.

**Recommendation for §7 phasing:** WF-1/WF-2/WF-3 form the first shippable increment (a working guest cart that survives), WF-5 follows cheaply, and WF-4 is deferred behind the A-14 decision rather than blocking the rest.
