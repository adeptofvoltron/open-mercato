# Handoff — 2026-10-26-ecommerce-release-5-conversion

**Last updated:** 2026-10-27T21:00:00Z
**Branch:** feat/release-5-conversion (fork `adeptofvoltron/open-mercato`)
**PR:** https://github.com/adeptofvoltron/open-mercato/pull/16 (draft, reused — not opened by this run)
**Current phase/step:** Phase 1 and Phase 2 COMPLETE (Checkpoint 6 passed, all 25 Steps 0.1–2.13
done). Next Step is 3.1.
**Last commit:** `607eb93e40` — docs(runs): track payment-method-selection route question for Step 4.1

## What just happened
- Phase 2 (wave 2, 13 Steps) is fully done:
  - `availability`: reservation entity + reserve/release/commit + expiry/reconciliation jobs (2.1–2.3)
  - `customer_groups`: purchase-approval entity + CAS service + portal/staff routes + notifications (2.4–2.7)
  - `cart`: lock extend/session binding, D-R5-21/22 identity-binding behavior change, markConverted
    lineMap + first admin UI, abandonment payload + K11 code-release (2.8–2.11)
  - `checkout`: B.1 session + step machine + security baseline (2.12, first checkout Step this
    run), B.3 delivery rate quoting + delivery promotions + payment-methods listing (2.13)
- Checkpoint 6 (closing Phase 2) passed: forced full `yarn typecheck` (40/40, 0 cached); full core
  retrospective sweep across every Phase-2-touched module (240/243 suites, 2523/2540 tests, 3
  expected Postgres-gated skips); full `checkout` package suite (47/47, 328/328). Details in
  `checkpoint-6-checks.md`.
- **Flagged, not yet acted on:** no dev-server/browser UI smoke pass has run across the whole run
  so far, despite THREE deferred UI surfaces now accumulated (credit panel/ledger/create/adjust
  dialogs; cart admin list/detail/reprice; any checkout session UI Phase 3+ needs).
  `checkpoint-6-checks.md` explicitly commits the NEXT UI-touching Step (or Step 6.1 at the
  latest) to actually start the dev server and verify at least one path through each surface —
  this must not be deferred a fourth time.
- One tracked, non-blocking note carried forward: Step 4.1 must check whether a
  payment-method-SELECTION route is needed before/alongside submit, since Step 2.13 only built
  the listing route.

## Next concrete action
- Dispatch Step 3.1: `cart` approval gate (K1–K5) — `requiresApproval` computation from fresh
  terms, `cart.lock` refusal (`409 cart_requires_approval`), `purpose: 'quote'` skip (D-R5-23),
  guest fail-closed (D-R5-12/29). This builds directly on Step 2.5's approval service and Step
  2.9's cart identity-binding work. **Remember the Step 2.5 tracked gap:** `resolveTerms` still
  does not resolve `termsCurrencyCode` — this Step needs it (K1's currency-match rule) and must
  fix `resolveTerms` to add it if still missing, rather than re-deriving the value another way.

## Blockers / open questions
- none

## Environment caveats
- Dev runtime runnable: unknown (not yet started) — see the UI-verification commitment above.
- Browser / UI checks: not yet attempted, across any phase.
- Database/migration state: clean. Migrations so far: `customer_groups` (1.5, 1.12, 2.4),
  `promotions` (1.9), `availability` (2.1), `cart` (2.10), `checkout` (2.12). `yarn db:migrate`
  has not been run.
- Concurrency mechanisms mutation-tested by their own executors but not independently
  re-verified at checkpoints (no live Postgres here): Steps 1.6 (credit), 2.2 (availability
  reserve), 2.5 (approval decide) — accepted risk, unchanged posture.

## Worktree
- Path: `/Users/bernard/workspace/open-mercato/.ai/tmp/release-5-conversion-impl`
- Created this run: yes (no prior worktree existed for this branch)
