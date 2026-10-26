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
