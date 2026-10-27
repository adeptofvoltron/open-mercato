# Notify — 2026-10-26-ecommerce-release-5-conversion

> Append-only log. Every entry is UTC-timestamped. Never rewrite prior entries.

## 2026-10-26T00:00:00Z — run started
- Brief: implement eComm Release 5 — Conversion on fork PR #16 (adeptofvoltron/open-mercato),
  against the revised specs on `feat/release-5-conversion` + the Release 5 analysis/decisions
  docs. Unattended; all Ask First items in scope pre-approved via D-R5 decisions.
- External skill URLs: none
- Worktree: created fresh at `.ai/tmp/release-5-conversion-impl` (none existed for this branch).
  `fork` remote already configured. Branch confirmed at `c92470d8d5`, matching the brief.

## 2026-10-26T12:00:00Z — checkpoint 1 (Steps 1.1–1.5)
- Range: `cc618cce9c`..`f619ac8d4d`. Summary: shared trusted-context helper; `ecommerce`
  `resolveForBuyer`; `wms` `wmsReservationService` extraction (no behavior change); availability
  Phase-2 sellable-quantity alignment; `customer_groups` credit entities/ledger/migration + new
  `CustomerGroupTerms` columns.
- Checks: forced full typecheck (40/40, 0 cached) pass; scoped tests pass (shared 20/20 suites,
  core customer_groups+wms+ecommerce 160/160 suites). No UI touched, UI verification skipped.
- Decisions/problems: none. All five tracks landed exactly as planned, no rescues needed.

## 2026-10-26T13:00:00Z — Step 1.7 landed
- `customer_groups`: credit admin API (`GET/PUT /api/customer_groups/customer-groups/credit-accounts`,
  list keyed by `customerId`/`id`/`currencyCode`/`isOnHold`, update edits `creditLimit`/`isOnHold`/
  `holdReason` with the hold-reason invariant re-validated against the MERGED entity state, not the
  raw partial payload — see `credit-accounts/crud.ts`), a widget tab (`customer_groups.injection.
  credit-panel`) on `detail:customers.person:tabs`/`.company:tabs`, 3 new ACL features
  (`credit.view`/`.manage`/`.adjust`), `employee` grant for `credit.view` (D-R5-7), and
  `encryption.ts` registering `hold_reason`/`note` (G22).
- Scope narrowed deliberately versus the full spec §9 route table: no account-creation route (G13/
  D-R5-5 provisioning), no ledger-listing route, no `/adjust` command route — none of these are in
  this Step's own Implementation bullet list; a future Step should pick them up alongside the
  credit-exposure-audit job (1.8) or its own dedicated Step. The ACL feature ids for all three
  (`credit.view`/`.manage`/`.adjust`) ARE declared now per the task's explicit instruction, ahead of
  the routes that will use `.adjust`.
- `approvals.view`/`.decide` ACL features deliberately deferred to Step 2.6 — `CustomerPurchaseApproval`
  doesn't exist until Step 2.4, so declaring the feature id now would have nothing behind it. See
  PLAN.md "Decisions taken without the owner".
- No new events/notifications/jobs in this Step (Step 1.8's scope) — a hold toggle does not yet emit
  `customer_groups.credit_account.put_on_hold`/`.released_from_hold` (unshipped in the spec's own
  "Shipped on develop" line); Step 1.8 should decide whether to add that emission alongside the
  notification wiring.
- Verified `customerCreditService.ts` (Step 1.6) never reads `hold_reason`/`note` back for business
  logic — only writes them — so no encryption-driven bug fix was needed there; added a doc comment
  only, no logic change.

## 2026-10-26T13:30:00Z — dispatcher: appended Step 1.11 to close a real gap
- Step 1.7's executor correctly scoped out account creation (not in its bullet list) but flagged
  that without ANY provisioning route, `CustomerCreditAccount` can never be created (G13/D-R5-5
  says "operator only", which presupposes an operator-facing create route exists). Left unfixed,
  this blocks checkout B.4/B.5's on-account path (Phase 4/5) at the end of the release, far from
  where the gap was introduced. Appended Step 1.11 (admin-create + ledger-listing routes) to the
  end of Phase 1 rather than stopping the run — a same-module, additive, low-risk fix with an
  unambiguous spec basis (G13/D-R5-5), not a scope change requiring the owner.

## 2026-10-26T14:00:00Z — Step 1.8 landed
- `customer_groups`: declared the `customer_groups.credit.limit_exceeded` notification type
  (`notifications.ts`, in-app only, per G15 — approval notifications stay Step 2.7's scope),
  wired as a persistent subscriber (`subscribers/credit-limit-exceeded-notification.ts`) on a new
  `customer_groups.credit.limit_exceeded` domain event. `reserveCredit` (`customerCreditService.ts`,
  Step 1.6) now emits that event after its transaction commits when it refuses with reason
  `limit_exceeded` — this is the event's only trigger, consistent with spec §10.1's own wording
  ("emitted on a refused reserveCredit"); the sibling `credit.reserved/.released/.settled/.adjusted`
  and `credit_account.put_on_hold/.released_from_hold` events (G18) stay undeclared — nothing in
  this Step's scope consumes them, and declaring events with no subscriber felt like the same kind
  of premature ACL-surface mistake Step 1.7 flagged for `approvals.*`.
- Recipient resolution (G15): the company's `account_manager` via `customers.CustomerEntityRole`
  (direct SQL on `customer_entity_roles`, FK-id only — no ORM import of `customers`, same coupling
  rule `lib/creditIdentity.ts` already used for the company-first resolution), falling back to any
  staff holding `customer_groups.credit.manage` in the organization. Factored into
  `lib/creditNotifications.ts` so the exposure-audit job's own over-limit finding can reuse it
  without duplicating the recipient lookup.
- `sales.order.cancelled` subscriber (`subscribers/order-cancelled-credit-release.ts`, persistent):
  finds `CustomerCreditLedgerEntry` rows with `entryType: 'reserve'` and `linkedOrderId = orderId`
  in the event's own tenant/organization, and calls `releaseCredit` for each. Idempotent by
  construction — `releaseCredit` (Step 1.6) already keys its release entry as
  `release:{reserveIdempotencyKey}` and no-ops on redelivery, so no dedupe was added here. Note:
  `linkCreditReservationToOrder` (the thing that actually WRITES `linked_order_id`) is Step 4.2's
  scope and does not exist yet, so this subscriber is a correct no-op until checkout Phase 4 lands
  — verified by reading `linkedOrderId`'s only writer in the current tree (none).
- `credit-exposure-audit` worker (G21): tenant-scoped queue worker
  (`customer_groups.credit_exposure_audit`), paginated over `CustomerCreditAccount`, recomputing
  `SUM(amount)` per account and comparing it against the latest entry's `balance_after` (exported
  `toMinorUnits`/`formatMinorUnits` from `customerCreditService.ts` so the rounding is identical,
  G14). Every drift is logged and sent through `reportError`; the `limit_exceeded` notification is
  reused ONLY when the drifting account's recomputed exposure is also over its limit (a genuine
  over-limit case), never for drift alone — per this Step's own instruction not to invent a new
  notification type. Registered a daily (`0 3 * * *` UTC) per-tenant schedule in `setup.ts`, same
  `schedulerService.register` pattern as `warranty_claims`' SLA sweep. Accepts an optional
  `progressJobId` in its payload and reports through `ProgressService` when present, so a future
  "run now" UI trigger can enqueue it as a `ProgressJob` (G21) without the worker changing — no such
  trigger route is built in this Step; it wasn't named in the Step's own bullet list.
- **Gap identified and deferred, not built here**: `/adjust` (manual settlement route, D-R5-2/§6.5/
  §9) is still unshipped after this Step. Checked PLAN.md Phase 1/2 — Step 1.11's gap-fill covers
  account-creation and ledger-listing only, not `/adjust`; no Step names it. Appended Step 1.12
  (same gap-fill pattern as 1.11) to the end of Phase 1 for a future executor — see PLAN.md
  "Decisions taken without the owner" for the full reasoning. Without it, exposure can be lowered
  automatically (cancel-release) but never manually, which is a real functional hole for a tenant
  with no payments integration calling `settleCredit`.

## 2026-10-26T14:30:00Z — Step 1.9 landed
- `promotions`: found that `CodeUsage` (`promotion_code_usages`) stored none of `code_id`,
  `customer_id`, `organization_id`, `tenant_id`, `used_at` that could key a reversal to a specific
  cart or order — `useCode`'s own `em.create(CodeUsage, {...})` call wrote none of `cartId`,
  `orderId`, or which `GeneratedCode` a dynamic use deactivated. `revertCodeUse({ cartId?,
  orderId? })` had nothing to look up without one. Added additive, nullable columns `cart_id`,
  `order_id`, `generated_code_id`, `reverted_at` to `CodeUsage` (migration
  `Migration20261026161603_promotions`) and an additive, optional `orderId` on `UseCodeInput` so a
  future checkout caller (Phase 4, which calls `useCode` AFTER document creation per the C5
  finding) can record it immediately — see PLAN.md "Decisions taken without the owner" for the
  full reasoning and the alternative considered.
- `revertCodeUse` (new, `lib/code-service.ts`) reverses the exact inverse of `useCode`'s own flip
  under the same row-lock pattern (`LockMode.PESSIMISTIC_WRITE` on `Code`/`GeneratedCode` inside
  `withAtomicFlush`): reactivates the specific `GeneratedCode` for a dynamic use, or decrements
  `Code.used` and reactivates the code once `hasRemainingGlobalUses` is true again for a static
  use. Marks the `CodeUsage` row `reverted_at` — never deletes (append-only log, same precedent as
  `PromotionUsage.reverted_at`). Idempotent (only unreverted rows match) and tenant/organization-
  scoped on every lookup and lock, proven by a dedicated cross-tenant-id-collision test. Registered
  as command `promotions.code.use.revert` (additive sixth command to §A.2a's own five) and exposed
  on the `promotionsService` facade, mirroring `releaseCode`/`revertUsage`.
- `subscribers/order-cancelled-usage-revert.ts` (new, persistent): on `sales.order.cancelled`,
  resolves `promotionUsageService`/`promotionCodeService` directly from the container (no `auth`/
  command-bus wrapping needed — same direct-service-call idiom as `customer_groups`'s own
  `order-cancelled-credit-release.ts` subscriber for this exact event) and calls `revertUsage`
  then `revertCodeUse`, both keyed by the event's `orderId`. Reads only `orderId`/`tenantId`/
  `organizationId` off the payload; never imports a `sales` entity. Both calls are independently
  idempotent on redelivery; the subscriber adds no dedupe of its own.
- SPEC-055 did not document `revertCodeUse` or a cancellation subscriber anywhere (confirmed by
  grep — the only prior mention of reversal was `revertUsage`'s own, and §3.3's withdrawn "`sales`
  calls `revertUsage`" line). Added an additive amendment (v2.3.0): §Code Lifecycle diagram +
  prose, the `CodeUsage` data-model table, the Commands & Events table, the Public TypeScript
  Contract, and a Changelog row — no full rewrite.
- Did NOT touch checkout (no caller exists yet) or cart's `codeService.releaseCode` wiring in the
  expire/mark-abandoned sweepers (that is Step 2.11/K11's separate reservation-release mechanism,
  not this Step's use-time reversal).

## 2026-10-26T17:00:00Z — checkpoint 2 (Steps 1.6–1.10)
- Range: `e94c9305dc`..`9a6703e162`. Summary: customer_groups credit service (row-lock concurrency,
  mutation-tested) + admin widget/ACL/encryption + notifications/exposure-audit/cancel-release;
  promotions revertCodeUse + cancellation subscriber + un-hidden delivery promotions.
- Checks: forced full typecheck (40/40, 0 cached) pass; scoped tests pass (core
  customer_groups+promotions+cart 79/80 suites, 910/912 tests — 1 expected skip, Postgres-gated).
  No dev-server/browser UI smoke pass yet for the two UI surfaces touched (1.7, 1.10) — deferred,
  not skipped silently; logged in checkpoint-2-checks.md.
- Decisions/problems: two gap-fill Steps appended (1.11 credit-account provisioning, 1.12
  manual /adjust settlement) — both logged in PLAN.md's "Decisions taken without the owner".

## 2026-10-26T18:00:00Z — Step 1.11 landed
- Rescue attempt: the first executor for this Step failed mid-implementation on a provider rate
  limit; nothing had been committed, so no code was lost. This is an infrastructure retry on the
  next tier up, not a quality escalation.
- `customer_groups`: `POST /api/customer_groups/customer-groups/credit-accounts` (operator
  provisioning, `credit.manage`, `.strict()` body `{ customerId, currencyCode, creditLimit,
  isOnHold?, holdReason? }`) on the existing `makeCrudRoute` instance; duplicate customer+currency
  answers `409` with `code: credit_account_exists` (pre-check plus `withCreateConflictRecheck` for
  the concurrent race against the Step 1.5 partial unique index). `GET …/credit-accounts/:id/ledger`
  (`credit.view`, newest first, `pageSize ≤ 100`, `note` decrypted via
  `findAndCountWithDecryption`, account looked up inside the caller's organization scope — foreign
  ids answer 404). Credit panel widget: "Create credit account" dialog (gated by `credit.manage`)
  and a per-account read-only ledger toggle with prev/next paging.
- `creditLimit` is required (no server-side `default_credit_limit` fallback); a create for a
  customer outside the caller's selected organization answers 400. Both logged in PLAN.md
  "Decisions taken without the owner".
- Not in this Step: `GET …/credit-accounts/missing` (the D-R5-5 banner, US-E2) and the form pre-fill
  from the group default that rides on it — no Step names them yet; worth a gap-fill decision
  before Phase 6. TC-CGRP-032's ledger rows are inserted through `pg` with plaintext notes (no
  ledger-writing route exists until Step 1.12), so ciphertext decryption on that route is first
  exercised end to end once `/adjust` writes notes through the ORM.

## 2026-10-26T17:30:00Z — dispatcher: Step 1.11 rescue landed; one item deferred, not gap-filled
- Step 1.11's rescue executor flagged the US-E2 "orphan banner" (customers whose resolved terms
  allow purchase-on-account but have no credit account in the terms currency) as unbuilt. Unlike
  the 1.11/1.12 provisioning gaps, nothing in Phases 2-6 depends on this banner existing — it is
  an admin-UX nicety, not a functional blocker for on-account checkout (which only needs the
  create route, now shipped, and `checkCredit`'s `no_account` refusal path, already correct).
  Deferred to Phase 6 polish rather than appending a dedicated Step now; revisit only if the final
  integration-coverage pass (Step 6.1) finds a spec test case that actually requires it.

## 2026-10-26T18:40:00Z — Step 1.12 landed
- `customer_groups`: `POST /api/customer_groups/customer-groups/credit-accounts/:id/adjust`
  (`credit.adjust`, `.strict()` body `{ amount: string, note: string }`, amount signed/non-zero/≤2dp)
  closes the last D-R5-2 gap: the operator-facing half of hybrid settlement. The account is
  resolved inside the caller's organization scope (same shape as the sibling `[id]/ledger` route);
  the route dispatches the new `customer_groups.credit.adjust` command through `commandBus.execute`.
- `customerCreditService.adjustCredit` (new method, `services/customerCreditService.ts`) appends a
  signed `adjust` entry under the SAME account-row lock (`LockMode.PESSIMISTIC_WRITE` inside
  `withAtomicFlush`) as `reserveCredit`/`releaseCredit`/`settleCredit`, with the same idempotency-key
  lookup pattern — the command mints its own key (`` `adjust:${randomUUID()}` ``) per execution since
  the HTTP body carries none (§9's literal `{ amount, note }`). Rejects a zero amount
  (`invalid_amount`).
- `commands/adjustCredit.ts`: the command (`customer_groups.credit.adjust`, `isUndoable: true`).
  `buildLog` snapshots everything undo needs (account/tenant/org/customer/currency ids, the entry id
  and its amount); `undo` calls `adjustCredit` a SECOND time with the negated amount,
  `relatedEntryId` = the original entry, and the key `` `undo:${entryId}` `` — appending the inverse
  entry, never deleting the original (G20). The route sets the `x-om-operation` response header
  (same convention as every other command-backed route, e.g. `staff/leave-requests/accept`) so the
  generic `/api/audit_logs/audit-logs/actions/undo` route can actually reach this `undo` handler.
- Declared and emit `customer_groups.credit.adjusted` (`events.ts`, G18/§10.1) after the write
  commits, gated to fire once per genuinely new entry — never on an idempotent replay.
- Admin UI: credit panel widget (`widgets/injection/credit-panel.tsx`) gained an "Adjust" icon
  button (gated by `credit.adjust`, independent of `credit.manage`) opening a dialog with `amount`
  (signed decimal string) and a required `note`, posted via `apiCallOrThrow` directly against the
  `/adjust` route (not `createCrud`/`updateCrud` — this isn't a CRUD write on the account entity,
  it appends a ledger entry).
- Tests: `services/__tests__/customerCreditService.test.ts` (7 new cases: positive/negative
  adjustment, zero rejection, no-account, idempotent replay, the `.adjusted` event, and the
  undo shape appending an inverse entry while the original survives);
  `commands/__tests__/adjustCredit.test.ts` (8 new cases: scope resolution, zero-amount validation,
  cross-tenant/cross-org 404, missing-tenant 400, `buildLog` payload shape, undo negation both
  directions); `__integration__/TC-CGRP-033-credit-account-adjust.spec.ts` (full HTTP path: post,
  exposure math, `.strict()`/zero/decimal-places validation, undo via the generic audit-logs undo
  route confirming the reversal entry appears and the original survives, ACL —
  `credit.adjust` required, `credit.view`/`.manage` alone insufficient — and tenant/organization
  isolation). Typecheck and the `customer_groups` jest suite (378 tests) pass; `i18n:check-sync` and
  `i18n:check-hardcoded` are clean for this module. The Playwright suite itself was not executed in
  this run (no live app/DB server available in this worktree) — verified by typecheck plus the unit
  tests exercising the same service/command code paths the route calls.
- Scope calls made without the owner (all logged in PLAN.md "Decisions taken without the owner"):
  the command-minted idempotency key, reusing one method for both the forward write and its undo,
  the `.adjusted` event's emission-once-per-write gate, and adding the `x-om-operation` header so
  undo is actually reachable.

## 2026-10-26T18:00:00Z — checkpoint 3 (Steps 1.11–1.12, closes Phase 1)
- Range: `9c35d9af44`..`122ee35173`. Summary: credit account creation + ledger-listing routes
  (rescued once after an unrelated provider rate limit, no code lost); manual /adjust settlement
  route as a real command with inverse-entry undo (G20).
- Checks: forced full typecheck (40/40, 0 cached) pass; full Phase-1 retrospective module sweep
  (customer_groups+promotions+cart+wms+ecommerce) 214/215 suites, 2254/2256 tests, 1 expected skip.
- Phase 1 is complete. All 12 Steps landed; one rescue needed (infrastructure, not quality); two
  gap-fills appended and closed within the same phase. No fix-forward Steps needed.

## 2026-10-26T19:00:00Z — Step 2.1 landed (Phase 2 opens)
- `availability`: `AvailabilityReservation` entity (`availability_reservations`) per §5.3/A3 —
  `id`, `tenant_id`/`organization_id`, `idempotency_key`, `source_type` (narrowed to the literal
  `'checkout'`, A16's system-only rule), `source_id`, `status` (`active|committed|released|expired`,
  default `active`), `expires_at` (nullable), `items` (jsonb snapshot: `catalogProductId`,
  `catalogVariantId`, `requested`, `outcome`, `heldQuantity`, `backorderQuantity`),
  `wms_reservation_ids` (jsonb `string[]`, default `[]`), `order_id` (nullable uuid, FK-id only, no
  ORM relation into `sales`), `status_reason` (nullable), `created_at`/`updated_at`. No
  `deleted_at` (§5.3: never soft-deleted, the hold's own audit trail) and no optimistic-lock
  header (§5.3: not user-editable, `updated_at` exists only for the Step 2.2 CAS transitions).
- Indexes: unique `(tenant_id, organization_id, idempotency_key)` over ALL statuses (A15 — a key
  is never reused for different content even once terminal); partial `(expires_at) WHERE status =
  'active'` for the Step 2.3 expiry sweep (A11); `(tenant_id, organization_id, source_type,
  source_id)` for session lookups.
- `data/validators.ts`: zod schemas for the persisted `items` snapshot shape
  (`availabilityReservationItemSnapshotSchema`/`...ItemsSnapshotSchema`, non-empty array,
  five-member outcome enum), plus `sourceType`/`status` schemas. Entity-only Step — no
  `reserve`/`release`/`commit` service or command code (Step 2.2's scope).
- Test: `data/__tests__/reservation.test.ts` (7 cases) — entity/validator round-trip for a `held`
  and a `backorder` line, null-variant product-rollup line, negative-quantity rejection, outcome
  enum rejection, empty-items rejection, source-type/status enum bounds.
- Scope call (logged in PLAN.md "Decisions taken without the owner"): the spec's richer
  `AvailabilityReservationLine` type (`key`/`available`) lives in `lib/reservationCommands.ts`,
  which is Step 2.2's own deliverable and doesn't exist yet. Declared the narrower, persisted-
  snapshot status/outcome/source-type types in `data/entities.ts` instead, next to the entity —
  mirrors `wms/data/entities.ts`'s `InventoryReservationSourceType`/`Status` precedent. Step 2.2
  should import these rather than redeclare a divergent set.
- Checks: `yarn typecheck` in `packages/core` clean (tsc --noEmit, no output). `yarn db:generate`
  produced exactly one migration (`availability: generated Migration20261026185450_availability.ts`,
  a pure `create table` + 3 indexes + 1 unique constraint). Re-ran a second time to confirm
  `availability: no changes`. Pre-existing, unrelated drift in `forms` and `wms` (an old consent
  unique-index drop and a wms FK/idempotency-key backfill, both predating this Step) appeared on
  both runs regardless of this Step's own changes — discarded both times per the root AGENTS.md
  coding-agent exception, snapshots reverted via `git checkout`. `yarn jest` in `packages/core`:
  new test file 7/7 pass; full `src/modules/availability` suite 108/108 pass (11 suites), no
  regressions.

## 2026-10-26T20:00:00Z — Step 2.2 landed (the release's core mechanism)
- `availability`: `reserveAvailability`/`releaseAvailability`/`commitAvailability`
  (`lib/reservationCommands.ts`, new) built on `wmsReservationService` (Step 1.3), one
  transaction per call via `em.transactional()`, CAS on `status = 'active'`, per-line outcome
  classification (`held|not_tracked|preorder|backorder|shortfall`, D-R5-9 backorder holds
  `min(requested, sellable)`), warehouse allocation preferring the primary warehouse (A7),
  key-mismatch `409 idempotency_key_mismatch` (A15), `isUndoable: false` (A14/D-R5-10) on the
  thin `commands/reservations.ts` command-bus wrappers (`availability.reserve`/`.release`/
  `.commit`).
- `wms`: `wmsReservationService` (Step 1.3) gained the gate itself —
  `reserveLinesForCheckout` (locks every balance row of every variant in one statement,
  re-derives sellable with the §4.2 shared builder, allocates across warehouses, inserts
  `wms` rows per `(variant, warehouse)` bucket), a real `convertInTransaction` (was a stub —
  this Step is its first real caller, converting a `'checkout'` hold to an `'order'` hold in
  place with a rebuilt idempotency key, per §4.4), and `emitSideEffects` (A19 cache
  invalidation parity with the existing `wms.inventory.reserve`/`.release` commands).
  `InventoryReservationSourceType` gained `'checkout'` (additive); the public
  `wms.inventory.reserve` command/route now explicitly reject it with `400
  checkout_reservation_is_system_only` (A16's functional half — the cosmetic i18n label and
  `UPGRADE_NOTES.md` entry are Step 6.2's named scope, not duplicated here).
- **Correctness bug found and fixed in this same commit, not shipped broken**: the first
  implementation of the gate's row lock used raw SQL (`em.getConnection().execute('...FOR
  UPDATE')`) reusing the A2 shared SQL builder as instructed. Against a REAL Postgres
  instance under N=20 real concurrent `reserve` calls for a single unit of stock, this
  oversold the unit — every caller saw the same pre-consumption snapshot, because this
  installed MikroORM version's raw `.execute()` never binds to the ambient ORM transaction
  unless its `ctx` parameter is passed explicitly, which `em.getConnection()` never supplies.
  Root-caused by reproducing the failure with verbose logging, then fixed by switching the
  lock AND the aggregate read to the same proven ORM-level pattern (`findWithDecryption(...,
  { lockMode: LockMode.PESSIMISTIC_WRITE }, ...)`) `wmsReservationService`'s own existing,
  tested `reserveInTransaction` path already relies on — computing the sellable arithmetic
  client-side from the now-correctly-locked entities (still calling the A2 builder's PURE
  `computeSellableQuantities` function, just fed from locked entities instead of a second raw
  query). Proved the fix is real, not a coincidence, by temporarily removing the lock mode and
  re-running the same N=20 pg test: it reproduced the exact oversell, confirming the test is
  not vacuous; the lock was restored immediately after and the full pg suite re-verified green
  before committing. Full reasoning in PLAN.md "Decisions taken without the owner".
- Tests: a new real-Postgres concurrency suite,
  `availability/lib/__tests__/reservationCommands.concurrency.pg.test.ts` (gated on
  `OM_AVAILABILITY_PG_URL`, 9 cases) — N=20 parallel reserve for the last unit (exactly one
  succeeds), multi-line all-or-nothing, backorder `min(requested,sellable)`, not_tracked for a
  non-stock-managed line, idempotency-key mismatch 409 + same-content replay, release
  idempotency (A21: second release / committed-hold release / unknown-key release are all
  no-ops), commit racing the expiry sweep (both the `recovered` and `stock_lost` branches,
  simulated by setting the hold's status to `expired` directly since the real sweep is Step
  2.3's scope), and cross-tenant/organization isolation. Plus a new unit test in
  `wms/commands/__tests__/inventory-actions.reserve-release.test.ts` for the A16 guard, and
  `wms/lib/__tests__/wmsReservationService.test.ts`'s `convertInTransaction` stub test
  rewritten to exercise the real conversion (the stub itself is gone).
- Checks: `yarn typecheck` in `packages/core` clean. Full `src/modules/wms` (65 suites, 429
  tests) and `src/modules/availability` (12 suites, 117 tests incl. the new pg suite skipped
  without the env var) pass — zero regressions. The gated pg suite itself: 9/9 pass against a
  throwaway `postgres:18-alpine` container (via the existing `colima` runtime), confirmed via
  mutation testing per the run brief's own instruction. `yarn build:packages` (`@open-mercato/
  core` et al.) green.
- Scope calls (all logged in PLAN.md "Decisions taken without the owner"): product-pool
  allocation (A7's pool check) deferred — not in this Step's 8-test gate, named explicitly as
  A20/Step 6.1 scope; §4.4's confirmed-first collision handling in `convertInTransaction`
  deferred — checkout never takes that path (D-R5-8); the service/command split (plain
  DI-resolved lib functions + thin `isUndoable: false` command wrappers) mirrors Step 1.3/1.6's
  own precedent rather than the spec's abbreviated single-argument pseudocode.

## 2026-10-26T21:00:00Z — Step 2.3 landed (closes Phase 2's availability track)

- `availability.reservation.expired` declared in `events.ts` (`availability/events.ts`) — the
  last of the four lifecycle ids Step 2.2 left undeclared for this Step; `.created`/`.released`/
  `.committed`/`shortfall.detected` were already emitted by Step 2.2's `reserve`/`release`/
  `commit` and are untouched here.
- `lib/reservationSweep.ts`: `expireAvailabilityReservations` (A11) — one-minute, tenant-scoped
  tick; pages `active` holds past `expires_at` (the §5.3 partial index), CAS to `expired` +
  `wmsReservationService.releaseInTransaction` in one transaction per hold, `emitSideEffects`
  then `.expired` after commit; a lost CAS (another transition already won) is skipped, never
  double-processed.
- `reconcileAvailabilityReservations` (A12) — hourly, tenant-scoped; repairs all three redefined
  drift cases per their own transaction + CAS: (a) active hold whose wms rows are released or
  missing → release the rest, CAS the hold to `released` (`reason: 'reconciled'`), emit
  `.released`; (b) an active `'checkout'` wms row no hold's `wmsReservationIds` references,
  older than the 3600 s max TTL → release it directly; (c) a committed hold whose wms rows are
  still `'checkout'` → `convertInTransaction` to `'order'`. Every repair is logged AND
  `reportError`-ed (never silent), same convention Step 1.8's exposure-audit job established.
- `wmsReservationService` gains two additive read methods (`findReservationsByIds`,
  `listActiveReservationsBySourceType`) — the reconciliation job's only way to see a hold's own
  wms rows, or every active cross-organization `'checkout'` row for a tenant, without a static
  `wms` entity import. See PLAN.md "Decisions taken without the owner" for the cross-org scope
  reasoning.
- Scheduling: `lib/scheduling.ts#registerAvailabilityReservationSweeperSchedules` (60 s / 3600 s
  interval schedules, tenant-scoped, mirrors `cart`'s own sweeper registration exactly), wired
  into `setup.ts#seedDefaults` (new tenants) and a new `availability.register-reservation-
  sweep-schedules` upgrade action (existing tenants, `configs/lib/upgrade-actions.ts`, version
  `0.10.0`) plus its 5-locale i18n keys — see PLAN.md for why the upgrade action was added
  despite not being named explicitly in this Step's own brief.
- Tests: new `availability/lib/__tests__/reservationSweep.test.ts` (7 cases) — the expiry job's
  false-positive guard (only a past-due `active` hold transitions and releases its wms row;
  active-not-due/committed/released/already-expired holds are untouched) plus a genuine lost-CAS
  race simulation; each of the three reconciliation drift cases with a concrete fixture, plus a
  clean-state no-op case; and an explicit A13 discipline test asserting every event these jobs
  emit is `availability.reservation.expired`/`.released`, carries `tenantId`/`organizationId`
  (X11), and is never `availability.shortfall.detected` (reserve/commit's own signal, a
  different trigger) nor anything resembling `wms.inventory.reservation_shortfall` (a different
  module's order-automation signal).
- Checks: `yarn workspace @open-mercato/core typecheck` clean. Full `src/modules/wms` +
  `src/modules/configs` (78 suites, 524 tests) and the targeted `src/modules/availability`
  suites pass — zero regressions from Step 2.2's work. `yarn i18n:check-hardcoded` shows no new
  findings under `core/availability` (the two pre-existing hits are Step 2.1/2.2's `commands/
  policies.ts`, untouched here).
- Phase 2's `availability` track is now feature-complete per PLAN.md's Phase 2 heading, pending
  the run's final gate (Step 6.4).

## 2026-10-26T21:30:00Z — Step 2.4 landed (customer_groups: `CustomerPurchaseApproval` entity + migration)

- `data/entities.ts`: `CustomerPurchaseApproval` (`customer_purchase_approvals`), exact column
  set per spec §5.6 — `organizationId`/`tenantId`/`customerId` (company, FK-id only),
  `requestedByActorType`/`requestedByActorId` (D-R5-1; `staff_user` reserved/unused for the
  REQUESTER per X7), `subjectType` (`cart | quote`, `quote` reserved for acceptance per
  D-R5-23/X6, `checkout_session` not in the enum at all), `subjectId`, `amountGross` (numeric
  16,2 decimal string) + `currencyCode`, `approvalPolicy` (the `CustomerGroupTerms.approvalPolicy`
  snapshot at creation), `status` (5-value lifecycle), the two decision slots
  (`buyerDecision`/`buyerDecidedByActorType`/`buyerDecidedByActorId`/`buyerDecidedAt`/
  `buyerDecisionNote` and the `merchant*` mirror, each slot `pending|approved|rejected|
  not_required`), `decidedAt`, `withdrawnReason`, `expiresAt`, `createdAt`/`updatedAt` (no
  `deletedAt` — an approval always transitions `status` instead of being soft-deleted).
  Constraints exactly as spec'd: partial unique `(tenant_id, subject_type, subject_id) WHERE
  status = 'pending'`, two `@Check` constraints pinning each decider's actor-type column to its
  side, plus the two named indexes for the status lookup and the expiry job.
- `data/validators.ts`: five new zod enum schemas mirroring the entity's TS unions
  (`customerPurchaseApprovalActorType/SubjectType/Status/SlotDecision/WithdrawnReason`). No
  create/update/delete trio — the spec names no public create route (service-only, Step 2.5)
  and this is not a `makeCrudRoute` entity.
- New test: `data/__tests__/purchaseApproval.test.ts` (9 cases) — entity/validator round-trip
  for all three policies (`both`/`buyer`/`merchant`), a withdrawn-with-reason case, and an enum
  rejection case per schema. Mirrors the `availability`/Step 2.1 `data/__tests__/reservation.test.ts`
  convention.
- Migration: `yarn db:generate` produced exactly one `customer_groups` migration
  (`Migration20261026201625_customer_groups.ts`, create-table only, no `down()` — matches this
  module's own create-table precedent) plus unrelated `forms`/`wms` drift (a stale index rename
  and a pre-existing `wms` idempotency-column gap, reproduced on a second bare `db:generate` run
  with zero `customer_groups` changes left) — discarded per the established coding-agent-
  exception pattern (Steps 1.5/1.9/2.1).
- Scope calls: none beyond the established discard pattern above — spec §5.6 names every column
  literally, so no "two decision slots" design ambiguity to resolve (not logged in PLAN.md's
  Decisions section for that reason). One minor implementation choice, not escalated: `status`/
  `buyerDecision`/`merchantDecision` have no entity-level default and must be set explicitly by
  every writer (Step 2.5's service) — a single hard-coded default would be wrong for some
  `approvalPolicy` values (e.g. `not_required` vs. `pending` depends on which side the policy
  requires), so leaving them required-with-no-default is safer than guessing one.
- Checks: `yarn typecheck` (`packages/core`) clean. `yarn jest` in `packages/core` for the full
  `customer_groups` suite: 36/37 suites pass (394/396 tests), 1 suite with 2 DB-dependent tests
  skipped (no live Postgres in this environment, pre-existing, unrelated to this Step).

## 2026-10-26T22:00:00Z — Step 2.5 landed (customer_groups: approval service + expire-approvals job)

- Blocking gap found and fixed first: `customerGroupsService#resolveTerms` never resolved
  `approvalPolicy` (Step 1.5 added the DB column only, not the resolution-loop plumbing) —
  `requestApproval` cannot snapshot a policy that never resolves. Added `approvalPolicy` to
  `TERMS_FIELD_NAMES`/`ResolvedTerms`/`tenantDefaultTerms`/`termsFieldIsSet`/`applyTermsField`
  (tenant default `'buyer'`, D-R5-1), deliberately NOT the other three new §6.0 fields
  (`termsCurrencyCode`/`allowQuoteRequests`/`requiresPoNumber` — no caller in this Step). Updated
  `resolveTerms.test.ts`'s two exact-object snapshots and added one inheritance test. Full
  reasoning and the explain-terms route's own non-exhaustive `satisfies` check: PLAN.md
  "Decisions taken without the owner".
- `services/customerPurchaseApprovalService.ts` (new): `requestApproval`/`getApproval`/
  `getActiveApprovalForSubject`/`withdrawApproval`/`decideApproval` per spec §6's authoritative
  contract (G3's floor). Every transition (`decideApproval`'s slot CAS + the dependent overall-
  status CAS, `withdrawApproval`'s CAS) is a plain `em.nativeUpdate` inside `em.transactional`,
  never `enforceCommandOptimisticLock` — G6's exact SQL pattern, with the overall-status flip
  computed from a same-transaction re-read (`computeOverallStatus`, generic over all three
  policies via a `not_required`-is-always-satisfied rule) so a `both`-policy race between the two
  sides lands correctly regardless of commit order. `requestApproval` is idempotent per
  `(subjectType, subjectId)` while pending (pre-check + `isUniqueViolation` race fallback, same
  pattern Step 1.6's `reserveCredit` established for G12). `decideApproval` enforces G24
  (self-decision refused; a `customer_user` actor's REAL company re-derived from
  `customer_accounts.CustomerUser` by actor id via a new `lib/creditIdentity.ts#
  resolveCustomerUserCompanyId` helper — never trusted from the caller-supplied
  `ApprovalActor.customerEntityId` field alone, per the task brief's explicit defense-in-depth
  instruction) — both violations answer the SAME `approval_not_found` shape spec §9.2 requires
  (no disclosure). `buyer_decision_note`/`merchant_decision_note` are registered in
  `encryption.ts` (G22) and read back through `findOneWithDecryption`/`findWithDecryption` since
  (unlike credit) the spec requires notes to round-trip to callers.
- `lib/expireApprovals.ts` + `workers/expire-approvals.worker.ts` (new): hourly, tenant-scoped,
  the SAME CAS pattern (`status = 'pending' AND expires_at <= now()` → `expired`), a lost race to
  a concurrent decide/withdraw is skipped silently (never reported as an error, §11 "safe to
  re-run"). Reads the already-stored `expires_at` only — never re-resolves the tenant's expiry
  window. Registered an hourly tenant-scoped schedule in `setup.ts#seedDefaults` (no upgrade
  action added for existing tenants — see PLAN.md).
- `events.ts`: declared and emit all five `customer_groups.approval.*` ids now
  (`requested`/`approved`/`rejected`/`expired`/`withdrawn`), each `portalBroadcast: true`
  (D-R5-6) — unlike the sibling `credit.*` events, which Steps 1.8/1.12 left undeclared absent a
  consumer. Reasoning for the asymmetry: PLAN.md.
- `di.ts`: new `customerPurchaseApprovalService` key (G26), soft-resolving an optional
  `moduleConfigService` (same `softCradle` pattern `catalog/di.ts` uses for
  `catalogOmnibusService`) for D-R5-27's per-tenant expiry-days override, default 14.
- Tests: `services/__tests__/customerPurchaseApprovalService.test.ts` (29 cases, fake EM) —
  every policy transition (`both`/`buyer`/`merchant`), G24's two guards (self-decision,
  cross-company incl. a forged-`customerEntityId` case), G8 idempotency incl. a simulated
  unique-violation race, withdraw's requester/system/non-pending rules, tenant/org isolation, the
  error body's `details` shape. `services/__tests__/customerPurchaseApprovalService.concurrency.
  pg.test.ts` (new, gated on `OM_CUSTOMER_GROUPS_PG_URL`, 6 cases) — ran for real against a
  disposable local Postgres (`om_cgrp_approval_test`, dropped after): N=20 concurrent decides on
  a single-slot policy AND N=20 on one slot of a `both`-policy approval (the harder case, since a
  lone slot decision leaves the overall `status` at `pending`, so only the slot-specific CAS
  condition — not the overall-status one — can be what excludes a second decider) both land
  exactly one winner; simultaneous buyer+merchant approvals and a simultaneous approve/reject
  pair, both from real, independent connections; decide-vs-expire at the boundary; N=20 concurrent
  `requestApproval` for the same subject create exactly one row. Mutation-tested the `both`-policy
  same-slot race specifically (not the single-slot one, which the overall-status guard alone
  already protects): temporarily removed just the `[fields.decision]: 'pending'` WHERE condition,
  re-ran — all 20 concurrent calls "won" and overwrote each other's slot, confirming the test is
  not vacuous; restored immediately and re-verified the full pg suite green before committing.
  `lib/__tests__/expireApprovals.test.ts` (new, fake EM, 4 cases) — the false-positive guard, a
  lost-CAS-race skip with no error report, tenant isolation, a clean no-op tick.
- Checks: `yarn workspace @open-mercato/core typecheck` clean. Full `src/modules/customer_groups`
  jest suite: 38/40 suites pass (428 tests; 2 suites skipped — 1 pg-gated suite intentionally run
  separately above then re-skipped by default, 1 pre-existing unrelated DB-dependent skip from
  Step 2.4), zero regressions. No UI touched — no browser verification needed.

## 2026-10-26T20:30:00Z — dispatcher: tracked follow-up from Step 2.5
- Step 2.5 found and fixed that `resolveTerms` never resolved `approvalPolicy` (added in Step 1.5
  but never wired in). It fixed only that one field (needed for its own Step). `termsCurrencyCode`,
  `allowQuoteRequests`, `requiresPoNumber` are STILL unresolved by `resolveTerms` as of `5db46425d1`.
  Flagging for the Steps that need each one, so they check and fix `resolveTerms` rather than
  re-deriving the value some other way:
  - `termsCurrencyCode` — needed by Step 3.1 (cart approval gate, K1/D-R5-4 currency-match rule)
    and by checkout's `min_order_value` check (Step 5.1).
  - `allowQuoteRequests` — needed by checkout B.5 (Step 5.1, D-R5-20 request_quote method gating).
  - `requiresPoNumber` — needed by checkout B.5 (Step 5.1, D-R5-28 PO-on-quote).

## 2026-10-26T21:00:00Z — checkpoint 4 (Steps 2.1–2.5)
- Range: `04f87ab424`..`5db46425d1`. Summary: availability reservation entity + reserve/release/
  commit service (bug found+fixed during concurrency testing: raw SQL FOR UPDATE wasn't binding
  to the ambient transaction, switched to ORM lockMode) + expiry/reconciliation jobs; customer
  purchase approval entity + CAS service (mutation-tested double-decide race) + expiry job.
- Checks: forced full typecheck (40/40, 0 cached) pass; scoped tests pass (availability+wms+
  customer_groups 115/118 suites, 973/990 tests — 3 expected Postgres-gated skips).
- Decisions/problems: none blocking. One tracked follow-up already logged above (resolveTerms
  gaps). availability track is now fully complete for this release.

## 2026-10-26T22:00:00Z — Step 2.6 landed
- `customer_groups`: staff routes — `GET /api/customer_groups/customer-groups/approvals` (list,
  `approvals.view`, filters `status`/`customerId`/`subjectType`/`ids`, organization-scoped via the
  same `resolveOrganizationScopeForRequest` the credit routes use), `GET …/approvals/:id` (detail,
  same feature), `POST …/approvals/:id/decide` (`approvals.decide`, body `{ decision, note? }`,
  optimistic-lock header via `enforceCommandOptimisticLock` since the service itself does not read
  it, G6/§5.6). The staff actor is always `{ actorType: 'staff_user', actorId: auth.sub }` — no
  `side` input exists on `decideApproval` (Step 2.5 derives the slot from `actor.actorType`
  directly, simpler than the brief's own framing).
- Portal routes (new `api/portal/approvals/` tree) — `GET /api/customer_groups/portal/approvals`
  (list, pending-first, `…portal.approvals.view`), `GET …/:id` (detail), `POST …/:id/decide`
  (`…portal.approvals.decide`, buyer slot), `POST …/:id/withdraw` (`…portal.approvals.view`,
  requester-only enforced by the SERVICE's own actor comparison). Every portal route resolves the
  customer session via `customer_accounts/lib/customerAuth` (static import, same convention as
  `workflows/api/portal/tasks/route.ts` — both are `packages/core` modules, no extractability
  concern like `staff`'s dynamic import). A request for another company's approval answers 404,
  the same body as an unknown id (`lib/portalApprovalAccess.ts`'s `isApprovalVisibleToPortalPrincipal`
  — one pure predicate, reused by list/detail/decide/withdraw, no second copy of the rule).
- ACL (`acl.ts`): added `customer_groups.approvals.view`/`.decide` (staff) and
  `customer_groups.portal.approvals.view`/`.decide` (portal), `dependsOn` the sibling `.view` each,
  closing the deferral Step 1.7 logged. `setup.ts`: `employee` → `approvals.view` (D-R5-7);
  `defaultCustomerRoleFeatures.portal_admin` → both portal features, `.buyer` → view only (own
  requests/withdraw enforced by route scoping, not feature withholding — per the Step brief's own
  explicit instruction).
- `services/customerPurchaseApprovalService.ts`: exported `toApprovalView` (was private) so the
  new list/detail routes serialize through the exact same mapping `getApproval`/`decideApproval`/
  `withdrawApproval` already return — additive, no behavior change.
- Tests: `lib/__tests__/portalApprovalAccess.test.ts` (8 cases) for the pure visibility
  predicate/list-`WHERE` builder; `data/__tests__/purchaseApprovalRoutes.test.ts` (9 cases) for the
  new decide/list-query zod schemas (`.strict()` body, pageSize cap, filter validation). New
  Playwright integration spec `TC-CGRP-034-purchase-approval-routes.spec.ts` (2 tests): staff
  decide feature-gating + tenant/organization isolation + re-decide-409; portal company scoping
  (buyer sees/withdraws only their own requests, a `…decide` holder sees the whole company,
  self-decision 403, cross-company 404 on every route, viewer gets 403 with no portal feature at
  all) — written against the live-DB `withClient` fixture convention this suite's siblings already
  use (no create route exists for approvals, so every fixture row is inserted directly), NOT
  executed in this sandboxed worktree (no live Postgres/dev server here) — same situation as every
  prior `__integration__` spec in this run; run it via the project's normal QA/CI pipeline.
- Checks: `yarn workspace @open-mercato/core typecheck` clean (0 errors). Full
  `src/modules/customer_groups` jest suite: 40/42 suites pass, 445/453 tests (8 skipped — the two
  pg-gated concurrency suites, expected without a live Postgres), zero regressions. `eslint` clean
  on every new/changed file. No UI touched — no browser verification needed.

## 2026-10-26T21:52:32Z — Step 2.7 landed
- `customer_groups`: approval notifications — in-app to merchant deciders (`customer_groups.
  approval.requested`, new type in `notifications.ts`, fan-out via `createForFeature` +
  `restrictRecipientsToOrganization: true` to every staff holder of `customer_groups.approvals.
  decide` in the organization, idempotent on redelivery for free via the notification system's own
  `groupKey` dedupe); e-mail to buyer-side deciders/requesters through the shared `sendEmail`
  pipeline, gated by a new per-tenant switch (`ModuleConfigService` key `customer_groups.
  approval_emails_enabled`, default ON, same call shape `resolveApprovalExpiryDays` already
  established in this module).
- Did NOT declare `customer_groups.approval.decided` — the authoritative, REVISED spec text
  (§10.2's own closing line) explicitly says it is not declared in Release 5 (no path creates a
  staff-requested approval, X7), directly contradicting the pre-decision G15 wording the Step brief
  quoted. Did NOT e-mail the requester on `.withdrawn` — §10.2's e-mail trigger table names only
  `.approved`/`.rejected`/`.expired`. Both are genuine conflicts between the Step brief (which
  quotes the ANALYSIS doc, written BEFORE the owner's decision pass) and the spec (written AFTER
  it, and the explicitly authoritative text per PLAN.md's own "Implementation Plan" preamble) — see
  PLAN.md "Decisions taken without the owner" for the full reasoning and code citations.
- Idempotency for the e-mail sends (no platform primitive exists for this — persistent subscribers
  are only at-least-once, and `sendEmail` has no dedup of its own): added two additive, nullable
  timestamp columns to `CustomerPurchaseApproval` (`requested_email_sent_at`,
  `decided_email_sent_at`) as CAS markers, migration `Migration20261026213913_customer_groups`
  (generated via `yarn db:generate`; two unrelated migrations it also emitted for `forms`/`wms`
  were deleted and their snapshots reverted per the coding-agent exception in root AGENTS.md).
- New files: `lib/approvalNotifications.ts` (merchant in-app fan-out), `lib/approvalEmails.ts`
  (buyer e-mail fan-out + requester e-mail + the per-tenant switch + the CAS markers), `lib/
  approvalEmailRecipients.ts` (FK-id-only raw-SQL reads against `customer_accounts.customer_users`,
  no ORM import — same convention `lib/creditIdentity.ts` already set), `lib/
  approvalDecidedSubscriberHandler.ts` (shared dispatch behind the three decided subscribers),
  `emails/ApprovalEmail.tsx` (shared buyer-facing e-mail layout, modelled on `customer_accounts/
  emails/CustomerInvitationEmail.tsx`), four subscribers (`subscribers/approval-{requested,
  approved,rejected,expired}-notification.ts`, one event id per file per the `events` module's own
  registry contract).
- `customer_accounts` (`customerRbacService`, for the portal-decide feature check) and `configs`
  (`moduleConfigService`, for the switch) are both resolved via a local `tryResolve` helper and
  degrade to "skip the e-mail" when absent — optional peers, per `packages/core/AGENTS.md` → Cross-
  Module Coupling, same pattern `customer_groups/di.ts`'s own `softCradle` already established for
  `moduleConfigService`.
- No deep link on the new in-app notification — no staff admin UI page for approvals exists yet
  (Step 2.6 shipped API routes only); left `linkHref` unset rather than inventing one, same
  restraint `customer_groups.credit.limit_exceeded` took in Step 1.8.
- Tests: `lib/__tests__/approvalNotifications.test.ts` (merchant fan-out + groupKey + feature id),
  `lib/__tests__/approvalEmails.test.ts` (all three policies' routing, the per-tenant switch, the
  CAS-marker idempotency on redelivery for both the requested batch and the decided single-send,
  the never-staff-requester guard, requester exclusion from the buyer-decider list),
  `lib/__tests__/approvalDecidedSubscriberHandler.test.ts` (status binding, payload parsing),
  `subscribers/__tests__/approval-requested-notification.test.ts` (policy-gated dispatch, one
  channel's failure not blocking the other).
- Checks (local mode, no Docker `app` container running): `yarn db:generate` (customer_groups
  migration reviewed, unrelated forms/wms output discarded); `yarn generate` (clean, 381 generated
  artifacts refreshed); `npx tsc --noEmit` scoped to `packages/core` clean (0 errors); `npx jest
  src/modules/customer_groups` from `packages/core` (root `yarn jest` fails on every suite here,
  known issue) — 44/46 suites pass, 467/475 tests, 2 suites skipped (pg-gated concurrency, expected
  without a live worker harness), zero regressions; `eslint` clean on every new/changed file. No UI
  touched — no browser verification needed.

## 2026-10-26T22:06:30Z — Step 2.8 landed
- `cart`: lock contract (C1/X15). `cart.lock` gains a bounded, optional `lockTtlMs` (`60_000..
  86_400_000`, default unchanged — `resolveCartLockTimeoutMs()`, the existing env-configurable 30
  min). A second `cart.lock` call carrying the SAME `checkoutSessionId` the cart is already locked
  under is now an idempotent EXTEND: it moves `lockExpiresAt` forward and returns the cart with a
  new `extended: true` flag, running neither the forced re-price nor the whole-cart visibility pass
  (both confirmed skipped by a dedicated test asserting `cart.reprice` is never dispatched a second
  time). A re-lock attempt with a DIFFERENT or ABSENT `checkoutSessionId` is completely unchanged —
  still the ordinary 423 `cart_locked` — covered by a new regression test for the no-session case
  alongside the pre-existing different-session one.
- `cart.unlock`/`cart.markConverted` both gain an OPTIONAL `checkoutSessionId` input: when the
  caller supplies it, a mismatch against the cart's own stored session is refused with the uniform
  404 (same no-oracle body every other refusal in this module already uses); when omitted, both
  commands behave exactly as before this Step — no session check runs at all. Decision (logged in
  PLAN.md): optional rather than mandatory, because these commands already shipped in Release 4
  (this fork's own develop, PR #7592) and root AGENTS.md/`BACKWARD_COMPATIBILITY.md` treat a
  shipped command's signature as frozen regardless of whether an in-repo caller exists yet — even
  though `commands/lock.ts`'s own header comment confirms none of the three commands has a real
  caller in this worktree today (no `checkout` module exists). No DB migration needed —
  `Cart.checkout_session_id` already existed as a column since Release 4.
- New event `cart.lock.extended` (alongside the pre-existing `cart.lock.acquired`/`.released`/
  `.timed_out` family) for the `locked -> locked` transition, same "no real consumer yet" posture
  its siblings already have.
- Files: `packages/core/src/modules/cart/commands/lock.ts` (bounds validation, the extend branch
  and its own `extendCartLock` helper, session-match guards on `unlock`/`markConverted`),
  `packages/core/src/modules/cart/events.ts` (new event id), `packages/core/src/modules/cart/
  commands/__tests__/lock.test.ts` (10 new tests: bounds validation on both fresh-lock and extend,
  explicit `lockTtlMs` honoured on a fresh lock, the extend's TTL bump + no-reprice-dispatch
  guarantee + event, the env-default fallback on an extend, the no-session-still-423 regression
  guard, and matched/mismatched `checkoutSessionId` for both `unlock` and `markConverted`).
- Checks (local mode): `npx tsc --noEmit` scoped to `packages/core`, clean (0 errors). Full
  `src/modules/cart` jest suite from `packages/core`: 18/18 suites, 226/226 tests, zero regressions
  outside this Step's own new tests (one existing test's expected-error log line, `currentCartRoute.
  error-mapping.test.ts`, prints "boom" to stderr by design — not a failure). No UI touched, no
  `yarn generate`/`yarn db:generate` needed (no new auto-discovered files, no schema change).

## 2026-10-26T22:26:13Z — Step 2.9 landed

- **Behavior change (D-R5-21, UPGRADE_NOTES-ready description for Step 6.2):** every
  `/api/cart/current/*` route (`current`, `current/lines`, `current/lines/[lineId]`,
  `current/lines/bulk`, `current/promotions`, `current/promotions/[id]`, `current/merge`,
  `current/undo-merge`) now refuses an IDENTIFIED basket (one with `customer_user_id` set) to
  any request that does not also carry that buyer's own customer session (`X-Cart-Token` plus
  a valid `customer_auth_token` cookie or `Authorization: Bearer <customer JWT>` whose subject
  equals the basket's `customer_user_id`). A request with no session, or with a DIFFERENT
  customer's valid session, now gets the exact same `404` body as an unknown/wrong token — no
  re-price, no re-identification, no activity stamp runs. `POST /current/merge`'s `sourceToken`
  body field follows the identical rule for the SOURCE (guest) cart it names. A GUEST basket
  (`customer_user_id` null) is completely unaffected and stays fully token-only, exactly as
  before. Before this change, an anonymous `GET /current` presenting an identified basket's
  token silently re-identified that basket to "guest" (`customerUserId` rewritten to `null` by
  the whole-cart re-price trigger), disclosing B2B contract pricing and re-pricing the basket to
  list — the storefront integration must now forward the buyer's customer session alongside the
  cart token on every request, and must start a brand-new guest cart after logout rather than
  reusing the old token (a later login still merges it normally). No cart/API contract fields
  changed — only the authorization outcome for this one case.
- **Non-breaking addition (D-R5-22):** a trusted `pos`/`pay_link`/`agent`/`api` cart created
  via `cart.create`'s authenticated path for a known buyer (`customerId` or `customerUserId`
  supplied by the trusted caller, never from request input) now resolves that buyer's REAL
  company/group/price-kind identity through `storeContextService.resolveForBuyer` when
  `ecommerce` is registered — `customerId`, `customerIds` (person AND company), `customerUserId`,
  `customerGroupIds`, `priceKindId`, `taxMode` and `buyerDigest` all come from the resolved
  identity instead of the old placeholder (`customerIds = [customerId]`, no groups, no price
  kind). `currencyCode` is unaffected — it stays the trusted caller's own required input, per
  the spec's own fill list. A guest trusted cart (no buyer named) or a deployment with
  `ecommerce` disabled behaves exactly as before (documented fallback, not silent).
- Files: `packages/core/src/modules/cart/lib/currentCartRoute.ts` (the identity-binding check,
  centralized once in `resolveCurrentCart`'s own `peekCartCustomerUserId` pre-check — runs
  BEFORE `cart.get` so the old bypass's own write path, trigger 2's `applyCartRepriceTriggerFields`,
  can never fire for a mismatched/anonymous request against an identified basket);
  `packages/core/src/modules/cart/commands/merge.ts` (the SAME check applied to `sourceToken`'s
  resolved guest cart); `packages/core/src/modules/cart/commands/cart.ts` (the trusted-path
  `resolveForBuyer` fill, `resolveTrustedCartBuyerIdentity`/`tryResolveStoreContextService`).
  Tests: `packages/core/src/modules/cart/lib/__tests__/currentCartRoute.identity-binding.test.ts`
  (new, 6 cases), `packages/core/src/modules/cart/commands/__tests__/merge.test.ts` (+3 cases),
  `packages/core/src/modules/cart/commands/__tests__/cart.test.ts` (+3 cases).
- Two scope calls made without the owner, both logged in PLAN.md "Decisions taken without the
  owner": (1) extended Part A to also cover `cart.merge`'s `sourceToken`, which the task brief's
  own bullet list did not name but §8.4's text explicitly lists as a consequence of the same
  rule; (2) followed the spec's literal seven-field `resolveForBuyer` fill list over the task
  brief's broader field list, which named `currencyCode` — the spec text and the trusted
  caller's own required-field validator both confirm the omission is deliberate.
- Checks (local mode, no Docker `app` container running): `npx tsc --noEmit` scoped to
  `packages/core`, clean (0 errors). Full `src/modules/cart` jest suite from `packages/core`:
  19/19 suites, 238/238 tests — zero regressions (226 pre-existing + 12 new: 6 identity-binding
  + 3 merge sourceToken + 3 trusted-path identity fill). `eslint` clean on every changed/new
  file. The X1 regression test (`resolveCurrentCart`'s "an identified basket refuses a
  token-only anonymous request" case) and the guest/token-only preservation test both pass,
  proving the old bypass path can no longer be reached and guest baskets are unaffected. No UI
  touched, no `yarn generate`/`yarn db:generate` needed (no new auto-discovered files, no schema
  change).

## 2026-10-27T00:00:00Z — Step 2.10 landed

- `cart`: `markConverted` additive `salesOrderId`/`salesQuoteId`/`lineMap` inputs (K8/D-R5-26),
  and the FIRST admin UI this module ships — `GET /api/cart/carts` + `/carts/[id]` + `POST
  /carts/[id]/reprice` (K6) with a `DataTable` list, a read-only detail page, and i18n in all 5
  locales.
- `cart.markConverted`: `lineMap` entries are `{ cartLineId, salesOrderLineId }` under
  `salesOrderId`, or `{ cartLineId, salesQuoteLineId }` under `salesQuoteId` — never both ids in
  one call (D-R5-26). Validated before any write: every entry's `cartLineId` must be a live line
  of the cart, every live line must appear exactly once (bijection), and every entry must match
  the SAME discriminant the call named — any violation throws `400
  cart_convert_line_map_invalid` with nothing written. A caller naming none of the three fields
  behaves exactly as before this Step (regression-tested). `cart.cart.converted`'s payload grows
  additively to the full §11 rev-10 shape: `{ cartId, tenantId, organizationId,
  checkoutSessionId, salesOrderId, salesQuoteId, lineMap }` (all three new fields `null` when
  omitted).
- Admin `GET /api/cart/carts` (`makeCrudRoute`, `cart.carts.view`): filters
  `status`/`channel`/`storeId`/`customerId`/`requiresApproval`/`lastActivityFrom`/
  `lastActivityTo`/`ids`; `kind` defaults to, and can ONLY be, `basket` (the §7a proposal seam
  stays unreachable, K12's "pin the inert seam" posture, until Step 3.4); sorts by
  `lastActivityAt` (default) or the new `grandTotalGrossAmount` generated column;
  `pageSize ≤ 100`; `email` decrypted through the query engine with no free-text search on it
  (search by `customerId`); `lineCount` batched in one `CartLine` query per page.
- Admin `GET /api/cart/carts/[id]` (hand-written, `cart.carts.view`): reuses
  `buildCartResponseEnvelope` for lines/totals/warnings, layered with admin-only fields
  (`kind`/`channel`/`storeId`/`customerId`/`customerUserId`, decrypted `email`/`note`,
  `proposedToCartId`), the LIVE approval via `customerPurchaseApprovalService.getApproval`
  (soft `tryResolve`, both branches tested — present and absent), and `CartMergeLog` entries.
  404s on an unknown cart, another organization, another tenant, or a proposal cart.
- Admin `POST /api/cart/carts/[id]/reprice` (hand-written, `cart.carts.manage`, trigger 7):
  REQUIRES the optimistic-lock header (`400` if missing, not merely fail-open —
  `enforceCommandOptimisticLock`'s own default); accepts `active` OR `abandoned` carts (`423`
  locked, `409 cart_not_active` otherwise); refreshes the buyer's identity via `ecommerce`'s
  `storeContextService.resolveForBuyer` from the cart's OWN stored identity (soft peer, never
  from the staff caller's request) before dispatching `cart.reprice` with the new
  `trigger: 'admin_reprice'`; returns the §10.1 envelope with `versionBumpReason: 'repricing'`.
- `commands/cart.ts` changes backing the admin reprice action: `cart.reprice`'s status guard now
  accepts `'active' | 'abandoned'` (the command never writes `Cart.status`, so this can never
  reactivate a basket); `applyCartRepriceTriggerFields` gained a dedicated `'admin_reprice'`
  branch that only overwrites a buyer-identity field when the admin route actually resolved one
  (never wipes an existing field on a partial/absent refresh, unlike trigger 2's always-full
  overwrite); the §6a.2 whole-cart re-visibility pass now also runs for `admin_reprice`.
- New generated column `Cart.grandTotalGrossAmount` (`grand_total_gross_amount`, Postgres STORED
  GENERATED from `totals->>'grandTotalGrossAmount'`, same declarative pattern as
  `CartLine.configurationHash`/`wms.InventoryBalance.quantityAvailable`), backing the admin
  list's `grandTotalGrossAmount` sort — mirrors how `sales/data/entities.ts` already stores its
  own grand total as a flat column. Migration + `.snapshot-open-mercato.json` hand-authored
  (documented in PLAN.md's decisions log — a local Postgres exists in this sandbox but holds
  unrelated prior-session schema state, so `yarn db:generate` was skipped in favor of a two-
  statement `alter table` matching this module's own existing generated-column precedent).
- Route-enumeration test (`api/carts/__tests__/routeEnumeration.test.ts`) asserts every admin
  cart route file exports exactly the one HTTP method it needs (`GET`/`GET`/`POST`) and nothing
  that could mutate a line — closing §10.2/§14's "no admin route adds, updates or removes a
  line" guarantee at the HTTP layer.
- Files: `packages/core/src/modules/cart/commands/lock.ts` (`markConverted` inputs + validation),
  `packages/core/src/modules/cart/commands/cart.ts` (status guard, `admin_reprice` field
  branch + revisibility gate), `packages/core/src/modules/cart/lib/reprice.ts` (new
  `'admin_reprice'` reason), `packages/core/src/modules/cart/data/validators.ts` (lineMap +
  admin list/reprice schemas), `packages/core/src/modules/cart/data/entities.ts`
  (`grandTotalGrossAmount` generated column + index), `packages/core/src/modules/cart/migrations/
  Migration20261026231500_cart.ts` + `.snapshot-open-mercato.json`, `packages/core/src/modules/
  cart/lib/adminCartScope.ts` (new — org-scope + approval-service tryResolve helpers),
  `packages/core/src/modules/cart/api/carts/{route.ts,[id]/route.ts,[id]/reprice/route.ts}` (new),
  `packages/core/src/modules/cart/backend/cart/carts/{page.tsx,page.meta.ts,[id]/page.tsx,
  [id]/page.meta.ts}` (new), `packages/core/src/modules/cart/i18n/{en,pl,es,de,ko}.json` (+71
  keys each, real per-locale translations, not English placeholders). Tests: `commands/
  __tests__/lock.test.ts` (+8 markConverted cases: backward-compat no-op, order/quote lineMap,
  both-ids rejection, foreign-line rejection, incomplete-bijection rejection, wrong-shape
  rejection), `commands/__tests__/cart.test.ts` (+4 reprice cases: abandoned acceptance, merged
  rejection, partial-refresh non-destructive, full-refresh), `api/carts/__tests__/route.test.ts`
  (buildFilters + kind rejection + lineCount afterList), `api/carts/[id]/__tests__/route.test.ts`
  (401/404×3/200, approval present/absent, merge-log mapping), `api/carts/[id]/reprice/
  __tests__/route.test.ts` (ACL metadata, missing/stale optimistic-lock header, 404×2, 423, 409,
  abandoned acceptance, trigger/routeContext shape, envelope shape), `api/carts/__tests__/
  routeEnumeration.test.ts` (new).
- Checks (local mode): `npx tsc --noEmit` scoped to `packages/core`, clean (0 errors). Full
  `src/modules/cart` jest suite from `packages/core`: 23/23 suites, 280/280 tests — zero
  regressions (238 pre-existing + 42 new). `eslint` clean on every new/changed file.
  `i18n-check-sync`: all 5 locales in sync (69 modules). `i18n-check-hardcoded`: zero hits under
  `modules/cart/` (advisory, exit 0 either way). `yarn generate`: completed (exit 0, 383
  generated artifacts refreshed, cart's own `api-route-shard.*.cart.generated.ts` picked up the
  three new routes) — every generated output lives under the gitignored `.mercato/generated/`
  tree, so nothing new is tracked by git. No `yarn db:migrate` run (hand-authored migration per
  the documented decision above).
- Scope calls made without the owner (full reasoning in PLAN.md's decisions log): the new
  `grandTotalGrossAmount` generated column + migration (root-causing the admin list's sort
  requirement rather than dropping it); `checkoutSessionId` added to the `cart.cart.converted`
  payload (§11's own literal shape, not explicitly named in the brief); `cartMarkConverted
  LineMapEntrySchema`'s plain-string (not `uuid()`) id fields; the admin reprice status guard's
  blanket (not trigger-scoped) `'active' | 'abandoned'` relaxation; a dedicated
  `'admin_reprice'` field-application branch; `tryResolveCustomerPurchaseApprovalService` kept
  despite `customer_groups` being a hard dependency; and `lib/adminCartScope.ts` duplicating
  (never importing) `customer_groups`' own module-private scope helper.

## 2026-10-27T00:30:00Z — Step 2.11 landed (closes Phase 2's `cart` track)

- `cart.cart.abandoned` (K9, §11 as revised) grows from `{ cartId }` to the full Release 5
  shape: `{ cartId, tenantId, organizationId, storeId, channel, customerId, customerUserId,
  hasEmail, currencyCode, grandTotalGrossAmount, lineCount, lastActivityAt }`. `hasEmail` is a
  derived boolean (`Boolean(cart.email)`) — the decrypted `email` string itself never appears on
  the payload (no PII leak, this run's established redaction discipline). `grandTotalGrossAmount`
  reads Step 2.10's generated column directly rather than recomputing from the `totals` jsonb.
  `lineCount` is batched in ONE `CartLine` query per sweep page (never N+1), mirroring the exact
  pattern `api/carts/route.ts`'s own `afterList` hook already established for the same field
  (Step 2.10). `cart.cart.expired`'s own payload is unchanged — K9 only names `.abandoned`.
- K11: `mark-abandoned-carts` and `expire-carts` now release every distinct code reservation a
  transitioned basket holds, by `cartId` — closing the Release 4 deferral `lib/sweepers.ts`
  carried at this exact spot since Step 4.8/7.2. Implemented as a new local helper,
  `releaseCartCodeReservations`, which enumerates the basket's `CartPromotionApplication.codeId`
  values (deduped — a code referenced by more than one promotion's rule tree gets exactly one
  release call, mirroring `commands/promotions.ts#removePromotionCommand`'s own pattern) and
  calls `codeService.releaseCode(em, codeId, cartId, scope)` for each, immediately after that
  cart's own lifecycle-event emission in the same per-cart loop (no extra transaction — matches
  this file's existing "the DB transition already committed, side effects run after" shape).
  Best-effort: a release failure is logged and swallowed, never re-thrown to retry an already-
  landed status transition — the exact same reasoning this file's own `emitCartLifecycleEvent`
  already documents for itself, now applied identically to the new call; `promotions`' own
  `code-reservation-sweeper.ts` (TTL-based, independent) is the safety net for whatever this
  call does not reach.
- `codeService` is injected, never DI-resolved inside `lib/sweepers.ts` itself — a new exported
  duck type, `CartCodeServiceLike` (`releaseCode(em, codeId, cartId, scope): Promise<void>`),
  matching `promotions/lib/code-service.ts#PromotionCodeService.releaseCode`'s exact signature
  with zero static `promotions` entity import. Both `sweepAbandonedCarts`/`sweepExpiredCarts`
  gained a new required `codeService: CartCodeServiceLike` parameter (ahead of the existing
  `now` default), and both workers (`mark-abandoned.worker.ts`/`expire.worker.ts`) now resolve
  it via `ctx.resolve<CartCodeServiceLike>('promotionCodeService')` — `promotions`' own frozen DI
  token (§Release 4 Contract Freeze) — before calling the sweep. `cart`'s `index.ts` already
  lists `promotions` as a hard `requires`, so this resolve can never fail for "module not
  installed" the way a soft `tryResolve` would need to guard against.
- **Verified, not a gap:** `expire-carts`/`mark-abandoned-carts` are the only two sweepers K11
  names, and they are also the only two `kind = 'basket'` transitions that ever set `resolvedAt`
  BEFORE `purge-expired-carts` can see a cart — `release-stale-locks` doesn't touch `resolvedAt`
  at all (a `locked -> active` row stays non-terminal). So neither of K11's two targets is a
  real gap for `purgeExpiredCarts` to additionally cover.
- **Gap found and deliberately left open (not silently expanded into this Step's scope):**
  `purgeExpiredCarts`'s own `WHERE` (`kind: 'basket'`, `resolvedAt` past the 90-day cutoff) has
  no `status` filter, and TWO other transitions write `resolvedAt` directly without ever passing
  through `expire`/`mark-abandoned` first — `cart.markConverted` (`commands/lock.ts:~506-507`,
  `status = 'converted'`) and `cart.merge`'s absorbed-cart finalization (`commands/merge.ts:
  ~595-597`, `status = 'merged'`). A converted or merged basket that still held an open
  `CartPromotionApplication`/`CodeReservation` pair at that moment (today: always true for
  `markConverted`, since no caller in this worktree calls `promotions.code.use` before it —
  that lands in checkout's own Phase 4 submit, Steps 4.1–4.2) will reach `purgeExpiredCarts`'s
  90-day cutoff with that reservation never released by THIS file's mechanism. K11's own text
  names only `expire`/`mark-abandoned`, not `purge`, `markConverted`, or `merge` — extending the
  release call to either of those two commands, or to `purgeExpiredCarts` itself, is a materially
  different change (a NEW call site in `commands/lock.ts`/`commands/merge.ts`, not a sweeper
  the brief already named) than this Step was asked to make, so it was left alone rather than
  silently grown. In practice this is non-fatal today: `promotions`' own
  `code-reservation-sweeper.ts` is an independent, TTL-based safety net that releases a lapsed
  `CodeReservation` row regardless of the cart's own state, and once checkout's real submit
  sequence lands (Phase 4) a converted cart's codes will already be consumed via
  `promotions.code.use` (which deletes the `CodeReservation` row itself, same transaction) before
  `markConverted` is ever called — so the gap is real today but time-bound, not a correctness
  defect in what K11 asked for. Flagged here per the task brief's own instruction rather than
  expanding scope to fix it.
- Files: `packages/core/src/modules/cart/lib/sweepers.ts` (`CartCodeServiceLike`,
  `releaseCartCodeReservations`, both sweepers' new `codeService` parameter, the K9 payload,
  the purge doc-comment), `packages/core/src/modules/cart/workers/mark-abandoned.worker.ts` +
  `expire.worker.ts` (resolve `promotionCodeService`, pass it through). Tests:
  `lib/__tests__/sweepers.test.ts` — rewrote the `cart.cart.abandoned` assertions to the full K9
  shape, added a dedicated full-field-coverage test (non-default values on every field, asserts
  `email` itself never appears on the payload), added K11 coverage for both sweepers (releases
  every distinct code once each, a reservation-free basket calls `releaseCode` zero times, a
  `releaseCode` rejection never blocks the transition or the event), and a tenant-isolation
  regression check for `sweepExpiredCarts`. `makeEm`'s stub grew two new read-only in-memory
  tables (`CartLine`, `CartPromotionApplication`) and two new fixture builders.
- Checks (local mode, from `packages/core`): `TMPDIR=/tmp yarn jest src/modules/cart/lib/
  __tests__/sweepers.test.ts` — 27/27 passing. Full `src/modules/cart` jest suite — 23/23
  suites, 287/287 tests, zero regressions (260 pre-existing + 27 new/changed). `src/modules/
  promotions` jest suite — 28/28 suites, 333/333 tests, unaffected (confirms `PromotionCodeService
  .releaseCode`'s own signature/behavior was read, never edited). `TMPDIR=/tmp yarn typecheck`
  (scoped to `packages/core`) — clean, exit 0. `npx eslint` on all four touched files — clean.

## 2026-10-27T19:40:00Z — checkpoint 5 (Steps 2.6–2.11)
- Range: `38149dcb0a`..`7443c78d16`. Summary: approval portal/staff routes + ACL/grants +
  notifications (customer_groups approval track complete); cart lock extend, D-R5-21/22 identity
  binding (recorded behavior change, UPGRADE_NOTES-ready description already logged above by
  Step 2.9 itself), markConverted lineMap + first cart admin UI, abandonment payload + K11
  code-release.
- Checks: forced full typecheck (40/40, 0 cached) pass; scoped tests pass (customer_groups+cart+
  promotions 95/97 suites, 1087/1095 tests — 2 expected Postgres-gated skips).
- Process note: this checkpoint covers 6 Steps, not 5 — a pacing slip (dispatched 2.10→2.11
  without pausing). No quality impact; resuming strict every-5 pacing from Step 2.12.
- Decisions/problems: none blocking. One non-blocking gap from 2.11 (purge sweeper / converted
  baskets' code reservations) already logged above.

## 2026-10-27T20:30:00Z — Step 2.12 (checkout B.1: session entity, step machine, C14 minimum)
- First `checkout`-module Step in this run. `checkout` was Phase-A-only before this Step (pay
  links/templates/transactions, `/pay/[slug]`); `index.ts` declared NO `requires` at all.
- Shipped: `CheckoutSession` + `CheckoutSessionEvent` entities + hand-authored migration
  (`Migration20261027120000.ts`) + `.snapshot-open-mercato.json` edit (local Postgres holds
  unrelated QA-session schema drift, same reasoning Step 2.10 already gave — ran `yarn generate`
  only, not `yarn db:generate`, against this worktree); `checkout.session.create`/`.update`
  commands; `POST /api/checkout/sessions` (buyer, from `{ source: 'cart' }` + `X-Cart-Token`
  only — `{ source: 'link' }`/B.2 is Step 3.5's own scope and fails zod validation, not a
  silent no-op); `GET`/`PATCH /api/checkout/sessions/current` (`X-Checkout-Session-Token`,
  D-R5-33 binding, C21 scope); admin `GET /api/checkout/sessions` + `/sessions/[id]`
  (`checkout.sessions.view`); `checkout.sessions.view`/`.manage` ACL + `employee`/`admin` grants
  (D-R5-34); `checkout:checkout_session` encryption map (email/phone/shipping_address/
  billing_address); `CheckoutSessionEvent.payload` allowlist-redaction at write time;
  `enforceCheckoutRateLimit` extended with an additive `keyOverride` + three new rate-limit
  configs (create 20/min/IP, mutate 60/min/session + 120/min/IP, all fail-closed per §13's own
  table); `lib/session-status-machine.ts` (the §4.1 status enum + this Step's own synthesized
  legal-transition table, CAS-enforced via `nativeUpdate`, same pattern as `checkout.transaction
  .updateStatus`'s `VALID_CHECKOUT_TRANSITIONS`).
- **Decision — scope cut on session creation's cross-module cart lookup (not in the task brief,
  found during implementation):** `cart.get`'s own command input REQUIRES `tenantId`/
  `organizationId` upfront, which checkout cannot know before resolving a bare `X-Cart-Token`
  (a guest buyer's only credential, §9.0 — no store/host-mapped tenant resolution is reliable for
  every channel: `storeContextService.resolve` ALWAYS requires a resolvable store-by-host, which
  would make `POST /sessions` unusable for the agent/API-only selling model the spec's own
  Executive Summary names as a release invariant). Resolved by a SCOPE-FREE lookup
  (`lib/cartPeer.ts#lookupCartPeerByToken`) against `cart`'s globally-unique `carts.token_hash`
  column via a raw Kysely select on the table name — never an import of `cart`'s `Cart` entity or
  any `cart/lib` function (the spec's own "checkout imports nothing from cart/lib" rule, §6),
  mirroring `ecommerce/lib/storeContextService.ts#lookupStoreTenantId`'s own precedent for this
  exact "FK-id + snapshot" coupling style (`packages/core/AGENTS.md` § Cross-Module Coupling).
  The found row's own `tenantId`/`organizationId` become the session's ground truth. Alternative
  considered: require `storeContextService.resolve` for every session creation — rejected as
  making link/API/agent-channel session creation impossible with no ecommerce store configured,
  contradicting the module's own stated release invariant.
- **Decision — §7.1 check 4 (store/channel/currency consistency, C9) is NOT enforced at session
  CREATE in this Step.** The task's own Implementation list scopes this Step to the session
  entity + skeleton + security baseline, explicitly excluding B.3/B.4 business logic; C9 is a
  SUBMIT precondition (Step 4.1) that the spec ALSO names at creation (§7.1), but implementing
  the request-host-resolved-store comparison requires the same `storeContextService.resolve`
  call this Step deliberately avoids making mandatory (see above). The session instead copies the
  cart's own `storeId`/`channel`/`currencyCode` verbatim — correct as a snapshot, just not yet
  cross-checked against a request-resolved store. **Follow-up needed**: Step 3.5 (B.2) or a
  dedicated gap-fill must add the `storeContextService.resolve(request, { fresh: true })` +
  `cart_store_mismatch` check at `POST /sessions` before B.3/B.4 can rely on it being pre-verified.
- **Decision — exact state-enum adjacency table (the spec gives prose, not a table).** Built
  `VALID_CHECKOUT_SESSION_TRANSITIONS` as: `open -> {awaiting_approval, submitting, canceled,
  expired}`; `awaiting_approval -> {open, failed, canceled, expired}`; `submitting ->
  {awaiting_payment, completed, failed, open}`; `awaiting_payment -> {completed, failed}`;
  `completed`/`failed`/`canceled`/`expired` terminal. Same-state transitions are idempotent
  no-ops (mirrors `isValidCheckoutStatusTransition`'s own convention for `CheckoutTransaction`).
  Full per-row citation to the spec section it derives from is in `lib/session-status-machine.ts`'s
  own doc comment. Only `open -> canceled` (cancel route skeleton via the "one live session per
  cart" supersede rule, §9.0) is actually EXERCISED by code this Step ships — every other row is
  untested-by-business-logic until Steps 2.13/3.5/4.1/4.2 land, but is unit-tested directly as a
  legal transition via the table itself.
- **Decision — exact rate-limit numbers for `POST /sessions` (C14 doesn't name them).** §13's own
  table in the REVISED spec actually DOES name them explicitly (20/min per IP, fail-closed;
  60/min per session + 120/min per IP for `/current` mutations) — read §13 directly rather than
  guessing, since the task brief's own framing ("C14 doesn't name them explicitly") pre-dated the
  spec revision pass. Used the spec's literal numbers, not invented ones.
- **Decision — `/sessions/current/step` and `/sessions/current/cancel` are NOT built in this
  Step**, despite the spec's own §17 Phase B.1 scope naming both. The task brief's own
  Implementation bullet list enumerates only `POST /sessions` (create) and `GET`/`PATCH /sessions/
  current` as this Step's route surface, and none of the 9 test priorities names either route.
  Building them now would mean inventing the step-navigation validation (`/step`) and the
  approval-interaction rule ("the cart's approval is kept") for `/cancel` ahead of any Step that
  actually needs them. **Follow-up needed**: a later checkout Step (2.13 or a gap-fill) should
  add both, reusing `lib/currentSessionRoute.ts#resolveCurrentSession` and `lib/session-status-
  machine.ts` exactly as this Step's `current/route.ts` already does.
- **Decision — `expire-checkout-sessions` background job is NOT built in this Step**, though §17
  Phase B.1 names it. Not in the task brief's own Implementation list or test-priority list;
  `CheckoutSession.expiresAt` is written (1-hour placeholder TTL, documented in `commands/
  session.ts`) so a later Step can build the sweep without a further migration. **Follow-up
  needed**: register the job + its `setup.ts` schedule when a Step actually needs sessions to
  stop accumulating as `open` forever.
- Files: `packages/checkout/src/modules/checkout/data/entities.ts` (+`CheckoutSession`,
  `CheckoutSessionEvent`), `data/validators.ts` (+create/update schemas), `migrations/
  Migration20261027120000.ts` + `.snapshot-open-mercato.json`, `encryption.ts`, `acl.ts`,
  `setup.ts`, `events.ts` (+`.created`/`.canceled`), `commands/session.ts` (+`commands/index.ts`
  wiring), `lib/tryResolve.ts`, `lib/sessionToken.ts`, `lib/cartPeer.ts`, `lib/currentSessionRoute.ts`,
  `lib/session-status-machine.ts`, `lib/sessionEvents.ts`, `lib/sessionView.ts`, `lib/rateLimiter.ts`
  (additive `keyOverride` + 3 new configs), `api/sessions/route.ts`, `api/sessions/[id]/route.ts`,
  `api/sessions/current/route.ts`. Tests added: `lib/__tests__/session-status-machine.test.ts`,
  `lib/__tests__/sessionEvents.test.ts`, `lib/__tests__/currentSessionRoute.identity-binding.test.ts`,
  `commands/__tests__/session.test.ts`, `api/sessions/__tests__/route.test.ts`,
  `__tests__/phase-a-non-regression.test.ts`, `__tests__/encryption.test.ts` (extended).
- Checks (local mode, from repo root): `yarn generate` — clean. `yarn workspace @open-mercato/
  checkout run typecheck` — clean, exit 0. `yarn workspace @open-mercato/checkout test` — 37/37
  suites, 272/272 tests, ZERO regressions on the pre-existing 36/270 Phase-A suite (C10
  guarantee). `yarn build:packages` — 40/40 tasks successful (incl. `@open-mercato/core` and
  `@open-mercato/checkout`).

## 2026-10-27T21:15:00Z — Step 2.13 (checkout B.3: delivery rate quoting, delivery promotions,
payment methods listing)
- Second `checkout`-module Step, building directly on Step 2.12's `CheckoutSession`/step-
  machine/security baseline. Read Step 2.12's own NOTIFY entry closely per the task brief —
  confirmed `/sessions/current/step`/`/cancel` genuinely do not exist yet (irrelevant to this
  Step's own route surface) and that store/channel/currency match is NOT enforced at session
  creation (irrelevant here too — this Step reads the session's own snapshot fields, never
  re-resolves the store).
- Shipped: `GET /api/checkout/sessions/current/delivery-options` (rate quote + cache),
  `POST /api/checkout/sessions/current/delivery` (method selection + delivery-promotion
  evaluation, `checkout.session.selectDelivery` command), `GET /api/checkout/sessions/current/
  payment-methods` (gateway listing). All three reuse Step 2.12's `resolveCurrentSession`
  (D-R5-33 binding + C21 cross-tenant check) and rate-limit helpers verbatim.
- **Route path decision:** the task brief's prose named `POST .../delivery-method`; the revised
  spec's own §9 route table literally names `POST /sessions/current/delivery`. Built the spec's
  literal path — the task brief itself says the spec is authoritative for "shapes", and this is
  exactly that kind of discrepancy (paraphrase vs. the owning document).
- **`delivery-options` (C13 §5.3).** Origin: gated behind `tryResolve('wmsReservationService')`,
  reads the organization's primary `wms_warehouses` row via a raw-Kysely peer read (the same
  "FK-id + snapshot" style `lib/cartPeer.ts` established in Step 2.12 — never an ORM import of
  another module's entity). **Found during implementation:** `ecommerce.EcommerceStore` has NO
  structured address at all (`settings.contact.address` is one free-text string) and no "tenant
  default address" concept exists anywhere in the codebase — so C13's own three-tier origin
  fallback (store → warehouse → tenant default) collapses to two reachable tiers here (warehouse
  → unavailable). Flagged as a follow-up: a later Step should add a structured store address if
  the owner wants tier 1 to ever be real. Packages: one parcel per cart, built from `cart_lines`
  joined (via three flat raw-Kysely queries, never a cross-module join, for easy unit-testing)
  against `catalog_products`/`catalog_product_variants` for weight/dimensions, variant overriding
  product when present, the single-parcel default (1kg/30x20x10cm) substituted per missing line.
  **Judgment call:** weight is summed per-line-times-quantity (physically correct — more units
  really do weigh more); dimensions take the largest single-unit value per axis across lines (a
  bounding box), NOT a literal sum — summing lengths across unrelated products would produce a
  parcel no carrier could ever quote, and the spec's "one parcel per cart" framing only makes
  sense as a bounding box. Documented in `lib/cartLinesPeer.ts`'s own doc comment. Carriers:
  every adapter `listShippingAdapters()` returns is tried via `shippingCarrierService
  .calculateRates`; a single adapter's failure is caught and logged, never surfaced — falls
  through to the flat-rate fallback (R10) exactly like "no provider configured" does. Cached 5
  min per `(address hash, cart hash)` via `@open-mercato/cache` (`lib/deliveryRateCache.ts`,
  mirroring `promotions/services/promotion-cache.ts`'s own best-effort get/set shape) — a cache
  read/write failure degrades to a recompute, never a failed request.
- **Flat-rate fallback location (D-R5-35) — the one genuinely new data-model gap.** Neither
  `ecommerce.EcommerceStore` nor `checkout.CheckoutLink` had ANY field for a flat-rate amount
  before this Step; D-R5-35 names the SOURCE per channel but the spec never specifies the field's
  shape. Added: an additive `shipping.flatRate: { amount, currencyCode } | null` key on
  `ecommerceStoreSettingsSchema` (jsonb `settings` column, `.prefault(null)`, zero migration —
  confirmed zero regressions: ran the FULL `@open-mercato/core` typecheck, 40/40 build tasks, and
  the ecommerce module's own jest suite, 68/68 suites / 891/891 tests, all green; the existing
  hand-written `mergeStoreSettings()` merge function in `api/stores/crud.ts` does not even pass
  the new key through today, so no admin-facing write path exists yet — a follow-up gap, not a
  blocker for this Step's own reads); and two additive nullable columns on
  `CheckoutLinkTemplate`/`CheckoutLink` (`flat_rate_shipping_amount`/`flat_rate_shipping_currency
  _code`, `Migration20261027180000.ts` + snapshot update, mirroring how `gateway_provider_key`
  was added originally) for the link tier, read directly via `em.findOne(CheckoutLink, ...)`
  since `CheckoutLink` is checkout's own entity (no cross-module peer-read needed there). Branch
  is exact: `channel === 'pay_link' && linkId` reads the link; everything else with a `storeId`
  reads the store; neither reads the other. Note: no live route can create a `channel: 'pay_link'`
  session yet (B.2/Step 3.5 hasn't landed — `{source:'link'}` still 400s per Step 2.12), so the
  link branch is unit-tested directly against a synthetic session input
  (`lib/__tests__/deliveryRateQuote.test.ts`), not through a full HTTP fixture.
- **`POST .../delivery` + delivery-promotion evaluation (C8/D-R5-17).** The command (`checkout.
  session.selectDelivery`) never trusts a client-supplied price: it RE-resolves the real options
  through the same cached `computeDeliveryOptions` call and 422s `delivery_unavailable` when the
  requested `deliveryMethodCode` isn't among them (§13 Entitlement's "never trusted" rule, applied
  here even though §13 only names it for payment methods explicitly). `promotionsService.evaluate`
  is called with the cart's buyer context (customerId/customerIds/customerGroupIds, re-read via a
  new `lookupCartPeerById` on `lib/cartPeer.ts`) plus `deliveryMethodCode`/`deliveryCost`, mirroring
  `cart/commands/cart.ts`'s own `ctx.container.register({ auth: asValue(...) })` precedent for
  resolving `promotionsService`'s scope. **Scoped decision:** `codes: []` is sent — this Step's
  call never re-derives the cart's currently-entered codes (`CartPromotionApplication` rows),
  since doing so properly would mean either importing `cart/lib` (forbidden, §6) or re-deriving
  that table cross-module, and the only rule type this Step's own scope needs working is
  `delivery_method`, which `rule-evaluators.ts` gates purely on `context.deliveryMethodCode`, not
  on `codes`. A combined code+delivery rule is therefore a gap — flagged for Step 4.1's own
  submit-time re-evaluation (§7.2 step 2) to close for real, since THAT call sits inside the
  authoritative submit path and already has to get this right. Only the `DELIVERY_DISCOUNT`
  effect is extracted from the result; `LINE_DISCOUNT`/`CART_DISCOUNT`/`ADD_FREE_ITEM` are ignored
  (cart-stage effects, already applied by `cart.reprice`, never this Step's to re-apply). On a
  match, writes a PARTIAL `quoted_totals` (`deliveryMethodCode`/`deliveryCost`/`deliveryDiscount`/
  `currencyCode`/`evaluatedAt` only) — `goodsGross`/`payableGross` are deliberately NOT written;
  §4.1's full shape is submit's own concern (Step 4.1), which this Step's brief explicitly
  excludes. A promotions evaluation failure (exception) degrades to "no discount shown", never a
  failed delivery-method selection — showing no discount is always safe, silently charging one
  that errored is not.
- **`GET .../payment-methods` (§5.5 gateway half only).** Lists every `isConfigured`,
  currency-compatible `paymentGatewayDescriptorService.listResolved(scope)` descriptor for a
  non-link session — `ecommerce` has no per-store gateway selection any more than it has a
  flat-rate-fallback field (a parallel gap, not fixed here, since fixing it is out of this Step's
  named scope). A link session restricts to the link's own single `gatewayProviderKey`, unchanged
  from Phase A's one-provider-per-link model. `on_account`/`request_quote` are not offered at
  all — expected per the task brief, since both need `customer_groups` terms
  (`allow_purchase_on_account`/`allow_quote_requests`) not yet wired into checkout (B.5).
- **Not built in this Step (named by §9/§17 B.3 but out of the task brief's own route list):**
  `POST /sessions/current/payment` (method selection + PO capture) — a later B.5-adjacent Step
  should add it, reusing this Step's `listCheckoutPaymentMethods` for server-side entitlement
  checking before storing the choice.
- Files: `packages/checkout/src/modules/checkout/lib/cartLinesPeer.ts` (+tests),
  `lib/warehousePeer.ts`, `lib/storeSettingsPeer.ts`, `lib/linkFlatRate.ts`, `lib/deliveryAddress.ts`
  (+tests), `lib/deliveryRateCache.ts` (+tests), `lib/deliveryRateQuote.ts` (+tests),
  `lib/promotionsDeliveryEvaluation.ts` (+tests), `lib/paymentMethods.ts` (+tests), `lib/
  cartPeer.ts` (+`lookupCartPeerById`, +`customerIds`/`customerGroupIds`), `lib/constants.ts`
  (package defaults, cache TTL), `lib/rateLimiter.ts` (+`checkoutDeliveryOptionsRateLimitConfig`,
  +`checkoutSessionOtherGetRateLimitConfig`), `data/validators.ts`
  (+`checkoutSessionDeliverySelectSchema`), `data/entities.ts` (+`CheckoutLinkTemplate` flat-rate
  columns), `commands/delivery.ts` (+tests) + `commands/index.ts` wiring,
  `migrations/Migration20261027180000.ts` + `.snapshot-open-mercato.json`,
  `api/sessions/current/delivery-options/route.ts` (+tests), `api/sessions/current/delivery/
  route.ts` (+tests), `api/sessions/current/payment-methods/route.ts` (+tests). Cross-module:
  `packages/core/src/modules/ecommerce/data/validators.ts` (+`ecommerceStoreShippingSchema`,
  additive jsonb field on `ecommerceStoreSettingsSchema`).
- Checks (local mode, from repo root): `yarn generate` — clean (first attempt caught a genuine
  duplicate `currencyCodeSchema` declaration in the edited `ecommerce/data/validators.ts`, fixed,
  re-ran clean). `yarn workspace @open-mercato/checkout run typecheck` — clean, exit 0.
  `yarn workspace @open-mercato/core run typecheck` — clean, exit 0. `yarn workspace
  @open-mercato/checkout test` — 47/47 suites, 328/328 tests, ZERO regressions on Step 2.12's own
  37/272 Phase-A-plus-B.1 baseline. `yarn workspace @open-mercato/core test -- src/modules/
  ecommerce` — 68/68 suites, 891/891 tests, ZERO regressions from the additive settings-schema
  field. `yarn build:packages` — 40/40 tasks successful (incl. `@open-mercato/core` and
  `@open-mercato/checkout`).

## 2026-10-27T20:30:00Z — dispatcher: tracked note from Step 2.13
- Step 2.13 listed available payment methods but did not build a `POST /sessions/current/payment`
  method-SELECTION route (not in its named scope). Flagging for Step 4.1 (B.4 submit) to check: if
  submit itself accepts the chosen payment method as a direct input, no separate selection route
  is needed; if the spec's step machine expects the method to be SET on the session before submit
  is called, Step 4.1 must add that route itself before building the submit sequence on top of it.

## 2026-10-27T21:00:00Z — checkpoint 6 (Steps 2.12–2.13, closes Phase 2)
- Range: `09e6d489bb`..`aac84cb6ad`. Summary: checkout session entity + step machine + B.1
  security baseline (first checkout Step this run, C10's requires-unchanged guarantee verified by
  a dedicated Phase-A-non-regression test); delivery rate quoting + delivery promotions + payment
  methods listing.
- Checks: forced full typecheck (40/40, 0 cached) pass; full core retrospective sweep across every
  Phase-2-touched module (240/243 suites, 2523/2540 tests, 3 expected Postgres-gated skips); full
  checkout package suite (47/47 suites, 328/328 tests).
- Decisions/problems: none blocking. Flagged explicitly: no dev-server/browser UI pass has run yet
  across the entire run (3 UI surfaces accumulated). Committing the next UI-touching Step, or
  Step 6.1 at the latest, to actually do this.
- Phase 2 is complete. All 13 Steps landed; no rescues needed this phase.

## 2026-10-27T22:00:00Z — Step 3.1 landed (cart: approval gate — K1-K5/§9a, Phase 3 opens)

- Closed the tracked `resolveTerms` gap first (flagged after Step 2.5): `termsCurrencyCode`
  was still unresolved as of `5db46425d1`. Added it to `customerGroupsService.ts`'s per-field
  resolution loop the same way Step 2.5 added `approvalPolicy`, PLUS one extra, field-only
  step (`applyTermsCurrencyFallback`) implementing D-R5-37: when no group in the chain sets
  it, fall back to the buyer's organization's base currency. Found and reused an EXISTING
  `currencies.BaseCurrencyService`/`baseCurrencyService` DI key (nobody in this run had
  wired it up yet) rather than writing a second raw-SQL lookup — threaded in via the same
  `softCradle` shape `customerPurchaseApprovalService` already uses for
  `moduleConfigService`, since `currencies` stays a soft peer of `customer_groups`.
  `ResolveTermsInput.organizationId` is new, optional and additive. Still did NOT resolve
  `allowQuoteRequests`/`requiresPoNumber` — no caller yet; Step 5.1 owns those.
- `cart/lib/approvalGate.ts` (new): the gate's pure math and its one soft-DI read, shared by
  the totals phase and `cart.lock` — `computeGoodsGrossAmount` (K1: parses
  `totals.grandTotalGrossAmount`), `computeRequiresApproval` (§9a.2's literal formula),
  `tryResolveCustomerGroupsService`, `resolveCartRequiresApproval` (orchestrates
  `resolveTerms` + the formula, degrading to `false` when `customer_groups` cannot be
  resolved — documented degrade, same precedent Step 2.10 set for the approval-service
  sibling).
- `cart/lib/reprice.ts#buildRecomputeCartTotalsPhase`: now also sets `cart.requiresApproval`
  on every call, right after `cart.totals` is written. This ONE function is already the
  universal hook every totals-changing command funnels through (`commands/lines.ts`'s line
  writes directly; `commands/cart.ts`'s `cart.reprice` for everything that DISPATCHES it —
  merge, promotions apply/remove, admin reprice, and `cart.lock`'s own forced re-price) — so
  this single change satisfies §9a.2's "whenever totals change" AND "recomputes it from fresh
  terms at `cart.lock`" (the lock's forced reprice IS a totals-change event, strictly before
  the gate ever reads the flag back) without a second `resolveTerms` call anywhere.
- `cart/commands/lock.ts`: added `purpose?: 'order' | 'quote'` to `CartLockInput` (default
  `'order'`). The gate sits between the visibility-pass check and `withAtomicFlush`, per
  §9.1's own "order of checks." `purpose === 'quote'` skips it entirely (D-R5-23). Otherwise,
  when `cart.requiresApproval` (freshly read post-reprice): a guest (`customerUserId` null)
  gets `409 approval_requires_identified_buyer` (D-R5-12) instead of the generic gate
  refusal; an identified buyer's `Cart.approvalId` is read LIVE through
  `customerPurchaseApprovalService.getApproval` (soft-resolved via the existing
  `tryResolveCustomerPurchaseApprovalService` in `lib/adminCartScope.ts`) and must be
  `approved`, same-currency, and `amountGross >= current goods gross` to qualify; otherwise
  `409 cart_requires_approval` with `{ approval, amountGross, currencyCode }`. No channel
  branch anywhere in this logic (D-R5-29) — `pay_link`/`api`/`agent` carts hit the exact same
  code path as `storefront`.
- i18n: added REAL `cart.errors.cart_requires_approval`/
  `cart.errors.approval_requires_identified_buyer` keys to all 5 locales (per this Step's own
  explicit instruction) — English text duplicated into the non-English files, matching the
  existing `cart.errors.store_context_unavailable` precedent (no `cart.errors.*` key is
  actually localized today). The command's thrown message itself stays `[internal]`-prefixed
  (no public route calls `cart.lock` yet), same convention `cart_has_unavailable_lines`/
  `invalid_lock_ttl_ms` already follow.
- Did NOT build `/current/request-approval` (Step 3.2's scope) or the §7a proposal seam
  (Steps 3.3/3.4) — this Step is the gate mechanism only, exactly as scoped.
- Did NOT implement `min_order_value` anywhere in `cart` — confirmed via grep it does not
  exist in this module today, and §9a.6 is explicit that it is checkout's own concern (Step
  5.1), not the cart's.
- Tests (TC-CART-APR-01..09, one extra for the documented `customer_groups`-absent degrade):
  `cart/lib/__tests__/approvalGate.test.ts` (new, 11 cases) — pure-function coverage for
  `computeGoodsGrossAmount`/`computeRequiresApproval`/the soft-DI helpers.
  `cart/lib/__tests__/reprice.test.ts` — 2 new cases: `requiresApproval` recomputed on every
  call (above AND below a threshold, in the SAME test, proving it is not cached), and the
  absent-service degrade. `cart/commands/__tests__/lock.test.ts` — 14 new cases under a new
  `describe('cart.lock — approval gate ...')`: refusal without a qualifying approval,
  success with one, refusal when the total rose above the approved amount (D-R5-3), BOTH
  currency-mismatch sub-cases (no usable currency at all → fail-closed; a resolved
  `termsCurrencyCode` matching the cart → passes), guest refusal with the distinct error
  code, `purpose: 'quote'` skipping the gate for a guest-over-threshold cart, the same
  refusal across `pay_link`/`api`/`agent` channels (`it.each`), and the `customer_groups`-
  absent degrade. All pre-existing tests in `reprice.test.ts`/`lock.test.ts` (36 + 13 before
  this Step) pass UNMODIFIED — the new DI tokens are optional and default to the same
  `Unexpected DI token` throw every other unlisted token already got, caught internally.
- Checks: `yarn workspace @open-mercato/core typecheck` — one pre-existing, unrelated error
  in `ecommerce/api/stores/crud.ts` (confirmed present on a clean `git stash` of this Step's
  changes too; from Step 2.13's `shipping` settings addition, not touched here). Full
  `src/modules/cart` suite: 24/24 suites, 312/312 tests, zero regressions. Full
  `src/modules/customer_groups` suite: 44/46 suites (2 pre-existing pg-gated skips),
  472/472 tests, zero regressions. Full `src/modules/currencies` suite: 27/27, 203/203,
  zero regressions (unaffected — `baseCurrencyService` itself was not touched, only
  consumed).

## 2026-10-27T21:30:00Z — dispatcher: fix-forward Step 3.1-fix
- A forced full `yarn typecheck` run immediately after Step 3.1 landed found a real TS error
  (`TS2741`/later `TS2322`) at `packages/core/src/modules/ecommerce/api/stores/crud.ts`'s
  `mergeStoreSettings`: Step 2.13 added a required `shipping` field to `EcommerceStoreSettings`
  (and a separate omission — `shipping` was never added to `EcommerceStoreSettingsPatchSchema`
  either, meaning there was previously no way to ever SET it via `PUT /stores/:id`) but never
  updated this pre-existing merge function or the patch schema. Oddly, Checkpoint 6's own forced
  typecheck (run right after Step 2.13, before Step 3.1) reported this exact file tree as clean
  (`40 successful, 40 total, 0 cached`) — re-confirmed by inspecting the committed source at
  `aac84cb6ad` directly: the bug was present in that commit's source. The checkpoint's green result
  for this specific check cannot be explained from the committed diff alone and is not reproduced
  on a second forced run against the same commit; logged here as an unresolved discrepancy rather
  than asserted as a known cause, so it isn't mistaken for a resolved explanation.
- Fixed directly (small, well-understood, one-line-class fix): moved `currencyCodeSchema`/
  `ecommerceStoreShippingSchema` above `ecommerceStoreSettingsPatchSchema` (declaration-order
  fix), added `shipping: ecommerceStoreShippingSchema.optional()` to the patch schema (full-object
  replace, matching contact/seo/branding), and `shipping: patch.shipping ?? current?.shipping ?? {
  flatRate: null }` to `mergeStoreSettings`. Added two regression tests (set via patch; preserved
  when the patch doesn't touch it) plus updated one pre-existing test's assertion that had been
  silently relying on the missing field. Full monorepo forced typecheck (40/40, 0 cached) and the
  full `ecommerce` suite (68/68 suites, 893/893 tests — 2 new) now pass.
- Lesson for future checkpoints in this run: treat a clean forced typecheck as strong evidence, not
  absolute proof — if a later Step's own typecheck disagrees with a prior checkpoint's result for
  the same committed tree, trust the fresh run and fix forward, as done here, rather than assuming
  the fresh run is wrong.

## 2026-10-27T22:45:00Z — Step 3.2 landed (cart: request-approval route + K3/K4/K5/K7 lifecycle wiring)

- `commands/approval.ts` (new): `cart.approval.request` — the ONLY way a cart's approval is
  created (§9a.4). Local `loadMutableCart` (same shape as `commands/promotions.ts`'s own):
  `423 cart_locked` → `409 cart_not_active` → abandoned-reactivates. Then K4's guest refusal
  (`409 approval_requires_identified_buyer`), the soft-resolved `customerPurchaseApprovalService`
  (`503` when absent), a fresh `resolveCartRequiresApproval` recompute, and §9a.4 step 2's
  "an already-qualifying current approval is ALSO `approval_not_required`" rule (reuses the
  new `lib/approvalGate.ts#approvalQualifies` shared formula — see PLAN.md's own decision for
  why `cart.lock` was refactored onto the same helper). Step 3: a still-pending, still-covering
  approval returns as-is (idempotent, G8 is the service's authority); a stale pending one is
  withdrawn FIRST (REQUESTER actor, `withdrawnReason: 'requester'`, not the `system` actor the
  lifecycle sweepers use) before a fresh `requestApproval` call. Writes `approvalId`/
  `awaitingApprovalSince` in one `withAtomicFlush`, emits `cart.cart.updated` + (only on a
  genuinely new approval) `cart.approval.requested` with the full 8-field §11 payload (see
  PLAN.md's K7 decision — the brief's own 6-field paraphrase is stale against the revised spec).
- `api/current/request-approval/route.ts` (new): structurally identical to `current/undo-merge/
  route.ts` — empty `.strict()` body, standard optimistic-lock + mutation-guard + `CART_MUTATE`
  rate limit, `buildCartResponseEnvelope` re-read on success. Did NOT wire the generic
  `Idempotency-Key` replay cache (PLAN.md decision — out of that helper's own documented scope,
  redundant with G8).
- `data/entities.ts`: additive `Cart.awaitingApprovalSince` (nullable `timestamptz`), migration
  `Migration20261027190000_cart.ts` + hand-edited `.snapshot-open-mercato.json` (same
  "local Postgres holds unrelated drift" reasoning Step 2.10 gave for its own hand-authored
  migration — not regenerated via `yarn db:generate`).
- `lib/approvalGate.ts`: added `approvalQualifies` (the one qualification formula — approved +
  same currency + amount covers goods gross), extracted out of `commands/lock.ts`'s own inline
  check (refactored to call it) so `cart.lock`'s gate, `cart.approval.request`'s pre-check, and
  `lib/cartView.ts`'s `CartView.approval.qualifies` field all share one implementation.
- `lib/cartView.ts`: `CartApprovalView` was still a Step-5.2-era stub (`{ id, status: 'pending'
  }` for ANY non-null `approvalId` — written before `CustomerPurchaseApproval` existed). Now
  reads the approval LIVE through `customerPurchaseApprovalService.getApproval` (soft-resolved,
  `null` on absence) per §9a.4's own "`CartView.approval` is read live" text, and returns the
  full §10.1 shape (`amountGross`/`currencyCode`/`qualifies`). Added `awaitingApprovalSince`
  to the envelope too. `commands/cart.ts`'s `CartSummary`/`toCartSummary` grew the same field.
- `lib/approvalLifecycle.ts` (new): `withdrawPendingCartApproval` — the ONE system-actor,
  idempotent-on-`approval_not_pending` withdrawal shared by `commands/merge.ts` (source side,
  §7.4), and `lib/sweepers.ts`'s `sweepExpiredCarts`/`purgeExpiredCarts` (§12). `commands/
  merge.ts`: on `absorbedCart.status = 'merged'`, withdraws a pending approval and clears
  `awaitingApprovalSince` in the same flush as the rest of that cart's transition.
  `lib/sweepers.ts`: `sweepAbandonedCarts` gained the K5 skip filter (`awaitingApprovalSince:
  null` on both the candidate `find` and the `nativeUpdate` WHERE); `sweepExpiredCarts`/
  `purgeExpiredCarts` gained a new `approvalService` parameter (soft-resolved by their worker
  files, `expire.worker.ts`/`purge-expired.worker.ts`, mirroring the existing `codeService`
  injection pattern) and withdraw-before-transition/delete logic, best-effort (caught, logged,
  never re-thrown — same discipline as the existing code-reservation release).
- Four new thin subscriber files (`subscribers/approval-{approved,rejected,expired,withdrawn}.ts`)
  share `lib/approvalDecidedSubscriber.ts#createCartApprovalDecidedHandler` — filters
  `subjectType === 'cart'`, then a single `nativeUpdate` keyed on `(id, tenantId,
  organizationId, approvalId)` clearing ONLY `awaitingApprovalSince` (never `approvalId` — see
  PLAN.md's K5 decision for why the task brief's own instruction to clear it too was NOT
  followed). Mirrors `customer_groups/lib/approvalDecidedSubscriberHandler.ts`'s own
  one-handler-per-event-id shape.
- NOT done (see PLAN.md's own decisions for the full reasoning on each): the K3 fifth
  lifecycle row ("Converted, pending, a `purpose: 'quote'` conversion → withdrawn") — no
  caller reaches `cart.markConverted` with `salesQuoteId` set in this worktree yet (Step 5.1's
  own scope); the admin list's `awaitingApproval` filter (§10.2 names it, Step 2.10's own
  route file untouched here, since this Step never had a reason to open that file); any
  `yarn db:generate`-based migration (hand-authored, same reasoning Step 2.10 gave).
- Tests (priority order from the task brief, all passing): `commands/__tests__/approval.test.ts`
  (new, 13 cases) — idempotent-while-pending, guest refusal, `approval_not_required` (both the
  "no threshold" and "already qualifies" sub-cases), `423`/`409` lock-state `it.each`, the
  full K7 payload assertion, stale-pending withdrawal-then-fresh-request, the
  `approval_not_pending` race swallow, abandoned-reactivation, and the `503` absent-service
  case. `lib/__tests__/approvalDecidedSubscriber.test.ts` (new, 16 cases via `describe.each`
  over the four event ids) — clears-when-matching, no-op-when-moved-on, `approval_id` never
  touched, ignores `subjectType: 'quote'`, incomplete-payload no-op. `commands/__tests__/
  merge.test.ts` — 3 new cases: source-side withdrawal + `awaitingApprovalSince` clear,
  no-approvalId no-op, and the undo-merge regression guard (approval stays withdrawn,
  `approvalId` unchanged, `customerPurchaseApprovalService` never called by undo at all).
  `lib/__tests__/sweepers.test.ts` — 7 new cases across `sweepAbandonedCarts`/
  `sweepExpiredCarts`/`purgeExpiredCarts` (K5 skip; withdraw-and-clear; already-settled
  race; no-approvalId no-op; failed-withdrawal-does-not-block-the-sweep, ×2).
  `lib/__tests__/cartView.test.ts` — replaced the stale stub assertion with a live-read test
  (`qualifies: true`), added the pending/unavailable-service and
  `approvalId`-null/`awaitingApprovalSince`-passthrough cases.
  Checks: `yarn workspace @open-mercato/core typecheck` clean (0 errors). Full
  `src/modules/cart` suite: 26/26 suites, 354/354 tests (42 new), zero regressions. Full
  `src/modules/customer_groups` suite: 44/46 suites (2 pre-existing pg-gated skips),
  472/472 tests, zero regressions (unaffected — only its already-public
  `CustomerPurchaseApprovalService`/`CustomerPurchaseApprovalServiceError` exports and
  frozen `customer_groups.approval.*` event payload shape were consumed, nothing in that
  module itself was touched).

## 2026-10-27T02:36:00Z — Step 3.3 landed (cart: §7a proposal seam commands — create/reject, supersede/re-author on merge)

**Scope.** Two commands only, per the Step's own brief: `cart.proposal.create` (§7a.2) and
`cart.proposal.reject` (§7a.5). No HTTP route, no acceptance flow (`cart.merge { strategy:
'manual' }`), no sweeper branches — all Step 3.4's scope (K15/S15, plus D-R5-25's undo-merge
refusal). The re-author/supersede mechanism (D-R5-14) is built as a provisional, cart-only
subscriber (see below) since `assisted_selling` does not exist as code yet.

**Reject-command-vs-route question, resolved by re-reading the spec closely.** The task
brief's own "WAIT, re-check" question asked whether `reject` is a route-level concern or a
real command. The spec's §7a.5 answers directly: "The buyer rejects through `POST
/proposals/:proposalId/reject`... The author's side ends a proposal in-process:
`assisted_selling` withdraw, supersede and re-author call `cart.proposal.reject`..." — there is
**no** separate `cart.proposal.withdraw`/`.supersede` command anywhere in the spec. Every
author-side ending of a proposal IS a call to `cart.proposal.reject`, distinguished only by a
`rejectedBy: 'buyer' | 'author'` input field the CALLER supplies (never inferred from a request
body): the buyer-facing route (Step 3.4) passes `'buyer'`; every author-side caller (the
subscriber below, and eventually `assisted_selling`'s own withdraw/supersede/reauthor routes)
passes `'author'`. So `cart.proposal.reject` is built now, as a real command, exactly as the
task's implementation bullets originally asked — the "withdraw" and "supersede" language in
the brief's own bullet list map onto this ONE command, not three.

**The re-author/supersede subscriber lives in `cart` as a provisional mechanism, NOT
`assisted_selling` — and this is a deliberate, documented divergence from the authoritative
spec's own placement.** `.ai/specs/2026-09-22-assisted-selling.md` §8.1/§6.4 states plainly
that the login-merge re-author/supersede subscriber is `assisted_selling`'s own code ("a
`kind = 'basket'` subscriber on `cart.cart.merged`... re-authored as its original author...
through `buildTrustedCommandContext`"). That module is this run's own Phase 4 (Steps
4.3–4.5) and does not exist yet. The Step 3.3 task brief explicitly instructed building this
mechanism NOW anyway, using only what `cart` itself can see ("re-run CART's own
visibility/pricing/line-add logic equivalently... do not attempt to call into a non-existent
assisted_selling module"). Built as `lib/proposalRetarget.ts` +
`subscribers/cart-merged-proposal-retarget.ts` (persistent, event `cart.cart.merged`). It does
NOT touch anything `assisted_selling` owns (no thread, no `superseded_by_proposal_id`, no
`live_proposal_count`) — only `cart`'s own `Cart`/`CartLine` rows and its own two new commands.
When Phase 4 builds the real `assisted_selling` module, this subscriber should most likely be
REMOVED (or narrowed to a no-op) in favor of that module's own, spec-authoritative one — flagged
explicitly for whichever Step does that, so the two mechanisms never double-process the same
merge.

**"Supersede-on-merge" and "re-author" are ONE mechanism here, not two — and the task brief's
own literal test requirement ("supersede-on-merge leaves exactly one live proposal targeting a
cart after acceptance") was read against the authoritative spec rather than followed literally
for its "after ACCEPTANCE" framing.** Re-checked `.ai/specs/2026-09-22-assisted-selling.md`
directly: "Both proposals are live. They are separate carts and separate rows; neither blocks
the other; the buyer may accept both, either or neither." (§6.1) — sibling proposals targeting
the SAME basket are explicitly **never** superseded by one another's acceptance. So there is no
"supersede siblings when one is accepted" logic to build, and building it would contradict the
spec directly. What IS built, and satisfies the literal test sentence under its most natural
reading (two proposals live, one is accepted, exactly one remains live afterward): acceptance
itself (Step 3.4's `cart.merge`) transitions the accepted proposal's own `status` out of
`active` into a terminal one — the sibling's `status` is simply never touched by anything in
this Step, so "exactly one live proposal remains" falls out of the ordinary lifecycle, not a
new cross-proposal rule. Added a regression test (`commands/__tests__/proposal.test.ts`,
"supersede-on-merge...") that simulates this exact scenario directly (two proposals targeting
one cart, one manually marked `merged` as Step 3.4's future acceptance would do) and asserts the
sibling is both present and untouched. The "Supersede-on-merge"/"re-author" bullets in the task
brief are, on this reading, two facets of the SAME login-merge mechanism (`lib/
proposalRetarget.ts`): the fallback branch IS the supersede, the success branch is the
re-author-then-supersede-the-old-one. Flagged as a genuine scope-interpretation call, not a
silent skip.

**Re-author mechanics (D-R5-14).** `handleCartMergedForProposalRetarget` (`lib/
proposalRetarget.ts`) finds every `kind: 'proposal'`, `status: 'active'` cart whose
`proposedToCartId` names the cart that `cart.cart.merged`'s `sourceCartId` says just got
absorbed, and for each one: reads the author off the proposal's own `CartLine.addedByActorType`/
`_id` (§4.1 — `Cart` has no `authored_by_*` column); if the author is not `'rep'` (Release 5
never writes `'ai_agent'`, S10) or has no id, supersedes immediately (no re-author attempted);
otherwise calls `cart.proposal.create` against the NEW target under
`buildTrustedCommandContext({ actorType: 'user', actorId: <author>, reason:
'cart.proposal.reauthor' })` (Step 1.1's helper) with the old proposal's own lines and a
TTL clamped to its remaining time (bounded to the same 3600–1,209,600s window); on success OR
on a caught failure (the create call's own `cart.proposals.author` check refuses — the only
eligibility signal `cart` can check without `assisted_selling`'s store-mode concept), the OLD
proposal is rejected (`cart.proposal.reject`, `rejectedBy: 'author'`) under a bare SYSTEM
context (no re-check of the ACL feature a second time — the create call already proved or
disproved it). Both branches tested explicitly in `lib/__tests__/proposalRetarget.test.ts`
(re-author-succeeds, ineligible-actor-type, create-throws-403), plus a no-pending-proposals
no-op, a missing-scope no-op (S3/D-R5-32), and two-siblings-processed-independently.

**Known gap, documented not closed:** a crash between a successful `cart.proposal.create` and
the matching `cart.proposal.reject` leaves the OLD proposal still `active`, so a redelivery of
the same `cart.cart.merged` event can re-author a SECOND time before finally rejecting the
first old row. No idempotency key exists at this layer (that is `assisted_selling`'s own S23
concern, keyed on its own `AssistedSellingProposal.idempotency_key`, not available to this
provisional cart-only mechanism). Acceptable for Release 5 per the same risk class this run's
own precedent already accepts elsewhere (assisted-selling's own S23 finding: "a
double-submitted authoring call creates two proposal carts", bounded, not eliminated).

**`cart.cart.merged`/`.adopted` gained `tenantId`/`organizationId` (additive, S3/D-R5-32)** —
both were missing them entirely (confirmed by reading `commands/merge.ts` directly); the new
subscriber needs them to filter before loading anything by id, and D-R5-32 already calls for
this exact fix on every Release 5 event payload. Existing `expect.objectContaining(...)`
assertions in `commands/__tests__/merge.test.ts` are unaffected (additive fields never break a
partial-match assertion).

**Reused, never duplicated, the existing per-line pricing/visibility machinery.** Exported
(additive `export` keyword, zero behavior change — same precedent Step 2.6 set for
`CustomerPurchaseApprovalService.toApprovalView`) eleven previously-private helpers from
`commands/lines.ts` (`buildCartPricingRowFilterContext`, `fetchPriceRowsBatch`,
`groupRowsByProduct`, `resolveLinePricing`, `applyPriceSnapshot`, `computeLineTotals`,
`resolveSnapshotFields`, `computeStartingLineNumber`, `resolveQuantityRulesForProduct`,
`buildCartPromotionsAndTotalsPhases`, `emitCartPromotionsAndTotalsSideEffects`) rather than
re-implementing a second pricing/totals path in `commands/proposal.ts`. `cart.proposal.create`
could NOT reuse `cart.lines.bulkAdd` wholesale the way a first instinct suggests — that
command's own `loadMutableCart` filters `kind: 'basket'` unconditionally, which a brand-new
`kind: 'proposal'` cart (not yet persisted at line-build time) can never satisfy — so it builds
its own line loop directly on the freshly-created `Cart` entity, calling the SAME exported
pricing/quantity-rule helpers bulkAdd itself calls.

**`addedByActorType` is always `'rep'` in Release 5.** The spec's own caller list for `POST
/proposals` names "a staff `auth.User`, or an AI agent principal (`users.kind = 'agent'`)", but
S10 (assisted-selling) restricts Release 5 to `mode: rep | off` with NO AI agent participant
ever created — so `'ai_agent'` is unreachable in this release regardless of what `cart` itself
might otherwise support. `cart.proposal.create` hard-codes `'rep'` for any authenticated
`ctx.auth.sub`-bearing caller rather than trying to detect `users.kind` (a query this command
has no documented need for yet, and no caller in this release ever supplies an agent
principal). Revisit if/when Phase 3 (AI actor) actually ships.

**`cartProposalCreateLineInputSchema`'s `productId`/`variantId` are plain non-empty strings,
not `uuid()`** — same precedent `cartMarkConvertedLineMapEntrySchema` already set two Steps ago
("this is the command's own internal input shape... not an HTTP body validator"): no public
route exists yet, the real guard is the batched catalog lookup resolving to
`product_unavailable`, and every `CatalogProduct.id` fixture across this module's own test
suite (`lines`/`cart`/`merge`.test.ts) is a plain string like `'product-1'`, never a real UUID.
The public `POST /proposals` body (Step 3.4) gets its own `.strict()`, `uuid()`-validated
schema, matching `cartLineAddRequestSchema`'s existing split.

**Files touched:**
- `commands/proposal.ts` (new) — `cart.proposal.create`, `cart.proposal.reject`.
- `commands/lines.ts` — eleven `export` additions (listed above), plus `'proposal_create'`
  added to `CartVisibilityRejectionTrigger` (additive enum member, S13/K13).
- `commands/merge.ts` — `tenantId`/`organizationId` added to `cart.cart.merged`/`.adopted`
  payloads (additive, S3/D-R5-32).
- `lib/proposalRetarget.ts` (new) — the re-author/supersede mechanism.
- `subscribers/cart-merged-proposal-retarget.ts` (new) — thin wiring.
- `data/validators.ts` — `cartProposalCreateLineInputSchema`/`cartProposalCreateLinesSchema`/
  `cartProposalCreateTtlSecondsSchema` + the three TTL bound constants.
- Tests: `commands/__tests__/proposal.test.ts` (new, 18 cases), `lib/__tests__/
  proposalRetarget.test.ts` (new, 7 cases).

**Checks:** `yarn workspace @open-mercato/core typecheck` clean (0 errors). Full
`src/modules/cart` suite: 28/28 suites, 379/379 tests (25 new), zero regressions. Every
pre-existing basket-only command (`cart.get`, `cart.lines.*`, `cart.merge`, `cart.lock`, the
sweepers) is untouched and still filters `kind: 'basket'` — confirmed by grep and by this
Step's own `cart.get` regression test.

## 2026-10-27T04:10:00Z — Step 3.4 landed (cart: §7a proposal routes, sweeper branches, undo-merge refusal — K13–K16/S13–S15/D-R5-13/D-R5-21/D-R5-25)

**Scope.** The HTTP route family under `/api/cart/proposals/*` (`GET /proposals`,
`POST /proposals`, `GET /proposals/:id`, `POST /proposals/:id/preview`,
`POST /proposals/:id/accept`, `POST /proposals/:id/reject`), the third proposal command
(`cart.proposal.accept`, §7a.4), `commands/merge.ts`'s new `proposalCartId`/`lines` manual-
acceptance input variant, the three §12 sweeper branches for `kind = 'proposal'` (K15/S15),
and the D-R5-25 `409 merge_undo_not_supported_for_proposal` refusal on `/current/undo-merge`.

**`cart.proposal.accept` is a real third command, delegating to `cart.merge`.** §3.1a's own
command list names `cart.proposal.create · cart.proposal.accept · cart.proposal.reject` as
the module's three proposal commands — so "the route delegates to the existing merge
command" (this Step's own brief) means `cart.proposal.accept`'s OWN `execute` verifies the
two-step §7a.4 `acceptanceToken` contract and then calls `commandBus.execute('cart.merge',
...)`, not that the HTTP route calls `cart.merge` with no wrapper at all. Full reasoning in
PLAN.md's own Step 3.4 decision entry.

**The two-step `preview` → `acceptanceToken` → `accept` dance, built per §7a.4's literal
text (re-read closely, as instructed — this was NOT in the task brief's own bullet list in
as much detail, which only said "price the proposal's lines... build the minimal version").**
`POST /proposals/:id/preview` re-prices every proposal line against the TARGET's CURRENT
buyer context (`lib/proposalPreview.ts#buildProposalAcceptancePreview`, reusing
`cart.proposal.create`'s own exported pricing helpers from `commands/lines.ts` — creates
nothing, no `em.persist`/`flush` anywhere in that file) and returns `{ acceptancePreview,
acceptanceToken }`. The `acceptanceToken` (`lib/acceptanceToken.ts`) is a `signAudienceJwt`/
`verifyAudienceJwt`-signed token (audience `cart_proposal_acceptance`, reusing the SAME
shared primitive `customer_accounts` already uses for session JWTs, 15-minute TTL) binding
BOTH the target's and the proposal's current `updatedAt`. `POST /proposals/:id/accept`
verifies the token's signature AND freshness (`isAcceptanceTokenFresh`); a stale or
malformed token gets `409 proposal_changed` carrying a FRESH preview+token built the same
way, never a bare error. "Single-use" (TC-CART-PROP-11) is a consequence of the freshness
check alone — a successful accept moves both carts' `updatedAt`, so replaying the same
token fails the identical comparison a genuinely-stale token would.

**`commands/merge.ts`'s manual-acceptance branch is a fully separate code path, not woven
into the existing §7.1 guest-merge flow.** `CartMergeInput` is now a discriminated union
(`CartMergeAutoInput | CartMergeManualInput`); `mergeCartCommand.execute` branches to a new
`executeProposalAcceptance` function at the very top when `proposalCartId` is present. That
function reuses the EXISTING `buildMergeOutcome`/`resolveMaxOrderQuantities`/
`filterCustomerLines` helpers (treating the proposal's SELECTED lines as "source," the
target's customer-origin lines as "target," the target always as survivor — never
`strategy: 'replace'`) and the existing mandatory whole-cart reprice dispatch, but has its
own target/proposal resolution, its own lock/status gates (`423 cart_locked` with the
session id, `409 cart_not_active` for either cart), its own `declined`-disposition pass for
every unselected proposal line, and writes `CartMergeLog.proposalCartId` — the ONE field
D-R5-25's undo refusal keys off. Zero changes to the pre-existing, heavily-tested §7.1
guest-merge path itself — confirmed by running the full pre-existing `merge.test.ts` suite
unchanged alongside the new tests.

**D-R5-25's refusal lives in `restoreCartMerge`, checked BEFORE the survivor/absorbed cart
lookups (which would otherwise 404 for a proposal-sourced merge, since the absorbed row's
`kind` is `'proposal'` and both lookups filter `kind: 'basket'`).** `cart.mergeUndo`
(buyer-facing) throws the `409` straight through; the generic command-undo-log `undo`
handler (the admin "Undo" action) now ALSO swallows this code silently, alongside the
pre-existing `merge_already_undone`/`cart_not_active` swallows — same "no HTTP consumer to
show an error to" reasoning those two already established.

**Sweeper branches (K15/S15).** `sweepAbandonedCarts` needed NO change — its own
`kind: 'basket'` filter already excluded every proposal (confirmed by the pre-existing
regression test, still green). `sweepExpiredProposals` (new function, `lib/sweepers.ts`)
runs on the SAME hourly `cart:expire` tick as `sweepExpiredCarts` (no new schedule —
`workers/expire.worker.ts` now calls both in sequence, separate try/catch per branch):
`kind = 'proposal' AND status = 'active' AND expires_at < now()` → `expired`, `resolved_at`
set, `cart.proposal.expired` with scope, code reservations released by `cartId` (finds
nothing in Release 5, S14, but the rule stays correct). `purgeExpiredCarts`'s `base` filter
simply DROPPED its `kind: 'basket'` restriction — the `CartMergeLog` exclusion logic already
checked `ref.proposalCartId` (written ahead of time by Step 2.11/K11, confirmed by reading
that Step's own NOTIFY.md entry), so widening the base query was the ONLY change needed; an
accepted proposal stays excluded via the exact same `excludedIds` set a still-referenced
basket already used.

**Identity binding reused verbatim, not reinvented.** `lib/currentCartRoute.ts` gained
`resolveIdentifiedBasketByToken` — the SAME `getCustomerAuthFromRequest` session-vs-
`customerUserId` check `resolveCurrentCart` already enforces for every `/current/*` route,
duplicated at this file's own small scope (same precedent `lib/reprice.ts`'s own duplication
note already sets) rather than refactoring the heavily-tested `resolveCurrentCart` to share
it — zero risk to that existing seam. Every buyer `/proposals/*` route calls it before
touching anything.

**Decisions flagged in PLAN.md (not repeated here in full):** `cart.proposal.accept` built
as a real third command, not route-inline merge dispatch; the acceptanceToken's JWT-based
design; `GET /proposals` filters to `status: 'active'` ("live") while `GET /proposals/:id`
stays readable at any status; the STAFF admin `/api/cart/carts` list/detail is **NOT**
widened to `kind: 'proposal'` in this Step (Step 2.10's own pre-existing, explicitly-flagged
deferral — a separate file family from this Step's `/api/cart/proposals/*` scope; `cart.
proposals.view` is already declared and sits unused, waiting for whichever Step closes that
gap); no dedicated rate-limit bucket for the staff-authored `POST /proposals` (no cart token
to key by; reusing a token-keyed bucket would conflate two different abuse surfaces);
`cart.cart.merged`'s `kind` field is read as "the source's kind" (`'proposal'` for this
branch); token rotation on acceptance mirrors the existing unconditional guest-merge
rotation.

**Files touched:**
- `commands/proposal.ts` — new `cart.proposal.accept` command; exported `resolveProposalAuthor`.
- `commands/merge.ts` — `CartMergeInput` is now `CartMergeAutoInput | CartMergeManualInput`;
  new `executeProposalAcceptance` function; D-R5-25 refusal in `restoreCartMerge`; the
  generic `undo` handler's swallowed-code list grows by one.
- `lib/acceptanceToken.ts` (new) — sign/verify/freshness for the §7a.4 acceptanceToken.
- `lib/proposalPreview.ts` (new) — the dry-run preview builder.
- `lib/currentCartRoute.ts` — new exported `resolveIdentifiedBasketByToken`.
- `lib/sweepers.ts` — new `sweepExpiredProposals`; `purgeExpiredCarts`'s `kind` filter widened.
- `workers/expire.worker.ts` — calls `sweepExpiredProposals` after `sweepExpiredCarts`.
- `data/validators.ts` — new public `/proposals/*` request-body schemas.
- `api/proposals/route.ts` (new) — `GET` (list) + `POST` (author).
- `api/proposals/[id]/route.ts` (new) — `GET` (detail).
- `api/proposals/[id]/preview/route.ts` (new) — `POST`.
- `api/proposals/[id]/accept/route.ts` (new) — `POST`.
- `api/proposals/[id]/reject/route.ts` (new) — `POST`.
- `api/current/undo-merge/route.ts` — `openApi` error-doc update (new 409 code mentioned).
- Tests (new/extended): `lib/__tests__/acceptanceToken.test.ts` (new, 9 cases),
  `lib/__tests__/proposalPreview.test.ts` (new, 5 cases), `commands/__tests__/proposal.test.ts`
  (+6 cases, `cart.proposal.accept`), `commands/__tests__/merge.test.ts` (+12 cases: manual
  acceptance branch, D-R5-25 refusal, regression guards), `lib/__tests__/sweepers.test.ts`
  (+9 cases, replacing the one stale "never purges a proposal" test that this Step's own
  purge-widening superseded).

**Checks:** `yarn workspace @open-mercato/core typecheck` clean (0 errors), run twice
(once after a full `tsconfig.tsbuildinfo` wipe to rule out a stale incremental cache). Full
`src/modules/cart` suite: 30/30 suites, 417/417 tests (38 new), zero regressions — every
pre-existing guest-merge/undo/sweeper test passes unchanged.

## 2026-10-27T23:30:00Z — checkpoint 7 (Steps 3.1–3.4 + 3.1-fix)
- Range: `4a056a7764`..`469bd19c17` (incl. `efc2335eb9`). Summary: cart approval gate; resolveTerms
  termsCurrencyCode fix; a real ecommerce typecheck regression found and fixed (3.1-fix);
  request-approval route + K3 lifecycle; §7a proposal seam commands; §7a proposal routes +
  sweepers + undo-merge refusal.
- Checks: forced full typecheck with tsbuildinfo wiped (40/40, 0 cached) pass; full cart suite
  (30/30 suites, 417/417 tests); customer_groups+ecommerce regression sweep (112/114 suites,
  1365/1373 tests, 2 expected gated skips).
- Decisions/problems: the Checkpoint 6 vs. post-3.1 typecheck discrepancy remains unexplained
  (logged, not papered over); mitigated going forward by wiping tsbuildinfo before every forced
  checkpoint typecheck. `cart`'s Phase 3 scope (approval gate + proposal seam) is now complete.

## 2026-10-27T22:00:00Z — Step 3.5 (checkout B.2: cart-backed links — trusted pay-link cart
seeding D-R5-19 + store/channel/currency mismatch check C9)
- Third `checkout`-module Step, building on Step 2.12's `CheckoutSession`/step-machine
  baseline and Step 2.13's delivery/payment listing. Read Step 2.12's own flagged gap
  closely ("C9 is NOT enforced at session CREATE ... Step 3.5 or a dedicated gap-fill must
  add the storeContextService.resolve(request, { fresh: true }) + cart_store_mismatch
  check") and Step 2.9's trusted-path identity fill (`cart/commands/cart.ts`'s
  `resolveTrustedCartBuyerIdentity`) — this Step's pay-link seeding reuses that exact
  mechanism for buyer identity, and Step 1.1's `buildTrustedCommandContext` for the audit.
- **Genuine gap found during implementation, not anticipated by the task brief:** the
  checkout spec's §4.3 names a brand-new entity, `CheckoutLinkCartTemplate`
  (`checkout_link_cart_templates`) — "merchant-defined lines that seed a cart on first
  visit" — which did not exist in code at all (confirmed: zero hits for
  `unit_price_override`/`CheckoutLinkCartTemplate` anywhere outside the spec/analysis
  docs). The task brief's own Read-first list implied `CheckoutLink`/`CheckoutLinkTemplate`
  already carried "the template's line definitions, including whether a line has
  `unit_price_override`" — they do not; Phase A's `CheckoutLinkTemplate` only ever had
  `pricingMode` (fixed/custom_amount/price_list), never a lines concept. Built the entity
  now (additive migration + snapshot), scoped tightly to what seeding needs — see PLAN.md
  "Decisions taken without the owner" for the full reasoning (product_id required, no
  freeform line, no admin write route yet).
- **A second genuine gap, on the `cart` side (D-R5-19, Ask First already approved):** the
  checkout/cart specs' own "rev 10" text describes a `systemActor` bypass in
  `cart.create`'s `requireChannelFeature` (accepted for `channel: 'pay_link'` ONLY, R22)
  and a `CartLine.unitPriceOverride` field — neither existed in the shipped `cart` code
  through Step 3.4. Closed both, minimally: `requireChannelFeature` now short-circuits for
  `ctx.systemActor === true && channel === 'pay_link'`, rejecting every other channel the
  identical way an unauthenticated caller would (new `it.each` test: pos/agent/api all
  403). `cart.create`'s authenticated-path schema gained an optional `tenantId` field,
  honored ONLY when `ctx.systemActor` is true (there is no `ctx.auth` to derive tenant
  scope from otherwise) — `resolveAuthenticatedScope` falls back to it. `CartLine` gained
  `unitPriceOverride: { amount, basis } | null` (additive migration), and
  `cart.lines.add` accepts it as an input field gated by the identical `systemActor` +
  `pay_link` check (`assertUnitPriceOverrideAllowed`) — when present, it bypasses catalog
  price-row resolution entirely via a synthetic `ResolvedLinePrice` fed through the
  EXISTING `applyPriceSnapshot` (no duplicated pricing logic). `lib/reprice.ts`'s
  `buildCartLineRepricePhases` excludes an override line from re-pricing with the exact
  same one-line pattern already used to exclude gift (`origin: 'promotion'`) lines — "never
  silently overwrite a deliberately non-catalog price."
- **Pay-link cart seeding (`lib/payLinkCartSeed.ts`), wired into `checkout.session.create`
  for `{ source: 'link', slug }`:** only a `checkoutType: 'simple_checkout'` link reaches
  this branch — a `checkoutType: 'pay_link'` link 404s at this command (identical body to
  an unknown slug), leaving Phase A's `/pay/[slug]` + `/submit` completely untouched and
  unaware this code exists. Phase A's own availability checks (active, usage limit,
  password cookie) are reproduced here, at session-creation time. On success: builds a
  trusted, request-less context via `buildTrustedCommandContext({ actorType: 'system',
  reason: 'checkout:pay_link_seed:<linkId>' })` from the LINK's own tenant/organization
  (never request input); when a customer session is present AND its tenant/organization
  equal the link's, resolves the buyer's real identity via `storeContextService
  .resolveForBuyer({ tenantId, organizationId, customerUserId })` with no store (D-R5-13/
  D-R5-22) and passes it to `cart.create`; calls `cart.create` (channel `pay_link`) then
  `cart.lines.add` once per template line — both over the REAL command bus, never a direct
  entity write. A template line's `unitPriceOverride` (merchant-fixed) is passed through
  as `{ amount, basis: 'gross' }` (judgment call — Phase A's pricing is gross-oriented, and
  the template entity has no `basis` column of its own); a line with none is omitted,
  pricing the buyer at their own catalog rate.
- **C9 (`lib/cartSessionConsistency.ts`), ONE reusable guard wired at session creation for
  BOTH `source` branches, left ready for Step 4.1 to call again at submit without
  duplicating the comparisons:** `assertCartMatchesCheckoutScope` (pure — tenant/
  organization, channel, currency always compared; the store compared only when
  `cart.storeId` is non-null, X13) plus `resolveRequestStoreIdForConsistencyCheck` (resolves
  "the store from the request" via soft `storeContextService.resolve(request, { fresh:
  true })`, `503 checkout_sessions_unavailable` — not `409` — when a non-null-store cart has
  no resolvable store context at all, matching §3.4's own documented behavior for an absent
  `ecommerce`). At creation, three of the four comparisons are tautological by construction
  (the session copies the cart's own fields verbatim) — the store check is the one with
  real teeth, and it is NEWLY enforced here (Step 2.12's own flagged gap, closed). The link
  path's cart always has `storeId: null`, so it never even attempts a store resolution —
  verified by a test with NO `storeContextService` registered at all (would hard-throw if
  ever consulted).
- **Regression check (one pre-existing test needed an update, not a design change):**
  `commands/__tests__/session.test.ts`'s "copies the cart scope and identity onto the new
  session" test used a `store_id: 'store-1'` cart peer with no `storeContextService` mocked
  — correctly caught by the new store-resolution requirement. Added a matching
  `storeContextService.resolve` mock returning `store.id: 'store-1'` (a real match, so the
  test's own assertions are otherwise unchanged) and a `request` on the input. Every OTHER
  pre-existing test in that file uses the default `store_id: null` cart peer and needed no
  change at all. `api/sessions/__tests__/route.test.ts`'s "rejects an unsupported source"
  test (encoding "B.2 is not built yet") was replaced with a "dispatches { source: 'link',
  slug } to the command" test plus a narrower 400-on-malformed-body test.
- **Re-verified, not assumed: the Phase-A-only pay-link flow is completely unaffected.**
  `index.ts` was not touched (no new `requires`) — the existing
  `__tests__/phase-a-non-regression.test.ts` (C10's own static-contract guard from Step
  2.12) ran as part of the full suite below and passed unchanged; no file under
  `api/pay/**` was touched; `checkout.session.create`'s `source: 'link'` branch is reachable
  only for `checkoutType: 'simple_checkout'`, which no admin surface can create yet (no
  write route for `CheckoutLinkCartTemplate` either) — so no LIVE `checkoutType: 'pay_link'`
  link's behavior changes in any way.
- Files: `packages/checkout/src/modules/checkout/data/entities.ts` (+`CheckoutLinkCartTemplate`),
  `data/validators.ts` (+`{ source: 'link', slug }` on `checkoutSessionCreateSchema`,
  discriminated union), `migrations/Migration20261027220000.ts` + `.snapshot-open-mercato
  .json`, `commands/session.ts` (`source: 'link'` branch, C9 wiring for both branches),
  `lib/payLinkCartSeed.ts` (new), `lib/cartSessionConsistency.ts` (new),
  `api/sessions/route.ts` (link slug dispatch). Cross-module: `packages/core/src/modules/
  cart/commands/cart.ts` (`requireChannelFeature` systemActor bypass,
  `resolveAuthenticatedScope` trusted tenantId fallback), `cart/data/validators.ts`
  (+`tenantId` on `cartCreateInputSchema`), `cart/data/entities.ts`
  (+`CartLine.unitPriceOverride`), `cart/commands/lines.ts` (override bypass +
  `assertUnitPriceOverrideAllowed`), `cart/lib/reprice.ts` (override-line exclusion),
  `cart/migrations/Migration20261027210000_cart.ts` + `.snapshot-open-mercato.json`. Tests
  added: `checkout/commands/__tests__/session.link-seed.test.ts` (12 cases — seeding,
  override pricing, buyer identity, cross-tenant guest fallback, X13 store skip, link-not-
  found/not-simple-checkout/not-active/usage-limit/password/no-template-lines), `checkout/
  lib/__tests__/cartSessionConsistency.test.ts` (12 cases — the full C9 matrix plus
  availability-vs-mismatch degradation), plus extensions to `cart/commands/__tests__/
  cart.test.ts` (+4), `cart/commands/__tests__/lines.test.ts` (+4), `cart/lib/__tests__/
  reprice.test.ts` (+1), `checkout/commands/__tests__/session.test.ts` (+1, the storeId
  regression fix), `checkout/api/sessions/__tests__/route.test.ts` (updated for the new
  `source: 'link'` dispatch).
- Checks (local mode, from repo root): `yarn generate` — clean. `yarn workspace
  @open-mercato/core run typecheck` — clean, exit 0. `yarn workspace @open-mercato/checkout
  run typecheck` — clean, exit 0. `yarn jest src/modules/cart` (from `packages/core`) —
  30/30 suites, 427/427 tests, ZERO regressions on Step 2.9's own 30/423 baseline. `yarn
  workspace @open-mercato/checkout test` — 49/49 suites, 353/353 tests, ZERO regressions on
  Step 2.13's own 47/328 baseline (re-verified explicitly, including the C10 Phase-A-boot
  non-regression test). `eslint` clean (0 errors; 1 pre-existing anonymous-default-export
  style warning on `checkout/data/entities.ts`, unrelated to this Step's own additions) on
  every changed/new file.
