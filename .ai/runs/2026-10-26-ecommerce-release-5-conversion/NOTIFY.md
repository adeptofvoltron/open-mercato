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
