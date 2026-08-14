# App Spec: Storefront Cart

> The App Spec is a business architecture document that sits above feature specs.
> It captures domain knowledge, validates cross-spec consistency, and ensures
> the app solves a real business problem using the platform correctly.
>
> This document is the SINGLE SOURCE OF TRUTH for what this app is, who it serves,
> and how it maps to the platform. Feature specs are generated from this document.
> If a spec contradicts this document, this document wins.

| Field | Value |
|-------|-------|
| **Status** | **Phase 1 complete, architect checkpoint #1 applied.** §3 workflows, §3.5 UI, §3.7 reality check, §4 gap analysis re-mapped. Phase 0 closed after four challenger passes. §5 stories drafted. |
| **Created** | 2026-08-13 |
| **Parent spec** | [SPEC-029 Ecommerce Storefront Module](./SPEC-029-2026-02-17-ecommerce-storefront-module.md) |
| **Relationship** | **Elaboration of SPEC-029 Phase 3**, scoped to the `open` state of `EcommerceCheckoutSession`. This App Spec does NOT introduce a cart entity. |
| **Challenger findings** | [pass 1](./app-spec-notes/challenger-phase0.md) · [pass 2](./app-spec-notes/challenger-phase0-pass2.md) |
| **Platform readiness** | [`app-spec-notes/platform-readiness-cart.md`](./app-spec-notes/platform-readiness-cart.md) |
| **Base branch** | `develop` |

---

## 0. Architectural Decision — Cart is not a separate entity

SPEC-029 §7.4 states, as a reviewer-driven v3 decision:

> *"The checkout session is also the cart. There is no separate cart entity. `status: 'open'` means the user is still browsing and modifying items — this is the cart state."*

**This App Spec accepts that decision.** The Cart is the `EcommerceCheckoutSession` aggregate observed in `status='open'`. Consequences:

- No new entity, no new table, no new module. The cart lives in `packages/core/src/modules/ecommerce/`.
- **Work-scope boundary = the status enum.** Everything at `status='open'` is in scope; the first transition out of `open` is the checkout boundary.
- Anything SPEC-029 does not provide is recorded as a numbered amendment in §1.5. **§1.5 is the mechanism by which SPEC-029 stays true — an amendment applied but unlisted is a defect in this document.** Pass 2 found four such unrecorded amendments; they are now A-12..A-15.

### 0.1 The boundary is a lifecycle phase, not a bounded context

There is **one** bounded context — Ecommerce Checkout — and `open` is a slice of one aggregate's lifecycle inside it. The status boundary scopes *work*; it is not a context boundary, and treating it as one produces unowned decisions at the seam.

What the cart phase **owns**: line composition, per-line price snapshots, subtotal derivation, cart ownership and reconciliation, abandonment detection, expiry.

What the cart phase **hands over**:

| Handover | To whom | Contract |
|---|---|---|
| Price/availability drift accumulated during `open` | Checkout, at `open → locked` | Cart surfaces drift per line (INV-9); never resolves it |
| Tax computation | Checkout | Each line carries **both** net and gross amounts plus `tax_rate` (§1.4.3), so checkout never re-queries the catalog 30 days later |
| Shipping, discounts, grand total | Checkout | `CartTotals.adjustments` ships reserved and empty |
| Address and contact capture | Checkout | Cart never writes `shipping_address`, `billing_address` |
| Order creation | `sales`, via checkout | Cart never touches `sales_order_id` |
| **Workflow orchestration** | Checkout | The workflow instance is created at the first transition out of `open` (amendment A-13) — the cart phase is plain CRUD, not a workflow step |

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Separate `Cart` aggregate + `CheckoutSession` | Overturns a review-hardened parent decision; the motivating problems are fixable inside the single-entity model |
| Standalone cart module | Would duplicate store-context resolution (SPEC-029 §6.3) |

---

## 1. Business Context `PM`

### 1.1 Business Model

Open Mercato sells a multi-tenant commerce platform. The storefront cart is the last unowned step from product discovery to a `sales` order: SPEC-029 Phase 2 delivers browsing, Phase 3 delivers checkout, and the cart is the state between them where purchase intent accumulates but is not yet committed.

**Who pays:** the merchant (tenant) running a storefront. What they get: a cart that survives long enough and reconciles cleanly enough that intent captured on Monday still converts on Thursday.

**Flywheel:**
```
more items added to cart
   → more captured purchase intent, retained instead of lost on tab close
      → more carts still alive when the shopper returns (recovery, cross-device)
         → higher cart→checkout conversion
            → more completed orders per storefront
               → more signal about which carts convert and which stall
                  → better-targeted recovery and merchandising ↺
```

A cart that persists is not just a saved basket — it is an observation. Each surviving cart feeds the abandonment/recovery signal that makes the *next* cart likelier to convert. A cart that dies on tab close produces no observation, so the loop never starts turning.

#### Checklist
- [x] Paying customer identified
- [x] Flywheel articulated — a reinforcing loop, not a benefits list

### 1.2 Business Goals

**Primary goal:** maximize **cart→checkout conversion rate**.

**Cart creation trigger (fixes the denominator):** a session is created on the **first successful line add**, never on page view. An empty cart is not a cart. Without this fixed, an eager-creating storefront and a lazy-creating one report conversion rates differing by an order of magnitude on identical shopper behaviour.

| Metric | Definition | Source of data | Period |
|---|---|---|---|
| Cart→checkout conversion rate | `cart.checkout_started` events ÷ `cart.created` events | events (§1.4.4) | rolling 30 days |
| Cart survival rate | carts still `open`, non-expired and reachable 24h after creation ÷ carts created | `last_activity_at` (A-3) | rolling 30 days |
| Guest→account merge rate | `cart.merged` events with `linesTransferred > 0` ÷ authentications by a shopper holding a **non-empty** guest cart | events | rolling 30 days |
| Cart abandonment rate | carts with `abandoned_at` set ÷ carts created | `abandoned_at` (A-5) | rolling 30 days |

> The conversion numerator is an **event**, not a status query. `ecommerce.cart.checkout_started` (§1.4.4) is the cart phase's own last fact — the funnel's most important edge must be observable in the event stream the §1.1 flywheel depends on, and a status transition owned by checkout is not.
>
> **Threshold coupling.** The abandonment threshold (Q-3) and the `open` TTL (A-2) are chosen together. A 1h threshold against a 30-day TTL marks nearly every cart abandoned within the hour — a metric near 100% carrying no signal. Proposed pairing: **24h threshold, 30-day TTL.**
>
> Every metric depends on amendments (A-3, A-5, A-10); none is computable against SPEC-029 as it stands.

Survival rate is the leading indicator; conversion is lagging. Survival is what this scope can move — conversion also depends on the checkout.

**Secondary goal (reference app):** the first storefront surface to exercise SPEC-029's concurrency contract against a high-mutation UI. That claim obliges the spec to make idempotency (INV-7a) and the divergence from the platform locking contract (A-11) explicit rather than assumed.

**What is NOT important:**

| Excluded | Why |
|---|---|
| The entire checkout — `locked`, `submitted`, `completed`, `canceled` | User's scope call. SPEC-029 Phase 3. |
| Payment, shipping selection, address capture | Downstream of `locked`. |
| Order/quote creation, `sales` integration | Downstream of `submitted`. |
| Promotions, coupons, discounts | Reserved `adjustments` slot ships now so the payload shape survives their arrival. |
| Wishlists, saved-for-later, subscriptions | Different aggregates, different lifecycles. |
| Inventory reservation at cart time | SPEC-029 §5 non-goal. **If it enters scope, revisit the value-object line boundary** (§1.4.1). |
| `CheckoutCartItem` (`packages/checkout` Phase B) | Merchant-curated pay-link items; its public API forbids cart mutation. Unrelated domain. |
| Abandoned-cart **email delivery** | The event and payload are in scope; the campaign is not. |

### 1.3 Ubiquitous Language

| Term | Definition | Source of data | Period |
|------|-----------|----------------|--------|
| **Cart** | `EcommerceCheckoutSession` in `status='open'`. A **phase**, not an entity. | `ecommerce_checkout_sessions` | N/A |
| **Checkout Session** | The full aggregate across all statuses. | same | N/A |
| **Checkout** | Everything after the first transition out of `open`. Out of scope. | SPEC-029 Phase 3 | N/A |
| **Cart Line** | One shopper-chosen variant + quantity + price snapshot in `line_snapshot`. Value object, **identified by `(variant_id, canonical line_attributes)`** and addressed by a server-assigned `line_id`. | `line_snapshot` jsonb | N/A |
| **Line Attributes** | Shopper-supplied personalization on a line (engraving, gift note). Part of line identity; **normalized to a canonical form** before comparison (§1.4.3). | `line_snapshot` jsonb | N/A |
| **Cart Totals** | Derived money summary. Server-computed, never client-authored. | `totals_snapshot` jsonb | N/A |
| **Cart Token** | Opaque ≥128-bit secret identifying a shopper's browser claim to a cart. Stored as a **deterministic keyed hash**, never in plaintext. | `cart_token_hash` (A-1) | N/A |
| **Guest Cart** | A cart with no `customer_user_id`, reachable only by Cart Token. | same | N/A |
| **Cart Reconciliation** | What happens when an authenticating shopper holds a guest cart. Resolves to a **merge** (lines transferred) or a **supersede** (shopper chooses one cart; no lines transferred). Rules in §1.4.7. | `ecommerce.cart.merged` | N/A |
| **Abandoned Cart** | A cart still `open` whose `abandoned_at` has been stamped by the scanner. A **stored marker**, not a computed state. | `abandoned_at` (A-5) | per-store threshold |
| **Cart Expiry** | TTL after which an `open` cart becomes `expired`. Distinct from abandonment: abandoned carts are alive. | `expires_at` | per-store TTL |
| **Price Drift** | Divergence between a line's snapshot and the live catalog. Computed at read, surfaced per line, never resolved in the cart phase. | computed at read | N/A |
| **Store** | `EcommerceStore`. Owns TTL, abandonment threshold, line caps, tax display selection and the guest-cart flag — all in a new `settings.cart` section (A-6). | `ecommerce_stores` | N/A |
| **Shopper** | The person building the cart. Guest or authenticated. | N/A | N/A |
| **Customer User** | `customer_accounts.CustomerUser` — the **login**. Carries its own `personEntityId` and `customerEntityId`. What a cart's owner FK points at. | `customer_accounts` | N/A |
| **Customer Entity** | `customers.CustomerEntity` — the CRM record. **Not** a login, **not** a cart owner. | `customers` | N/A |
| ⚠️ **Checkout Cart Item** | `CheckoutCartItem` (`packages/checkout`) — **merchant**-authored pay-link items. **NOT a Cart Line.** | `packages/checkout` | N/A |

**Banned phrasings:**

| Do not write | Write instead | Why |
|---|---|---|
| "the Cart entity" / "cart table" | "the Cart phase" / `ecommerce_checkout_sessions` | §0 rejected the entity |
| "cart item" | "Cart Line" or "Checkout Cart Item" | Collides with `packages/checkout` |
| "customer id" / bare "customer" | "Customer User" (login) or "Customer Entity" (CRM) | Three referents; the ambiguous one becomes a foreign key |
| "cart expired" for an inactive cart | "cart abandoned" | Abandoned is alive; expired is not |
| "merge" for the currency-conflict case | "supersede" | No lines transfer; §1.4.7 |
| "session" alone | "Checkout Session" or "browser session" | Collides with auth sessions |

### 1.4 Domain Model

#### 1.4.1 Aggregate and context map

One aggregate: **Checkout Session**, root `EcommerceCheckoutSession`. Cart Lines and Cart Totals are value objects — no identity outside the session.

> **Boundary justification:** the two reasons lines normally acquire identity are inventory reservation and line-level promotion allocation; both are explicit non-goals. Per-line fulfillment lives in `sales` after order creation. **Revisit if inventory reservation enters scope.**

| Boundary | Direction | What crosses | Translation |
|---|---|---|---|
| `catalog` → cart | in | variant existence, net/gross price, tax rate, title, options | **Cart Line Resolver (§1.4.8)** |
| `customer_accounts` → cart | in | Customer User identity | FK id only; no ORM relation |
| `currencies` → cart | in | currency validity | Validated at creation; locked (INV-4) |
| cart → `sales` | out | nothing in this scope | Handover after `open` |
| cart → subscribers | out | 9 domain events | Payloads are the contract |

#### 1.4.2 Fields in cart scope

| Field | Type | Required | Cart-phase role |
|---|---|---|---|
| `store_id` | relation | yes | Immutable. Every query is store-scoped (INV-11). |
| `status` | select (`open`\|`locked`\|`submitted`\|`completed`\|`canceled`\|`expired`\|**`merged`**) | yes | Cart phase = `open`. `merged` added by A-10. |
| `version` | integer | yes, system | **Counts client-intent mutations only** (INV-7). System writes never increment it. |
| `updated_at` | datetime | yes, system | Platform-standard column. Present; not the locking token on this surface (A-11). |
| `idempotency_key` | text | no | Session creation. Expiry decoupled from row TTL (A-2). |
| `currency_code` | text | yes | Locked at creation (INV-4). |
| `locale` | text | yes | Locked at creation; display strings re-resolve at read. |
| `line_snapshot` | jsonb (`CartLine[]`) | yes | The cart's payload. Bounded by INV-14. |
| `totals_snapshot` | jsonb (`CartTotals`) | yes | Server-derived (INV-6). |
| `expires_at` | datetime | yes | TTL, extended on activity. **A store TTL change does not re-derive existing carts**; it applies from their next activity-driven extension (W-6). |
| `cart_token_hash` | text, unique globally | yes | A-1. **Deterministic** keyed hash (HMAC-SHA256, server secret) — a per-row-salted hash would make lookup a table scan. |
| `customer_user_id` | relation → `CustomerUser`, indexed | no | A-3. The **only** owner id. |
| `last_activity_at` | datetime | yes, system | A-3. **Updated on client-intent mutations only, never on reads** — otherwise every GET writes a row on the hottest public endpoint (W-6). |
| `abandoned_at` | datetime | no | A-5. Stamped by scanner; cleared on activity **and on `checkout_started`**. |
| `merged_into_session_id` | relation → self | no | A-10. Set on the absorbed or superseded cart. |
| `customer_ref` | jsonb | no | Display-only (`name`, `phone`). **MUST NOT carry an id** (A-3). |
| `email` | text | no | Written by checkout; read by cart-phase recovery (Q-7). |
| `shipping_address` / `billing_address` | jsonb | no | Checkout scope. |
| `workflow_instance_id` | relation | no | **Null throughout the cart phase — per amendment A-13**, which moves workflow creation to the first transition out of `open`. |
| `sales_order_id` | relation | no | Checkout scope. |

#### 1.4.3 `CartLine` and `CartTotals`

> SPEC-029 references both types and defines neither (A-4).

**Line identity (resolves the two-keys defect).** A Cart Line is identified by **`(variant_id, canonical(line_attributes))`** — the domain key. `line_id` is **server-assigned**, stable for the life of the line, and used only to address an existing line in update/remove. It is *not* the identity key and *not* the idempotency mechanism; idempotency is a transport concern handled by an `Idempotency-Key` header (A-12, INV-7a).

**Canonical form of `line_attributes`** (INV-2 is a Strong invariant, so its equality relation is part of the domain, not an implementation detail):

1. absent, `null` and `{}` all normalize to `{}`
2. shape restricted to a **flat `Record<string, string>`** — no nesting, no arrays, no non-string values
3. keys sorted; values trimmed and Unicode **NFC**-normalized
4. equality is over the canonical form, computed by a **named shared helper** — verified: no canonical-JSON helper exists in `packages/shared` today (the only one is module-local and unexported in `packages/search`), so promoting one is part of the work
5. bounded: max keys and max value length (INV-14 bounds shape as well as size)

**`CartLine`:**

| Key | Type | Required | Notes |
|---|---|---|---|
| `line_id` | text (uuid) | yes, **server-assigned** | Addressing only |
| `variant_id` / `product_id` | relation | yes | |
| `quantity` | integer | yes | ≥1 (INV-3), bounded (INV-14) |
| `line_attributes` | jsonb | yes (may be `{}`) | Canonical form above. Part of identity. |
| `unit_price_net` | decimal string (16,4) | yes | **Unrounded**, as the catalog stores it. Rounding happens once, at the line total (INV-5). |
| `unit_price_gross` | decimal string (16,4) | yes | Unrounded |
| `tax_rate` | decimal | yes | From `CatalogProductPrice.tax_rate` |
| `tax_amount` | decimal string (16,4) | yes on the line | From `CatalogProductPrice.tax_amount` where present. **Nullable in the catalog** — the resolver derives it as `gross − net` when null (§1.4.8), so the line always carries it even though the source may not. |
| `price_kind_id` | relation → `CatalogPriceKind` | yes | Which price list the snapshot came from |
| `price_kind_display_mode` | select (`including-tax`\|`excluding-tax`) | yes | From `CatalogPriceKind.displayMode` — the **per-line** basis |
| `unit_price_currency` | text | yes | Must equal session currency (INV-4) |
| `line_total_net_amount` / `line_total_gross_amount` | decimal string (18,4) | yes | `round(unit_price × quantity)` to 4dp — the **only** rounding point (INV-5, INV-13) |
| `title_snapshot` | text | yes | Audit record; display re-resolves per locale |
| `sku_snapshot` / `image_url_snapshot` / `option_values_snapshot` | — | no | |
| `price_resolved_at` | datetime | yes, system | Per-line pricing basis (replaces the totals-level field) |
| `added_at` / `updated_at` | datetime | yes, system | UTC |

> **Money precision — the cart uses the platform's representation, not its own.**
> Catalog prices are `numeric(16,4)`; `sales` money is `numeric(18,4)`; `calculations.ts` rounds to 4dp. The cart matches: decimal strings at 4dp, `line_total_* = round(unit_price_* × quantity)`, `subtotal_* = Σ line_total_*`. **No minor units anywhere.**
>
> Rounding the *unit* price first and then multiplying by quantity multiplies the error by quantity — wrong in v3. Converting to minor units at all — wrong in v4/v5, and worse: it would have made cart and order totals differ by construction at the very handover §0.1 defines.
>
> **The `(net, gross, tax_rate, tax_amount)` quadruple is normalized, not trusted and not naively validated.** Verified: `tax_amount` is nullable and left null by the seed and by the command layer's explicit net/gross path, and `catalog/seed/examples.ts:990` ships rows with `unitPriceNet == unitPriceGross` alongside a non-zero `taxRate`. The resolver derives what is missing using the platform's canonical arithmetic and rejects only genuinely contradictory rows — the normalization table is in §1.4.8.
>
> **All net/gross/tax arithmetic follows `sales/lib/calculations.ts` (INV-5a).** `tax_rate` is a **percentage** there, not a fraction. The cart does not define its own tax math; a cart that computed totals differently from the order it becomes would be a defect by construction.

**Read-time advisory fields** — computed on read, never stored, never mutating the snapshot:

| Key | Type | Notes |
|---|---|---|
| `price_changed_since_added` | boolean | Live resolved price ≠ snapshot |
| `current_unit_price_net_amount` / `_gross_amount` | decimal string (18,4) | For display beside the snapshot |
| `availability_status` | select (`available`\|`unavailable`\|`out_of_scope`\|`missing`) | Variant deleted, product unpublished, or outside `catalog_scope` |

**`CartTotals`:**

| Key | Type | Required | Notes |
|---|---|---|---|
| `currency_code` | text | yes | |
| `display_tax_mode` | select (`gross`\|`net`) | yes | **Display selection only** — which of the two stored per-line amounts the storefront shows. Derived from `settings.features.showPriceIncludingTax`. **Not the basis of the numbers**; the basis is per line. A merchant flipping the toggle mid-cart changes presentation only. |
| `line_count` / `item_count` | integer | yes | `item_count` = Σ quantity; the header badge uses it |
| `subtotal_net_amount` / `subtotal_gross_amount` | decimal string (18,4) | yes | Σ of the respective line totals (INV-13) |
| `adjustments` | array | yes | **Reserved, always `[]`.** Ships now so the jsonb payload shape survives promotions later (`BACKWARD_COMPATIBILITY.md` treats payload shapes as contract surfaces) |
| `total_net_amount` / `total_gross_amount` | decimal string (18,4) | yes | Equal to the subtotals in this scope; defined now so consumers bind to a stable field |
| `computed_at` | datetime | yes, system | |

> **Why both net and gross per line.** The catalog already resolves both on one row, plus `tax_rate`. Storing one and discarding the other would delete, at snapshot time, exactly the data §0.1 hands to checkout — forcing a catalog round-trip 30 days later against prices that have moved. It would also make a single store-wide tax mode describe a fact that is genuinely per line: `price_kind_id` is per line, and the channel binding can change over a 30-day TTL.

#### 1.4.4 Domain events

Ids follow `module.entity.action`. Verified across **420 unique event ids in 31 `events.ts` files**: multi-word snake_case actions dominate **21:3**, the three camelCase deviations all being in `packages/checkout`. So `line_added` is house style.

**Q-1 resolved: keep `ecommerce.cart.*`.** The middle segment names the concept, not a table — the platform ships `auth.login.failed`, `catalog.price.*`, and root AGENTS.md's own prose example is `pos.cart.completed` (prose only; no `pos` module exists). `ecommerce.checkout_session.*` is **reserved for post-`open`** so Phase 3 does not force a rename of FROZEN ids. In `events.ts` these carry `entity: 'checkout_session'`.

**Common payload:** `sessionId`, `storeId`, `tenantId`, `organizationId`, `occurredAt`.

| Event | Emitter | Extra payload | `clientBroadcast` |
|---|---|---|---|
| `ecommerce.cart.created` | line-add endpoint (A-12), on first line | `isGuest` | no |
| `ecommerce.cart.line_added` | `POST …/lines` | `lineId`, `variantId`, `quantity` | **yes** |
| `ecommerce.cart.line_updated` | `PATCH …/lines/:lineId` | `lineId`, `variantId`, `quantity`, `previousQuantity` | **yes** |
| `ecommerce.cart.line_removed` | `DELETE …/lines/:lineId` | `lineId`, `variantId` | **yes** |
| `ecommerce.cart.merged` | reconciliation endpoint (A-14) | `targetSessionId` (**always the surviving cart**), `sourceSessionId` (**nullable — null on adoption, where no second cart exists**), `linesTransferred`, `outcome` (`adopted`\|`merged`\|`superseded`) | no |
| `ecommerce.cart.abandoned` | abandonment scanner worker — edge-triggered on stamping `abandoned_at` | `abandonedAt`, `itemCount`, `subtotalGrossAmount` | no |
| `ecommerce.cart.recovered` | API — edge-triggered on clearing `abandoned_at` | `abandonedForSeconds` | no |
| **`ecommerce.cart.checkout_started`** | A **subscriber on the parent's existing `POST /sessions/:id/transition`**. The cart phase owns the precondition check the transition calls, and emits this event; it neither owns nor replaces the endpoint. | `itemCount`, `subtotalGrossAmount`, `wasAbandoned` | no |
| `ecommerce.cart.expired` | expiry worker | `expiredAt` | no |

> `checkout_started` exists so the primary KPI's numerator is an emitted fact, and so an abandoned cart that **converts** clears `abandoned_at` and is attributable — otherwise recovery attribution measures re-engagement and systematically misses success.

#### 1.4.5 Invariants

| ID | Invariant | Consistency | Violation consequence |
|---|---|---|---|
| INV-1 | Mutations accepted only while `status='open'`; **includes reconciliation** | Strong | Editing a cart mid-payment |
| INV-2 | A line is identified by `(variant_id, canonical(line_attributes))`; `line_id` is server-assigned and is not the identity key. **Add is a delta**: adding an existing key increments quantity and emits `line_updated`, not `line_added`. **An attribute edit that would collide with an existing line merges into it**, returns the surviving `line_id`, and emits `line_updated` for the survivor plus `line_removed` for the absorbed line — otherwise a `clientBroadcast` subscriber never learns the absorbed line is gone. | Strong | Duplicate lines indistinguishable from a retry bug; and a shopper able to drive two lines to one canonical key |
| **INV-2a** | Removal is `DELETE` only. **A quantity update to `0` is rejected**, never treated as removal — INV-3 forbids storing it and silent reinterpretation hides intent. | Strong | Two operations meaning one thing, disagreeing about which event fires |
| INV-3 | `quantity ≥ 1` for every stored line. Zero is **never stored and never reinterpreted** — see INV-2a | Strong | Poisoned totals |
| INV-4 | Every line's `unit_price_currency` equals the session `currency_code` | Strong | Mixed-currency cart |
| INV-5 | Cart money uses the platform's money representation: **`numeric(18,4)` carried as decimal strings**, rounded to **4 decimal places** by the same `round()` used in `sales/lib/calculations.ts`. **There is no minor-unit conversion anywhere in the cart.** Rounding happens once, at the line total. | Strong | Verified: all `sales` money columns are `numeric(18,4)` and `calculations.ts:22` rounds to 1e4. An earlier draft mandated integer minor units, which would have **guaranteed** that the cart and the order it becomes disagree at handover — the precise defect INV-5a exists to prevent, introduced by the invariant meant to prevent it |
| **INV-5a** | Net/gross/tax arithmetic follows the platform's canonical rules in `packages/core/src/modules/sales/lib/calculations.ts` — notably **`tax_rate` is a percentage**, so `gross = net × (1 + tax_rate/100)`. The cart never defines its own tax arithmetic. | Strong | The cart and the order it becomes would compute different totals from the same row. An earlier draft of this spec wrote `tax_amount ≈ net × tax_rate`, which is wrong by a factor of 100 and would have rejected every correct catalog row. |
| INV-6 | **All money is server-derived and never client-accepted** — line prices and tax fields as well as `totals_snapshot`. The client request type (`CartLineInput`: `variant_id`, `quantity`, `line_attributes` **only**) is distinct from the stored `CartLine` and carries no money fields at all. | Strong | Price tampering on a public unauthenticated API. Covering only totals left the line prices — which the totals are derived *from* — unprotected. |
| INV-7 | Every accepted **client-intent** mutation increments `version` by exactly 1. **System writes** (`abandoned_at`, `last_activity_at`, `expires_at` extension, TTL re-derivation) do not increment it and do not invalidate a client's held version. | Strong | If system writes bumped it, every shopper returning after the abandonment threshold would 409 into the re-fetch-and-reapply path — turning a metrics job into a correctness bug |
| INV-7a | An idempotent replay (same `Idempotency-Key`) returns the prior result and does not increment `version`. **Replay detection precedes the version precondition** (A-12) | Strong | Otherwise a retry carrying a stale version 409s before replay is ever detected, and INV-7a is unreachable |
| INV-8 | A cart has exactly one **owner**: `customer_user_id` when set, else the Cart Token. `customer_ref` never carries an id. Ownership ≠ access: a live Cart Token continues to grant access to an owned cart (so a logged-in shopper's other tab keeps working), which is why INV-15's rotation is load-bearing rather than ceremony. | Strong | Cart leaks between shoppers |
| INV-9 | Snapshots may drift while `open`; drift is **surfaced per line at read** and resolved only at the checkout boundary | **Eventual** | Deliberate; silence untenable at a 30-day TTL |
| INV-10 | `expires_at > now()` for any cart accepting mutations | Strong | Zombie carts converting on stale pricing |
| INV-11 | Every read and write is scoped to the owning store **in the query predicate** | Strong | Cross-tenant exposure on a public API — a root-AGENTS.md "Never". The `?storeSlug=` dev override makes it exploitable otherwise. |
| INV-12 | At most one `open` session per `(store_id, customer_user_id)` **that is not marked `merged_into_session_id`** | Strong | "The customer's cart" ambiguous; cross-device continuity undefined |
| INV-13 | `line_total_* = round(unit_price_* × quantity)` to 4dp; `subtotal_* = Σ line_total_*`, per basis. **`subtotal_net + tax ≠ subtotal_gross` is expected** after per-line rounding and is not an error — the gross subtotal is the sum of gross line totals, never derived from the net subtotal. | Strong | Audit mismatches; and a UI that "corrects" the discrepancy reintroduces one |
| INV-14 | `line_snapshot` bounded: max lines, max quantity per line, max `line_attributes` keys and value length — store-configurable with platform defaults | Strong | Unbounded jsonb growth on a public endpoint |
| INV-15 | Cart Token: ≥128 bits entropy, deterministic keyed hash at rest, rotated on reconciliation, on login and **at the `open →` transition**, invalidated on logout. It has its own TTL, no longer than the cart's. **The cart phase does not revoke it at the phase boundary** — it rotates it and hands the post-`open` authority rules to checkout. | Strong | An outright ceiling at `open` would revoke the guest's only credential at the exact moment they start checkout, making **guest checkout unreachable** and §1.4.7's deferred reconciliation unexecutable. Rotation gives the same fixation protection without severing the session. |
| INV-16 | The bare session id authorizes nothing on the storefront surface | Strong | Ids leak via Referer, analytics, logs |
| **INV-17** | Every cart endpoint is rate-limited per token and per IP via `rateLimiterService`; cart creation is limited separately and more strictly | Strong | A public, unauthenticated, row-creating, unbounded-write endpoint with no rate limit is an incident, not a bug. SPEC-029 defers rate limits to Phase 5, so the parent does not cover this. Budgets in Q-11. |

#### 1.4.6 Access control and data ownership

**The session id is an identifier, not a credential (INV-16).** Amendment A-8 changes SPEC-029 §12.1 so every guest cart read and write requires a valid Cart Token; the id alone is insufficient.

| State | Creates | Reads | Updates | Deletes |
|---|---|---|---|---|
| Cart (guest) | Shopper, public API | Valid Cart Token, store-scoped | same | System (expiry worker — marks `expired`, does not delete) |
| Cart (authenticated) | Shopper (Customer User) | Owning Customer User **or** a live Cart Token for that cart (INV-8) | same | System |
| `totals_snapshot` | System only | Anyone who can read the cart | System only | — |
| Cart (backoffice) | — | Internal user with `ecommerce.checkout.view`, **scoped by the standard tenant/organization predicate** | no write path in scope | — |

Backoffice read uses **`ecommerce.checkout.view`** — additive to SPEC-029 §12.3 rather than a parallel `ecommerce.carts.*` namespace (ACL ids are ADDITIVE-ONLY; a `carts` namespace would also mint the entity §0 denies). **A-7 records that this feature governs the whole checkout aggregate, including post-`open` sessions carrying `email` and addresses** — the Store Operator persona in §2 is therefore a filtered *view* of a broader permission, not a narrower one.

#### 1.4.7 Cart Reconciliation rules

Triggered when a shopper authenticates while holding a guest cart, at the reconciliation endpoint (A-14).

| Question | Rule |
|---|---|
| **No existing account cart (the dominant path)** | The guest cart is **adopted**: `customer_user_id` is set on it, the token is rotated, and `cart.merged` is emitted with `outcome: 'adopted'` and `linesTransferred: <its own line count>`. Nothing is absorbed and nothing terminates. Without this rule the most common authenticated path emitted no event at all, so the merge-rate metric read zero exactly when reconciliation was working. |
| Target, when an account cart exists | The Customer User's existing `open` cart. The guest cart is absorbed. |
| Line collisions | INV-2's identity key: colliding lines have quantities **summed**. If the sum exceeds INV-14's cap, the merge is **rejected**, not silently clamped, and the shopper is shown the conflict — clamping loses intent the shopper expressed twice. |
| Currency conflict | INV-4 makes conversion illegal. **No lines transfer.** The shopper chooses which cart to keep; the unchosen one terminates as `merged` with `merged_into_session_id` set and `linesTransferred: 0` — the `merged` status covers both *transfer* and *supersede*, which is why the event carries an `outcome` discriminator. |
| Both claims present, unresolved | Between authentication and reconciliation the browser holds both a Cart Token and a Customer User identity. **The authenticated cart wins for ordinary reads**; the guest cart stays addressable only through the reconciliation endpoint until resolved. |
| Empty guest cart | No-op, **no event** — otherwise the merge-rate metric inflates toward 100%. |
| Token lifecycle | Guest token invalidated on reconciliation; the surviving cart's token rotated on reconciliation and on login; invalidated on logout (INV-15). |
| Logout | The cart stays owned by `customer_user_id` and becomes unreachable from that browser — no token left pointing at it. On a shared device this is the difference between privacy and a cross-shopper leak. |
| Authentication while `locked` | INV-1 forbids mutation. Reconciliation is deferred and executed **on the shopper's next authenticated cart access** — a trigger the cart phase can actually execute, unlike waiting for a checkout-completion event the cart phase neither owns nor observes. |
| Status transitions | `open → merged` only. `merged` is terminal with no outbound edges. **The abandonment scanner and expiry worker must both exclude it** (A-10), or a naive expiry predicate flips merged carts to `expired`, destroying the audit trail and re-polluting the conversion denominator. |

#### 1.4.8 Cart Line Resolver — the anti-corruption layer

One named function turns `(variant_id, quantity, line_attributes, store context)` into a validated `CartLine`. It is the only path by which catalog data enters the aggregate.

**Steps:** verify the variant exists, is published, and is inside the store's `catalog_scope` → **fetch candidate `PriceRow[]`** for the variant and the bound `price_kind_id` → call `catalogPricingService.resolvePrice` / `resolvePriceMany` with a `PricingContext` carrying the **current** quantity → verify resolved currency equals session currency → **normalize the money quadruple** (below) → snapshot unit prices at catalog precision, plus `tax_rate`, `tax_amount`, `price_kind_display_mode` and display fields → stamp `price_resolved_at`. Rounding belongs to the line total (INV-5).

**Money normalization reuses `sales/lib/calculations.ts`, it does not reimplement it.** `calculateLine`, `calculateDocumentTotals`, `buildBaseLineResult` and `registerSalesLineCalculator` are exported and callable, and `buildBaseLineResult` already implements every row of the table below — including the branch that handles the seed's `net == gross` + `rate > 0` shape. The resolver calls it; the table documents the behaviour the cart depends on rather than a second implementation of it.

**Normalization, not validation.** An earlier draft rejected rows failing `net + tax_amount ≈ gross`. That rule was unusable: `tax_amount` is **nullable** and is left null by both the seed and the command layer's explicit net/gross path, and `tax_rate` is a **percentage**, so the formula was wrong by 100×. The resolver instead **derives what is missing** using the platform's canonical arithmetic (INV-5a):

| Row state | Action |
|---|---|
| net + gross + rate present and consistent | Use as-is |
| `tax_amount` null | Derive: `tax_amount = gross − net` |
| net == gross **and** rate > 0 (the seed's shape) | Treat the stored amount as the **display-mode side** per `price_kind_display_mode`, derive the other side via `gross = net × (1 + rate/100)`, and **log a data-quality warning** |
| net and gross disagree with rate beyond the 4dp rounding tolerance | Reject the line — the row is genuinely contradictory |

> Deriving rather than rejecting is what keeps the demo store usable (Q-14) without silently snapshotting money that cannot be reconciled: every derivation is explicit, canonical, and recorded.

**Quantity changes re-resolve the price.** `CatalogProductPrice` carries `min_quantity`/`max_quantity`, so tiered pricing is real and `PricingContext` takes `quantity`. A quantity change therefore re-runs the resolver and may legitimately change `unit_price_*` — this is **not** price drift and must not raise the drift advisory. Leaving this undefined would have let two implementations charge different money for the same shopper action.

> **The fetch is a separate step and it is the expensive one.** Verified: `resolvePrice`/`resolvePriceMany` do **not** load prices — the caller supplies already-fetched `PriceRow[]`. So "one call, not N" is true of the *resolve* and false of the *fetch*. Whole-cart drift re-resolution on every read is a public hot path; the **fetch** is what must be batched and cached.
>
> **`PricingContext` mapping** (`{ channelId, offerId, userId, userGroupId, customerId, customerGroupId, quantity, date }`): `channelId` from the store's channel binding; `quantity` from the **current** line quantity — otherwise tiered prices drift for a reason unrelated to catalog change; `date` = now. The customer/group fields stay null for guest carts; whether an authenticated shopper's group affects cart pricing is Q-13.

**Rejection cases** (typed errors, never a partially-populated line): variant not found; unpublished; outside `catalog_scope`; no price for the bound price kind (**no fallback to another price kind** — that would silently apply B2B pricing on a B2C store); currency mismatch; quantity or `line_attributes` outside INV-14 bounds; and a money quadruple that normalization cannot reconcile (table above).

### 1.5 Required amendments to SPEC-029

| # | Amendment | Why | Cost |
|---|---|---|---|
| **A-1** | Add `cart_token_hash` (globally unique, deterministic keyed hash) in a cookie; entropy, rotation, invalidation per INV-15 | SPEC-029 defines **no client persistence for the session id**, and §12.1 makes the bare id the de-facto credential | **Medium — corrected.** `packages/checkout`'s access cookie is a **stateless HMAC token, never stored, 1h, SameSite=Strict** — the opposite mechanism, and it cannot do per-row revocation. Correct precedents: `sales/api/quotes/public/[token]`, `onboarding`, `enterprise/sso/scimTokenService`. |
| **A-2** | Split the TTL: store-configurable `open` TTL (default 30 days) vs 24h post-`open`. Decouple idempotency-key expiry from the row's TTL | One TTL cannot serve a cart and a payment-in-flight session | Low. **Mechanism:** `idempotency_key` is a column on the session row (not a separate table, so unbounded growth was never the failure mode) — it is **nulled at 24h by the expiry sweep**, and a later retry with the same key creates a new cart, which for an authenticated shopper is caught by INV-12. |
| **A-3** | Promote `customer_ref.id` to indexed FK `customer_user_id`; `customer_ref` keeps display-only fields. Add `last_activity_at` | The parent already models the owner in `customer_ref.id`; it lacks an *indexed* FK, not the concept | Low |
| **A-4** | Define `CartLine` / `CartTotals` (§1.4.3) with per-line net+gross+`tax_rate`+`price_kind_display_mode` | Referenced twice in the parent, defined nowhere | Low |
| **A-5** | Add `abandoned_at`, stamped by the scanner, cleared on activity and on `checkout_started` | Scanner events are not emittable from a read-time computation | Low |
| **A-6** | Add a **`settings.cart` section** *(a TypeScript type edit on an existing jsonb column — folded into the entity commit, not scored separately)* to `EcommerceStore.settings`: `allowGuestCart` (bool), `openTtlDays` (int), `abandonmentThresholdHours` (int), `maxLines` (int), `maxQuantityPerLine` (int), `maxAttributeKeys`/`maxAttributeValueLength` (int) | §7.1.1's `features` is a **closed type of six booleans** — a TTL in days and integer caps cannot live there | Low |
| **A-7** | Add ACL feature `ecommerce.checkout.view`, documented as governing **all** session statuses | The parent has `checkout.manage` but no read feature | Low |
| **A-8** | Amend §12.1: the bare session id MUST NOT authorize; guest access requires the Cart Token with a store-scoped lookup predicate | The API half of the credential fix | Low |
| **A-9** | Amend §14.3 `storefrontFetch`: `credentials: 'include'`, `cache: 'no-store'` on all session endpoints, and **API proxied same-site under the store host** | Separate origin + `SameSite=Lax` sends no cookie on any mutation; `revalidate: 30` would put cart reads in Next's **shared server cache**, replaying one shopper's cart to another. The same-site proxy also preserves §6.3 `Host` resolution — and is required again by A-14 for the customer session cookie. | Low |
| **A-10** | Add `merged` to the status enum + `merged_into_session_id`; amend §7.4's lifecycle diagram (`open → merged`, terminal); **amend the scanner and expiry worker predicates to exclude it** | The absorbed/superseded cart has no representable terminal state | Low |
| ~~A-11~~ | **Withdrawn — not an amendment.** SPEC-029 §7.5.2 already specifies the body `version` mechanism and the `{ error: 'version_mismatch', currentVersion }` body, and §14.3 already ships `StorefrontVersionConflictError`. There is nothing to amend: the cart adopts the parent's contract as written. Recorded instead as a **documented divergence** from the platform's `updated_at` header locking, which no test covers on this surface. | Amending a spec to say what it already says is noise, and it inflated Q-12. | — |
| **A-12** | Replace the parent's whole-array `lines` PATCH with intent-bearing sub-resources: `POST /sessions/:id/lines` (create-or-increment), `PATCH /sessions/:id/lines/:lineId`, `DELETE /sessions/:id/lines/:lineId`, plus `POST /sessions/:id/checkout`. Each mutation accepts `Idempotency-Key`; **replay detection precedes the version precondition**. Request bodies use `CartLineInput` (INV-6) — never `CartLine`. | The parent's only mutation is a whole-array replace of `{variantId, quantity}` — no `line_id`, no `line_attributes`, no per-line intent, so the three `line_*` events cannot be emitted deterministically and INV-7a has nothing to key on. **The whole-array PATCH does not survive**: two mutation surfaces on one aggregate would let a client bypass INV-2. | **Medium** |
| **A-12a** | **Pointer only.** The four operation semantics that decide whether an invariant holds are **promoted into the model**: delta-add, collision → `line_updated`, attribute-edit merge and `quantity: 0` rejection are now **INV-2 / INV-2a**, with their event consequences in §1.4.4. What stays feature-spec detail is the **idempotency store**: a side table keyed `(session_id, idempotency_key)` holding the resulting version and the response body, retained 24h independently of the session TTL. "The prior result" in INV-7a means that stored body, replayed verbatim. | The App-Spec-vs-feature-spec boundary was right, but listing these separately created two sources of truth — A-12a said `quantity: 0` is rejected while INV-3 said zero means remove, and A-12a said a collision emits `line_updated` while §1.4.4 said `line_added`. Decomposition would have inherited both contradictions. | — |
| ~~A-17~~ | **Withdrawn.** The cart phase should not amend, replace or own `POST /sessions/:id/transition` — that endpoint belongs to Checkout, in a phase this spec excludes. Instead the cart **exports a precondition check** the transition calls, and emits `cart.checkout_started` from a **subscriber** on the transition. A-12 shrinks with it. | §0.1 assigns orchestration to Checkout; owning the endpoint contradicted our own boundary. | — |
| **A-18** | Amend SPEC-029 §12.1's `POST /checkout/sessions` body from `lines?: CartLine[]` to `lines?: CartLineInput[]`, and define the creation operation as **first successful line add** | The parent's creation contract accepts the *stored* line type, which lets a client submit money — directly contrary to INV-6 — and §1.2's creation trigger had no endpoint under A-12's paths | Low |
| **A-16** | Amend SPEC-029 §14.1 to add the `cart/` component folder and the `/cart` + `/cart/reconcile` routes | The parent's §6.1 diagram promises a `CartPage` its own app structure never defines; the cart UI is entirely unspecified there | Low |
| **A-13** | Amend §19.3/§19.4: the workflow instance is created at the **first transition out of `open`**, not at session creation; drop `cart_review` from `checkout_storefront_v1` | The parent returns `workflowInstanceId` from session creation and makes `cart_review` the workflow's first step — i.e. the cart phase is workflow-driven. This document says the opposite. Both cannot be built, and **Phase 1 writes the workflows.** Chosen direction keeps the cart phase plain CRUD, consistent with §0.1. | **Medium** |
| **A-14** | Resolve SPEC-029 Open Question #1 to `customer_accounts.CustomerUser` — **which requires no new endpoints**. `api/login.ts` (`requireAuth: false`, sets `customer_auth_token`), `api/signup.ts`, `api/portal/logout.ts`, `api/portal/profile.ts`, `api/portal/sessions.ts` already exist and are storefront-usable. What remains: the **reconciliation endpoint**, and stating that the customer session cookie is issued for the store host under A-9's same-site topology. | The parent leaves storefront login undecided; this closes it by pointing at what already ships. | **Low — was scored Medium on the false premise that the endpoints did not exist** |
| **A-15** | Add `ecommerce.cart.checkout_started` to the event catalogue | The primary KPI's numerator must be an emitted fact, and it is the edge that clears `abandoned_at` for converting carts | Low |

> **Correction to earlier research.** An earlier version of these notes claimed the amendments were "cheaper than they read" because `packages/checkout` already shipped the pattern. That is **wrong for A-1** — verified: `signCheckoutAccessToken` is stateless, unstored, 1h, `SameSite=Strict`, and cannot do the per-row revocation INV-15 requires. It remains true for A-2 and A-5 (the expiry-worker shape) and for rate limiting (INV-17). A-12, A-13 and A-14 are new design, not reuse.
>
> **Nothing is implemented** — no `packages/core/src/modules/ecommerce/`, no `apps/storefront/`. Every schema amendment costs one line in an unwritten migration.

---

## 2. Identity Model `PM`

| Persona | Access gated by | Identity | Org scope | Sees | Does |
|---|---|---|---|---|---|
| **Guest Shopper** | Cart Token (bearer capability) | **No account**; a capability with the INV-15 lifecycle | one store | Own cart | Create cart, add/update/remove lines |
| **Authenticated Shopper** | `requireCustomerAuth` (endpoints per **A-14**) | external — `CustomerUser` | one store, own carts | Own carts across devices | The above, plus reconciliation and cross-device access |
| **Store Operator** | ACL feature `ecommerce.checkout.view` | internal — backoffice user | own tenant/org | Sessions in their store, read-only | Inspect for support and abandonment analysis |

> The gating column holds **ACL feature ids and capabilities, not role keys** — root AGENTS.md is explicit that role names are mutable and spoofable. Nothing here goes to `requireRoles`.
>
> **"No account" is not "no credential."** The Guest Shopper holds a 30-day bearer capability over a record that can contain PII — hence INV-15.
>
> **The Store Operator's feature is broader than the persona.** `ecommerce.checkout.view` governs all statuses, including post-`open` sessions with `email` and addresses (A-7). The cart view is a filtered view of a wider permission.

**Three surfaces:** public storefront (`apps/storefront/`, where the cart lives), customer portal, backoffice.

```
External persona?
├─ Guest Shopper → YES → different UX than internal? YES → and no account at all
│                        → public storefront, Cart Token bearer
├─ Authenticated Shopper → YES → YES → CustomerUser identity, consumed on the storefront
└─ Store Operator → NO → internal user + backoffice + ACL feature
```

**Portal decision: NOT USED for the cart.** The cart is a public-storefront concern; building it on the portal would force login before add-to-cart — the most damaging possible choice against §1.2. The Authenticated Shopper's identity comes from `customer_accounts` but is **consumed on the storefront**, which is exactly why A-14 must add storefront-side auth endpoints rather than assume portal login.

**Decision log:**

| Persona | Why this identity | Alternative rejected |
|---|---|---|
| Guest Shopper | Zero identity friction is the point. The token is a capability, not an account. | Anonymous `CustomerUser` rows — junk identities, GDPR-deletable data, merge problem on every visit |
| Authenticated Shopper | Cross-device continuity needs a durable indexable owner | A cart-specific identity — a second identity system for one organization |
| Store Operator | Needs backoffice grids and filters | Portal access — internal persona on an external surface |

> **Guest-cart configuration.** Gated by `settings.cart.allowGuestCart` (A-6). When disabled, cart creation requires an authenticated Customer User and the storefront redirects to login on first add-to-cart. A store-level policy, not a persona change.

---

## 3. Workflows `PM`

Six workflows. A seventh (backoffice cart inspection) was drafted and **cut** — see §3.6.
Full edge-case detail and per-step notes: [`app-spec-notes/phase1-workflows-draft.md`](./app-spec-notes/phase1-workflows-draft.md).

### WF-1: Add the first item — cart creation

**Journey:** PDP → select variant → Add to cart → session created in `open`, Cart Token issued, line resolved → drawer confirms

**ROI:** the top of the entire funnel — every unit of the §1.2 conversion metric starts here. A failure is not a degraded experience, it is a lost order with no trace.

**Boundaries:** starts at a submitted add-to-cart for a resolved variant; ends when the server returns a persisted cart with `version`, totals and a Cart Token cookie. NOT: browsing and variant selection (SPEC-029 Phase 2); anything after `open`.

**Edge cases:** guest carts disabled → login preserving the intended variant · variant unpublished between render and add → typed rejection, no partial line · no price for the bound price kind → reject, never fall back · retry after a lost response → `Idempotency-Key` replay, no version bump · concurrent add from two tabs → 409, re-fetch through the idempotent path.

### WF-2: Review and modify the cart

**Journey:** open cart → see lines, subtotal in the store's display mode, drift and availability advisories → change quantity or remove → totals recompute

**ROI:** removes the two mechanical causes of cart-step abandonment — inability to correct a mistake, and distrust of an unexplained number.

**Boundaries:** starts when the cart is opened; ends when the shopper leaves with their intended contents persisted. NOT: addresses, shipping, discounts.

**Edge cases:** price drifted → per-line advisory, snapshot untouched · quantity change crosses a pricing tier → price re-resolves, **not** flagged as drift · variant unavailable → line greyed but removable, rest of cart usable · quantity 0 → rejected, removal is `DELETE` (INV-2a) · second tab removes a line → `clientBroadcast` refresh.

### WF-3: Return to an existing cart

**Journey:** shopper returns hours or days later, same or different device → cart is there → continues

**ROI:** **the workflow this whole spec exists for.** The only one that moves cart survival rate, the §1.2 leading indicator. Under SPEC-029 as written it does not exist — `sessionStorage` is lost on tab close.

**Boundaries:** starts when a returning shopper loads the storefront; ends when prior contents are displayed and mutable. NOT: reconciliation (WF-4).

**Edge cases:** token present but cart expired → explain, clear cookie, never show a silent empty cart · token presented against another store → store-scoped predicate rejects (INV-11) · authenticated shopper on a second device → same cart via `customer_user_id`, single by INV-12 · abandoned cart returned to → `abandoned_at` cleared, `recovered` emitted once · logout on a shared device → token invalidated.

### WF-4: Reconcile the guest cart on authentication

> Two legitimate outcomes: **adoption** (no account cart existed), **merge** (lines transferred), **supersede** (shopper chose one). Calling all three "merge" is what left the currency path without a terminal state.

**Journey:** shopper with a guest cart authenticates → carts reconciled to one → token rotated

**ROI:** login is a high-abandonment moment precisely because shoppers expect to lose their cart. Preserving it converts a drop-off into a continuation.

**Boundaries:** starts when authentication succeeds with a non-empty guest cart present; ends when one cart remains, owned, with a rotated token and `cart.merged` emitted. NOT: logout; ordinary cross-device return.

**Edge cases:** no account cart → adoption, `outcome: 'adopted'`, `sourceSessionId: null` · both non-empty with collisions → quantities summed by INV-2's key · sum exceeds INV-14 → **rejected, not clamped**, shopper shown the conflict · currencies differ → no transfer, explicit choice at `/cart/reconcile` · empty guest cart → no-op, no event · authentication during `locked` → deferred to next authenticated cart access.

### WF-5: Detect abandonment, emit the recovery signal

**Journey:** cart goes quiet past the store threshold → scanner stamps `abandoned_at` → `cart.abandoned` emitted with contents and value

**ROI:** creates the observation that closes the §1.1 flywheel. Without it, abandoned intent is invisible. The event payload is the deliverable; the campaign is not.

**Boundaries:** starts when `last_activity_at` crosses the threshold; ends when the marker is stamped and the event emitted. NOT: sending email; expiry.

**Edge cases:** repeated scans → edge-triggered on the stored marker, emitted once · guest cart with no `email` → abandonment recorded, contactability is Q-7 · threshold too short → near-100% rate carrying no signal (§1.2 coupling) · cart abandoned then expires → `expired` wins, no `recovered` · cart abandoned then **converts** → `abandoned_at` cleared at `checkout_started`, so the success is attributed.

### WF-6: Expire the cart

**Journey:** TTL passes → worker marks `expired` → cart stops being reachable and stops accepting mutations

**ROI:** prevents mispriced orders from month-stale carts and bounds a table fed by an unauthenticated public endpoint. Loss prevention, not gain.

**Boundaries:** starts when `expires_at` passes; ends at `expired`. NOT: deletion or PII erasure.

**Edge cases:** expires in an open tab → typed error and an explained fresh start · store shortens TTL → existing carts keep their `expires_at`, re-derive on next activity · expired cart still holds `email` → **unresolved, Q-10** · expiry racing the checkout transition → INV-1 and INV-10 must not both fire.

### 3.5 UI Architecture `PM + UX`

> **The building-block rule is inverted here.** SPEC-029 §14.2 forbids the storefront app from depending on `@open-mercato/*`. `CrudForm`, `DataTable`, `apiCall`, the DS token rules and the `om-backend-ui-design` skill **do not apply** — and the platform's DS lint will not catch a violation, because the files sit outside the packages it scans. What applies instead: SPEC-029 §16 (design system), §17 (WCAG 2.2 AA), §18 (RWD), and `storefrontFetch` as amended by A-9.
>
> **Gap:** SPEC-029 §14.1's component tree contains **no cart components and no `/cart` route**, despite §6.1's diagram promising a `CartPage`. All of the below is new work (**A-16**).

**Routes:** `/cart` (full review) · `/cart/reconcile` (the choice surface §1.4.7 promised and had nowhere to render) · plus a drawer overlay that costs no navigation.

**Components (all new):** `CartBadge` (binds `item_count`, not `line_count`) · `CartDrawer` · `CartPage` · `CartLineRow` · `CartTotalsPanel` · `CartEmptyState` · `CartExpiredNotice` · `LineAdvisory` (the visible half of INV-9) · `ReconcileChoice`.

**Key flows:**

| Persona | Task | Flow | Clicks |
|---|---|---|---|
| Guest Shopper | Add first item | PDP → Add to cart → drawer | **1** |
| Guest Shopper | Review and adjust | badge → drawer → stepper | **1–2** |
| Returning shopper | Resume | any page → badge already populated → `/cart` | **1** |
| Authenticated Shopper | Resolve a conflict | login → `/cart/reconcile` → choose | **2** |

**Empty and exceptional states.** The governing rule: **never render an empty cart when the reason is not "you have not added anything"** — a shopper who returns to a cart they believe was saved and sees an empty box concludes the store lost their order.

| State | Shown | Action |
|---|---|---|
| Never had a cart | "Twój koszyk jest pusty" + what the store sells | Browse |
| Expired | Explains expiry and names the date | Browse. **No false promise of restoration** |
| Guest carts disabled | Sign-in prompt **at the point of add**, not as a later surprise | Sign in, return to the product |
| Line unavailable | Line greyed with a reason; rest of cart usable | Remove |
| Price drifted | Old and new price together, no alarm styling | Accept or remove |
| At INV-14 cap | Message naming the limit | Remove something |
| Reconciliation conflict | Both carts side by side, **no default pre-selected** | Choose |
| 409 | Silent re-fetch; never a technical error, and the replay goes through the idempotent path | — |

**Real-time:** three events carry `clientBroadcast: true`, so a second tab updates via the DOM Event Bridge — subject to **Q-16** (the bridge is an `@open-mercato/*` capability the storefront may not import).

### 3.6 WF-7: Backoffice cart inspection — cut, then restored

Drafted, cut for moving no §1.2 metric, and **restored at architect checkpoint #1**. The cut rested on "every metric is answerable from the event stream" — true for a developer, false for a merchant: `audit_logs` has no subscribers and the platform ships no event-occurrence browser. A merchant with no cart view is blind to their own funnel.

Cost is ~1 commit (`checkout`'s transactions list page is 14 lines of `page.meta.ts`). A-7 and the Store Operator persona stay.

### 3.7 Production reality check

> *"Could a client run their business on this today?"* A workflow that cannot complete end-to-end is a demo.

| WF | Completes? | Blocker |
|---|---|---|
| WF-1, WF-2, WF-3 | **Yes**, given the amendments and SPEC-029 Phase 1 | — |
| WF-5 | **Yes**, given A-5 | — |
| **WF-4** | **Yes** | **Corrected at architect checkpoint #1.** An earlier draft called this workflow untriggerable. That was wrong: `customer_accounts` already ships the full auth surface as `requireAuth: false` HTTP routes — `api/login.ts` (verified: sets the `customer_auth_token` cookie), `api/signup.ts`, `api/portal/logout.ts`, `api/portal/profile.ts`, `api/portal/sessions.ts`, `sessions-refresh.ts`, password reset. The trigger is a successful login. A-14 shrinks accordingly. |
| **WF-6** | **No** | **Q-10.** A worker that marks rows `expired` forever, on records holding `email`, with a merchant-configurable 30-day retention, is not a finished workflow for an EU-market platform. |

**Cross-cutting:** every workflow depends on SPEC-029 Phase 1 (the store-context resolver), which is unimplemented. The **UI** additionally depends on SPEC-029 Phases 2 and 4 — there is no `apps/storefront/` and no PDP to add to cart from. That split is what makes the API-only first slice in §4.3 the right one.

---

## 4. Workflow Gap Analysis `Architect`

Scored in **atomic commits** (template §4 scale). Shared foundations are counted **once**, in §4.1, rather than re-counted per workflow — double counting would inflate the plan by roughly half.

### 4.1 Shared foundation (prerequisite to WF-1..WF-6)

> Re-scored at architect checkpoint #1. Six items shrank because the platform already ships the pattern.

| Item | Scope | Commits | Notes |
|---|---|---|---|
| SPEC-029 Phase 1 — store context resolver | **platform (parent)** | — | **Blocking dependency, not our commits** |
| Session entity + migration with all amendment columns, incl. the `settings.cart` type edit | app | 1 | |
| **Cart Line Resolver** — fetch, then `calculateLine`/`buildBaseLineResult` from `sales` | app | 2 | Was 3. Normalization is a **call**, not a reimplementation |
| Canonical `line_attributes` helper promoted to `packages/shared` | **platform** | 1 | Promote `shipping_carriers/lib/shipment-idempotency.ts`'s `stableSerialize` — **not** the `search` copy; doing so also fixes a live bug at `payment-operation-idempotency.ts:33` |
| Line sub-resources + idempotency store | app | 2 | Was 3. Adapt `shipment-idempotency.ts` (claim/resolve/release + request hash) and the header→unique-index→replay pattern in `checkout/api/pay/[slug]/submit` |
| Cart Token: generation, hash, cookie, rotation | app | 1 | Was 2. `auth/lib/tokenHash.ts` exports `generateAuthToken`/`hashAuthToken` (HMAC-SHA256, cross-package); `CustomerSessionService` is already a 30-day rotatable hash-at-rest token on this identity surface. **Do not follow `scimTokenService`** — it uses per-row-salted bcrypt, deliberately non-deterministic and unusable for lookup |
| Rate limiting | app | 1 | Adopt `readEndpointRateLimitConfig` + `checkRateLimit`; copy `sales/api/quotes/accept/route.ts`. ⚠️ `RATE_LIMIT_TRUST_PROXY_DEPTH` defaults to **0**, which collapses per-IP limiting into one global bucket — must be set |
| Event catalogue (9 events) | app | 1 | |
| Worker registration | app | 1 | Use `packages/scheduler` (DB-backed cron, admin UI, auto-discovers module `workers[].queue`). Copy `ai-assistant`'s `ai-token-usage-prune.ts` + its `setup.ts` registration — **not** `checkout`'s `transaction-expiry.worker.ts`, which is an **orphan nothing enqueues** |
| **Subtotal** | | **10** | was 13 |

### 4.2 Per-workflow deltas

| WF | Delta over the foundation | Scope | Commits | Blocks ROI? |
|---|---|---|---|---|
| WF-1 | Creation-on-first-add (A-18) | app | 1 | no |
| WF-2 | Drift/availability advisory computation | app | 1 | no |
| WF-3 | Cross-device lookup; expiry-aware resume; A-9 topology | app | 2 | no |
| WF-4 | Reconciliation endpoint + choice dialog. **Auth already exists** — no new endpoints | app | 3 | **no — ungated** |
| WF-5 | Abandonment scanner + scheduler registration | app | 1 | no |
| WF-6 | Expiry worker + **retention rule (Q-10)** | app | 1 + ? | **yes — Q-10** |
| WF-7 | Backoffice cart list — **restored**, see below | app | 1 | no |
| §3.5 | Cart component tree + routes (A-16) | app | 3 | no |

> **WF-7 restored.** Cutting it was wrong: `audit_logs` has no subscribers and the platform has no event-occurrence browser, so "answerable from the event stream" is true for a developer and false for a merchant. The cost is ~1 commit — `checkout/backend/.../transactions/page.meta.ts` is 14 lines. A-7 (`ecommerce.checkout.view`) and the Store Operator persona stay.
>
> **`/cart/reconcile` demoted to a dialog on `/cart`.** Adoption is the dominant path and needs no UI at all; a dedicated route added three landing states for two rare cases.

### 4.3 Summary and first slice

| Group | Priority | Commits | Blocks ROI? |
|---|---|---|---|
| Foundation | highest | **10** | no |
| WF-1 + WF-2 + WF-3 + WF-5 server halves | highest | **5** | no |
| §3.5 UI + WF-1..WF-3 client halves | high | **5** | no |
| WF-4 | high | **3** | no |
| WF-7 | medium | **1** | no |
| WF-6 | medium | **1 + unknown** | yes — Q-10 |
| **Total scored** | | **26** | was 30 |

**First shippable slice — API-only, 15 commits.** Foundation (10) + the server halves of WF-1/2/3 and WF-5 (5). It depends only on SPEC-029 **Phase 1** and `catalog`, is verifiable by integration tests alone, and delivers the survival-rate indicator immediately.

The earlier "foundation + UI" slice under-counted its dependencies: the 3 UI commits need SPEC-029 Phases **2 and 4** as well — there is no `apps/storefront/` and no product page to add to cart from. **UI ships with Phase 4.** WF-5 is pulled forward because one commit closes the flywheel's observation loop.

**One commit is scoped `platform`** (the canonical-JSON helper) and needs an upstream PR first — down from two, since A-14 requires no new platform endpoints.

---

## 5–7

*§5 user stories, §6 platform mapping and §7 phasing follow the architect checkpoint on §4.*

---

## 10. Open Questions

**Closed:** Q-1 (event namespace — keep `ecommerce.cart.*`), Q-4 (promotions excludable; the real blocker was tax basis), Q-6 (surface drift at read, do not resolve).

| # | Question | Owner | Status |
|---|---|---|---|
| Q-2 | `open` TTL default 30 days — configurable range and upper bound? | PM | Open |
| Q-3 | Abandonment threshold — 24h proposed, coupled to the TTL | PM | Open |
| Q-5 | Portal surface for cart history — later or never? | PM | Deferred |
| Q-7 | Guest carts have no `email` until checkout. Is recovery guest-capable at all, or authenticated-only? | PM | Open |
| Q-8 | Currency lifecycle over 30 days: store default changes, currency deactivated, shopper switches. Proposed: switch = new session, old one terminal. | PM + Architect | Open |
| Q-9 | Locale drift: snapshots freeze language, §10 of the parent resolves per request. Proposed: re-resolve display at read, snapshot is the audit record. | UX | Open |
| Q-10 | **Retention/GDPR.** The expiry worker marks `expired`, it does not delete; A-2 extends retention to 30 days by default on rows that can hold `email`. Needs a retention rule and an erasure path. | PM + Architect | **Open — compliance** |
| Q-11 | Rate-limit **budgets** (the requirement itself is now INV-17). Cart mutations are per-keystroke-ish, unlike checkout's page-view config. | Architect | Open |
| Q-12 | **Shrunk to A-13 alone.** A-11 was withdrawn (the parent already specifies body `version`); A-14 needs no new endpoints. A-13 (workflow-instance creation) is a spec edit, not an upstream negotiation — SPEC-029 §19.5 already brackets §19 as a forward reference gated on workflow docs. | Architect | Open — deferred to §7 at the user's direction |
| Q-13 | Does an authenticated shopper's customer group affect cart pricing (`PricingContext.customerGroupId`), or is cart pricing always guest-equivalent until checkout? | PM + Architect | Open |
| Q-14 | The catalog's seed data ships rows with `unitPriceNet == unitPriceGross` **and** a non-zero `taxRate` (`catalog/seed/examples.ts:990`). The resolver now rejects such lines — so the demo store cannot add to cart until its seed is corrected. Fix the seed, or add a documented tolerance? | Architect | **Open — blocks demo** |
| Q-15 | `requireCustomerAuth` guards API routes; the storefront app is a separate Next.js app that cannot import `@open-mercato/*` (SPEC-029 §14.2). A-14 must therefore state that page-level protection is the storefront's own concern and only the API is platform-guarded. | Architect | Open |
| ~~Q-16~~ | Multi-tab sync for guest carts | **Resolved — not available as-is.** The SSE stream is `requireAuth: true` and filters by tenant/org/user/role; the portal bridge needs a customer session. Neither has an audience for a Cart Token bearer. Guest multi-tab sync needs its own transport or leaves scope. |
| ~~Q-14 / Q-17~~ | Catalog seed's `net == gross` + `rate > 0` rows | **Mostly closed.** `buildBaseLineResult` in `sales/lib/calculations.ts` already has a branch handling exactly this shape; the cart inherits it by calling the shared calculator. What remains is whether to fix the seed anyway. |

---

## 11. Changelog

### 2026-08-13

- **v7** — **Architect checkpoint #1 applied. Verdict was RE-MAP NEEDED and it was right.**
  - **Money representation corrected — the most serious error in the document so far.** All `sales` money is `numeric(18,4)` and `calculations.ts:22` rounds to 4dp; **the platform has no minor-unit money at all**. v4–v6 mandated integer minor units, which would have guaranteed the cart and the order disagree at handover — the exact defect INV-5a exists to prevent. The cart now uses the platform's representation.
  - **`sales/lib/calculations.ts` is called, not paraphrased.** `calculateLine`/`buildBaseLineResult` are exported and already implement every row of §1.4.8's normalization table, including the seed's `net == gross` shape (largely closing Q-14/Q-17).
  - **WF-4's "no trigger exists" was factually wrong.** `customer_accounts` ships `api/login.ts` (verified `requireAuth: false`, sets `customer_auth_token`), signup, logout, profile, sessions and refresh. A-14 needs **no new endpoints**; WF-4 completes end-to-end and is **ungated**.
  - **A-11 and A-17 withdrawn.** The parent already specifies body `version` and its 409 body, so A-11 amended nothing; A-17 had the cart owning a transition endpoint its own §0.1 assigns to Checkout — now a precondition check plus a subscriber.
  - **WF-7 restored** — `audit_logs` has no subscribers and there is no event browser, so "answerable from events" was true for a developer and false for a merchant. `/cart/reconcile` demoted to a dialog.
  - **`clientBroadcast` is inert for guest carts** — the SSE stream is `requireAuth: true`; Q-16 resolved negatively.
  - **Reuse found for six foundation items** (`auth/lib/tokenHash.ts`, `shipment-idempotency.ts`, `packages/scheduler`, `readEndpointRateLimitConfig`), plus the trap that `RATE_LIMIT_TRUST_PROXY_DEPTH` defaults to 0. `checkout`'s expiry worker is an orphan nothing enqueues — not the pattern to copy.
  - **Re-scored: foundation 13 → 10, total 30 → 26, platform-scoped commits 2 → 1.** First slice changed to **API-only, 15 commits**, because the UI slice silently depended on SPEC-029 Phases 2 and 4.
- **v6** — **Phase 1**: six workflows with ROI, boundaries and edge cases (§3); UI architecture with the inverted building-block rule and the `/cart/reconcile` surface §1.4.7 had promised (§3.5); WF-7 cut with its consequences named (§3.6); production reality check — **WF-4 and WF-6 do not complete end-to-end** (§3.7); gap analysis scored in atomic commits with shared foundations counted once, **23 commits for the first shippable increment** (§4).
- **v5** — Challenger pass 4: 8 CRITICAL addressed, plus a **consistency sweep** — the pass's most useful output was the observation that v4 fixed rules in one place and left them stated elsewhere.
  - **Money model made internally consistent.** v4's line-total rounding fix had reached §1.4.3 only; INV-5 and §1.4.8 still carried v3's round-at-the-unit-price rule while §1.4.3 cited them as its authority. INV-5 restated, INV-13 restated (and `subtotal_net + tax ≠ subtotal_gross` declared *expected* after per-line rounding), the resolver step corrected.
  - **INV-5a added**: net/gross/tax arithmetic follows `sales/lib/calculations.ts`, where **`tax_rate` is a percentage**. v4's validation rule `tax_amount ≈ net × tax_rate` was wrong by 100× and would have rejected every correct catalog row.
  - **Validation replaced by normalization.** `tax_amount` is nullable and left null by the seed and the command layer; the resolver now derives what is missing and rejects only genuinely contradictory rows. This is also what unblocks the demo store (Q-14) without loosening the boundary.
  - **Quantity changes re-resolve the price** — tiered pricing (`min_quantity`/`max_quantity`) is real and `PricingContext` takes quantity. Undefined in all four prior versions; the two readings charge different money.
  - **INV-15's status ceiling replaced by rotation.** v4's ceiling revoked the guest's only credential at the moment they start checkout, making guest checkout unreachable.
  - **A-12a's contradictions resolved by promotion**: delta-add, collision → `line_updated`, attribute-edit merge and `quantity: 0` rejection are now INV-2 / INV-2a. A-12a had contradicted Strong INV-3 and §1.4.4's own event table.
  - **`cart.merged` payload fixed for adoption**: `sourceSessionId` is nullable and `outcome` gains `adopted`. v4's contract implied a terminal source cart that adoption never produces — on a FROZEN payload, on the dominant path.
  - **A-16, A-17, A-18 recorded**: the missing cart UI in the parent's component tree, the displacement of `POST /sessions/:id/transition` (with Checkout as the endpoint's owner), and `POST /checkout/sessions` accepting `CartLineInput[]` rather than the stored type.
- **v4** — Challenger pass 3: 7 CRITICAL addressed.
  - **Money arithmetic corrected.** Unit prices are carried unrounded; rounding happens **once, at the line total**. v3 rounded the unit price and then multiplied by quantity, which scales the rounding error with quantity. `tax_amount` is now snapshotted — it is the catalog's own reconciler between net and gross, and discarding it made the triple unverifiable. The resolver **validates** the quadruple and rejects inconsistent rows; verified that the platform's own seed ships such rows (Q-14).
  - **INV-6 widened** from `totals_snapshot` to all money, with a distinct `CartLineInput` request type — v3 protected the totals but not the line prices they are derived from, on a public unauthenticated API.
  - **`checkout_started` got an emitter**: `POST /sessions/:id/checkout`. A-13 had moved the workflow out of the cart phase without naming the operation that exits it, leaving the primary KPI's numerator unemittable.
  - **INV-15 got a TTL and a status ceiling.** INV-8's "ownership ≠ access" clause had made the Cart Token a 30-day bearer credential that survived into the checkout phase, where the row gains `email` and addresses.
  - **§1.4.7 gained the dominant path**: a guest cart with no existing account cart is **adopted**, emitting `cart.merged` with `outcome: 'adopted'`. Without it the merge metric read zero on the path that works.
  - **A-12 tightened and A-12a added**: the parent's whole-array PATCH does not survive (two mutation surfaces would let a client bypass INV-2), and the five operation semantics that determine whether invariants hold are recorded as binding obligations on the feature spec rather than left to it.
- **v3** — Challenger pass 2: 8 CRITICAL fixed (five of them defects introduced by v2's own fixes), 14 WARNING addressed.
  - **Line identity unified**: `(variant_id, canonical(line_attributes))` is the domain key; `line_id` is server-assigned and addressing-only; idempotency moves to an `Idempotency-Key` header (A-12). v2 had specified two incompatible keys, which reproduced the double-add invisibly.
  - **Canonical form of `line_attributes` specified** as part of the domain (absent/null/`{}` unified, flat string map, sorted keys, trimmed + NFC, bounded) — a Strong invariant over jsonb cannot leave equality undefined, and no shared canonical-JSON helper exists in the repo.
  - **Tax basis sourced from the price, not the store**: per-line net + gross + `tax_rate` + `price_kind_display_mode`; `CartTotals.display_tax_mode` demoted to a display selection. v2's store-wide `tax_mode` was a third source of truth for a fact the catalog already carries twice, and discarded data checkout needs.
  - **Money precision rule** added: `numeric(16,4)` → minor units, half-up, once, in the resolver.
  - **A-12..A-15 added**: the line mutation surface (the parent's whole-array replace cannot carry line intent), workflow creation moved out of the cart phase (the parent makes `cart_review` a workflow step — this decides whether add-to-cart is CRUD or a transition), storefront customer auth (the parent leaves login undecided, so the merge model had no execution point), and `cart.checkout_started`.
  - **`version` semantics**: counts client-intent mutations only; system writes never bump it; replay detection precedes the version check. Otherwise every shopper returning after the abandonment threshold 409s into the re-apply path.
  - **INV-17** added: rate limiting is a requirement, not a deferred budget.
  - **Reconciliation** (renamed from merge) covers supersede; currency conflict, INV-14 overflow, dual-claim request resolution, deferred-merge trigger and worker predicates all decided.
  - INV-8 clarified: ownership ≠ access; a live token still serves an owned cart's other tab.
  - §1.4.8: the price **fetch** named as a distinct, expensive step; `PricingContext` mapping stated.
  - Corrections to earlier research: A-1 does **not** reuse `packages/checkout`'s pattern (stateless HMAC, unstored, 1h); `OptimisticLockConflictBody` is timestamp-only so A-11's 409 body is now concrete; event-id counts corrected to 420 / 21:3.
- **v2** — Challenger pass 1: 8 CRITICAL fixed (ownership model, session-id credential, tax basis, merge rules, event emittability, customer-term collision, cookie transport), amendments 4 → 11, invariants 10 → 16, §0.1, §1.4.7, §1.4.8 added.
- **v1** — Phase 0 initial.
