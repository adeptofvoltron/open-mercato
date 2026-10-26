# Handoff — 2026-10-26-ecommerce-release-5-conversion

**Last updated:** 2026-10-27T19:40:00Z
**Branch:** feat/release-5-conversion (fork `adeptofvoltron/open-mercato`)
**PR:** https://github.com/adeptofvoltron/open-mercato/pull/16 (draft, reused — not opened by this run)
**Current phase/step:** Phase 1 complete. Phase 2 in progress — Checkpoint 5 passed (Steps 2.1–2.11
done). Next Step is 2.12.
**Last commit:** `7443c78d16` — feat(cart): extend abandonment payload and release code reservations on expire/abandon (K9/K11)

## What just happened
- `availability` track (2.1–2.3) and `customer_groups` approval track (2.4–2.7) are fully done —
  see `checkpoint-4-checks.md` for detail.
- `cart` track for this wave (2.8–2.11) landed:
  - 2.8 `2a6c08325b` idempotent lock extend + `checkoutSessionId` binding on unlock/markConverted (C1)
  - 2.9 `0ac273199e` **recorded behavior change** (D-R5-21/22, owner-approved): identified baskets
    now require the matching customer session on every `/current/*` route (closes the X1 token-only
    re-identification bypass); trusted-path (`pay_link`/`api`/`agent`) carts now seed real
    `customerIds`/`customerGroupIds`/`priceKindId`/etc. via `resolveForBuyer` instead of placeholder
    values. UPGRADE_NOTES-ready description logged in `NOTIFY.md` for Step 6.2.
  - 2.10 `d9663a84bf` `markConverted` order/quote `lineMap` (K8/D-R5-26) + cart's FIRST admin UI
    this run (DataTable list/detail/reprice, K6). Added a generated `grandTotalGrossAmount` column
    (hand-authored migration, mirrors `CartLine.configurationHash` precedent — reviewed, sound).
  - 2.11 `7443c78d16` abandonment payload growth (K9) + code-reservation release on expire/abandon
    (K11). One documented, non-blocking gap: `purge` can reach converted/merged baskets Step 2.11's
    mechanism doesn't cover; `promotions`' own TTL sweep backstops it.
- **Process note:** let 6 Steps (2.6–2.11) land before checkpointing instead of 5 — a pacing slip,
  no quality impact (every Step individually verified before the next was dispatched). Resuming
  strict every-5 pacing.
- Checkpoint 5 passed: forced full `yarn typecheck` (40/40, 0 cached); scoped
  `customer_groups`+`cart`+`promotions` tests (95/97 suites, 1087/1095 tests — 2 expected
  Postgres-gated skips). Details in `checkpoint-5-checks.md`.

## Next concrete action
- Dispatch Step 2.12: `checkout` B.1 — session entity + step machine + token hash + the C14
  security minimum (rate limits, session encryption, payload redaction, cross-tenant check). This
  is the FIRST `checkout` Step in this run — `checkout` today ships Phase A (pay links) only, no
  session/step-machine code exists yet. Read the checkout analysis's C1–C26 findings and the
  revised checkout spec closely before dispatching.

## Blockers / open questions
- none

## Environment caveats
- Dev runtime runnable: unknown (not yet started). First real dev-server/browser smoke pass still
  deferred — now most likely triggered by Step 2.12/2.13's checkout session UI, or Phase 3.
- Browser / UI checks: not yet attempted, including for Step 2.10's new cart admin pages.
- Database/migration state: clean. Migrations so far: `customer_groups` (1.5, 1.12, 2.4),
  `promotions` (1.9), `availability` (2.1), `cart` (2.10, hand-authored generated column — reviewed
  sound). `yarn db:migrate` has not been run.
- The availability-reserve and approval-decide concurrency mechanisms (Steps 2.2, 2.5) remain
  mutation-tested by their own executors but not independently re-verified at checkpoints (no live
  Postgres here) — accepted risk, consistent posture since Step 1.6.

## Worktree
- Path: `/Users/bernard/workspace/open-mercato/.ai/tmp/release-5-conversion-impl`
- Created this run: yes (no prior worktree existed for this branch)
