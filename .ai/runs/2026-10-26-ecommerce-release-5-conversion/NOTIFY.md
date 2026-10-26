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
