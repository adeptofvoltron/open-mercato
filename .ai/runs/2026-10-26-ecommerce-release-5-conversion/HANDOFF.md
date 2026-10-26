# Handoff — 2026-10-26-ecommerce-release-5-conversion

**Last updated:** 2026-10-26T17:00:00Z
**Branch:** feat/release-5-conversion (fork `adeptofvoltron/open-mercato`)
**PR:** https://github.com/adeptofvoltron/open-mercato/pull/16 (draft, reused — not opened by this run)
**Current phase/step:** Phase 1, Checkpoint 2 complete (Steps 1.1–1.10 done); next Step is 1.11
**Last commit:** `9a6703e162` — feat(promotions): un-hide delivery_method rule and DELIVERY_DISCOUNT effect (D-R5-17)

## What just happened
- Steps 1.6–1.10 landed, each via a dispatched `standard`-tier executor, one at a time, each
  verified (clean worktree, single commit, push matched `fork/feat/release-5-conversion` HEAD)
  before the next was dispatched:
  - 1.6 `e94c9305dc` — `customerCreditService` (new DI key, G26), row-lock concurrency (G1/G2),
    decimal-string money (G14), idempotency (G12). N=20 real-Postgres concurrency test
    (`.pg.test.ts`, gated on `OM_CUSTOMER_GROUPS_PG_URL`); the executor mutation-tested its own
    proof by stripping `PESSIMISTIC_WRITE` and confirming the test then fails (14-17/20 wrongly
    succeeded vs. the correct 3/20), then restored it.
  - 1.7 `7151700d9e` — credit admin API, `detail:customers.company`/`.person` widget tab, 3 ACL
    features (`credit.view/.manage/.adjust`), `employee` → `credit.view` (D-R5-7),
    `encryption.ts` for `hold_reason`/ledger `note` (G22). Scope narrowed (logged as a decision):
    no account-creation route, no ledger-listing route — closed by Step 1.11 below.
  - 1.8 `f7b44d2eb6` — `credit.limit_exceeded` notification (G15), `sales.order.cancelled`
    cancel-release subscriber (D-R5-2, correct no-op today since `linkCreditReservationToOrder`
    doesn't exist until Step 4.2), `credit-exposure-audit` daily worker (G21). Scope gap logged:
    manual `/adjust` settlement route still unowned — closed by Step 1.12 below.
  - 1.9 `ed445d40ed` — `promotions.revertCodeUse` (new, `CodeUsage` gained additive
    cart/order/generated-code columns it didn't have at all before) + `sales.order.cancelled`
    reversal subscriber calling `revertUsage`+`revertCodeUse` (C5). SPEC-055 amended to v2.3.0.
  - 1.10 `9a6703e162` — un-hid `delivery_method` rule + `DELIVERY_DISCOUNT` effect (D-R5-17):
    removed both from `PROMOTIONS_HIDDEN_RULE_TYPES`/`_HIDDEN_BENEFIT_TYPES`, wired real
    evaluation via additive `deliveryMethodCode`/`deliveryCost` on `evaluate()`, fails closed
    when absent (cart's existing no-delivery-context calls unaffected — regression-tested).
    SPEC-055 amended to v2.4.0.
- Two gap-fill Steps were appended mid-run by the dispatcher/executors (documented in `NOTIFY.md`
  and PLAN.md's "Decisions taken without the owner", not scope changes requiring the owner):
  - **1.11** — credit account admin-create + ledger-listing routes (G13/D-R5-5 gap after 1.7)
  - **1.12** — manual `/adjust` settlement route (D-R5-2 gap after 1.8)
- Checkpoint 2 passed: forced full `yarn typecheck` (40/40 packages, 0 cached); scoped
  `packages/core` customer_groups+promotions+cart tests (79/80 suites, 910/912 tests — the one
  skip is the Postgres-gated concurrency suite, expected with no Postgres in this environment).
  No dev-server/browser UI smoke pass run yet (noted, deferred — see `checkpoint-2-checks.md`).
  Details in `checkpoint-2-checks.md`.

## Next concrete action
- Dispatch Step 1.11: `customer_groups` admin credit-account provisioning route (`POST
  .../credit-accounts`) + ledger-listing read route (`GET .../credit-accounts/:id/ledger`).
- Then Step 1.12: manual `/adjust` settlement route.
- Phase 1 then closes; run Checkpoint 3 (or fold into it if ≤5 since Checkpoint 2) before
  starting Phase 2 (availability reservations, customer-groups approvals, cart lock contract +
  identity binding, checkout B.1/B.3).

## Blockers / open questions
- none

## Environment caveats
- Dev runtime runnable: unknown (not yet started — no Step so far strictly needs it; a
  dev-server/browser smoke pass for the two UI surfaces touched so far (1.7 credit panel, 1.10
  rule-builder picker) is deferred, see checkpoint-2-checks.md)
- Browser / UI checks: not yet attempted
- Database/migration state: clean; two migrations generated and reviewed so far (`customer_groups`
  Step 1.5; `promotions` Step 1.9's additive `CodeUsage` columns) — unrelated `yarn db:generate`
  drift discarded each time per the root AGENTS.md coding-agent exception. `yarn db:migrate` has
  not been run (never run against a shared DB per the operator's instructions).

## Worktree
- Path: `/Users/bernard/workspace/open-mercato/.ai/tmp/release-5-conversion-impl`
- Created this run: yes (no prior worktree existed for this branch)
