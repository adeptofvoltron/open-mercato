# Challenger Gate — Pass 4 (v4 of `2026-08-13-app-spec-storefront-cart.md`, §0 / §1 / §2 / §10 / §11)

Reviewer role: domain-driven-design expert. Fourth pass, following
[`challenger-phase0.md`](./challenger-phase0.md) (8 CRITICAL),
[`challenger-phase0-pass2.md`](./challenger-phase0-pass2.md) (8 CRITICAL, five self-inflicted) and
[`challenger-phase0-pass3.md`](./challenger-phase0-pass3.md) (7 CRITICAL, several self-inflicted).
Sections 3–7 out of scope.

**Verdict: 8 CRITICAL, 17 WARNING. NOT READY for Phase 1.**

The dominant failure mode has not changed, but its mechanism is now precisely identifiable and worth naming
for the author, because it is a *process* defect rather than a domain-knowledge defect:

> **v4's fixes were applied to the paragraph the finding quoted, and not to the other places in the document
> that state the same rule.** Pass 3 asked for the rounding boundary to move to the line total. §1.4.3's table
> and its money note moved. INV-5, INV-13 and §1.4.8's resolver step — the three places an implementer
> actually binds to — still state the v3 rule. Pass 3 asked for `PATCH quantity: 0` to be decided. A-12a
> decided it, and INV-3 still says the opposite. Pass 3 asked for the POST-collision event to be decided.
> A-12a decided it, and §1.4.4's emitter table still says the opposite.

Five of this pass's eight CRITICALs are of that shape (C1, C2, C3, C5, C7). Two are genuine new holes opened
by a v4 fix (C4, C6). One is a domain rule all four passes have now missed (C8).

Also material to the gate decision: **of pass 3's 13 WARNINGs, one was addressed** (W7's first half, now
recorded as Q-15). Twelve are carried forward verbatim below. Several of them (W2, W5, W6) are one-line edits
whose absence suggests the WARNING tier is not being read at all.

---

## Ground truth verified this pass

Re-verified in code in this checkout, not against the author's notes or prior passes.

| Claim | Verdict |
|---|---|
| `CatalogProductPrice.tax_amount` exists and is `numeric(16,4)` | ✅ `catalog/data/entities.ts:833` — **`nullable: true`** |
| `tax_rate` is `numeric(7,4)`, nullable | ✅ `catalog/data/entities.ts:830` |
| `unit_price_net` / `unit_price_gross` are `numeric(16,4)`, **both nullable** | ✅ `:824`, `:827` |
| `tax_rate` is stored as a **percentage**, not a fraction | ✅ `taxCalculationService.ts:71` — `fraction = rate / 100`; `SalesTaxRate.rate` is `numeric(7,4)` (`sales/data/entities.ts:274`) |
| The command layer leaves `tax_amount` **null** unless the price was entered as amount+mode | ✅ `catalog/commands/prices.ts:355` `let taxAmountValue: string \| null = null`, populated only inside `if (amountInput)` (`:356-369`). A price posted as explicit `unitPriceNet`/`unitPriceGross` persists with `tax_amount = null` |
| Seeded prices set `taxRate` and `unitPriceNet == unitPriceGross` and **never set `taxAmount`** | ✅ `catalog/seed/examples.ts:983-993`, `:1004-1013` — no `taxAmount` key at all |
| `taxAmount = gross − net`, rounded at 4 dp with float math | ✅ `taxCalculationService.ts:83-89`, `roundAmount` `:134-137` (`Math.round(v * 10**4) / 10**4`) |
| No decimal library anywhere in the monorepo | ✅ no `decimal.js` / `big.js` / `bignumber.js` / `dinero` / `currency.js` in any `package.json` |
| `CatalogProductPrice` carries `min_quantity` / `max_quantity`, i.e. **tiered pricing is real** | ✅ `catalog/data/entities.ts:818-822`; selection is quantity-dependent (`lib/pricing.ts`) |
| SPEC-029 §12.1 `POST /checkout/sessions` body is `{ currencyCode, locale, lines?: CartLine[] }` | ✅ line 869 — **unamended by v4** |
| SPEC-029 §12.1 defines `POST /sessions/:id/transition { version, toStepId }` as the operation advancing status | ✅ lines 875-878; `POST /sessions/:id/submit` at `:880` |
| SPEC-029 §7.5.1 ties idempotency-key expiry to "24 hours (same as session TTL)" and defines the 422 mismatch rule | ✅ lines 316-317 |

---

# CRITICAL

## C1 — The money arithmetic is stated three times and v4 fixed one of them: INV-5, INV-13 and §1.4.8's resolver all still encode the v3 round-at-the-unit-price rule (§1.4.3, §1.4.5 INV-5/INV-13, §1.4.8)

This is the exact defect pass 3 raised as CR3-3(a), and the fix reached the CartLine table and the prose note
and nothing else.

**§1.4.3 (new):** `unit_price_net | decimal string (16,4) | **Unrounded**, as the catalog stores it. Rounding
happens once, at the line total (INV-5).` and `line_total_* = round_half_up(unit_price × quantity)`.

**INV-5 (unchanged):** *"All cart money is integer minor units; conversion from catalog `numeric(16,4)` happens
once, **in the resolver**, half-up."* Under v4, not all cart money is integer minor units — four of the line's
money fields are 4 dp decimal strings — and the conversion does **not** happen in the resolver, it happens at
the line total on every quantity change.

**INV-13 (unchanged):** `line_total_* = unit_price_* × quantity` — **no rounding operator at all**. Pass 3's
fix item (i) said this literally: *"INV-13's `line_total = unit × quantity` must be restated as
`round(unit_4dp × quantity)`."* It was not.

**§1.4.8 (unchanged):** the resolver's step list still reads *"verify resolved currency equals session currency
→ **round `numeric(16,4)` to minor units, half-up, once (INV-5)** → snapshot net, gross, `tax_rate`…"*. §1.4.8
is the one named function the document calls *"the only path by which catalog data enters the aggregate"* — it
is what an implementer builds first, and it still says round the unit price.

So the document now contains both rules, and §1.4.3's own cell cites **INV-5 and INV-13 as its authority** for
a rule those two invariants contradict. The Strong invariants win in any test suite. v3's bug ships.

Additionally, "conversion happens once" is no longer true under any reading: `line_total_*` must be
recomputed on every quantity mutation, and — see C8 — possibly re-resolved. The word "once" needs to become
"per line total, deterministically from the stored unrounded unit price".

**Fix:** restate INV-5 as *"unit prices are stored unrounded at 4 dp; every cart money amount **exposed as a
total** is an integer minor unit produced by exactly one half-up rounding of an unrounded product"*; restate
INV-13 with the rounding operator; delete the rounding step from §1.4.8's list and replace it with "snapshot
the 4 dp values verbatim".

## C2 — The new money-validation rule is unsatisfiable against the catalog it validates: `tax_amount` is nullable and routinely null, `tax_rate` is a percentage not a fraction, and the tolerance is stated at the unit scale while its error lands at the line-total scale (§1.4.3, §1.4.8)

v4's headline fix — snapshot `tax_amount`, validate the quadruple, reject on mismatch — is the right instinct
and is wrong in three independent ways, each verified in code.

**(a) `tax_amount` is `nullable` and is null on most real rows.** §1.4.3 marks `tax_amount` **required: yes**,
sourced *"From `CatalogProductPrice.tax_amount`"*, and §1.4.8 makes it the anchor of the consistency check.
Verified: the column is nullable (`entities.ts:833`), the **seed never sets it** (`examples.ts:983-993`), and
the command layer leaves it `null` whenever a merchant posts an explicit net/gross pair rather than an
amount+mode pair (`commands/prices.ts:355-369` — `taxAmountValue` is initialised to `null` and only assigned
inside `if (amountInput)`). So the field the resolver now requires is absent on the demo catalog and on an
entire legitimate authoring path. As written, `POST /lines` rejects those variants. Q-14 records this as a
*seed-data* problem; it is a *field-model* problem — the seed is only the most visible instance.
The document must state the null rule: derive `tax_amount = gross − net` when absent, or reject, and say which.

**(b) `tax_rate` is a percentage.** §1.4.8's check is `tax_amount ≈ net × tax_rate`. Verified:
`taxCalculationService.ts:71` computes `fraction = rate / 100`, so a 23% rate is stored as `23.0000`. Written
as specified, the check compares `2.8394` against `12.3450 × 23 = 283.94` and **rejects every correctly-priced
row in the catalog**. This is a two-character defect with a total-outage blast radius, and it is exactly the
kind of thing an implementer copies verbatim from a spec that presents itself as verified.

**(c) The tolerance is at the wrong scale.** *"within one minor unit"* is applied to the **unit price**. The
catalog's own values are exact to 4 dp (`roundAmount(v, 4)`), so the honest tolerance is ~1e-4; one minor unit
is 100× looser. A per-unit inconsistency of up to 0.01 that the check *admits* becomes up to `0.01 × quantity`
on the line total — up to 10.00 at a quantity INV-14 permits. That is the **same round/tolerate-then-multiply
class of defect** the v4 money fix was written to eliminate, reintroduced in the validation rather than the
arithmetic. The tolerance must be expressed against the precision of the stored value (≤ 1 unit in the last
place of `numeric(16,4)`), or the validation must be performed on the line total.

## C3 — INV-6 was widened and the only endpoint that can violate it is still unamended; the creation operation still does not exist (§1.2, §1.4.4, §1.4.5 INV-6, §1.5 A-12)

Pass 3's CR3-6 had three parts. Part (b) — widen INV-6 — is fixed, well. Parts (a) and (c) are untouched, and
they are the parts that make (b) enforceable.

**(a) The parent's creation body still accepts `CartLine[]`.** Verified: SPEC-029 §12.1 line 869 —
`POST /checkout/sessions  Body: { currencyCode, locale, lines?: CartLine[] }`. `CartLine` is the type A-4
defines as the *stored* value object, carrying `unit_price_net`, `unit_price_gross`, `tax_amount`,
`tax_rate` and `price_kind_id`. A-12 replaces the **PATCH** whole-array surface and is silent about the
**POST** creation body. INV-6 now declares in the strongest possible terms that money is never client-accepted,
on a public unauthenticated API, while the parent contract this document is an elaboration of accepts a full
priced line array at the very first call. Under §0's own rule — *"an amendment applied but unlisted is a
defect in this document"* — the amendment that closes this is missing, and it is the security-relevant one.

**(b) The first line add still has no endpoint.** §1.2 fixes the conversion denominator on *"a session is
created on the first successful line add"*; §1.4.4 names `cart.created`'s emitter as *"line-add endpoint
(A-12), on first line"*; A-12's only line-add endpoint is `POST /sessions/**:id**/lines`, which requires the
session that does not exist yet. Pass 3 raised this verbatim. The first operation of the entire cart lifecycle
is undefined, and three other mechanisms depend on it: A-2's creation `Idempotency-Key` (which store? see W4-D),
INV-17's *"cart creation is limited separately and more strictly"* (limited on which route?), and the primary
metric's denominator.

**Fix:** one sentence in A-12 — either `POST /sessions` takes `CartLineInput[]` and creates-and-adds
atomically, or `POST /lines` is session-less and mints the session — plus an amendment row removing `lines`
from the parent's creation body.

## C4 — INV-15's new status ceiling destroys the guest's only credential at the exact operation the cart phase now owns, so guest checkout is unreachable — and it makes §1.4.7's deferred-reconciliation rule unexecutable (§1.4.5 INV-8/INV-15, §1.4.6, §1.4.7, §1.4.4)

The ceiling — *"its authority ends the moment `status` leaves `open`"* — is the correct instinct for the
fixation risk pass 3 identified, and it was added without tracing what else depended on the token surviving.

**(a) A guest cannot check out.** The Guest Shopper's *only* credential is the Cart Token (§2: "No account; a
capability"). `POST /sessions/:id/checkout` (§1.4.4) transitions `open → locked`. At that instant INV-15
revokes the token. The guest now cannot read their own session, cannot supply an address, cannot pay — and
§1.4.6's table has no row for a guest after `open` because the table is scoped to the cart phase. Pass 3's
suggested fix carried the compensating half — *"a guest is re-issued a scoped checkout-access token if checkout
needs one"* — and v4 kept the revocation and dropped the re-issue. Even if re-issuance is checkout's job,
§0.1's handover table must say so; today the document terminates guest checkout and hands over nothing.
Note the irony: `packages/checkout`'s `signCheckoutAccessToken` is precisely the mechanism that would serve
here, and §1.5's correction block correctly explains why it cannot serve the *cart* — that reasoning does not
extend past `open`.

**(b) The deferred-reconciliation rule cannot execute.** §1.4.7: *"Authentication while `locked`. INV-1 forbids
mutation. Reconciliation is deferred and executed on the shopper's next authenticated cart access."* The row
does not say **whose** cart is `locked`, and both readings break:

- *Guest cart locked* (the shopper reached checkout, then logged in — the realistic case): the guest token was
  revoked at `open → locked`, so at the deferred trigger there is nothing left that identifies the guest cart;
  and `merged` is reachable **only from `open`** (§1.4.7, A-10), so by the time the shopper returns the cart is
  `submitted`/`completed`/`canceled` and can never be reconciled. INV-1's own extension (*"includes
  reconciliation"*) forbids it independently.
- *Account cart locked*: the guest cart is still `open`, but §1.4.7's dual-claim rule says *"the authenticated
  cart wins for ordinary reads"* — so the shopper is shown a cart they cannot modify while their real items sit
  in an unreachable guest cart. Coherent, arguably correct, and entirely unstated.

**Fix:** state whose cart is locked, state what identifies the guest cart at the deferred trigger (a
reconciliation claim recorded at authentication time, not a live token), and either narrow INV-15's ceiling to
*mutations and guest reads of post-`open` PII fields* or add the successor-credential handover to §0.1.

## C5 — A-12a's decided semantics contradict INV-3 (Strong) and §1.4.4's emitter table, which were left unchanged (§1.4.4, §1.4.5 INV-2/INV-3, §1.5 A-12a)

The five semantics are the right decisions. Three of them are now stated twice in the document, in opposite
directions.

- **A-12a(4)** *"`PATCH` to `quantity: 0` is rejected — removal is `DELETE`."*
  **INV-3** *"`quantity ≥ 1`; **zero means remove**."* Strong invariant. Two behaviours, one document. An
  implementer building from the invariant table — which is what invariant tables are for — builds
  remove-on-zero and emits nothing, because §1.4.4 binds `line_removed` to DELETE only.
- **A-12a(2)** *"a collision emits `line_updated`, not `line_added`."*
  **§1.4.4** binds `line_added` to `POST …/lines` and `line_updated` to `PATCH …/lines/:lineId`. The emitter
  column is still expressed as routes, which is the framing pass 3 said cannot express the fact. And
  `line_updated`'s payload requires `previousQuantity` — from a POST, on a `clientBroadcast: true` event
  a second tab consumes. Nothing says the POST path populates it.
- **A-12a(3)** the attribute-edit merge. This is the item that keeps Strong INV-2 true under a normal UI
  action and it is genuinely good. It is also incomplete in a way that matters on a broadcast surface: when
  line B merges into line A, **line B ceases to exist** and no event is specified for it. `line_removed` is
  `clientBroadcast: true`; without it the shopper's second tab renders a line that is gone, forever. The
  quantity rule for the merge is also unstated (summed? and does reconciliation's INV-14-overflow *rejection*
  rule apply here too, or does this path clamp?).

**Fix:** move (1), (2), (3) and (4) into §1.4.5 and §1.4.4 as domain facts — `line_added` iff a line came into
existence, `line_updated` iff quantity or attributes changed on an existing line, `line_removed` iff a line
ceased to exist (including by absorption) — and restate INV-3 as *"stored `quantity ≥ 1`; a client cannot
express removal by setting zero"*. See the A-12a verdict section below.

## C6 — `cart.merged`'s payload is undefined on the adoption path, and a subscriber resolving it finds an `open` cart where the event's own contract implies a terminal one (§1.4.4, §1.4.7, §1.2)

Adding the adoption row is the right fix for CR3-7 and it is the highest-value edit in v4. Its event shape was
not worked through, and event payloads are ADDITIVE-ONLY contract surfaces per `BACKWARD_COMPATIBILITY.md` —
this must be right *before* Phase 1.

`ecommerce.cart.merged` requires `sourceSessionId` and `targetSessionId`. Adoption has **one** session.
Pass 3 named the choice (same id in both fields, or a distinct event); v4 records `outcome: 'adopted'` and
leaves the two ids unspecified. Every consumer now has to guess, and the natural guess is wrong: everywhere
else in §1.4.7 the *source* of a `cart.merged` is a cart that has just become terminal (`status='merged'`,
`merged_into_session_id` set). A subscriber that loads `sourceSessionId` to record the absorbed cart finds an
`open`, active, now-authenticated cart. Abandonment analytics, recovery campaigns and the §1.1 flywheel's
observation stream all read this event.

`linesTransferred` acquires a second meaning at the same time: *"lines that moved between sessions"* for
merge, *"lines this cart happens to contain"* for adoption. §1.2's merge-rate metric is repaired by that
choice (which is why it was made), but any consumer summing `linesTransferred` to size merge volume now
double-counts the dominant path.

**Fix:** state the ids explicitly for adoption (recommend `targetSessionId === sourceSessionId === the adopted
session`, with a note that consumers MUST branch on `outcome` before assuming the source is terminal), and
either rename `linesTransferred` to `lineCount` or add a separate field. See also W4-E on the event's name.

## C7 — `POST /sessions/:id/checkout` displaces the parent's `POST /sessions/:id/transition` with no recorded amendment, and gives the cart phase the workflow orchestration §0.1 hands to Checkout (§0.1, §1.4.4, §1.5 A-12/A-13, §10 Q-12)

Naming the exit operation closes CR3-4's letter. Ownership was not worked out, and the brief asks directly:
**who owns this endpoint?** As written, both phases do, which is the one answer that cannot be built.

- **§0.1's handover table** assigns *"Workflow orchestration"* to Checkout, with the rationale *"the cart phase
  is plain CRUD, not a workflow step"*. **§1.4.4** then defines the cart phase's own endpoint as the thing that
  *"creates the workflow instance and transitions `open → locked`"*. Creating a workflow instance is workflow
  orchestration. The handover table and the event table disagree about who performs the single most consequential
  write in the aggregate's life.
- **It displaces a parent endpoint silently.** Verified: SPEC-029 §12.1 (lines 875-878) defines
  `POST /sessions/:id/transition { version, toStepId }` as the operation that advances status, and A-13 makes
  it unusable for the `open →` edge (no instance exists to transition). Neither A-12 nor A-13 records that
  §12.1's `transition` endpoint no longer serves the first transition. §0's rule makes an unlisted applied
  amendment a defect; this is one, on an API contract surface, and it is the same category of omission as C3(a).
- **Q-12 does not list it.** Q-12 blocks Phase 1 on A-11, A-13 and A-14 as *"changes the parent's design"*.
  A-12 now deletes one parent mutation endpoint, adds four, and displaces a fifth. Pass 3 raised this as W4;
  unaddressed.

**Recommended resolution (the document should pick one and write it down):** the operation belongs to
**Checkout**; the cart phase's contribution is the *precondition set* (INV-1, INV-10, non-empty, INV-14) and
the `cart.checkout_started` emission, which checkout triggers. That keeps §0.1 honest and keeps the KPI
numerator emittable. If instead the cart phase owns it, §0.1's handover row must be rewritten, because "plain
CRUD" is then false.

Secondary, and cheap to fix now: §1.4.4's Q-1 resolution reserves `ecommerce.checkout_session.*` *"for
post-`open`"*. `checkout_started` is emitted by an operation that ends in `locked`. The document's own
namespace rule is ambiguous about its own newest event.

## C8 — Whether a quantity change re-resolves the price snapshot is undefined, and tiered pricing makes the two readings produce different money (§1.4.3, §1.4.8, §1.5 A-12a(1))

Missed by all four passes, App-Spec altitude (§0.1 assigns *"per-line price snapshots"* to the cart phase),
and it decides money.

Verified: `CatalogProductPrice` carries `min_quantity` and `max_quantity` (`entities.ts:818-822`) and
`PricingContext.quantity` participates in selection — tiered pricing is a live platform feature, not
hypothetical. §1.4.8's own note insists the resolver be passed *"the **current** line quantity — otherwise
tiered prices drift for a reason unrelated to catalog change."*

So: a shopper at quantity 1 raises it to 10 and crosses a tier boundary. Does `PATCH …/lines/:lineId` (or a
delta-`POST` per A-12a(1)) **re-run the resolver** and rewrite `unit_price_*`, `tax_*` and `price_resolved_at`,
or does it multiply the existing snapshot by the new quantity?

- *Re-resolve*: correct pricing, but the shopper's unit price changes under them mid-session, and the
  snapshot's role as *"the audit record of what the shopper was shown"* weakens.
- *Keep the snapshot*: the cart charges tier-1 prices for a tier-10 quantity, and INV-9's read-time drift
  computation — which §1.4.8 says must pass the *current* quantity — will then report a "price change since
  added" that the catalog never made and the shopper caused themselves.

Both are defensible; they are different products and different money. The document says nothing, and A-12a,
which enumerates five binding obligations about line operations, does not include the one that changes the
amount charged.

**Fix:** state the rule in §1.4.3 next to `price_resolved_at` (recommend: **re-resolve on every quantity
change**, stamp a new `price_resolved_at`, and treat a resulting unit-price change as a shopper-visible
confirmation rather than as INV-9 drift), and add it to A-12a as obligation (6).

---

# WARNING

## New in v4

**W4-A — The implied tax handed to checkout is undefined, and per-line rounding makes the three available
derivations disagree (§0.1, §1.4.3).** `CartTotals` publishes `subtotal_net_amount` and
`subtotal_gross_amount` and **no tax total**, so the cart's own pair reconciles by construction (tax :=
gross − net). Checkout, handed `tax_rate` *and* `tax_amount` *and* both totals per line, has three ways to
compute tax that do not agree: `round(gross·q) − round(net·q)`, `round(tax_amount·q)`, and
`round(net·q · rate/100)` differ by up to one minor unit **per line**. §0.1 promises checkout never re-queries
the catalog; it does not promise checkout will land on the number the shopper saw. State that
`subtotal_gross_amount` is the binding figure and that tax is `gross − net` at the cart boundary, or state
explicitly that checkout may restate the total.

**W4-B — "decimal string (16,4)" is the right storage choice and the document supplies no arithmetic for it
(§1.4.3).** As a jsonb value consumed by JS, a string is correct (MikroORM already returns `numeric` as
string; a JS `number` cannot hold 16 significant digits). But `round_half_up(decimal string × quantity)` has no
implementation in this repo: verified, **no decimal library exists in any workspace package**, and the
platform's own money math is float-based (`taxCalculationService.roundAmount` = `Math.round(v * 1e4) / 1e4`).
Half-up on floats is wrong at exactly the `.xx5` boundary half-up exists to define (`1.005 * 100 =
100.49999999999999`). §1.4.3 was admirably rigorous about this for canonical JSON — *"no canonical-JSON helper
exists, so promoting one is part of the work"* — and the identical sentence is owed for decimal arithmetic
(scaled-integer helper in `packages/shared`, or a named dependency, which is an "Ask First" per root AGENTS.md).

**W4-C — §1.3's glossary definition of Cart Reconciliation is now stale (§1.3, §1.4.7).** It reads *"Resolves
to a **merge** (lines transferred) or a **supersede** (shopper chooses one cart; no lines transferred)."*
Adoption is neither, and it is the dominant path. Two-word fix, but the glossary is the section the document
declares authoritative over the others.

**W4-D — Two idempotency stores now exist and A-2 still denies the second one (§1.5 A-2/A-12a(5)).**
A-12a(5) creates a side table keyed `(session_id, key)` with 24h retention. A-2 still argues the mechanism is
*"a column on the session row (**not a separate table, so unbounded growth was never the failure mode**)"*.
Both can be true only if creation keys and mutation keys live in different places — which is unstated, and is
incoherent under §1.2's creation trigger, where the creation call **is** a line mutation (C3(b)) and would
need a key in both stores. Also unamended: SPEC-029 §7.5.1's *"keys expire after 24 hours (same as session
TTL)"* (verified, line 316) is now false in two directions, and its `idempotency_key_mismatch` 422 rule is
undefined for line mutations.

**W4-E — `ecommerce.cart.merged` now carries three outcomes, two of which are not merges, against the
document's own banned-phrasings rule (§1.3, §1.4.4).** Pass 3 raised this as W8 with two outcomes; adoption
makes it worse. The glossary's own chosen term is *"Cart Reconciliation"*. `ecommerce.cart.reconciled` with
`outcome ∈ {merged, superseded, adopted}` is free today and impossible after Phase 3 ships a FROZEN id.

**W4-F — INV-15's server-secret rotation story is still missing (§1.4.5 INV-15).** The hash is a deterministic
HMAC with a server secret; rotating that secret invalidates every live cart at once. Over a 30-day TTL that is
an operational event needing a dual-secret read path, not a config change. Pass 3 asked for this in CR3-5's fix
and v4 added the TTL and the ceiling without it.

## Carried forward from pass 3, unaddressed

**W1 — INV-7's system-write enumeration is still wrong** and still omits the expiry worker's
`status='expired'` write; two of the four listed writes ride client mutations. The withdrawn §7.5.2 guarantee
is still unrecorded in A-11.

**W2 — `DELETE …/lines/:lineId` still has no carrier for the body `version` precondition** that A-11 keeps and
INV-7 depends on. One line; two amendments still disagree about the same request.

**W3 — A-13 still orphans `cart_review`'s branch point**, and §12.1's `workflowInstanceId` / `currentStep` /
`availableTransitions` response triple (line 869) and §19.4's polling hook remain unamended although all are
null throughout the cart phase.

**W4 — A-12 is still absent from Q-12's blocking list** while deprecating more of the parent than A-11 does.
See C7.

**W5 — §1.3's Store row still says the tax display selection lives in `settings.cart` (A-6)**; A-6 has no tax
key and §1.4.3 derives it from `settings.features.showPriceIncludingTax`.

**W6 — INV-17 still excludes A-14's login/logout endpoints**, and still rests on `rateLimiterService`, which
is registered conditionally and whose helpers **fail open** — a Strong invariant on a best-effort service.

**W7b — The storefront-vs-portal session relationship is still undecided.** Q-15 now records the
`requireCustomerAuth` placement question (good), but under A-9's same-site topology the customer session cookie
is issued for the store host, a different scope from the portal's; Q-5 still assumes one identity session.

**W9 — A-2's decoupling still only works for authenticated shoppers** (INV-12 is scoped to
`(store_id, customer_user_id)`); guests, the majority of cart creators, silently get a second cart on a
post-24h retry.

**W10 — `email` remains unreachable for any `open` cart**, so Q-7 is a scope decision, not a question.

**W11 — A-11 still claims the UI coverage glob is `packages/core/src/modules/**` only**; a third file
(`optimistic-lock-ui-coverage-workspace.test.ts`) scans all workspace packages. A-11's conclusion holds; its
premise does not. (§1.4.3's `numeric(16,4)` claim was tightened — that half is resolved.)

**W12 — §1.4.8's rejection cases still do not cover the canonical form's shape rule** (nested/array/non-string
`line_attributes`), only INV-14's bounds.

**W13 — INV-12's `merged_into_session_id` qualifier is still unreachable** (such a cart has
`status='merged'`, so it is not `open`). Now worth re-examining specifically because adoption is exactly the
kind of case a qualifier like that would be protecting.

---

# Verdict on the A-12a pushback

**The boundary is legitimate. The execution hides a domain defect, and it will not survive decomposition.**

The author is right that a business-architecture document should not carry request/response schemas, status
codes or header names, and right that "the feature spec cannot silently decide them differently" is a real
risk worth a mechanism. That principle is sound and should be kept.

But the mechanism chosen — record the domain rules as prose obligations *inside an amendment row*, while
leaving the invariant table and the event table saying something else — produces a document that hands the
feature spec **two conflicting sources of truth**. Decomposition will read §1.4.5 and §1.4.4, because that is
what those sections are for. Per item:

| A-12a item | Verdict |
|---|---|
| **(1)** `POST /lines` quantity is a **delta** | **Domain rule.** It is the definition of INV-2's *"increments quantity"*, which is otherwise ambiguous. Belongs in INV-2's own cell. Content is correct. |
| **(2)** a collision emits `line_updated`, not `line_added` | **Domain rule, and it contradicts §1.4.4.** The emitter column still binds events to routes. This must be restated as fact→event mapping in §1.4.4, including how `previousQuantity` is populated on the POST path. |
| **(3)** attribute-edit collision merges into the surviving line | **Domain rule, and it is the only thing keeping Strong INV-2 true.** Belongs in INV-2. Incomplete: no event for the absorbed line (`clientBroadcast` surface), no quantity-sum rule, no INV-14-overflow rule. |
| **(4)** `PATCH quantity: 0` is rejected | **Domain rule, and it flatly contradicts INV-3** ("zero means remove"), which is Strong and unchanged. This is the clearest instance of the pushback hiding a defect. |
| **(5)** idempotency store = side table `(session_id, key)`, 24h | **Genuinely feature-spec detail** — with two App-Spec-level residues the document still owes: what *"the prior result"* means for INV-7a (Strong), and A-2's contradicting claim that no side table exists (W4-D). Strike the table design; keep the semantics. |

So: **four of five are domain rules that belong in §1.4.3/§1.4.4/§1.4.5, two of them actively contradicting
text left unchanged; one is correctly delegated.** The right move is not to delete A-12a but to *promote its
content* into the invariant and event tables and leave A-12a as a pointer — at which point the amendment row
does exactly the job the author claims for it, without the contradictions.

---

# RESOLVED (pass-3 findings genuinely fixed)

- **CR3-1(a)** — delta semantics decided (A-12a(1)). Correct answer; wrong location (C5).
- **CR3-1(c)** — `PATCH`'s mutable field set decided, and the collision-merge rule is the right domain answer.
- **CR3-1(e)** — decided cleanly and argued well: *"the whole-array PATCH does not survive — two mutation
  surfaces on one aggregate would let a client bypass INV-2."* This is the sharpest sentence added in v4.
- **CR3-2** — the idempotency store now exists (A-12a(5)), with a retention independent of the row TTL. A-2's
  contradicting rationale survives (W4-D).
- **CR3-3(c)/(d)** — `tax_amount` is snapshotted and the resolver validates rather than trusts. The reasoning
  (*"an ACL that passes such a row through has failed at the one job it exists to do"*) is exactly right; the
  validation as written is broken (C2), and the arithmetic fix reached one of four locations (C1).
- **CR3-5(a)** — the Cart Token now has its own TTL, bounded by the cart's. Correct and needed.
- **CR3-6(b)** — INV-6 widened to all money with a distinct `CartLineInput`. The best-executed fix in v4;
  `CartLineInput` is specified tightly enough to be a contract (three fields, enumerated, "only"). Its
  enforcement gap is C3, not the type.
- **CR3-7** — the adoption row exists and the reasoning for it is correct. Payload undefined (C6).
- **W7 (first half)** — now Q-15, correctly scoped.
- **W11 (first half)** — the `numeric(16,4)` claim tightened.

# OK

1. **§0 and §0.1's single-aggregate decision is settled** — four passes, no reason to reopen. C7 is a defect
   *in* the handover table's application, not in the table.
2. **`CartLineInput`** is the model for how the rest of the document should specify things: named, enumerated,
   closed ("only"), with the reason stated.
3. **The value-object boundary for Cart Lines still holds.** Nothing in C1–C8 argues for promoting lines to
   entities; A-12a(3)'s merge rule is precisely what a value object inside an aggregate root should do.
4. **The tax-basis decision (per-line net + gross + rate + display mode, `display_tax_mode` demoted to
   display) remains correct** and should not be reopened. Every money finding in this pass is about arithmetic
   and validation layered on top of it.
5. **The banned-phrasings table, the Customer User / Customer Entity split, INV-16, A-8 and A-9** continue to
   be the most durable work in the document.
6. **§0's "an applied but unlisted amendment is a defect" rule is what made C3(a) and C7 findable.** It keeps
   earning its place; it is simply not being applied to the amendments v4 itself introduced.

---

# What would change the verdict

**C1 and C2 are the gate.** They are one editing session: propagate the line-total rounding rule into INV-5,
INV-13 and §1.4.8, fix `tax_rate`'s percentage/fraction error, state the `tax_amount`-is-null rule, and
re-express the tolerance against the stored precision. Nothing else in the document is worth building until
the money is internally consistent, because §1.4.8 is the first function an implementer writes.

**C3, C5 and C7 are the same edit repeated three times**: take the decisions v4 already made correctly and
propagate them into the invariant table, the event table and the amendment list, deleting the superseded
statements. If the author does only one thing before pass 5, it should be a **consistency sweep** — for each
rule changed in v4, grep the document for every other place that states the same rule.

**C4, C6 and C8 are a paragraph each**: bound the token's ceiling without stranding the guest; define the
adoption payload's two ids; decide whether a quantity change re-prices.

**What would change my mind about the verdict:** if C1 and C2 were the only findings, I would call this ready
with conditions — the structure, the boundary work and the ubiquitous language are now genuinely good, and the
document is markedly stronger than v3. What blocks it is not the count but the pattern: v4 introduced two new
holes (C4, C6) while closing seven, and left twelve WARNINGs untouched. A pass 5 that closes the eight
CRITICALs *and* demonstrably swept for internal contradictions — rather than editing the quoted paragraphs —
should pass the gate.
