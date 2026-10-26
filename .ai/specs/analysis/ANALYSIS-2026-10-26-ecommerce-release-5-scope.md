# eComm Release 5 — Conversion (fork) — Scope and Status

> **Release scope**: Customer Groups & B2B Terms Phases 3–4 · Availability Contract Phase 3 · Cart module Phase 4 · Checkout (unified funnel) Phases B.1–B.5.
> **Base**: `develop` @ `fc5f8d04ca` (2026-10-26), which already contains the storefront read side (#7142) and the Release 4 write side (#7592: cart Phases 1–3, promotions Phases 1–3, buyer-scoped visibility Phase 3).
> **Delivery**: one branch `feat/release-5-conversion`, one PR on the `adeptofvoltron/open-mercato` fork (base: fork `develop`), then proposed upstream.

## Release invariant

The platform sells through the API and pay links, with no storefront of its own. Every buyer-facing step of this release (cart B2B, checkout session, submit, B2B approval and credit) is reachable through the public API and through checkout links; no first-party storefront UI ships, and none is required to exercise any gate.

Phase A pay links keep their existing path end to end (checkout spec §2): a `CheckoutTransaction` with no `session_id` and no cart. This release adds nothing to that path and removes nothing from it.

## Specs in scope

| Spec | Phases | Pre-implementation analysis |
|---|---|---|
| `2026-08-14-customer-groups-and-b2b-terms.md` | 3 Credit (`CustomerCreditAccount`, ledger, `checkCredit`/`reserveCredit`/`releaseCredit`/`settleCredit`, admin credit UI, exposure audit) · 4 Approvals (`CustomerPurchaseApproval`, request/decision flow, approver resolution via `CustomerEntityRole`, notifications). Phases 1–2 shipped in #6709; Phase 5 is out of scope. | pending |
| `2026-08-14-availability-contract.md` | 3 Reservations (`'checkout'` source type, `reserve`/`release`/`commit`, expiry and reconciliation jobs, shortfall events). Phases 1–2 shipped 2026-09-22. | pending |
| `2026-08-14-cart-module.md` (rev 9) | 4 B2B and admin: approval routing, bulk lines, admin cart list, abandonment events, the proposal seam (§7a). Phases 1–3 shipped in #7592. | pending |
| `2026-09-22-assisted-selling.md` (rev 5) | Added by D-R5-11. **Recommended by the analysis** (owner confirmation pending): Phase 1 (with `mode` limited to `rep \| off`, no AI entities); Phase 2 items 1, 2 (server side), 3 and 5; Phase 4 conditional on checkout B.4 supplying `lineMap`. Phase 2 item 4, Phase 3 and Phase 5 are out. Prerequisite: SPEC-029 `storeContextService.resolveForBuyer`. | `ANALYSIS-2026-10-26-assisted-selling-release-5.md` (S1–S25) |
| `2026-03-19-checkout-simple-checkout.md` (v2.1) | B.1 Session and step machine · B.2 Cart-backed links · B.3 Delivery and payment · B.4 Submit · B.5 B2B. **B.6 Hardening is out of scope.** Phase A pay links are implemented and unchanged. | pending |

## Ordering constraints (to be confirmed by the analyses)

- Availability Phase 3 (reservations) and customer-groups Phases 3–4 (credit, approvals) land before checkout B.4 (submit) and B.5 (B2B), which call `reserve`/`commit`, `reserveCredit`/`settleCredit` and the approval flow.
- Customer-groups Phase 4 (approvals) lands before cart Phase 4 approval routing: an over-threshold cart cannot lock until approved.
- Cart Phase 4 §7a (the proposal seam) and SPEC-029 `resolveForBuyer` land before assisted-selling Phase 1 (D-R5-11).
- Checkout B.1–B.3 depend only on the Release 4 cart and may proceed in parallel with the three prerequisites above.
- Checkout carries the obligations recorded in Release 4 decision **D-R4-24** (`ANALYSIS-2026-10-14-ecommerce-release-4-decisions.md`): at submit it calls the same `evaluateCartVisibility` as the cart, re-evaluates delivery effects, discloses newly appearing promotions, and refuses a channel/store mismatch. **D-R4-26** also applies: checkout is the first production caller of promotions `useCode`/`registerUsage`/`revertUsage`, so budgets and per-customer limits become enforced from B.4.

## Out of scope

- Checkout B.6 Hardening (rate limits, encryption, redaction, admin session viewer, the four seeded workflow definitions, stalled-instance monitor).
- Customer-groups Phase 5 (per-customer assortment overrides) and buyer-scoped visibility Phase 4.
- Any first-party storefront UI.

## Status

| Step | State |
|---|---|
| Branch and fork PR | done |
| Pre-implement analysis: customer groups F3–F4 | done (2026-10-26) — `ANALYSIS-2026-10-26-customer-groups-release-5.md` (G1–G26); owner decisions D-R5-1…7 in `ANALYSIS-2026-10-26-ecommerce-release-5-decisions.md` |
| Pre-implement analysis: availability F3 | done (2026-10-26) — `ANALYSIS-2026-10-26-availability-release-5.md` (A1–A21); owner decisions D-R5-8…10 in `ANALYSIS-2026-10-26-ecommerce-release-5-decisions.md` |
| Pre-implement analysis: cart F4 | done (2026-10-26) — `ANALYSIS-2026-10-26-cart-module-release-5.md` (K1–K17); owner decisions D-R5-11 (seam stays in Release 5, with assisted-selling Phase 1 added) and D-R5-12 |
| Pre-implement analysis: assisted selling (+ `resolveForBuyer`) | done (2026-10-26) — `ANALYSIS-2026-10-26-assisted-selling-release-5.md` (S1–S25); owner decisions D-R5-13 (S2 option a) and D-R5-14 (S11 re-author as author); phase scope pending |
| Pre-implement analysis: checkout B.1–B.5 | pending |
| Cross-spec consistency pass and decisions | pending |
| Spec revision pass | pending |
| Implementation | pending |
