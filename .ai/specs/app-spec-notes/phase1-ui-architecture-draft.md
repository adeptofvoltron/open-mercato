# Phase 1 draft — §3.5 UI Architecture (Storefront Cart)

Moves into §3.5 of `2026-08-13-app-spec-storefront-cart.md` once the Phase 0 gate closes.
Drawn from the personas in §2 and the workflows in `phase1-workflows-draft.md`.

---

## 0. The building-block rule is inverted here — read this first

Every other Open Mercato UI spec starts from `packages/ui`: `CrudForm`, `DataTable`, `apiCall`,
the DS token tables, the `om-backend-ui-design` skill. **None of that applies to the cart.**

SPEC-029 §14.2 states the storefront app **MUST NOT depend on `@open-mercato/*`**. It is a standalone
Next.js app with its own component tree (§14.1), its own design-system section (§16) and its own
component specifications (§15). An implementer reaching for `CrudForm` or `@open-mercato/ui/primitives`
here is building the wrong thing, and the platform's DS lint will not catch it because the file is
outside the packages it scans.

What *does* apply: SPEC-029 §16 (typography, spacing, colour, motion), §17's WCAG 2.2 AA checklist,
§18's RWD breakpoints, and `storefrontFetch` from §14.3 — as amended by A-9 (`credentials: 'include'`,
`cache: 'no-store'` on session endpoints).

**Gap found:** SPEC-029 §14.1's component tree contains **no cart components at all** — no `cart/`
folder, and no `/cart` route in `src/app/`, despite §6.1's architecture diagram promising
`/cart → CartPage (Phase 3)`. Every component and route below is therefore new work, and the parent's
tree needs amending (**A-16**, to be added to §1.5).

---

## 1. Routes (storefront app)

| Route | Purpose | Auth | Notes |
|---|---|---|---|
| `/cart` | Full cart page — review, modify, proceed | none | The `/cart` promised by §6.1 but absent from §14.1 |
| `/cart/reconcile` | **The choice surface for a reconciliation conflict** | authenticated | Pass 2 flagged that §1.4.7 promised the shopper "an explicit choice" with nowhere to make it. This is that page. |
| (drawer, no route) | Mini-cart overlay opened by add-to-cart and by the header badge | none | Not a route — a client-side overlay, so it never costs a navigation |

The cart badge lives in `StorefrontHeader.tsx` (existing in §14.1) and is the only change to an existing component.

## 2. Components (all new)

| Component | Purpose | Notes |
|---|---|---|
| `cart/CartBadge.tsx` | Item count in the header | Binds to `CartTotals.item_count`, **not** `line_count` — the badge counts things, not rows |
| `cart/CartDrawer.tsx` | Slide-over shown on add-to-cart | Primary confirmation that the add worked; must not steal focus from continued browsing |
| `cart/CartPage.tsx` | Full review surface | |
| `cart/CartLineRow.tsx` | One line: image, title, options, quantity stepper, line total, remove | Renders the drift and availability advisories |
| `cart/CartTotalsPanel.tsx` | Subtotal + the "tax and shipping calculated at checkout" statement | Shows net or gross per `CartTotals.display_tax_mode` |
| `cart/CartEmptyState.tsx` | First-visit and post-clear state | |
| `cart/CartExpiredNotice.tsx` | Explains an expired cart instead of silently showing an empty one | |
| `cart/LineAdvisory.tsx` | Per-line price-drift and availability messaging | The visible half of INV-9 / Q-6 |
| `cart/ReconcileChoice.tsx` | Side-by-side cart comparison with one explicit choice | Currency-conflict path only |

## 3. Key user flows

| Persona | Task | Flow | Clicks |
|---|---|---|---|
| Guest Shopper | Add first item | PDP → **Add to cart** → drawer confirms | **1** |
| Guest Shopper | Review and adjust | header badge → drawer → quantity stepper | **1–2** |
| Guest Shopper | Proceed | drawer → **Checkout** (hands over, out of scope) | **1** |
| Returning shopper | Resume | load any page → badge already populated → click → `/cart` | **1** |
| Authenticated Shopper | Resolve a reconciliation conflict | login → redirected to `/cart/reconcile` → choose → `/cart` | **2** |

Primary task (add an item) is **one click** from the product page; the cart is never more than one click
from anywhere via the header badge. The skill's ≤3-click rule is satisfied with margin.

## 4. Empty and exceptional states

> The rule for every one of these: **never render an empty cart when the reason is not "you have not added anything".**
> A shopper who returns to what they believe is a saved cart and sees an empty box concludes the store lost their
> order — the most expensive possible reading, and directly against the §1.2 goal.

| State | What the shopper sees | Action offered |
|---|---|---|
| Never had a cart | "Twój koszyk jest pusty" + a short line about what the store sells | Browse catalogue |
| Cart expired (INV-10) | Explains that the cart expired after N days, names the date | Browse catalogue. **No false promise of restoration** — expiry is terminal by design |
| Guest carts disabled (`allowGuestCart: false`) | Prompt to sign in before adding, shown **at the point of add**, not as a surprise later | Sign in, returning to the same product |
| Line unavailable (`availability_status`) | The line stays visible and greyed with a reason; the rest of the cart stays usable | Remove line |
| Price drifted (`price_changed_since_added`) | Old and new price shown together, plainly, without alarm styling | Accept implicitly, or remove |
| Cart at INV-14 cap | Explicit message naming the limit | Remove something |
| Reconciliation conflict | `/cart/reconcile` — both carts side by side with their contents and totals | Choose one; **no default pre-selected**, because either choice discards real intent |
| Version conflict (409) | Silent re-fetch and re-render; the shopper is not shown a technical error | none — but the re-applied mutation must go through A-12a's idempotency path, not a blind retry |

## 5. Real-time behaviour

Three events carry `clientBroadcast: true` (`line_added`, `line_updated`, `line_removed`), so a second tab
updates through the platform's DOM Event Bridge rather than through polling or a bespoke sync path.

> Caveat to verify in Phase 3: the DOM Event Bridge is an `@open-mercato/*` capability, and §14.2 forbids the
> storefront app from depending on those packages. Either the bridge's client half is consumable over plain SSE
> without the package, or multi-tab sync needs its own transport. **Recorded as Q-16.**

## 6. What is deliberately absent

| Absent | Why |
|---|---|
| Backoffice cart list | WF-7 is a cut candidate — it moves no metric. If cut, `ecommerce.checkout.view` (A-7) goes with it |
| Widget injections | The storefront is not a platform surface; there are no injection spots |
| Saved-for-later, wishlist | Out of scope (§1.2) |
| Coupon field | Promotions out of scope; `CartTotals.adjustments` reserved so adding one later is not a payload break |
| Grand total | The cart shows a subtotal and says the rest is calculated at checkout (§1.4.3) |

## 7. New amendment this section produces

**A-16** — amend SPEC-029 §14.1 to add the `cart/` component folder and the `/cart` + `/cart/reconcile` routes.
The parent's §6.1 diagram promises a `CartPage` that its own app structure never defines.

## 8. Open question raised here

**Q-16** — can `apps/storefront/` consume the DOM Event Bridge for multi-tab cart sync without importing
`@open-mercato/*` (forbidden by §14.2)? If not, either the three `clientBroadcast` flags are decorative on
this surface, or multi-tab sync needs a plain-SSE client written inside the storefront app.
