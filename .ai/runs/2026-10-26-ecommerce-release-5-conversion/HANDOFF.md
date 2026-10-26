# Handoff — 2026-10-26-ecommerce-release-5-conversion

**Last updated:** 2026-10-26T18:00:00Z
**Branch:** feat/release-5-conversion (fork `adeptofvoltron/open-mercato`)
**PR:** https://github.com/adeptofvoltron/open-mercato/pull/16 (draft, reused — not opened by this run)
**Current phase/step:** Phase 1 COMPLETE (Checkpoint 3 passed, all 12 Steps done). Next Step is 2.1.
**Last commit:** `122ee35173` — feat(customer_groups): add manual credit settlement route /adjust (D-R5-2/G7/G20)

## What just happened
- Phase 1 (foundations, wave 1 of the cross-spec order) is fully done:
  - 1.1 `cc618cce9c` shared trusted command-context helper (X10)
  - 1.2 `e6cd13d577` `ecommerce.resolveForBuyer` (D-R5-22)
  - 1.3 `4f9534f849` `wms.wmsReservationService` extraction (A1)
  - 1.4 `ce8c619f11` availability Phase 2 alignment (A2)
  - 1.5 `f619ac8d4d` customer_groups credit entities + migration + terms columns
  - 1.6 `e94c9305dc` customer_groups credit service, row-lock concurrency (G1/G2/G12/G14) —
    mutation-tested by its own executor
  - 1.7 `7151700d9e` credit admin widget + ACL + encryption (G13/G16/G22)
  - 1.8 `f7b44d2eb6` credit notifications + exposure-audit job + cancel-release subscriber (D-R5-2/G15/G21)
  - 1.9 `ed445d40ed` promotions `revertCodeUse` + cancellation reversal subscriber (C5)
  - 1.10 `9a6703e162` un-hidden `delivery_method`/`DELIVERY_DISCOUNT` (D-R5-17)
  - 1.11 `9c35d9af44` credit account creation + ledger-listing routes (G13/D-R5-5 gap-fill;
    **needed one rescue** after the first attempt was interrupted by a provider rate limit
    mid-implementation with nothing committed — the rescue ran one tier up [`opus`/capable] per
    this run's escalation rule and landed cleanly)
  - 1.12 `122ee35173` manual `/adjust` settlement route (D-R5-2/G7/G20 gap-fill)
- Checkpoint 3 (closing Phase 1) passed: forced full `yarn typecheck` (40/40, 0 cached); the full
  Phase-1 module sweep in `packages/core` (`customer_groups`, `promotions`, `cart`, `wms`,
  `ecommerce`) — 214/215 suites, 2254/2256 tests (1 expected Postgres-gated skip). Details in
  `checkpoint-3-checks.md`.
- Two non-blocking deferrals logged (US-E2 orphan banner; approval ACL features deferred to 2.6) —
  neither gates any later wave.

## Next concrete action
- Dispatch Step 2.1 (`availability`: `AvailabilityReservation` entity + migration, A3), opening
  Phase 2 (wave 2: availability reservations + jobs, customer-groups approvals, cart lock
  contract + identity binding, checkout B.1/B.3). 13 Steps in this phase (2.1–2.13).

## Blockers / open questions
- none

## Environment caveats
- Dev runtime runnable: unknown (not yet started). A real dev-server/browser smoke pass for the
  Phase 1 admin UI surfaces (credit panel, ledger list, create/adjust dialogs, promotions
  rule-builder) is still deferred — planned for the first Phase 2 checkpoint that needs the dev
  server up anyway (Step 2.10's cart admin list), rather than starting it twice.
- Browser / UI checks: not yet attempted.
- Database/migration state: clean. Migrations generated and reviewed so far: `customer_groups`
  (Steps 1.5, 1.12), `promotions` (Step 1.9's additive `CodeUsage` columns). Unrelated
  `yarn db:generate` drift discarded each time per the root AGENTS.md coding-agent exception.
  `yarn db:migrate` has not been run (never run against a shared DB per the operator's
  instructions).

## Worktree
- Path: `/Users/bernard/workspace/open-mercato/.ai/tmp/release-5-conversion-impl`
- Created this run: yes (no prior worktree existed for this branch)
