# Plan — eComm Release 5, Conversion (fork PR #16)

> Fork: `adeptofvoltron/open-mercato`. PR #16 (draft, base `develop` @ `fc5f8d04ca`).
> Branch: `feat/release-5-conversion` (already exists on the fork, reused — not created by this run).
> Worktree: `/Users/bernard/workspace/open-mercato/.ai/tmp/release-5-conversion-impl`.
> Source of truth: the revised specs on this branch (HEAD `c92470d8d5` at run start), plus
> `.ai/specs/analysis/ANALYSIS-2026-10-26-ecommerce-release-5-scope.md`,
> `-cross-spec.md` (wave table) and `-decisions.md` (D-R5-1…37, audit trail).
> Unattended run — no human in the loop until completion. Local ambiguity not resolved by a spec
> or a D-R5 decision is resolved with the safest option and logged under "Decisions taken without
> the owner" in this file; the run does not stop for it.

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status`
> to `done` and fill `Commit` with the short SHA. The first non-`done` row is the resume point.

| Phase | Step | Title | Exec | Status | Commit |
|-------|------|-------|------|--------|--------|
| 0 | 0.1 | Run folder scaffold (this commit) | inline | todo | — |
| 1 | 1.1 | shared: trusted command-context helper (X10) | dispatch:standard | done | 97e128cd49 |
| 1 | 1.2 | ecommerce: `storeContextService.resolveForBuyer` (D-R5-22, SPEC-029) | dispatch:standard | done | 8ceb5e42ce |
| 1 | 1.3 | wms: extract `wmsReservationService` (A1) | dispatch:standard | done | pending |
| 1 | 1.4 | availability: Phase 2 alignment — shared sellable builder (A2) | dispatch:standard | done | pending |
| 1 | 1.5 | customer_groups: credit entities + migration + new `CustomerGroupTerms` columns | dispatch:standard | done | pending |
| 1 | 1.6 | customer_groups: credit service, row-lock reserve/release/settle + N=20 test (G1/G2/G12/G14) | dispatch:standard | done | pending |
| 1 | 1.7 | customer_groups: credit admin API + UI + ACL + encryption.ts (G13/G16/G22) | dispatch:standard | done | pending |
| 1 | 1.8 | customer_groups: credit notifications + exposure-audit job + cancel-release subscriber (D-R5-2/G15/G21) | dispatch:standard | done | pending |
| 1 | 1.9 | promotions: `revertCodeUse` + `sales.order.cancelled` subscriber (C5) | dispatch:standard | todo | — |
| 1 | 1.10 | promotions: un-hide `delivery_method` rule + `DELIVERY_DISCOUNT` effect (D-R5-17) | dispatch:standard | todo | — |
| 1 | 1.11 | customer_groups: admin credit-account provisioning route + ledger-listing read route (G13/D-R5-5 gap-fill) | dispatch:standard | todo | — |
| 1 | 1.12 | customer_groups: admin credit-account `/adjust` command route (G13/G20/D-R5-2 gap-fill) | dispatch:standard | todo | — |
| 2 | 2.1 | availability: `AvailabilityReservation` entity + migration (A3) | dispatch:standard | todo | — |
| 2 | 2.2 | availability: reserve/release/commit via `wmsReservationService`, CAS, per-line outcomes, allocation (A6/A7/A14/A15) | dispatch:standard | todo | — |
| 2 | 2.3 | availability: expiry job + reconciliation job + events (A11/A12/A13) | dispatch:standard | todo | — |
| 2 | 2.4 | customer_groups: `CustomerPurchaseApproval` entity + migration (actor-typed columns, policy snapshot) | dispatch:standard | todo | — |
| 2 | 2.5 | customer_groups: approval service, CAS decide/withdraw (G6) + `expire-approvals` job (D-R5-27) | dispatch:standard | todo | — |
| 2 | 2.6 | customer_groups: approval portal + staff routes + ACL + grants (G5/G7/D-R5-7/D-R5-34) | dispatch:standard | todo | — |
| 2 | 2.7 | customer_groups: approval notifications (D-R5-6/D-R5-32/G15) | dispatch:standard | todo | — |
| 2 | 2.8 | cart: lock contract — `lockTtlMs`, idempotent extend by `checkoutSessionId`, `unlock`/`markConverted` match (C1) | dispatch:standard | todo | — |
| 2 | 2.9 | cart: D-R5-21/D-R5-22 identity binding on `/current/*` + trusted `resolveForBuyer` path for pay_link/api/agent | dispatch:standard | todo | — |
| 2 | 2.10 | cart: `markConverted` additive inputs (`salesOrderId`/`lineMap`/`salesQuoteId`, K8/D-R5-26); admin list + detail + reprice (K6) | dispatch:standard | todo | — |
| 2 | 2.11 | cart: abandonment payload (K9) + code-reservation release on expire/abandon (K11) | dispatch:standard | todo | — |
| 2 | 2.12 | checkout: B.1 session entity + step machine + token hash + C14 minimum (rate limits, encryption, redaction) | dispatch:standard | todo | — |
| 2 | 2.13 | checkout: B.3 delivery + payment step (rate quoting C13, delivery-promotions evaluation C8) | dispatch:standard | todo | — |
| 3 | 3.1 | cart: approval gate K1–K5 (`requiresApproval`, lock refusal, `purpose: 'quote'` skip D-R5-23, guest fail-closed D-R5-12/29) | dispatch:standard | todo | — |
| 3 | 3.2 | cart: `/current/request-approval` route + lifecycle withdrawal wiring (K3/K4/K7, `awaiting_approval_since` K5) | dispatch:standard | todo | — |
| 3 | 3.3 | cart: §7a proposal seam commands (create/withdraw/supersede/re-author, D-R5-14) | dispatch:standard | todo | — |
| 3 | 3.4 | cart: §7a proposal routes + sweeper branches (K13–K16/S13–S15) + undo-merge refusal (D-R5-25) | dispatch:standard | todo | — |
| 3 | 3.5 | checkout: B.2 cart-backed links — trusted pay-link seeding (D-R5-19) + store/channel/currency check (C9) | dispatch:standard | todo | — |
| 4 | 4.1 | checkout: B.4 submit sequence part 1 — preconditions, lock, `availability.reserve`, `reserveCredit`, idempotent document creation (C3/C7) | dispatch:standard | todo | — |
| 4 | 4.2 | checkout: B.4 submit sequence part 2 — commit, credit link, codes/usage, gateway, `lineMap`, recovery table (C5/C6/C18/C24) | dispatch:standard | todo | — |
| 4 | 4.3 | assisted_selling: module scaffold, store settings, `mode: rep\|off` validator, module registration (D-R5-36) | dispatch:standard | todo | — |
| 4 | 4.4 | assisted_selling: threads/participants/messages + staff author routes wrapping `cart.proposal.create` | dispatch:standard | todo | — |
| 4 | 4.5 | assisted_selling: buyer thread routes (Phase 2.1) + `/thread/events` (Phase 2.2) + retention/erasure (Phase 2.5) | dispatch:standard | todo | — |
| 5 | 5.1 | checkout: B.5 B2B — PO term, `min_order_value`, on-account eligibility, `request_quote` method (D-R5-20), quote branch (C15–C17) | dispatch:standard | todo | — |
| 5 | 5.2 | checkout: approval-resume subscriber (C11) + session-route identity binding (D-R5-33) | dispatch:standard | todo | — |
| 5 | 5.3 | assisted_selling: rep console (Phase 2.3) — inbox, thread, composer, proposal builder | dispatch:standard | todo | — |
| 5 | 5.4 | assisted_selling: Phase 4 attribution — entity, `cart.cart.converted` subscriber, `GET /attributions`, console report | dispatch:standard | todo | — |
| 6 | 6.1 | All modules: integration-coverage completion per each analysis's test list (G23/A20/K17/S16/C26) | dispatch:standard | todo | — |
| 6 | 6.2 | `UPGRADE_NOTES.md` — D-R5-21 behaviour change, A16, G26 | inline | todo | — |
| 6 | 6.3 | `yarn template:sync:fix` pass (apps/mercato/src/modules.ts registration etc.) | inline | todo | — |
| 6 | 6.4 | Full gate (`.ai/agentic.config.json` validation.commands), fix-forward | inline | todo | — |

## Goal

Implement eComm Release 5 — Conversion on the existing fork PR #16, against the revised specs
already on `feat/release-5-conversion` (customer groups Phases 3–4, availability Phase 3, cart
Phase 4 incl. §7a, assisted selling Phases 1/2(1,2,3,5)/4, checkout B.1–B.5 + C14 minimum, plus
additive SPEC-029 `resolveForBuyer` and SPEC-055 `revertCodeUse`/delivery un-hide).

## Scope

Exactly the "Specs in scope" table and "Implementation order (final)" wave table in
`ANALYSIS-2026-10-26-ecommerce-release-5-scope.md` / `-cross-spec.md`. Phases 1–6 above are waves
1–6 of that table (wave 0, the spec revision pass, is already on disk at the branch's starting
commit `c92470d8d5`).

## Non-goals

- Checkout B.6 Hardening beyond the C14 minimum (rate limits, session encryption, payload
  redaction, token hash) — no admin session viewer, no seeded workflow definitions, no
  stalled-instance monitor.
- Customer-groups Phase 5 (per-customer assortment overrides), buyer-scoped visibility Phase 4.
- Assisted-selling Phase 2 item 4 (storefront tray), Phase 3 (AI actor), Phase 5 (live transport).
- Any first-party storefront UI.

## Decisions taken without the owner

> Format: context — choice made — alternative considered. Appended as they happen; never edited
> after the fact.

- Step 1.7 (G16/D-R5-7): declaring `customer_groups.approvals.view`/`.decide` ACL features now, ahead
  of `CustomerPurchaseApproval` (Step 2.4) existing, felt premature per the executor brief's own
  framing — chose to declare ONLY the three credit features (`credit.view`/`.manage`/`.adjust`) in
  this Step and defer the approvals feature ids to Step 2.6, where the entity they gate finally
  exists. Alternative considered: declare all 5 features now with `approvals.*` as inert placeholders
  — rejected as a dead ACL surface with nothing to test against until Phase 2.
- Step 1.7 (G13/D-R5-5): no account-creation (`POST`), ledger-listing, or `/adjust` route shipped in
  this Step — the Step's own Implementation bullet list named only a read + hold/limit-edit surface
  for the widget, not the full §9 route table. Alternative considered: ship the full credit-accounts
  resource (create + ledger + adjust) in one Step — rejected as scope creep past what this Step was
  asked to build; a future Step should pick these up explicitly.
- Step 1.8 (G13/G20/D-R5-2): `/adjust` is still not shipped after this Step either — the Step's own
  brief named three deliverables (notifications, the exposure-audit job, the cancel-release
  subscriber) and explicitly warned against scope-creeping `/adjust` in alongside them. Checked
  PLAN.md Phase 1/2: Step 1.11's gap-fill covers account-creation and ledger-listing only, not
  `/adjust`; no other Step names it. Per D-R5-2/§6.5, `/adjust` is the operator-facing half of
  "payments settle only via `/adjust` or `settleCredit`" — without it, an on-account tenant with no
  payments integration has no way to ever lower exposure, which is a real functional gap for
  Release 5 completeness, not a cosmetic one. Appended Step 1.12 (same pattern as 1.11: a same-
  module, additive, low-risk admin command route with an unambiguous spec basis, §9/§9.1/§9.2/G20)
  to the end of Phase 1 rather than building it here or stopping the run. Alternative considered:
  build it in this commit since the service method shape (`adjust` as a command, G20) is simple —
  rejected because it is an admin API route (validator, feature-gated route, command registration,
  audit/undo wiring), a different surface than this Step's notification/job/subscriber work, and
  the brief's own instruction named this exact trade-off and asked to prefer the gap-fill.

## External References

- `.ai/specs/analysis/ANALYSIS-2026-10-26-ecommerce-release-5-scope.md`
- `.ai/specs/analysis/ANALYSIS-2026-10-26-ecommerce-release-5-cross-spec.md`
- `.ai/specs/analysis/ANALYSIS-2026-10-26-ecommerce-release-5-decisions.md` (D-R5-1…37, audit trail — specs win on conflict)
- `.ai/specs/analysis/ANALYSIS-2026-10-26-customer-groups-release-5.md` (G1–G26)
- `.ai/specs/analysis/ANALYSIS-2026-10-26-availability-release-5.md` (A1–A21)
- `.ai/specs/analysis/ANALYSIS-2026-10-26-cart-module-release-5.md` (K1–K17)
- `.ai/specs/analysis/ANALYSIS-2026-10-26-assisted-selling-release-5.md` (S1–S25)
- `.ai/specs/analysis/ANALYSIS-2026-10-26-checkout-release-5.md` (C1–C26)
- `.ai/specs/2026-08-14-customer-groups-and-b2b-terms.md`, `2026-08-14-availability-contract.md`,
  `2026-08-14-cart-module.md` (rev 10), `2026-09-22-assisted-selling.md` (rev 6),
  `2026-03-19-checkout-simple-checkout.md` (v2.3), `SPEC-029-2026-02-17-ecommerce-storefront-module.md`
  (v4.10), `SPEC-055-2026-02-23-promotions-module.md`

## Risks (brief)

- Each Phase-1 track is independent (per the wave table) but several later tracks (cart, checkout)
  have hard sequencing on Phase 1/2 outputs — Steps are ordered so a track's own prerequisites
  always land first.
- Row-lock concurrency (credit, G1) and CAS transitions (approvals G6; availability A3/A5) are the
  highest-risk mechanisms; each gets its own dedicated Step with a concurrency test before anything
  is built on top of it.
- Executors run on the `standard` tier per the operator's instruction (never `cheap`), given the
  size and cross-cutting nature of each Step.

## Implementation Plan

Each Step's full description is the corresponding Gap-Analysis / Critical-or-Important-Gap item
cited in its title, read from the analysis doc named, with the governing D-R5 decision applied
exactly (the revised spec sections cited in that decision's "Consequence for the specs" column are
the authoritative text — the analysis is the finding, the spec is the contract to build against).
Executors MUST read the cited spec sections themselves before writing code; this plan does not
re-paste them.

### Phase 1 — Foundations (wave 1, depends on wave 0 only; tracks independent)

- **1.1** shared trusted-context helper (cross-spec X10): one helper, inputs `{ tenantId,
  organizationId, actorType: 'system' | 'user', actorId?, reason }`, used by every caller that
  builds a command context not derived from a request (D-R5-14 re-author, D-R5-19 pay-link
  seeding, D-R5-22 `resolveForBuyer`-sourced identity, C2/X15 recovery re-lock). Marks audit
  entries system-initiated in one place.
- **1.2** `ecommerce`: `storeContextService.resolveForBuyer` per D-R5-22/S1 (SPEC-029 §6.3 as
  revised) — optional `storeId`, refuses a store outside tenant+organization, never cached under
  the buyer's 60s key, in-process only.
- **1.3** `wms`: extract `wmsReservationService` per A1 — `reserveInTransaction`/
  `releaseInTransaction`/`convertInTransaction`; existing `wms.inventory.reserve/release` commands
  become thin wrappers with no behaviour change (existing wms tests are the regression net).
- **1.4** `availability`: Phase 2 alignment (A2) — one shared SQL sellable builder used by both the
  read provider and the future reservation gate; fix `findProfile` variant fallback, add
  product-pool subtraction, lot-eligibility filter, and resolve the `locationIds`/warehouses
  naming per D-R5-31 (additive `warehouseIds`, no semantic change to the shipped type).
- **1.5** `customer_groups`: `CustomerCreditAccount`, `CustomerCreditLedgerEntry` entities +
  migration; `CustomerGroupTerms` additive columns: `terms_currency_code`, `approval_policy`
  (D-R5-1), `allow_quote_requests` (D-R5-20), `requires_po_number` (D-R5-28) — all nullable,
  inherited like `allow_purchase_on_account`.
- **1.6** `customer_groups`: credit service — `checkCredit`/`reserveCredit`/`releaseCredit`/
  `settleCredit`, scoped (G2), row-lock concurrency (G1, `PESSIMISTIC_WRITE` inside
  `withAtomicFlush(..., { transaction: true })`, no SERIALIZABLE/retry helper), decimal-string
  money (G14), idempotency rules (G12). Ship the N=20 parallel-reserve test plus the
  nested-outer-transaction variant before anything else in this Step.
- **1.7** `customer_groups`: credit admin API (detail tab widget on
  `detail:customers.company`/`.person`), ACL features + grants (G16), `encryption.ts` for
  `hold_reason`/ledger `note` (G22).
- **1.8** `customer_groups`: notification types (G15), `credit-exposure-audit` worker (G21), and the
  `sales.order.cancelled` subscriber releasing the order's unsettled reservation (D-R5-2 hybrid
  settlement — payments settle only via `/adjust` or `settleCredit`, never automatically).
- **1.9** `promotions`: additive `revertCodeUse` + a `sales.order.cancelled` subscriber (C5), per
  SPEC-055.
- **1.10** `promotions`: un-hide `delivery_method` rule + `DELIVERY_DISCOUNT` effect (D-R5-17,
  amending D-R4-14) — authorable once checkout exists as the evaluation source.
- **1.11** `customer_groups`: gap-fill appended after Step 1.7 landed without it. G13/D-R5-5
  ("Credit accounts are created by an operator only") requires an actual admin provisioning
  route — without one, no `CustomerCreditAccount` can ever exist and the whole credit feature
  (and checkout B.4/B.5's on-account path, Phase 4/5) is unreachable. Add: `POST
  /api/customer_groups/customer-groups/credit-accounts` (admin-create, `customer_groups.credit.manage`,
  `.strict()` body, `default_credit_limit` pre-fill semantics per D-R5-5) and a ledger-listing read
  route (`GET .../credit-accounts/:id/ledger`, `customer_groups.credit.view`, decrypted `note`,
  paginated) so the admin UI (1.7's widget) can show ledger history. No notification/job change —
  that's 1.8's own scope.
- **1.12** `customer_groups`: gap-fill appended after Step 1.8 landed without it — see PLAN.md
  "Decisions taken without the owner". D-R5-2/§6.5 states payments settle "only via `/adjust` or
  `settleCredit`"; Step 1.8 shipped the automatic cancel-release subscriber and the audit job but,
  per its own brief, deliberately did not build `/adjust` (an admin API route, not its scope). Add:
  `POST /api/customer_groups/customer-groups/credit-accounts/:id/adjust`
  (`customer_groups.credit.adjust`, body `{ amount: string, note: string }` validated `.strict()`),
  running the `customer_groups.credit.adjust` command under the account row lock (§6.3, same
  pattern as `reserveCredit`/`releaseCredit`), appending a signed ledger entry with the required
  `note` (G20). Undo appends the inverse entry (`related_entry_id` = the original,
  `idempotencyKey: undo:{entryId}`) and never deletes (G20). Declare and emit
  `customer_groups.credit.adjusted` (G18) alongside it, since the command has no consumer without
  it. ACL feature `customer_groups.credit.adjust` already exists (Step 1.7).

### Phase 2 — wave 2 (depends on wave 1)

- **2.1** `availability`: `AvailabilityReservation` entity + migration (A3) — columns per the gap
  analysis (`idempotency_key` unique per tenant+organization, `status`, `expires_at`, `items`
  jsonb, `wms_reservation_ids` jsonb, `order_id`).
- **2.2** `availability`: `reserve`/`release`/`commit` built on `wmsReservationService` (1.3), one
  transaction, CAS on `status = 'active'`, per-line `outcome` (`held|not_tracked|preorder|
  backorder|shortfall`, A6/D-R5-9: backorder holds `min(requested, sellable)`), warehouse
  allocation (A7), key-mismatch 409 (A15), `isUndoable: false` (A14/D-R5-10).
- **2.3** `availability`: expiry job (CAS to `expired`, release via the service, A11), reconciliation
  job (drift cases a/b/c, A12), `availability.reservation.*`/`availability.shortfall.detected`
  events with scope (A13/X11).
- **2.4** `customer_groups`: `CustomerPurchaseApproval` entity + migration — actor-typed
  requester/decider columns (D-R5-1), two decision slots for `approval_policy: both`, policy
  snapshot at creation, `subject_type: cart | quote` (D-R5-3/D-R5-23).
- **2.5** `customer_groups`: approval service (`requestApproval`/`getApproval`/
  `getActiveApprovalForSubject`/`withdrawApproval`/`decideApproval`), every transition a CAS
  conditional update (G6), `expire-approvals` job defaulting to 14 days (D-R5-27).
- **2.6** `customer_groups`: buyer portal routes (`requireCustomerAuth`), staff routes, ACL features
  + `defaultCustomerRoleFeatures` grants (G5/G7/D-R5-7), `checkout.sessions.*` + least-privilege
  grants per D-R5-34 land here too if checkout's ACL file already exists, else in 2.12.
- **2.7** `customer_groups`: approval notifications — in-app to staff deciders + the company's
  `account_manager`, email to buyer-side deciders/requesters with a per-tenant switch (D-R5-6);
  `customer_groups` is the only notifier (D-R5-32) — cart/checkout approval events stay signals.
- **2.8** `cart`: lock contract — `lockTtlMs` (bounded), idempotent extend (same
  `checkoutSessionId` on an already-locked cart returns the cart instead of 423), `unlock`/
  `markConverted` require a matching `checkoutSessionId` (uniform 404 on mismatch) (C1).
- **2.9** `cart`: D-R5-21 — every `/api/cart/current/*` route on an identified basket
  (`customer_user_id` set) requires the matching customer session, else `404` (closes the
  `commands/cart.ts:603-608` identity-rewrite bypass, D-R5-13 becomes a special case); D-R5-22 —
  the trusted `resolveForBuyer`-sourced identity path for `pay_link`/`api`/`agent` carts replaces
  the ad hoc context-less seeding at `cart/commands/cart.ts:236-258`.
- **2.10** `cart`: `markConverted` additive `salesOrderId`/`lineMap`/`salesQuoteId` inputs (K8,
  D-R5-26), emitted on `cart.cart.converted`; admin `GET /api/cart/carts` + `/carts/[id]` +
  `POST /carts/[id]/reprice` (K6) with `DataTable`, decrypted `email`/`note` via the query engine,
  no ciphertext search.
- **2.11** `cart`: `cart.cart.abandoned` payload growth (K9); `codeService.releaseCode` wired into
  `expire`/`mark-abandoned` sweepers (K11, closing the Release 4 deferral).
- **2.12** `checkout`: B.1 — `CheckoutSession` entity + step machine, `/api/checkout/sessions/
  current/*` with `X-Checkout-Session-Token` (C4, `token_hash` stored, plaintext returned once),
  soft `tryResolve` peers only (C10, no hard `requires`), plus the C14 minimum shipped now:
  rate limits (reusing `enforceCheckoutRateLimit`), the session encryption map, `CheckoutSessionEvent`
  payload redaction, cross-tenant check on every request. ACL `checkout.sessions.view/manage`
  (admin; `employee` view per D-R5-34).
- **2.13** `checkout`: B.3 — delivery step (rate quoting C13: store/warehouse origin, catalog
  weight/dimensions with single-parcel default, flat-rate fallback per D-R5-35, 5 min cache) and
  payment-method listing; delivery-promotions evaluation at delivery selection (`promotionsService.
  evaluate` with `deliveryMethodCode`/`deliveryCost`, C8).

### Phase 3 — wave 3 (depends on wave 2 approvals + cart trusted path)

- **3.1** `cart`: approval gate (K1 one amount basis = goods gross after promotions excl. delivery,
  K2 `requiresApproval` computed from fresh terms at every totals change and re-checked at `lock`,
  `409 cart_requires_approval`); `purpose: 'quote'` skips the gate and `min_order_value` (D-R5-23);
  guest carts over a default-group threshold refused fail-closed (D-R5-12/D-R5-29, `409
  approval_requires_identified_buyer`).
- **3.2** `cart`: `/current/request-approval` (idempotent per pending approval, G8), K3 lifecycle
  table (withdraw on merge-source/expiry/purge, recompute-not-restore on undo-merge), K4 guest
  rule enforcement, K7 `cart.approval.requested` payload, K5 `awaiting_approval_since` column +
  subscriber on `customer_groups.approval.*` maintaining it (no abandonment while pending).
- **3.3** `cart`: §7a proposal commands — `cart.proposal.create` (ttlSeconds input per S5, no
  promotion codes per S14/K14, visibility check against `resolveForBuyer` scope emitting
  `cart.line.visibility_rejected` with `triggeredBy: 'proposal_create'` per S13/K13), withdraw,
  supersede-on-merge, re-author on `cart.cart.merged` as the original author per D-R5-14 (with the
  stated fallback to supersede-only).
- **3.4** `cart`: §7a proposal routes (`/api/cart/proposals/*`, D-R5-13/D-R5-21 identity binding),
  sweeper branches for `kind = 'proposal'` (never abandoned, own `expires_at`, 90-day post-
  resolution purge per D-R4-20, K15/S15), `409 merge_undo_not_supported_for_proposal` on
  `/current/undo-merge` of a proposal-sourced merge (D-R5-25).
- **3.5** `checkout`: B.2 — cart-backed link flow; trusted in-process pay-link cart seeding via
  `cart.create` + template line adds through the command bus, context from the link's own tenant/
  organization via the 1.1 helper, buyer identity applied when a customer session is present
  (D-R5-19); store/channel/currency mismatch refusal at session creation and submit (C9).

### Phase 4 — wave 4 (depends on wave 3: availability, credit, cart lock, promotions)

- **4.1** `checkout`: B.4 submit, steps 1–5 of C19 — preconditions (C9, K1/K2 approval, D-R5-12
  guest, C15 PO/`min_order_value`), `cart.lock` with fresh route context + session id (C1/C2),
  `availability.reserve` (`sourceType: 'checkout'`, per-line outcomes), on-account `reserveCredit`
  (G1/G2), idempotent document creation (`external_reference`, non-confirmed status,
  `metadata.cartLineId` per line, C3), the C7 goods-totals equality check.
- **4.2** `checkout`: B.4 submit, steps 6–8 — order outcome: `availability.commit` (D-R5-8, right
  after document creation, before payment), `linkCreditReservationToOrder` (C6), `useCode` +
  `registerUsage` before payment with `409 promotion_unavailable` on refusal/budget overrun (C5);
  quote outcome: release stock (A9), no credit reservation; gateway step with lock-extend (C1),
  `lineMap` built from the order's lines (C18) and passed to `markConverted`; `recover-stuck-
  submits` decision table (C24).
- **4.3** `assisted_selling`: module scaffold (entities for threads/participants/messages come in
  4.4), store settings (`mode` limited to `rep | off`, S10; TTL setting), module registration in
  `apps/mercato/src/modules.ts` commented out in the create-app template (D-R5-36, run
  `yarn template:sync:fix`).
- **4.4** `assisted_selling`: thread/participant/message entities (encrypted `body`/`displayName`/
  `rejectionReason` per S19/G22-style map), staff author routes (`POST /threads`,
  `POST /threads/:id/proposals` wrapping `cart.proposal.create`, withdraw/supersede/re-author),
  scoped by the caller's `organizationIds` (S9), idempotency unique key per thread (S23).
- **4.5** `assisted_selling`: buyer thread routes (`GET/POST /thread`, `POST /thread/messages`)
  under the D-R5-21 identity rule when the basket is identified (Phase 2 item 1, required by R3);
  `GET /thread/events` server-side ETag/304 contract, rate limited (Phase 2 item 2); retention/
  erasure sweepers wired to `cart.cart.purged`, `customer_accounts.user.deleted`,
  `auth.user.deleted` (Phase 2 item 5, S7).

### Phase 5 — wave 5 (depends on wave 4: checkout B.4, cart approval gate)

- **5.1** `checkout`: B.5 B2B — PO number written to `SalesQuote.customer_reference` when the
  resolved term requires it (D-R5-28), `min_order_value` check in `terms_currency_code` (D-R5-4),
  on-account eligibility (allowPurchaseOnAccount + existing credit account, not on hold, D-R5-5),
  `request_quote` payment method offered only when `allow_quote_requests` allows it (D-R5-20),
  quote outcome ends submit after document creation with no payment/credit/stock hold (C16/C17).
- **5.2** `checkout`: approval-resume subscriber on `customer_groups.approval.approved|rejected|
  expired|withdrawn` returning the session to `open`/`failed` (C11, no workflows); every
  `/api/checkout/sessions/current/*` route requires the matching customer session on an identified
  cart (D-R5-33).
- **5.3** `assisted_selling`: rep console (Phase 2 item 3) — inbox with filters, thread page,
  composer, proposal builder showing the buyer's own prices with provenance; reuses existing
  backend UI families per `.ai/ui-backend-components.md`.
- **5.4** `assisted_selling`: Phase 4 attribution entity, `cart.cart.converted` subscriber
  (consuming `lineMap`/`salesOrderId`/`salesQuoteId` from 2.10/4.2), `GET /attributions`, console
  attribution report; degrades visibly to `assisted_selling.attribution.degraded` when `lineMap`
  is absent.

### Phase 6 — wave 6, full gate

- **6.1** Integration-test completion pass across every module touched, filling any test named in
  the five analyses' coverage lists (G23, A20, K17, S16, C26) not already covered by a Phase 1–5
  Step's own tests — cross-tenant isolation on every new route is non-negotiable here.
- **6.2** `UPGRADE_NOTES.md` entry: D-R5-21 behaviour change (identified-basket session requirement
  on `/api/cart/current/*`), A16 (`InventoryReservationSourceType` gains `'checkout'`), G26 (new DI
  keys `customerCreditService`/`customerPurchaseApprovalService` instead of growing
  `CustomerGroupsService`).
- **6.3** `yarn template:sync:fix` verification pass over every `apps/mercato/src/**` /
  `apps/mercato/src/i18n/**` change made across Phases 1–5 (module registration, new env vars if
  any).
- **6.4** Full validation gate per `.ai/agentic.config.json` `validation.commands`, fix-forward on
  any failure, re-run until green.

## Checkpoints

Fire every 5 landed Steps (or at a Phase close with ≥3 Steps), per
`.agents/skills/om-auto-create-pr-loop/references/checkpoint-pass.md`. Index starts at 1.
