# Handoff — 2026-10-26-ecommerce-release-5-conversion

**Last updated:** 2026-10-27T23:30:00Z
**Branch:** feat/release-5-conversion (fork `adeptofvoltron/open-mercato`)
**PR:** https://github.com/adeptofvoltron/open-mercato/pull/16 (draft, reused — not opened by this run)
**Current phase/step:** Phases 1–2 complete. Phase 3 nearly complete — Checkpoint 7 passed (Steps
3.1–3.4 + fix-forward 3.1-fix done). Next Step is 3.5 (closes Phase 3).
**Last commit:** `469bd19c17` — feat(cart): add proposal routes, sweeper branches and undo-merge refusal (D-R5-13/21/25, K15/K16)

## What just happened
- `cart`'s entire Phase-3 scope landed:
  - 3.1 `4a056a7764` approval gate in `cart.lock` (K1–K5, D-R5-12/23/29/37) — also fixed the
    tracked `resolveTerms` gap (`termsCurrencyCode` + D-R5-37 base-currency fallback)
  - **3.1-fix** `efc2335eb9` — a real, independently-confirmed typecheck regression from Step
    2.13 (`ecommerce`'s `mergeStoreSettings` + the settings PATCH schema never got `shipping`)
    that a forced typecheck caught right after 3.1 landed, despite Checkpoint 6's own forced
    typecheck reporting the same tree clean. The discrepancy itself is unresolved and logged as
    such; the practical response from here on is wiping `tsconfig.tsbuildinfo` before every
    forced typecheck (now standard practice — Step 3.4's own executor already did this
    unprompted).
  - 3.2 `0b80e92d0c` `/current/request-approval` + K3 lifecycle withdrawal wiring
  - 3.3 `31d4400a58` §7a proposal seam commands (create/reject/re-author) — correctly deviated
    from the brief twice in favor of the authoritative spec (single `reject` command, no sibling
    supersession)
  - 3.4 `469bd19c17` §7a proposal routes, sweeper branches, undo-merge refusal
- Checkpoint 7 passed: forced full typecheck with tsbuildinfo wiped (40/40, 0 cached); full `cart`
  suite (30/30 suites, 417/417 tests); `customer_groups`+`ecommerce` regression sweep (112/114
  suites, 1365/1373 tests, 2 expected gated skips). Details in `checkpoint-7-checks.md`.

## Next concrete action
- Dispatch Step 3.5: `checkout` B.2 — cart-backed links, trusted pay-link cart seeding (D-R5-19),
  store/channel/currency mismatch check (C9). This closes Phase 3. Remember Step 2.12 flagged
  that §7.1 check 4 (store/channel/currency match) was deliberately NOT enforced at session
  creation — this is exactly what C9/Step 3.5 is scoped to fix.

## Blockers / open questions
- none

## Environment caveats
- Dev runtime runnable: unknown (not yet started). UI-verification debt unchanged from Checkpoint
  6 — still committed to the next UI-touching Step or Step 6.1 at the latest.
- Browser / UI checks: not yet attempted.
- Database/migration state: clean. Migrations so far: `customer_groups` (1.5, 1.12, 2.4),
  `promotions` (1.9), `availability` (2.1), `cart` (2.10, 3.2), `checkout` (2.12). `yarn db:migrate`
  has not been run.
- **New practice from this checkpoint on:** wipe `tsconfig.tsbuildinfo` files before every forced
  full typecheck at a checkpoint, per the Checkpoint 6/Step 3.1 discrepancy above.

## Worktree
- Path: `/Users/bernard/workspace/open-mercato/.ai/tmp/release-5-conversion-impl`
- Created this run: yes (no prior worktree existed for this branch)
