# Handoff — 2026-10-26-ecommerce-release-5-conversion

**Last updated:** 2026-10-26T21:00:00Z
**Branch:** feat/release-5-conversion (fork `adeptofvoltron/open-mercato`)
**PR:** https://github.com/adeptofvoltron/open-mercato/pull/16 (draft, reused — not opened by this run)
**Current phase/step:** Phase 1 complete. Phase 2 in progress — Checkpoint 4 passed (Steps 2.1–2.5
done, `availability` track fully complete, `customer_groups` approvals data+service done). Next
Step is 2.6.
**Last commit:** `4a141d16ef` — docs(runs): track resolveTerms gaps

## What just happened
- Phase 1 (12/12 Steps) is complete — see prior HANDOFF history in `NOTIFY.md` if needed; not
  re-summarized here per the checkpoint-rewrite convention (full detail lives in
  `checkpoint-1/2/3-checks.md`).
- Phase 2 Steps 2.1–2.5 landed, each verified before the next was dispatched:
  - 2.1 `04f87ab424` `AvailabilityReservation` entity + migration (A3)
  - 2.2 `9454ae38fb` availability reserve/release/commit, CAS, per-line outcomes, allocation
    (A1/A6/A7/A14/A15) — the release's "last unit, parallel" gate. Its executor found and fixed a
    REAL bug while building the concurrency proof: raw SQL `FOR UPDATE` wasn't binding to the
    ambient transaction in this MikroORM version; switched to the proven ORM-level
    `lockMode: PESSIMISTIC_WRITE` pattern instead, mutation-tested the fix.
  - 2.3 `fe8b4adfba` expiry job (1 min) + reconciliation job (hourly) + `.expired` event (A11/A12/A13)
    — `availability` track is now fully done for this release.
  - 2.4 `03440b6557` `CustomerPurchaseApproval` entity + migration (D-R5-1 two-decision-slot
    design, D-R5-3 cart-as-subject, X6/X7 enum scoping)
  - 2.5 `5db46425d1` approval service with CAS decide/withdraw, `expire-approvals` job
    (G3/G6/G8/G24/D-R5-27) — mutation-tested the double-decide race the same way Step 2.2 did.
    Found and fixed that `resolveTerms` never actually resolved `approvalPolicy` (added in Step
    1.5, never wired in) — fixed just that field; `termsCurrencyCode`/`allowQuoteRequests`/
    `requiresPoNumber` are STILL unresolved, tracked in `NOTIFY.md` for Steps 3.1/5.1 to check and
    fix when each first needs its field.
- Checkpoint 4 passed: forced full `yarn typecheck` (40/40, 0 cached); scoped
  `availability`+`wms`+`customer_groups` tests (115/118 suites, 973/990 tests — 3 expected
  Postgres-gated skips). Details in `checkpoint-4-checks.md`.

## Next concrete action
- Dispatch Step 2.6: `customer_groups` approval portal + staff routes + ACL + grants
  (G5/G7/D-R5-7/D-R5-34). This is the FIRST Step with no prior rescue/escalation precedent to
  check — proceed normally.

## Blockers / open questions
- none

## Environment caveats
- Dev runtime runnable: unknown (not yet started). First real dev-server/browser smoke pass still
  planned for Step 2.10 (cart admin list) or whichever UI-touching Step comes first in Phase 2's
  remaining Steps (2.6's portal routes are API-only, no admin UI; 2.12/2.13's checkout session UI
  may be the actual trigger).
- Browser / UI checks: not yet attempted.
- Database/migration state: clean. Migrations so far: `customer_groups` (1.5, 1.12, 2.4),
  `promotions` (1.9), `availability` (2.1). `yarn db:migrate` has not been run.
- Two highest-stakes concurrency mechanisms after Step 1.6 (availability reserve, approval
  double-decide) are mutation-tested by their own executors but not independently re-verified at
  checkpoints since no live Postgres is available in this environment — accepted risk, same
  posture as Step 1.6 was accepted.

## Worktree
- Path: `/Users/bernard/workspace/open-mercato/.ai/tmp/release-5-conversion-impl`
- Created this run: yes (no prior worktree existed for this branch)
