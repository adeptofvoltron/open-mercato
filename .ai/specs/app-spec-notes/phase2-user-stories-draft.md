# Phase 2 draft — §5 User Stories + Cross-Story Impact Matrix

Moves into §5 once architect checkpoint #1 closes. Every story traces to a §3 workflow.
Identity per §2: Guest Shopper (Cart Token), Authenticated Shopper (`CustomerUser`), both on the **public storefront**.

> A story with only a happy path is a demo script. Every story below carries alternate and failure paths,
> and every failure path states **the system state afterwards** — "no partial state saved" is a claim, not a hope.

---

## WF-1 — Add the first item

**US-1.1** As a **Guest Shopper**, I add a variant to my cart so that my intent is captured without signing in.
*Success:* a session exists in `open`, holds exactly one line at the requested quantity, and the browser holds a Cart Token.
- **Happy:** drawer opens showing the line and subtotal in the store's display mode.
- **Alternate:** adding a variant already in the cart → quantity increments, `line_updated` fires, no second line (INV-2).
- **Alternate:** adding the same variant with different `line_attributes` → a second line, legitimately.
- **Failure — variant unpublished between page render and add:** typed rejection, **no session created**, shopper told the item is no longer available. State: nothing persisted.
- **Failure — no price for the bound price kind:** rejection, no fallback to another kind. State: nothing persisted.
- **Failure — money quadruple irreconcilable:** rejection after normalization fails. State: nothing persisted.
- **Failure — response lost, shopper retries:** `Idempotency-Key` replay returns the stored response verbatim; quantity unchanged, `version` unchanged.
- *Surface:* PDP + `CartDrawer` (§3.5).

**US-1.2** As a **Guest Shopper on a store with `allowGuestCart: false`**, I am told to sign in *before* I lose my intent.
*Success:* the sign-in prompt appears at the moment of add, and after authenticating the variant is added without re-navigation.
- **Failure — shopper abandons at the sign-in prompt:** nothing persisted, no orphan session.
- *Surface:* PDP inline prompt, not a redirect to a bare login page.

## WF-2 — Review and modify

**US-2.1** As a **Shopper**, I change a line's quantity so the cart matches what I intend to buy.
*Success:* quantity updated, totals recomputed server-side, `line_updated` emitted.
- **Alternate — the new quantity crosses a pricing tier:** the price re-resolves and the unit price legitimately changes. This is **not** drift and must not raise the advisory.
- **Alternate — quantity would exceed INV-14's cap:** rejected with the limit named; prior quantity intact.
- **Failure — `quantity: 0` submitted:** rejected (INV-2a). Removal is `DELETE`. State: line unchanged.
- **Failure — stale `version` (another tab changed the cart):** 409; client re-fetches and replays **through the idempotent path**, never a blind retry.
- **Failure — cart expired while the tab sat open:** typed expiry error, cart unreachable, shopper offered a fresh start with an explanation.

**US-2.2** As a **Shopper**, I remove a line I no longer want.
*Success:* line gone, totals recomputed, `line_removed` emitted and broadcast to other tabs.
- **Failure — line already removed in another tab:** idempotent success, not an error.

**US-2.3** As a **Shopper**, I see when a price or availability changed since I added an item, **before** I reach payment.
*Success:* per-line advisory shows old and new price, or an availability status; the stored snapshot is untouched.
- **Alternate — variant deleted from the catalog:** `availability_status: 'missing'`, line greyed, rest of cart usable.
- **Failure — catalog unreachable at read time:** the cart still renders from its snapshot with advisories suppressed and a soft notice. **Never block cart display on a catalog call.**

## WF-3 — Return to an existing cart

**US-3.1** As a **Guest Shopper**, I return to the store later on the same device and my cart is still there.
*Success:* the badge is populated on first paint; contents match what I left.
- **Failure — token valid but cart expired:** `CartExpiredNotice` explains and names the date; cookie cleared. **Never a silent empty cart.**
- **Failure — token presented against a different store:** store-scoped predicate rejects (INV-11); treated as no cart.

**US-3.2** As an **Authenticated Shopper**, I open the store on another device and find the same cart.
*Success:* the cart resolves by `customer_user_id`; exactly one open cart exists (INV-12).
- **Failure — two open carts exist despite INV-12:** the newest wins and the anomaly is logged; the shopper never sees an error. *(A data-repair path, not a UX path.)*

**US-3.3** As a **Shopper returning to an abandoned cart**, my return is recorded as a recovery.
*Success:* `abandoned_at` cleared, `cart.recovered` emitted exactly once.
- **Alternate — the shopper returns and immediately converts:** `abandoned_at` is cleared at `checkout_started`, so the conversion is attributed rather than lost.

## WF-4 — Reconcile on authentication

**US-4.1** As a **Guest Shopper with a cart and no prior account cart**, my cart becomes mine when I sign in.
*Success:* `customer_user_id` set on the existing session, token rotated, `cart.merged` with `outcome: 'adopted'` and `sourceSessionId: null`.
- **This is the dominant path** — it must emit an event, or the merge-rate metric reads zero exactly when reconciliation works.

**US-4.2** As an **Authenticated Shopper with carts on two devices**, signing in combines them without losing items.
*Success:* colliding lines summed by INV-2's key; guest cart terminal as `merged` with `merged_into_session_id`.
- **Failure — a summed quantity exceeds INV-14:** the merge is **rejected, not clamped**; the shopper is shown the conflict and chooses. Clamping would silently discard intent expressed twice.
- **Failure — reconciliation interrupted mid-write:** either both carts reach their final states or neither does. No cart may be left claiming to be authoritative.

**US-4.3** As a **Shopper whose two carts are in different currencies**, I choose which one to keep rather than losing one silently.
*Success:* `/cart/reconcile` shows both with contents and totals, **no default selected**; the unchosen one terminates as `merged` with `linesTransferred: 0` and `outcome: 'superseded'`.
- **Failure — shopper abandons the choice:** both carts remain; the guest cart stays reachable only via the reconciliation route; the account cart serves ordinary reads (§1.4.7).

## WF-5 — Abandonment

**US-5.1** As the **system**, I mark a quiet cart abandoned so recovery can act on it.
*Success:* `abandoned_at` stamped once, `cart.abandoned` emitted once with contents and value.
- **Failure — the scanner runs repeatedly:** the stored marker makes emission edge-triggered; no re-emission, ever.
- **Constraint:** stamping is a **system write** — it must not increment `version` (INV-7), or every returning shopper's first action 409s.

## WF-6 — Expiry

**US-6.1** As the **system**, I expire a cart past its TTL so stale pricing cannot convert.
*Success:* status `expired`, no further mutations accepted.
- **Failure — expiry races the checkout transition:** INV-1 and INV-10 must not both fire; the transition wins if it started first.
- **Unresolved:** the row is not deleted and may hold `email` (**Q-10**).
- **Constraint:** the predicate must exclude `merged` (A-10), or merged carts flip to `expired` and destroy the audit trail.

---

# Cross-Story Impact Matrix (the hard gate)

What each story changes, and whose preconditions that breaks.

| Story | State it changes | Breaks whose precondition | Resolution |
|---|---|---|---|
| US-1.1 | creates session; issues token | — | — |
| US-2.1 | `line_snapshot`, totals, `version`, `last_activity_at` | US-2.1 in another tab (stale version); US-2.3's advisory (tier re-resolve looks like drift) | 409 + idempotent replay; tier change explicitly excluded from the drift advisory |
| US-2.2 | removes a line | US-2.2 in another tab | Idempotent removal — second delete succeeds |
| US-3.1 | none (read) | — | `last_activity_at` deliberately **not** updated on reads, so reads never write |
| US-3.3 | clears `abandoned_at` | US-5.1's marker | Edge-triggered both ways; `recovered` fires exactly once |
| **US-4.1 / 4.2 / 4.3** | **ownership, token, and up to two sessions' statuses** | **US-3.1** (guest token must still resolve *something* afterwards); **US-3.2** + INV-12 (one open cart per customer); US-2.x if held mid-reconciliation | Token rotated, not orphaned; INV-12 holds because the absorbed cart leaves `open`; mutations during reconciliation are rejected under INV-1 |
| US-5.1 | stamps `abandoned_at` | **Every client holding a `version`** — if this bumped it, all of them 409 | INV-7: system writes never increment `version` |
| US-6.1 | terminal `expired` | **Every other story** | INV-10 gates mutation; the UI explains rather than showing an empty cart (US-3.1) |

**Conflict patterns present:**

1. **Concurrent same-entity edits** (US-2.1 × US-2.1, two tabs) — handled by `version` + idempotent replay.
2. **System-vs-user write race** (US-5.1 × US-2.1) — the reason INV-7 distinguishes client-intent from system writes. This is the single most dangerous pair in the matrix: a metrics job that made the primary surface throw 409s.
3. **Ownership transfer mid-flight** (US-4.x × US-3.x) — the timing window between authentication and reconciliation, where both a token and an identity claim exist. Resolved by §1.4.7's request-resolution rule.
4. **Terminal-state cascade** (US-6.1, US-4.2) — one story's terminal write invalidates others' preconditions. Handled by status gating, but it is why A-10's worker-predicate exclusions matter: a naive expiry predicate would destroy merge audit trails.
5. **Advisory false-positive** (US-2.1 × US-2.3) — a legitimate tiered-price change presenting as drift. Excluded explicitly; it was undefined until pass 4.

**Cascade chains — bounded?** `US-2.1 → line_updated → clientBroadcast → other tab refresh` terminates at the refresh; the refresh is a read and reads write nothing, so no loop. `US-3.3 → recovered → (recovery attribution)` leaves the aggregate. No chain re-enters the aggregate. **Bounded.**

**Missing stories found by building this matrix:** US-3.2's INV-12 violation path (two open carts despite the invariant) had no story and no owner — it is a data-repair path, not a UX one, and is now stated as such rather than being discovered in production.
