# Challenger Gate — Pass 3 (v3 of `2026-08-13-app-spec-storefront-cart.md`, §0 / §1 / §2 / §10)

Reviewer role: domain-driven-design expert. Third pass, following
[`challenger-phase0.md`](./challenger-phase0.md) (8 CRITICAL) and
[`challenger-phase0-pass2.md`](./challenger-phase0-pass2.md) (8 CRITICAL, five of them self-inflicted).
Sections 3–7 out of scope for this pass.

**Verdict: 7 CRITICAL, 13 WARNING. NOT READY for Phase 1.**

The pass-2 failure mode has not gone away, but it has changed shape. v2's defects came from fixes applied
*independently of each other* (two identity keys, a third tax-basis owner). v3's defects come from fixes
applied **at the wrong altitude**: A-12 names three URLs but no operation semantics; A-13 removes the
workflow from the cart phase without replacing the operation that exits it; the money rule fixes the *basis*
of an amount and leaves its *arithmetic* self-contradictory; INV-8's new "ownership ≠ access" clause extends
a credential's authority without bounding it. In each case the finding's letter is satisfied and the adjacent
mechanism is now missing.

Concentration, in order of blast radius:

1. **A-12 is a routing table, not a contract** (CR3-1, CR3-2, CR3-6). The amendment introduced to make the
   three `line_*` events deterministic leaves the most common path — re-adding an item already in the cart —
   ambiguous in four ways, gives `Idempotency-Key` no store, and defines no client input type. Three of
   pass 2's CR-1/CR-3 sub-cases survive inside it.
2. **The money model is arithmetically unsound** (CR3-3). New in v3, missed by both prior passes, and the
   one defect here that an implementer will not stop and ask about — they will implement it as written and
   ship a rounding bug into `sales`.
3. **Two credentials/operations lost their bounds** (CR3-4, CR3-5): the `open →` exit has no operation and
   therefore no emitter for the primary KPI; the Cart Token has no independent TTL and no status ceiling.

---

## Ground truth verified this pass

Re-verified in code, not against the author's notes.

| Claim | Verdict |
|---|---|
| `CatalogProductPrice` carries `unit_price_net`, `unit_price_gross`, `tax_rate`, `tax_amount` | ✅ `catalog/data/entities.ts:824-834` — all four, all nullable |
| "The catalog stores prices as `numeric(16,4)`" (§1.4.3) | ⚠️ True for `unit_price_net`/`unit_price_gross`/`tax_amount`; **`tax_rate` is `numeric(7,4)`** |
| Net and gross are independently stored columns with no DB-level consistency rule | ✅ No CHECK constraint in `catalog/migrations/*`; consistency is **command-layer only** (`catalog/commands/prices.ts:351-368`, `:620-679` → `taxCalculationService.calculateUnitAmounts`) |
| The catalog can persist an internally inconsistent (net, gross, rate) triple | ✅ **Shipped seed data already does**: `catalog/seed/examples.ts:990-992`, `:1011-1012` write `gross == net` with a non-zero `taxRate`. Direct `em.create` bypasses the command layer entirely |
| `taxAmount = gross − net`, all values rounded at 4 dp | ✅ `sales/services/taxCalculationService.ts:75-89`, `roundAmount` `:134-141` |
| `resolvePrice`/`resolvePriceMany` take caller-fetched `PriceRow[]`; never read amounts | ✅ `catalogPricingService.ts:9-12`; selection uses qty/date/scope/kind only (`lib/pricing.ts:52-87`) |
| `PriceRow` is the full entity, so net + gross + rate + `tax_amount` all survive resolution | ✅ `lib/pricing.ts:21-26` |
| `PricingContext = { channelId?, offerId?, userId?, userGroupId?, customerId?, customerGroupId?, quantity, date }` | ✅ `lib/pricing.ts:10-19` |
| `OptimisticLockConflictBody` is timestamp-only | ✅ `optimistic-lock-headers.ts:25-30` |
| A new `packages/core/src/modules/ecommerce/` entity escapes `optimistic-lock-editable-entities.test.ts` | ✅ Hand-curated maps at `:30-60` and `:124-155`; exemption = omission |
| "The UI test's glob covers `packages/core/src/modules/**` only" (A-11) | ⚠️ **Incomplete.** A third file, `optimistic-lock-ui-coverage-workspace.test.ts:159-176`, scans `packages/<pkg>/src/modules` for **`.ts` and `.tsx`**. `apps/storefront/` still escapes all three |
| No shared canonical-JSON helper in `packages/shared` | ✅ Only `packages/search/src/vector/services/checksum.ts:3` (module-local, unexported) |
| `rateLimiterService` exists as a DI key | ✅ `packages/shared/src/lib/ratelimit/service.ts:9`; registered at `core/bootstrap.ts:207-212` — **conditionally**, `null` on failure, helpers fail open |
| SPEC-029 §19.3 makes `cart_review` the workflow's first step and the branch point for guest-vs-customer | ✅ lines 1520-1524 |
| SPEC-029 §12.1's session GET returns `workflowInstanceId`/`currentStep`/`availableTransitions`, and §19.4 polls `workflowStatus` on an open session | ✅ lines 862-890, 1571-1580 |
| SPEC-029 §14.2's "MUST NOT depend on `@open-mercato/*`" is a constraint on the **storefront app's npm dependencies**, not on the API | ✅ line 1090 — A-14's server-side endpoints do not conflict with it (but see W7) |

---

# CRITICAL

## CR3-1 — A-12 defines three URLs and no operation semantics; the collision path is undefined four ways, and INV-2 (Strong) is violable by an ordinary shopper action (§1.4.3, §1.4.4, §1.4.5, §1.5 A-12)

Pass 2's CR-1 was resolved *as an identity question* — `(variant_id, canonical(line_attributes))` is the key,
`line_id` addresses. Correct. But CR-1's sub-cases (b) and (c) were about **what happens on collision**, and
A-12 answers them by naming HTTP verbs. Verbs are not domain facts, and INV-2 makes the fact depend on state:

**(a) `POST /lines` quantity is delta or absolute — undefined.** INV-2: *"adding an existing key **increments
quantity**."* Increments by what? The request's `quantity`, or to it? Every other line in the document is
silent. A shopper on a PDP with a quantity stepper set to 3, adding an item already in the cart at 2, gets
either 5 or 3. Both are defensible product decisions; only one can be built.

**(b) Which event fires on an increment, and with what payload.** §1.4.4 binds `line_added` to `POST …/lines`
and `line_updated` to `PATCH …/lines/:lineId`. On a colliding POST **no line is added** — a quantity changed.
So either `line_added` fires for a non-addition (and its payload has `quantity` but no `previousQuantity`,
so a `clientBroadcast: true` consumer in the shopper's second tab cannot tell whether to *set* or *add*), or
`line_updated` fires from an endpoint the table says does not emit it. Pass 2 raised this verbatim
(CR-1(c): *"The `line_added` event fires with `lineId: L1`? or `L0`? `line_updated` instead?"*). It is not fixed —
the emitter column was rewritten to name endpoints, which is precisely the framing that cannot answer it.

**(c) `PATCH …/lines/:lineId` has no stated mutable field set, and both readings are broken.** If
`line_attributes` is patchable, a shopper editing an engraving from "Bob" to "Ann" on a cart that already holds
an "Ann" line drives two lines to the same canonical key — a **Strong invariant violated by a normal UI action**,
with no stated resolution (merge into the existing line? 409? which events?). If it is not patchable, then
editing personalization is remove+add, the line loses its `added_at` and `line_id`, and the document never says
so. Pass 2's CR-1(b) is therefore still open. *Answering the pass-3 brief directly: yes, a shopper can reach a
state where two lines share a canonical key, and PATCH is the route.*

**(d) `PATCH {quantity: 0}` vs DELETE.** INV-3: *"zero means remove."* §1.4.4 binds `line_removed` to DELETE
only. So a PATCH-to-zero removes a line and emits `line_updated`, or emits `line_removed` from the wrong
endpoint, or is rejected — unstated.

**(e) Does A-12 replace or supplement §12.1's `PATCH /sessions/:id { lines }`?** The parent's whole-array
replace still exists in the contract and must survive for `email`/addresses at checkout. If it survives for
`lines`, it is a second write path that bypasses INV-2, the resolver and the three events entirely. A-12 says
"define the cart-phase mutation surface" and never says what happens to the surface it displaces.

**Fix:** A-12 must specify, per endpoint: request semantics (delta vs absolute), the mutable field set, the
collision rule for both POST and PATCH, and the **fact→event mapping** stated as domain facts rather than
routes — `line_added` iff a line came into existence, `line_updated` iff a quantity or attribute changed on an
existing line (including the POST-collision case), `line_removed` iff a line ceased to exist (including
PATCH-to-zero). Then state explicitly that §12.1's `lines` body is removed from the cart phase.

## CR3-2 — `Idempotency-Key` on line mutations has no store, no retention and no scope; INV-7a is unimplementable, and A-2's cost argument is now false (§1.4.2, §1.4.5 INV-7a, §1.5 A-2/A-12)

INV-7a is a **Strong** invariant: *"An idempotent replay (same `Idempotency-Key`) **returns the prior result**
and does not increment `version`."* Returning the prior result requires storing the prior result. Nothing in
the document stores anything:

- §1.4.2's `idempotency_key` column is documented as *"Session creation"* only.
- A-12 says the three line endpoints "accept `Idempotency-Key`" and stops.
- Pass 2's CR-3 fix explicitly prescribed *"a stored `key → (session_id, resulting_version)` map"*. v3 adopted
  the header and dropped the map.

Worse, A-2's cost line now argues **against** the mechanism A-12 needs: *"`idempotency_key` is a column on the
session row (**not a separate table, so unbounded growth was never the failure mode**)."* That was true when
one key existed per session. Under A-12 a 30-day cart accumulates one key per mutation — hundreds — which is
exactly a separate table with exactly the growth problem A-2 declares nonexistent. **Two amendments in the same
table contradict each other about the same mechanism.** Phase 1 writes the migration; this is a schema decision
with no owner.

Also unstated and load-bearing: is the key scoped per session, per endpoint, or globally? What happens on the
§7.5.1 `idempotency_key_mismatch` case (same key, different body) for a line mutation? How long is a mutation
key retained relative to the 30-day row TTL?

**Fix:** state where mutation keys live (side table keyed by `(session_id, key)` with its own retention, or a
bounded ring on the session row), what "the prior result" is (the resulting line state + version), the
scope/mismatch rule, and correct A-2's rationale, which no longer describes the system being specified.

## CR3-3 — The money rule is arithmetically self-contradictory: rounding at the unit price scales the error by quantity, net and gross are rounded independently, and the field that reconciles them is discarded (§1.4.3, §1.4.5 INV-5/INV-13, §1.4.8, §0.1)

CR-5's fix — source the basis from the price, snapshot net + gross + `tax_rate` per line — is the right call.
The rounding rule bolted onto it is not. Three compounding defects, all new in v3:

**(a) Round-then-multiply.** The money note says rounding from 4 dp to minor units happens *"exactly once, in
the Cart Line Resolver"* — i.e. **on the unit price**. INV-13 then defines `line_total_* = unit_price_* ×
quantity`. So the ≤0.5-minor-unit rounding error on the unit price is multiplied by quantity. Catalog net
`12.3450`, qty 10: the cart stores 1235 × 10 = 12350; the true value is 12345. Five grosz, on a line, before
tax. INV-14 permits store-configured large quantities, so the error is unbounded in practice. This is not a
theoretical case: the EU B2C pattern is a merchant-entered gross with a **derived** net
(`taxCalculationService.ts:82-85` divides), which lands on 4 significant decimals routinely.

**(b) Independent rounding of net and gross destroys the relationship between them.** Both are rounded from
4 dp half-up, separately. Net `1.2350` → 124; gross `1.518050` → 152. But `124 × 1.23 = 152.52 → 153`. The
stored triple `(net=124, gross=152, tax_rate=0.23)` is now internally inconsistent: no two of the three derive
the third. §0.1 promises checkout *"never re-queries the catalog 30 days later"* — it hands checkout three
numbers that disagree.

**(c) `tax_amount` — the catalog's own reconciler — is dropped.** Verified: `CatalogProductPrice` stores
`tax_amount`, and `taxCalculationService` defines it as `gross − net` at 4 dp. `PriceRow` carries it through
resolution unchanged. §1.4.3 snapshots net, gross and `tax_rate` and **not** `tax_amount`, so the cart discards
the only field that makes the triple reconcilable, and it cannot be reconstructed from the rounded pair. This is
the same class of error CR-5 identified ("discarding data checkout needs"), reintroduced one field over.

**(d) The anti-corruption layer translates the triple but never validates it.** §1.4.8's rejection cases cover
existence, publication, scope, price kind, currency and bounds — not consistency. And the repo **demonstrably
produces inconsistent triples**: `catalog/seed/examples.ts:990-992` writes `gross == net` with a non-zero
`taxRate` via direct `em.create`, bypassing the command layer that is the only place the rule is enforced (no DB
constraint exists). An ACL whose stated job is to stop foreign data corrupting the aggregate will faithfully
snapshot a 0%-tax gross onto a 23%-tax line and hand it to `sales`.

Consequence for the question asked: `subtotal_net + tax = subtotal_gross` holds **only** if tax is *defined* as
`subtotal_gross − subtotal_net`. The document never defines tax at all (§0.1 hands it to checkout), so checkout
is free to compute `Σ(line_net × rate)` instead — which will not foot against the two subtotals the cart shipped.

**Fix:** decide and write down (i) whether the rounding boundary is the unit price or the line total — if the
line total, INV-13's `line_total = unit × quantity` must be restated as `round(unit_4dp × quantity)` and INV-5
must permit a 4 dp unit price in the snapshot; (ii) which of net/gross is authoritative and how the other is
derived (mirror `taxCalculationService`'s "net wins if present" rule so cart and order agree); (iii) snapshot
`tax_amount` alongside the other three; (iv) add "net/gross/`tax_rate` mutually inconsistent" to §1.4.8's
rejection cases; and (v) state whether the cart's implied tax (`gross − net`) is a handover contract or an
artifact checkout may override.

## CR3-4 — A-13 removes the workflow from the cart phase without replacing the operation that exits it, so `cart.checkout_started` — the primary KPI's numerator — has no emitter (§1.4.4, §1.2, §1.5 A-13)

A-13's direction is right and §0.1's handover table is consistent with it. Its consequence is unworked.

SPEC-029's only operation that leaves `open` is `POST /sessions/:id/transition { version, toStepId }` — a
**workflow** transition against an instance created at session creation. A-13 states that no workflow instance
exists during `open`. There is therefore nothing to transition, and no replacement operation is defined
anywhere: A-12 defines only line mutations, A-14 defines auth and reconciliation, and §12.1's `PATCH` writes
fields, not status.

§1.4.4 nevertheless lists `ecommerce.cart.checkout_started` with emitter *"API, at the `open →` transition."*
There is no such API. §1.2 makes this event the **numerator of the primary business goal**. Pass 2's W-8
complained that the numerator was emitted by nothing; v3 added the event (A-15) and, in the same pass, removed
the machinery that would emit it. The metric is no more computable than before.

This also leaves §0.1's central boundary claim unresolved: is `open → locked` a status write on the session
(which the cart phase could own the emission of) or a workflow start (which it could not)? The document decided
the workflow does not exist yet, which forces the former, but never says it.

**Fix:** name the operation that exits `open` and record it in A-12 or A-13 — minimally *"`POST
/sessions/:id/checkout` creates the workflow instance, transitions `open → locked`, emits
`cart.checkout_started` and clears `abandoned_at`"* — and state that it is the cart phase's last write.

## CR3-5 — INV-8's "ownership ≠ access" clause extends the Cart Token's authority without bounding it: no independent TTL, no revocation on abandonment, no status ceiling (§1.4.5 INV-8/INV-15, §1.4.6, §1.4.7)

Pass 2's W-10 correctly identified the contradiction (rotation is ceremony if a token grants nothing once the FK
is set) and v3 resolved it the defensible way: a live token continues to grant access to an owned cart.
§1.4.6's table now agrees. The clause is internally consistent — and it opened two holes the previous reading
closed by accident.

**(a) The token has no lifetime of its own.** INV-15 specifies entropy, hash-at-rest, rotation on reconciliation
and login, and invalidation on logout. It specifies **no expiry**. `cart_token_hash` is one column on a row with
a 30-day, activity-extended TTL, so the token lives as long as the cart. §1.4.7's logout rule covers *explicit*
logout only. On a shared device — a kiosk, a library terminal, a family laptop — a shopper who authenticates,
fills a cart and closes the browser leaves a live 30-day bearer credential in a cookie jar, and INV-8's new
clause is what makes that credential still work against an **owned** cart. Under v2's reading it would have
stopped working the moment the FK was set. This is pass 1's C-5 item 5 (session fixation) re-entering through
the fix for pass 2's W-10.

**(b) The token's authority has no status ceiling.** INV-1 bounds *mutations* to `open`. Nothing bounds *reads*.
§1.4.6's table describes the cart phase only, and SPEC-029 §12.1's session GET is one endpoint across all
statuses (checkout needs it). So a Cart Token minted for a guest cart continues to read the same row after it
becomes `locked`, `submitted` and `completed` — by which point it carries `email`, `shipping_address` and
`billing_address`. INV-16 was written to stop the *session id* being a credential over that record; the Cart
Token now is one, with a longer life and no stated end.

**Fix:** give the token its own bounded lifetime independent of the cart's TTL (idle expiry plus an absolute
cap, both shorter than 30 days), state that a cart's token is invalidated when the session leaves `open`
(the authenticated shopper reads via `customer_user_id` thereafter; a guest is re-issued a scoped
checkout-access token if checkout needs one), and add both to INV-15. Also state the server-secret rotation
story for the deterministic HMAC — rotating it invalidates every live cart, which over a 30-day window is an
operational event, not a config change.

## CR3-6 — No client input type exists, no invariant makes line prices server-authored, and the §1.2 creation trigger has no endpoint (§1.4.3, §1.4.5 INV-6, §1.2, §1.5 A-12)

**(a) `CartLine` is used as both the stored snapshot and the request body.** A-4 defines `CartLine` as the
persisted value object, including `unit_price_net_amount`, `unit_price_gross_amount`, `tax_rate` and
`price_kind_id`. SPEC-029 §12.1 defines `POST /checkout/sessions { currencyCode, locale, lines?: CartLine[] }`
— the same type name, supplied by an **unauthenticated client**. Nothing in v3 amends it, and A-12 defines no
input type of its own.

**(b) INV-6 does not cover line prices.** It reads: *"`totals_snapshot` is server-derived, never
client-accepted"* — its consequence column says "price tampering on a public API", but its subject is the
totals object only. `line_snapshot`'s money fields are described in §1.4.3 only by *provenance* ("From
`CatalogProductPrice.unit_price_net`"), never by *authority*. §1.4.8 implies the resolver owns them; no
invariant says so. On a public unauthenticated surface, with the parent's creation body accepting `CartLine[]`,
that is a live gap between the invariant set and the contract.

**(c) The first line add has no endpoint.** §1.2 fixes the conversion denominator by ruling that *"a session is
created on the first successful line add, never on page view,"* and §1.4.4 names `cart.created`'s emitter as
*"line-add endpoint (A-12), on first line."* A-12's line-add endpoint is `POST /sessions/**:id**/lines` — it
requires a session that does not exist yet. The first mutation of the cart lifecycle has no defined operation,
and the primary metric's denominator is defined in terms of it.

**Fix:** define `CartLineInput = { variantId, quantity, lineAttributes? }` as the only client-authored line
shape; restate INV-6 to cover `line_snapshot`'s money fields as well as `totals_snapshot` ("all cart money is
server-authored by the Cart Line Resolver and never accepted from a client"); and define the creation
operation — either `POST /sessions` with a `CartLineInput[]` body that creates and adds atomically, or a
session-less `POST /lines` that mints the session — and reconcile it with A-2's creation `Idempotency-Key` and
INV-17's stricter creation limit, both of which currently assume a distinct creation endpoint.

## CR3-7 — §1.4.7 has no rule for the dominant authenticated path — guest cart, no existing account cart — and the merge-rate metric scores that path as a failure (§1.4.7, §1.2, §1.4.4)

The reconciliation table's Target row reads: *"The Customer User's existing `open` cart. The guest cart is
absorbed."* The single most common authenticated flow is a guest who fills a cart and **logs in for the first
time at checkout**, holding no account cart at all. There is no row for it. Pass 1's C-5 listed it ("no account
cart yet → guest cart becomes the customer's"); pass 2 referenced it under CR-8; three passes on it is still
unwritten.

Two implementations are equally consistent with the text: **adopt** the guest cart (set `customer_user_id`,
rotate the token, keep the session id, `added_at` and event history), or **create** an empty account cart and
absorb into it (a second `cart.created`, a polluted denominator, and a discarded session id). They produce
different analytics and different cross-device behaviour.

The metric is worse than ambiguous. §1.2 defines guest→account merge rate as *"`cart.merged` events with
`linesTransferred > 0` ÷ authentications by a shopper holding a non-empty guest cart."* Adoption transfers no
lines — there is no second session — so it emits no `cart.merged` at all: **denominator +1, numerator +0.** The
headline metric reads zero on the path that works perfectly and is by volume the majority of the flow.

The event shape compounds it: `cart.merged` carries `sourceSessionId`, `targetSessionId` and
`outcome ∈ {merged, superseded}`. Adoption has one session and neither outcome. Event ids and payload shapes
are FROZEN/ADDITIVE-ONLY surfaces — this must be right before Phase 1, not after.

**Fix:** add the adoption row to §1.4.7 (recommend: adopt in place, session id preserved, token rotated,
INV-12 satisfied trivially), decide whether it emits `cart.merged` with a third `outcome: 'adopted'` and
`targetSessionId = sourceSessionId`, or a distinct `cart.claimed` event, and restate the merge-rate metric so
the adoption path counts in the numerator.

---

# WARNING

## W1 — INV-7's system-write enumeration is wrong, and it silently withdraws a §7.5.2 guarantee with no amendment (§1.4.5 INV-7, §1.5 A-11)

INV-7 lists four system writes that do not bump `version`: `abandoned_at`, `last_activity_at`, `expires_at`
extension, TTL re-derivation. Two of them are not system writes: §1.4.2 makes `last_activity_at` and the
`expires_at` extension ride **client-intent mutations** (that was pass 2's W-6 fix), so they occur inside a
transaction that bumps `version` anyway; and W-6 also decided TTL re-derivation never happens. The genuinely
independent writes are the scanner stamping `abandoned_at` and the expiry worker writing `status='expired'` —
and the latter is **absent from the list**.

Separately, SPEC-029 §7.5.2 names *"stale-client updates after server-side expiry bump"* as something the
version guard prevents. INV-7 removes that protection. The replacement is sound — INV-1 and INV-10 catch it
with an explicit status/expiry check, which is exactly the *"state-machine rows guarded by an explicit status
check"* rationale the platform's own lock test cites — but §0's rule is that an unrecorded amendment is a
defect. A-11 already amends §7.5.2 twice (409 body, evaluation order); add the third line there.

## W2 — A-11 (body `version`) and A-12 (`DELETE …/lines/:lineId`) collide: DELETE has no carrier for the version precondition (§1.5 A-11/A-12)

A-11 records that "the storefront keeps body `version`". A-12 makes line removal a `DELETE` with an empty
path-addressed resource. DELETE request bodies are legal but unreliable across proxies and CDNs and are not
sent by several HTTP clients. So one of the three mutation verbs cannot carry the precondition that INV-7 and
the entire concurrency story rest on. One-line fix (a header or a query parameter for DELETE), but it must be
chosen — two amendments authored independently, disagreeing on the same request.

## W3 — A-13's §19.3 edit orphans the workflow's start step and its only conditional branch; §12.1's response triple and §19.4's polling hook are unamended (§1.5 A-13)

Verified in the parent: `cart_review (USER_TASK)` is `checkout_storefront_v1`'s **first** step, and the
guest-vs-customer branch (`condition: no customer`) lives on the transitions *out of* it. Dropping the step
drops the branch point, leaving a workflow with two candidate start steps and a condition with no evaluating
node. A-13 says "drop `cart_review`" and does not say what replaces it.

A-13 also names only §19.3/§19.4. The same `workflowInstanceId` / `currentStep` / `availableTransitions` triple
is in §12.1's session GET response (line 869), and §19.4's polling hook reads `workflowStatus` on an **open**
session (lines 1571-1580). Under A-13 all four are null throughout the cart phase — a response-shape change to
a contract surface, unrecorded.

## W4 — A-12 is absent from Q-12's blocking list although it deprecates the parent's only cart mutation contract (§10 Q-12, §1.5)

Q-12 names A-11, A-13 and A-14 as needing an upstream decision. A-12 replaces SPEC-029 §12.1/§7.5.2/§19.4's
sole cart write path with three new endpoints, is scored Medium, and is the amendment on which CR3-1, CR3-2 and
CR3-6 all hang. Either it belongs in Q-12 or Q-12's criterion is not "changes the parent's design".

## W5 — §1.3 and §1.4.3/A-6 disagree about where the tax display selection lives (§1.3, §1.4.3, §1.5 A-6)

§1.3's Store row: *"Owns TTL, abandonment threshold, line caps, **tax display selection** and the guest-cart
flag — **all in a new `settings.cart` section (A-6)**."* A-6's key list contains no tax key, and §1.4.3 derives
`display_tax_mode` from `settings.features.showPriceIncludingTax`. Residue of the CR-5 fix: the store-wide
`tax_mode` was correctly demoted in §1.4.3 and the glossary row was updated to point at the wrong home.

## W6 — INV-17's scope excludes the endpoints A-14 just added, and its named mechanism is fail-open (§1.4.5 INV-17, §1.5 A-14)

INV-17 covers *"every cart endpoint"*. A-14 adds **login/logout/session** endpoints to the same public
storefront surface; they are not cart endpoints, and a public login with no stated abuse control is the classic
credential-stuffing target. Extend INV-17's subject to "every public storefront endpoint in this scope, with
authentication limited separately and most strictly."

Second: verified that `rateLimiterService` is registered **conditionally** (`core/bootstrap.ts:207-212`,
`null` on failure) and `checkRateLimit` **fails open** (`shared/lib/ratelimit/helpers.ts:18-43`). A **Strong**
invariant cannot rest on a best-effort service. Either state that cart endpoints must fail *closed* when the
limiter is unavailable, or downgrade INV-17's consistency classification and say why.

## W7 — §2 does not say where `requireCustomerAuth` runs, and the storefront-vs-portal session relationship is undecided (§2, §1.5 A-9/A-14, §10 Q-5)

§14.2's "MUST NOT depend on `@open-mercato/*`" constrains the **storefront app's dependencies**, so A-14's
server-side endpoints are fine — but §2's gating column reads *"`requireCustomerAuth` (endpoints per A-14)"*,
and `requireCustomerAuth` is a platform helper used in **portal page metadata**
(`customer_accounts/lib/customerAuth.ts`). If any reader takes §2 as licence to guard `apps/storefront/` pages
with it, §14.2 breaks. State that it guards the core module's API routes only and that the storefront app
enforces nothing locally.

Unstated and product-relevant: under A-9's same-site topology the customer session cookie is issued for the
**store host**, so it is a different cookie scope from the portal's. Is a shopper logged into the portal logged
into the storefront? Q-5 (portal cart history) silently assumes one identity session; A-9 + A-14 build two.

## W8 — The event id `ecommerce.cart.merged` contradicts the document's own banned-phrasings discipline, on a FROZEN surface (§1.3, §1.4.4, §1.4.7)

The banned-phrasings table forbids writing "merge" for the supersede case ("No lines transfer; §1.4.7"). The
event carrying that case is literally named `merged`, with an `outcome` discriminator bolted on — and CR3-7
would need a third value on it. The ubiquitous-language rule and the event id, which is FROZEN once shipped,
say opposite things. Either rename to `ecommerce.cart.reconciled` (matching the glossary's own chosen term,
"Cart Reconciliation") with `outcome ∈ {merged, superseded, adopted}`, or drop the banned-phrasing row.
Renaming is free today and impossible after Phase 3.

## W9 — A-2's decoupling mechanism holds only for authenticated shoppers, and does not survive §1.2's creation trigger (§1.5 A-2, §1.2)

A-2: the creation key is *"nulled at 24h by the expiry sweep, and a later retry with the same key creates a new
cart, which for an authenticated shopper is caught by INV-12."* INV-12 is scoped to
`(store_id, customer_user_id)` — it says nothing about guests, who are the majority of cart creators. A guest
retrying at 25h silently gets a second cart, inflating the §1.2 denominator by exactly the mechanism A-2 was
written to control. Also unamended: §7.5.1's `idempotency_key_mismatch` 422 rule, and the fact that under §1.2's
"created on first line add" trigger the creation key must now ride the **line-add** call (CR3-6c), which A-12
does not mention.

## W10 — `email` is unreachable for every cart this document scopes, so Q-7 is narrower than it reads (§1.4.2, §10 Q-7)

§1.4.2 marks `email` *"Written by checkout; read by cart-phase recovery (Q-7)."* Since email is only written
post-`open` and no status returns to `open`, **no `open` cart ever carries an email**. Guest-cart recovery is
therefore not an open question but a structural impossibility under the current field model; only carts with
`customer_user_id` are recoverable (via the CustomerUser's address). Q-7 should be restated as "recovery is
authenticated-only unless the cart phase captures an email itself" — which is a scope decision, not a question.

## W11 — Two "verified" claims in the document are imprecise, and specs get read as ground truth (§1.4.3, §1.5 A-11)

- §1.4.3: *"The catalog stores prices as `numeric(16,4)`."* True for `unit_price_net`, `unit_price_gross` and
  `tax_amount`; `tax_rate` is **`numeric(7,4)`**. Relevant because CR3-3's arithmetic depends on the precision
  of the rate.
- A-11: *"the UI test's glob covers `packages/core/src/modules/**` only."* There is a third file,
  `optimistic-lock-ui-coverage-workspace.test.ts:159-176`, scanning `packages/<pkg>/src/modules` for `.ts` **and**
  `.tsx`. A-11's conclusion (`apps/storefront/` escapes all of them) still holds; the premise is incomplete, and
  a backoffice `.tsx` under `packages/core/src/modules/ecommerce/backend/` **would** be scanned.

This is the same nit pass 2 raised as W-14 and the author corrected. Prefer "verified against X on <date>" over
absolute claims that the next reader will not re-derive.

## W12 — §1.4.8's rejection cases do not cover the canonical form's own shape rule (§1.4.3, §1.4.8)

The canonical form restricts `line_attributes` to a *flat `Record<string, string>`* — no nesting, no arrays, no
non-string values. §1.4.8's rejection list covers "quantity or `line_attributes` outside INV-14 **bounds**"
only. A client sending `{ engraving: { text: "Ann" } }` hits a shape rule with no stated rejection, on a public
API where the client controls the JSON. State that non-conforming shapes are rejected (typed error), not
coerced — coercion would make two distinct client payloads canonicalize to the same key.

## W13 — `merged` in the status enum makes INV-12's qualifier dead, which suggests it is guarding something else (§1.4.5 INV-12)

INV-12 caps open sessions per `(store_id, customer_user_id)` *"that is not marked `merged_into_session_id`."* A
cart with `merged_into_session_id` set has `status='merged'` (§1.4.7: "terminal with no outbound edges"), so it
is not `open` and the qualifier can never fire. Either it is v2 residue and should be removed, or it is
protecting a state the document has not described — worth confirming which, because CR3-7's adoption path is
exactly the kind of case that would need it.

---

# RESOLVED (pass-2 findings verified genuinely fixed)

- **CR-1** *(identity key)* — resolved as an identity question. `(variant_id, canonical(line_attributes))` is
  the domain key; `line_id` is server-assigned and addressing-only. Sub-cases (b) and (c) survive as CR3-1.
- **CR-2** *(canonical form)* — fully resolved. The five-point canonical rule is the right level of detail for
  a Strong invariant over jsonb, and the "no shared helper exists, promoting one is part of the work" note is
  verified correct. Only W12 remains.
- **CR-3** *(mutation surface)* — A-12 exists and is recorded. Its content is CR3-1/CR3-2/CR3-6.
- **CR-4** *(workflow instance)* — A-13 records the decision and §0.1's handover table is consistent. Its
  consequences are CR3-4 and W3.
- **CR-5** *(tax basis)* — resolved at the source and resolved well. Per-line net + gross + `tax_rate` +
  `price_kind_display_mode`, `display_tax_mode` demoted to a display selection, with the reasoning stated. The
  arithmetic layered on top is CR3-3; the basis decision itself is correct and should not be re-opened.
- **CR-6** *(currency conflict)* — resolved. `merged` covers supersede, the `outcome` discriminator is the right
  shape, the dual-claim read rule is stated, INV-14 overflow rejects rather than clamps with a stated reason,
  and the deferred-merge trigger is one the cart phase can actually execute.
- **CR-7** *(version semantics)* — resolved in substance; INV-7a's ordering rule is correct and necessary.
  Enumeration defects are W1; the missing store is CR3-2.
- **CR-8** *(auth surface)* — A-14 records the amendment, resolves SPEC-029 OQ#1, and names the cookie
  topology. Residuals are W6 and W7.
- **W-1..W-14** of pass 2 — all addressed. A-1's cost corrected to Medium with the right precedents and the
  deterministic-hash requirement; §1.4.8's fetch/resolve split and `PricingContext` mapping stated; A-11's 409
  body made concrete; A-2's mechanism named (though see W9); `abandoned_at` cleared on `checkout_started` and
  worker predicates amended; `last_activity_at` mutation-only; `settings.cart` created; the creation trigger
  fixed; `pricing_basis_ref` correctly demoted to a per-line `price_resolved_at`; INV-8/INV-15 reconciled
  (see CR3-5); the deferred-merge trigger rewritten; INV-17 added; A-7 scoped honestly; event counts corrected.

# OK

1. **§0 and §0.1 are settled.** Three passes have not produced a reason to reopen the single-aggregate
   decision, and the handover table has absorbed every boundary finding raised against it. It is now the most
   useful artifact in the document.
2. **The CR-5 resolution is exemplary.** Sourcing the tax basis from the price rather than the store, keeping
   both amounts, and demoting the store toggle to a display selection is the correct domain answer and is
   argued from the catalog's actual shape. CR3-3 is about arithmetic layered on top, not about this decision.
3. **INV-16 and A-8 remain the strongest security work in the document**, and A-9's same-site topology choice
   is correctly justified twice over (cookie delivery and §6.3 `Host` resolution).
4. **The value-object boundary for Cart Lines holds under a third round of pressure.** Nothing in CR3-1
   argues for promoting lines to entities — the defects are about operation semantics, which a value object
   inside an aggregate root is entitled to have specified for it.
5. **The amendment table is the right mechanism** and §0's rule ("an applied but unlisted amendment is a
   defect") continues to earn its place — it is what makes W3, W4 and W9 findable at all.
6. **The banned-phrasings table and the Customer User / Customer Entity split** remain correct and are the
   part of §1 most likely to survive contact with implementation. W8 is a naming inconsistency against them,
   not a defect in them.

---

# What would change the verdict

CR3-1, CR3-2 and CR3-6 are one cluster: A-12 must be rewritten from a routing table into an operation contract
(semantics, input type, fact→event mapping, idempotency storage, creation path). That is the single highest-value
edit in this pass and it closes three CRITICALs plus W2 and W9.

CR3-3 is independent and is the one an implementer will *not* catch — it must be decided in the document, not in
review of the migration.

CR3-4, CR3-5 and CR3-7 are each a paragraph: name the exit operation, bound the token, add the adoption row.

None of the seven requires reopening §0, §0.1, or the CR-5 tax-basis decision. The document's structure is
sound; what it is missing, three passes in, is consistently one altitude below where the fixes were applied.
