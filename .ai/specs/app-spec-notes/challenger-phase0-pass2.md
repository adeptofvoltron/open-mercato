# Challenger Gate — Pass 2 (v2 of `2026-08-13-app-spec-storefront-cart.md`, §0 / §1 / §2 / §10)

Reviewer role: domain-driven-design expert. Second pass over the rewrite that followed
[`challenger-phase0.md`](./challenger-phase0.md) (8 CRITICAL / 15 WARNING). Sections 3–7 intentionally
unwritten — not reported.

**Verdict: 8 CRITICAL, 14 WARNING. NOT READY for Phase 1.**

The rewrite is real work and most of the first pass is genuinely closed — the ownership model, the token
lifecycle, the merge rules, the anti-corruption layer and the event emittability problems are all fixed.
The failure mode of this pass is different and more dangerous: **five of the eight CRITICALs below are
defects the fixes themselves introduced**, and two more are contradictions with the parent spec that the
first pass never checked because v1 did not make the claims that collide with it.

Concentration of defects, in order of blast radius:

1. **The line identity key is now specified twice, differently** (INV-2 vs INV-7a). The fix for C-3
   (idempotency) and the fix for C-3's other half (INV-2 rewrite) were applied independently and were never
   reconciled. Together they reproduce the exact double-add C-3 was raised to kill.
2. **The document now contradicts SPEC-029 in two places it did not contradict in v1** —
   `workflow_instance_id` (§19.3/§19.4) and the PATCH mutation shape (§12.1/§7.5.2) — with no amendment
   recorded, which §0 defines as a defect in this document.
3. **`tax_mode` fixed C-4's symptom by minting a third source of truth for tax basis**, reproducing the
   two-owner-claims pattern that C-2 killed for identity.

---

## Ground truth re-verified this pass

Spot-checks against code, not against the author's notes. Where the notes were wrong, it is called out.

| Claim (source) | Verdict |
|---|---|
| `readCheckoutAccessCookie` / `verifyCheckoutAccessToken` exist | ✅ `packages/checkout/src/modules/checkout/api/helpers.ts:83`; `verifyCheckoutAccessToken` actually lives at `lib/utils.ts:292` |
| A-1 "reuses this exact pattern" from `packages/checkout` | ❌ **Refuted.** That token is a **stateless HMAC-signed** token (`signCheckoutAccessToken`, `utils.ts:278-290`), **never stored**, `sameSite: 'strict'`, `maxAge: 3600`, host-only. A-1 wants a *stored, hashed, per-row-revocable, 30-day, rotatable* secret. Different mechanism. (Stored-hash precedents do exist: `sales/api/quotes/public/[token]`, `onboarding`, `enterprise/sso/scimTokenService`.) See W-1 |
| `catalogPricingService.resolvePrice` / `resolvePriceMany` exist | ✅ — but **neither loads prices**; the caller supplies already-fetched `PriceRow[]`. See W-2 |
| Catalog carries tax basis | ✅ `CatalogProductPrice` has **both** `unit_price_net` and `unit_price_gross`, plus `tax_rate`, `tax_amount` (`catalog/data/entities.ts:824-833`); `CatalogPriceKind.displayMode ∈ {'including-tax','excluding-tax'}` (`entities.ts:754`, `data/types.ts:89`). See CR-5 |
| `OptimisticLockConflictBody` shape | ✅ `{ error:'record_modified', code:'optimistic_lock_conflict', currentUpdatedAt, expectedUpdatedAt }` (`optimistic-lock-headers.ts:25-30`) — **timestamp-only payload**. See W-3 |
| Optimistic-lock tests have a claimable exemption | ⚠️ **Partially.** Exemption = *omission from a hardcoded curated map* (`optimistic-lock-editable-entities.test.ts:30-60`); the "state-machine rows guarded by an explicit status check" carve-out exists only in a header comment. The UI test scans `packages/core/src/modules/**/{backend,components}/**/*.tsx` only — it would never see `apps/storefront/`. See W-3 |
| `CustomerUser` with `personEntityId` + `customerEntityId`; `customers.CustomerEntity` | ✅ `customer_accounts/data/entities.ts:17,55-61`; `customers/data/entities.ts:30` |
| "387 event ids, snake_case dominates 19:3" | ⚠️ Substance correct, numbers wrong: **420** ids across 31 files, ratio **21:3**. `pos.cart.completed` is prose in root `AGENTS.md:202` only — **no `pos` module exists**. See W-14 |
| A shared canonical-JSON / stable-key helper exists | ❌ **None in `packages/shared`.** The only real one is module-local and unexported (`packages/search/src/vector/services/checksum.ts:3-13`). See CR-2 |
| SPEC-029 leaves storefront customer login undecided | ✅ Open Question #1, line 1837: *"Reuse `auth` module for storefront customer login or introduce separate customer identity? (Phase 3 decision point)"*. See CR-8 |
| `ecommerce` module / `apps/storefront/` still unimplemented | ✅ confirmed — every fix below still costs one line in an unwritten migration |

---

# CRITICAL

## CR-1 — INV-2 and INV-7a specify two different identity keys for the same value object; together they reproduce the double-add C-3 was raised to kill (§1.4.3, §1.4.5, §1.4.7)

This is the most important finding in the pass. The two fixes for C-3 were applied independently:

- **INV-7a / `CartLine.line_id`** (§1.4.3): *"Client-supplied. Makes add-to-cart an idempotent upsert: a retried request targets the same line."* → the identity key is `line_id`.
- **INV-2** (§1.4.5): *"A line is uniquely keyed by `(variant_id, line_attributes)`; adding an existing key increments quantity rather than appending a line."* → the identity key is `(variant_id, line_attributes)`.

They cannot both be the key. Three concrete contradictions:

**(a) The retry bug returns, unchanged.** Shopper adds variant V (attrs A) — line `L0` created. Shopper adds V/A again; the client mints a fresh `line_id` `L1`. INV-2 collapses the add into `L0` and **`L1` is never persisted anywhere**. The response is lost. The client retries with `L1`. The server looks for `L1`, finds nothing, treats it as a new add, and sums the quantity a second time. The cart now reads qty 3 where the shopper intended 2 — and unlike v1's duplicate-line symptom, this one is *invisible*: there is no duplicate row to notice, just a wrong number. INV-7a's premise ("a retried request targets the same line") is false for every add that collides, i.e. for the single most common add-to-cart path.

**(b) Same `line_id`, different `line_attributes`.** INV-7a says the request targets the same line (upsert). INV-2 says it is a different key, therefore a different line. Undefined which wins — and the answer determines whether a shopper editing an engraving mutates a line or creates one.

**(c) Different `line_id`, identical `(variant_id, line_attributes)`.** INV-2 merges them; the surviving line keeps `L0`'s id, so the client's optimistic UI keyed on `L1` now points at nothing. The `line_added` event fires with `lineId: L1`? or `L0`? `line_updated` instead? §1.4.4's emitter column ("API, on line upsert (new line)") does not disambiguate, so the three `clientBroadcast` events cannot be emitted deterministically either.

**Fix — pick one key and demote the other:**
- **Preferred:** `(variant_id, canonical(line_attributes))` is the *domain* key (INV-2 stands); `line_id` is **server-assigned**, stable, and used only for addressing existing lines in update/remove. Idempotency then needs its own mechanism — a per-mutation `Idempotency-Key` header with a stored `key → (session_id, resulting_version)` map, which is also what makes INV-7a implementable at all (see CR-7).
- **Or:** `line_id` is the key (client-supplied), INV-2 becomes a *client-side* convenience ("the client SHOULD reuse the existing `line_id` when re-adding the same variant+attributes") and stops being a Strong server invariant.

Whichever is chosen, INV-2, INV-7a, `CartLine.line_id`'s description, §1.4.7's collision rule and §1.4.4's three line events must all be restated together. They are currently four independent statements of one rule.

## CR-2 — INV-2 is a Strong invariant whose equality relation is undefined, over jsonb, with no helper in the repo (§1.4.3, §1.4.5)

INV-2 keys lines by `(variant_id, line_attributes)` where `line_attributes` is `jsonb`, optional, shopper-supplied. Nothing in the document defines what "the same `line_attributes`" means. Every one of these is unanswered and each produces a different cart:

| Case | Consequence if undefined |
|---|---|
| absent vs `null` vs `{}` | Three representations of "no personalization". A client that omits the field and one that sends `{}` produce **two lines of the same variant** — precisely the duplicate INV-2 exists to prevent, on the 95% path where no personalization is used |
| key order (`{a,b}` vs `{b,a}`) | Postgres `jsonb` normalizes key order, but the comparison here happens **in application code** over elements of a jsonb *array* loaded into JS, where `JSON.stringify` is insertion-ordered. The invariant's correctness silently depends on which layer compares |
| `1` vs `"1"`, `true` vs `"true"` | Type coercion across a public, unauthenticated API where the client controls the JSON |
| `"John"` vs `"John "` vs unicode NFC/NFD | Shopper-typed engraving text. Trivial to produce accidentally |
| nested objects / arrays, `undefined` members | No depth or shape constraint on `line_attributes` at all — and it is inside the jsonb blob INV-14 bounds by *size*, not by *shape* |

Verified: **there is no shared canonical-JSON helper in `packages/shared`.** The only stable serializer in the repo is module-local and unexported (`packages/search/src/vector/services/checksum.ts:3-13`, which itself collapses `undefined` to `'null'` and mishandles Date/Map/Set). So this is not "one line in a migration" — it needs a normalization rule *and* a promoted shared helper.

**Fix:** state the canonical form as part of the domain model, not as an implementation detail — (1) `line_attributes` is normalized on write: absent/`null` ⇒ `{}`; (2) keys sorted, values restricted to a flat `Record<string, string>` (or an explicitly stated JSON subset); (3) strings trimmed and NFC-normalized; (4) the equality predicate is over the canonical form, computed by a named shared helper. Add a schema constraint (`line_attributes` max keys / max value length) so INV-14 bounds shape as well as size.

## CR-3 — The mutation contract the whole line model depends on does not exist in the parent and is not amended (§1.4.3, §1.4.4, §1.4.5, §1.5)

SPEC-029 §12.1, §7.5.2 and §19.4 all specify one mutation shape:

```
PATCH /api/ecommerce/storefront/checkout/sessions/:id
Body: { version: N, lines?, email?, customerRef?, shippingAddress?, billingAddress? }
// §7.5.2 example: { version: 3, lines: [{ variantId, quantity }] }
```

That is a **whole-array replace of `{variantId, quantity}` pairs**. It carries no `line_id`, no `line_attributes`, and no per-line intent. The App Spec's entire line model presumes the opposite:

- `line_id` is *client-supplied* (§1.4.3) — the parent's body has no field to supply it in.
- `line_attributes` is part of the line identity (INV-2) — the parent's body cannot express it.
- `ecommerce.cart.line_added` / `line_updated` / `line_removed` are three distinct facts with `previousQuantity` (§1.4.4) — an array replace can only be *diffed*, and a diff cannot distinguish "removed L1, added L2" from "changed L1's attributes".
- INV-7a's "same `line_id`, **same intent**" is undefined when the request expresses no intent, only a desired end state.

Ironically, whole-array replace is *naturally* idempotent (replaying the same array twice is a no-op), so the parent's contract does not have C-3's bug — the App Spec's per-line model introduces the need for INV-7a and then never amends the contract that would carry it.

**§0 states that an unrecorded amendment is a defect in this document.** This is the largest one: A-4 defines the *types* `CartLine`/`CartTotals` but no amendment touches the *operations*.

**Fix:** add an amendment (A-12) specifying the cart-phase mutation surface explicitly — either intent-bearing sub-resources (`POST/PATCH/DELETE …/sessions/:id/lines[/:lineId]`) or a documented `lines` body extended with `lineId`/`lineAttributes` plus an operation discriminator. State which one, because CR-1's resolution depends on it.

## CR-4 — `workflow_instance_id` "null throughout the cart phase" directly contradicts SPEC-029 §19.3/§19.4, unrecorded — and Phase 1 is about to build workflows (§1.4.2, §0.1)

§1.4.2 classifies `workflow_instance_id` as *"**Checkout scope.** Null throughout the cart phase."* The first pass endorsed this framing (OK-5). It is wrong against the parent:

- **§19.4**: `POST /checkout/sessions` — *"Returns: `{ id, version: 1, status: 'open', workflowInstanceId, currentStep, availableTransitions }`"*. The workflow instance is created **at session creation, while `status='open'`**.
- **§19.3**: the seeded workflow `checkout_storefront_v1` has **`cart_review (USER_TASK)` as its first step**. The cart *is* a workflow step in the parent's model.
- **§12.1**: the same `workflowInstanceId` / `currentStep` / `availableTransitions` triple is on the session GET response, and §19.4's polling hook reads `workflowStatus` on an open session.

So the parent says the cart phase is workflow-driven from creation; this App Spec says the cart phase never touches a workflow. Both cannot be built. This is not a nuance — it decides whether add-to-cart is a plain CRUD write or a workflow transition, whether `cart_review` transitions are the mutation surface (interacting with CR-3), and whether the `open → locked` handover in §0.1 is a status write or a workflow transition.

It is also the highest-cost item to discover late: **Phase 1 writes the workflows.**

**Fix:** decide and record it as an amendment. Either (a) amend §19.3/§19.4 to create the workflow instance at the *first transition out of `open`* and drop `cart_review` from the workflow (cleanest, and consistent with §0.1's handover table), or (b) accept the parent and rewrite §1.4.2, §0.1 and the merge rules to account for a live workflow instance during the cart phase — including what happens to that instance when a cart is absorbed by a merge or expires.

## CR-5 — `tax_mode` fixes C-4's symptom by minting a *third* source of truth for tax basis, one the catalog already carries twice (§1.4.3, §1.4.8, §1.5 A-4)

C-4 was correct: the cart's money had no defined net/gross basis. The chosen fix is wrong at the source.

`CartTotals.tax_mode` is *"Snapshotted from `EcommerceStore.settings.features.showPriceIncludingTax` at creation"* — a **store-wide display toggle**. But the catalog already carries the fact, twice, at the right granularity:

- `CatalogProductPrice` stores **both** amounts on the same row: `unit_price_net` (`entities.ts:824`), `unit_price_gross` (`:827`), plus `tax_rate` (`:830`) and `tax_amount` (`:833`).
- `CatalogPriceKind.displayMode ∈ {'including-tax','excluding-tax'}` (`entities.ts:754`) — **per price kind**, and the App Spec already snapshots `price_kind_id` on every `CartLine`.

Three consequences:

1. **Two fields can disagree about one fact.** A store with `showPriceIncludingTax: true` bound to a price kind with `displayMode: 'excluding-tax'` produces a cart stamped `tax_mode: 'gross'` over net numbers. This is exactly the defect pattern the first pass killed in A-3 (two owner claims on one row) — reintroduced for money. And unlike identity, the contradiction is invisible until an order total is wrong.
2. **A store-wide mode cannot describe a per-line fact.** `price_kind_id` is per line (§1.4.3) and the channel binding can change over a 30-day TTL, so two lines in one cart can legitimately come from price kinds with different display modes. A single `CartTotals.tax_mode` then describes neither.
3. **`CartLine` discards data checkout needs.** A single `unit_price_amount` "in the session's `tax_mode`" throws away the other half of a row the catalog already resolved. §0.1 hands "tax breakdown" to checkout while deleting, at snapshot time, the `tax_rate`/`tax_amount` that would let checkout do it without a catalog round-trip 30 days later.

There is also a latent impossibility if the store toggle is ever treated as authoritative: converting net→gross requires a tax rate, which for cross-border B2C depends on the shopper's country — an address §0.1 explicitly hands to checkout. The cart can only ever *report* a basis it received; it can never *choose* one.

**Fix:** source the basis from the price, not the store. Snapshot per `CartLine`: `unit_price_net_amount`, `unit_price_gross_amount`, `tax_rate`, and `price_kind_display_mode` (all already available on the resolved row). Keep `CartTotals.tax_mode` only as the **display selection** derived from `showPriceIncludingTax`, explicitly documented as "which of the two stored amounts the storefront shows", not as "the basis of the numbers". Then a merchant flipping the toggle mid-cart changes presentation only — INV-13 holds, the read-time drift advisory compares like with like, and the handover to `sales` is unambiguous.

## CR-6 — The currency-conflict no-merge path has no terminal state, no surface, and no INV-12-compatible resolution (§1.4.7, §1.4.5 INV-12, §2)

§1.4.7: *"If the two carts' `currency_code` differ, **no merge occurs**: the guest cart is preserved untouched, no `cart.merged` event is emitted, and the shopper is offered an explicit choice."* Three holes:

1. **No surface for the offer.** §2 defines three surfaces and three personas; nothing in §1 or §2 defines a shopper-facing decision point, and §3/§3.5 (workflows, UI architecture) are unwritten. As written the rule is a promise the document cannot keep. That alone would be a Phase-1 deferral — the next two are not.
2. **Resolution violates INV-12 or requires a lying status.** If the shopper picks the guest cart, that cart must become theirs → `customer_user_id` is set → **two open sessions for `(store_id, customer_user_id)`**, which INV-12 forbids. The other cart must therefore terminate — with what? `merged` (A-10) is false (nothing merged, and `merged_into_session_id` would point at a cart that absorbed nothing). `canceled` pollutes the §1.2 conversion denominator, which §1.2 excludes **only** `merged` from. `expired` lies about TTL. **A-10 was created to fill exactly this hole and fills it only for the happy path.**
3. **Meanwhile, "which cart is mine" is undefined.** Between login and resolution, the browser holds a valid Cart Token for the guest cart *and* an authenticated identity owning another cart. INV-8 governs *a cart's* owner claim; nothing governs *request resolution* when both claims are present. §1.4.6's table ("Cart (authenticated): Reads = Owning Customer User") implies the guest cart silently becomes unreachable — which contradicts §1.4.7's "preserved untouched" and makes the offer undisplayable.

The same hole reappears for the INV-14 cap: §1.4.7 says colliding quantities are *"summed, capped by INV-14"* — silently clamping loses shopper intent, rejecting leaves the merge in the same limbo, and neither is chosen.

**Fix:** (a) add a terminal status for a cart discarded by shopper choice, or state that the losing cart stays `open` and is excluded from INV-12 by an explicit `superseded_at`/`merged_into_session_id` marker; (b) state the request-resolution rule when both a Cart Token and a Customer User identity are presented and no merge has occurred; (c) decide clamp-vs-reject for the INV-14 cap during merge, and say what the shopper is told.

## CR-7 — System writes have no defined `version` semantics; INV-7 as stated forces a 409 storm on the exact path that double-adds (§1.4.2, §1.4.5 INV-7/INV-7a, §1.5 A-5)

INV-7: *"Every accepted mutation increments `version` by exactly 1."* The v2 amendments added three **server-initiated** writes to the same row and no rule for any of them:

| Write | Actor | Version bump? |
|---|---|---|
| `abandoned_at` stamped (A-5) | abandonment scanner worker | undefined |
| `abandoned_at` cleared, `last_activity_at` updated (A-3/A-5) | API, possibly on **read** | undefined |
| `expires_at` extended on activity (§1.4.2) | API | undefined — and SPEC-029 §7.5.2 explicitly cites *"stale-client updates after server-side expiry bump"* as something the version guard is meant to catch, implying the parent expects it to bump |

If system writes bump `version`, then **every shopper returning after the abandonment threshold gets a 409 on their first action**, and SPEC-029 §7.5.2's documented recovery is *"re-fetch the session to get the current state before retrying"* — i.e. re-fetch and re-apply, which is CR-1's double-add path. A metric-collection job would become a correctness bug on the primary conversion surface.

If they do not bump, INV-7 is simply false as written and needs the word "client" in it.

Related and equally unstated: **INV-7a is unreachable under the parent's own ordering.** A retried mutation carries the *stale* version (3) while the server is at 4, so §7.5.2's version check fires **before** any replay detection and returns 409. For INV-7a to exist at all, the spec must state that idempotency detection precedes the version precondition — which is a change to §7.5.2 and is not amended anywhere.

**Fix:** state that `version` counts **client-intent mutations only**; system writes (`abandoned_at`, `last_activity_at`, `expires_at` extension, TTL re-derivation) do not increment it and do not invalidate a client's held version. Amend §7.5.2's evaluation order so replay detection precedes the version check. Add `last_activity_at`-on-read as an explicit decision (it makes every GET a write on a public unauthenticated endpoint — see W-6).

## CR-8 — The Authenticated Shopper has no login surface; §2 silently closes SPEC-029's own Open Question #1 (§2, §1.4.7, §1.5)

§2 gates the Authenticated Shopper on `requireCustomerAuth` / `customer_accounts.CustomerUser`, and the entire merge model (§1.4.7), INV-12, A-3's FK and the §1.2 merge-rate metric rest on it. Against the parent:

- **SPEC-029 Open Question #1 (line 1837)**: *"**Customer account model**: Reuse `auth` module for storefront customer login or introduce separate customer identity? (Phase 3 decision point)"* — the parent explicitly leaves this **undecided**. §2 decides it and records no amendment. §0 calls that a defect in this document.
- **§12.1 defines no authentication endpoint** on the public storefront surface — only `context`, `products`, `categories`, and the four session routes.
- **§14.1 defines no `login`, `account` or `auth` route** in `apps/storefront/`, and §14.2 forbids the app from depending on `@open-mercato/*`.
- Consequence: `ecommerce.cart.merged`'s emitter is listed as *"API, on login merge"* — **there is no login API to hang it on.** The merge trigger, the token rotation "on login" (INV-15), and the "no account cart yet → guest cart becomes the customer's" path all have no execution point.
- Cookie topology compounds it: A-9 chose "API proxied same-site under the store host", which is the *right* call precisely because a customer session cookie must be issued for `firda.pl` — but A-9 argues it only for the **Cart Token**, never for the customer session, and §2 never states that customer auth must be served on the store host.

**Fix:** record the amendment. Minimum content: (a) SPEC-029 OQ#1 resolves to `customer_accounts.CustomerUser`; (b) the public storefront surface gains customer auth endpoints (login/logout/session) under `/api/ecommerce/storefront/`, or the portal login is served same-site under the store host; (c) the customer session cookie is issued for the store host with the same topology constraint A-9 imposes on the Cart Token; (d) `cart.merged`'s emitter names that endpoint.

---

# WARNING

## W-1 — A-1's cost line ("Low — `packages/checkout` already ships this exact pattern") is false (§1.5 A-1)

Verified: `packages/checkout`'s access cookie is a **stateless HMAC-signed token** (`signCheckoutAccessToken`, `lib/utils.ts:278-290`) that is **never stored in the database**, with `sameSite: 'strict'`, `maxAge: 3600`, host-only, and expiry baked into the payload. A-1 specifies a **stored, hashed, globally-unique, 30-day, rotatable, per-row-revocable** secret (`cart_token_hash`). The lifecycle INV-15 demands — rotate on merge, rotate on login, invalidate on logout — is exactly what a stateless signed token *cannot* do without a stored per-row version. Different mechanism, different cost.

This matters beyond bookkeeping: §4's gap matrix will inherit the "Low / 0-1" score, and the note under §1.5 (*"None is new platform machinery"*) is wrong for A-1.

Stored-hash precedents that *are* the right analogue: `packages/core/src/modules/sales/api/quotes/public/[token]/route.ts`, `packages/onboarding/.../data/entities.ts`, `packages/enterprise/src/modules/sso/services/scimTokenService.ts`.

Also unspecified and load-bearing: **"stored hashed" must mean a *deterministic* hash** (e.g. HMAC-SHA256 with a server secret). A per-row-salted hash (bcrypt/argon, the repo's password precedent) makes lookup-by-token a table scan and is incompatible with both the unique index and INV-11's store-scoped predicate.

## W-2 — §1.4.8's resolver steps omit the price *fetch*, and the "one call, not N" claim is misleading (§1.4.8)

`catalogPricingService.resolvePrice` / `resolvePriceMany` do **not** load prices — the caller supplies already-fetched `PriceRow[]` and a `PricingContext` (`catalog/services/catalogPricingService.ts`, `catalog/lib/pricing.ts:139,192`). §1.4.8's step list (*"resolve price via `catalogPricingService.resolvePrice` / `resolvePriceMany`"*) therefore skips the step that actually costs the queries, and the note *"`resolvePriceMany` is the batch entry point … one call, not N"* is true of the resolve and false of the fetch. For a whole-cart drift re-resolution on every read — on a public, unauthenticated, hot path — the fetch is the thing that needs to be batched and cached.

Also: `PricingContext` is `{ channelId?, offerId?, userId?, userGroupId?, customerId?, customerGroupId?, quantity, date }`. §1.4.8's input list does not map onto it — notably `quantity` (so re-resolving a line at read time must pass the *current* quantity, or tiered prices drift for a reason unrelated to catalog change) and `date`. Name the mapping.

## W-3 — A-11's two concrete requirements are both unsatisfiable as written (§1.5 A-11, §1.5 A-9)

- *"The 409 body SHOULD match `OptimisticLockConflictBody`'s shape."* That shape is `{ error:'record_modified', code:'optimistic_lock_conflict', currentUpdatedAt, expectedUpdatedAt }` (`optimistic-lock-headers.ts:25-30`) — **its payload fields are ISO timestamps**. An integer version cannot be expressed in it. At most `error`/`code` can match, which is not "the shape".
- *"the test exemption [must be] claimed explicitly."* There is **no claim mechanism**. `optimistic-lock-editable-entities.test.ts` audits a hardcoded curated map (lines 30-60) — exemption is *omission*, and nothing forces a new entity into the map. `optimistic-lock-ui-coverage.test.ts` scans `packages/core/src/modules/**/{backend,components}/**/*.tsx`; `apps/storefront/` is outside its glob entirely. Its inline `optimistic-lock-exempt` marker applies to `.tsx` files that call `updateCrud`/`deleteCrud` — not to this surface.
- **A-9/A-11 contradict each other on the same file.** A-11 changes the 409 body; A-9 amends §14.3 for `credentials`/`cache` but leaves `StorefrontVersionConflictError` parsing `json.currentVersion` (SPEC-029 §14.3, lines 1149-1152). Two amendments to one client, disagreeing.

**Fix:** state the actual position — the entity keeps its `updated_at` column (root AGENTS.md → Conventions, satisfied); the storefront surface uses body `version` and does **not** use the header token; no existing test covers it, so the divergence is enforced by nothing and must be documented rather than "exempted"; and define the 409 body concretely (e.g. `{ error:'version_mismatch', code:'optimistic_lock_conflict', currentVersion, expectedVersion }`), then amend §14.3 to parse it.

## W-4 — A-2's rationale describes a table the parent does not have, and its mechanism is unstated (§1.5 A-2)

A-2: *"left coupled, keys live 30 days and the creation-idempotency **table** grows unbounded."* SPEC-029 §7.4 stores `idempotency_key` as a **column on `ecommerce_checkout_sessions`**, unique per store. There is no separate table; the key dies with the row it is on, so "unbounded growth" is not the failure mode. (This error is inherited verbatim from the first pass — worth correcting rather than propagating.)

The real question A-2 must answer and does not: *how* do you decouple a column's expiry from its own row's TTL? Null it at 24h (then a 25h retry with the sessionStorage key creates a **second** cart — and for an authenticated shopper that trips INV-12)? Move it to a side table (a schema amendment A-2 does not state)? Keep it 30 days and accept the uniqueness window?

## W-5 — `abandoned_at` is never cleared at the phase boundary, so recovery attribution systematically undercounts conversions; and A-10 amends the enum but no worker predicate (§1.4.4, §1.5 A-5/A-10)

- §1.4.4 emits `cart.recovered` *"edge-triggered on clearing `abandoned_at`"*, and A-5 clears it *"on activity"*. A `open → locked` transition is not described as activity. So the abandoned cart that **converts** — the outcome recovery campaigns exist to produce — emits no `recovered` event. Attribution measures re-engagement and misses success.
- A-10 adds `merged` to the enum but amends no predicate. The abandonment scanner and the expiry worker must both exclude `merged` (and the scanner must exclude anything not `open`). A naive expiry predicate — `expires_at < now() AND status NOT IN ('completed','canceled','expired')`, which is the obvious reading of SPEC-029 §7.4 — would flip merged carts to `expired`, destroying the `merged_into_session_id` audit trail and re-polluting the §1.2 denominator that A-10 exists to protect.
- A-10 also leaves §7.4's **status lifecycle diagram** unamended. State the legal transitions: `open → merged` only, terminal, no outbound edges.

## W-6 — `last_activity_at` makes reads write, on a public unauthenticated endpoint (§1.4.2, §1.5 A-3)

`last_activity_at` is *"yes, system"* and drives both the survival metric and abandonment scanning, but nothing says what counts as activity. If reads count, every cart `GET` becomes a row write on the platform's highest-traffic public endpoint (and interacts with CR-7's version question, `updated_at`, and any cache strategy). If only mutations count, the "survival rate" metric (*"still `open`, non-expired and **token-reachable** 24h after creation"*) measures something different from what §1.2 claims, and a shopper who returns and browses their cart without editing it is scanned as abandoned.

Also still missing from the first pass's W-4 list: **what `expires_at` does when a store changes its TTL.** A-2 makes the TTL store-configurable; nothing says whether existing carts re-derive, keep their original `expires_at`, or extend on next activity.

## W-7 — Unrecorded store-settings amendments; `settings.features` cannot hold three of the four values §1 assumes (§1.3, §1.4.5 INV-14, §1.5 A-2/A-6)

§1.3 states the Store *"Owns TTL, abandonment threshold, tax display mode and the guest-cart flag."* A-6 records **only** `allowGuestCart`. Unrecorded: the `open`-phase TTL (A-2 says "store-configurable" without a home), the **abandonment threshold** (§1.3: "per-store threshold"), and INV-14's **max lines per cart / max quantity per line** ("both store-configurable with platform defaults").

Worse, they cannot go where A-6 puts its flag: SPEC-029 §7.1.1's `features` is a closed type of **six booleans**. A TTL in days, a threshold in hours and two integer caps are not booleans — they need a new `settings.cart` section, which is a further schema/type amendment nobody has written.

## W-8 — The primary KPI's numerator is emitted by nothing in scope, and its denominator depends on an unspecified creation trigger (§1.2)

- **Numerator:** *"carts reaching `locked`"*. The `open → locked` transition is explicitly out of scope (§0.1) and §1.4.4's eight events contain no `cart.locked` / `checkout_started`. The metric's stated source is "status transitions" on the table, which is queryable — but nothing in this spec *emits* the fact, so no subscriber can react to it and the funnel's most important edge is unobservable in the event stream that §1.1's flywheel depends on.
- **Denominator:** *"carts created"*. When is a cart created — first page view, first add-to-cart, or first `POST /checkout/sessions`? §1.4.2 says `line_snapshot` *"may be `[]`"*, so empty carts exist and count. A storefront that creates a session eagerly and one that creates it lazily will report conversion rates differing by an order of magnitude on identical shopper behaviour. Fix the trigger in §1.2 (recommend: session created on first successful line add; an empty cart is not a cart).

## W-9 — `CartTotals.pricing_basis_ref` is a single value describing a multi-valued fact (§1.4.3)

`pricing_basis_ref: { price_kind_id, resolved_at }` sits on `CartTotals`, i.e. one per cart. But `price_kind_id` is already per `CartLine`, lines are resolved at different times across a 30-day TTL, and the channel binding (which supplies the price kind, SPEC-029 §7.3/§6.3) can change in between. So the totals-level field can contradict the lines it summarizes — the CR-5/C-2 pattern again, in miniature. Verified: the resolver returns a bare `PriceRow`, so `resolved_at` has no producer other than "when we called it"; there is no version column on `catalog_product_prices`.

**Fix:** drop it from `CartTotals` and keep the basis per line (`price_kind_id` + `resolved_at` alongside `added_at`), which is where drift is computed anyway.

## W-10 — INV-8's precedence and INV-15's rotation-on-login contradict each other (§1.4.5, §1.4.7, §1.4.6)

INV-8: owner is *"`customer_user_id` when set, else a valid Cart Token"* — read as an access rule, once the FK is set the token grants nothing, which is what §1.4.6's table says (*"Cart (authenticated): Reads = Owning Customer User"*). §1.4.7 then says *"the surviving cart's token is **rotated** on login"*.

If the token no longer grants access to an owned cart, rotating it is dead ceremony. If it does still grant access, then a leaked or planted token reads an authenticated shopper's cart — the fixation risk C-5 was raised about, surviving the fix. One of the two statements must go; if the token *does* remain live for owned carts (defensible: it is how a logged-in shopper's other tab keeps working), then INV-8 must say so and §1.4.6's table must be corrected.

Related: in the CR-6 no-merge case there is no single "surviving cart", so "the surviving cart's token is rotated" has no referent.

## W-11 — The deferred merge after a `locked` checkout has no trigger, no owner and no event (§1.4.7)

*"Merge while `locked` … the guest cart stays open and merges after the checkout resolves."* Nothing observes "the checkout resolves": §1.4.4's eight events are all cart-phase, SPEC-029 declares no session-status events, and §0.1's handover table is one-directional (cart → checkout). The cart phase is claiming a behaviour it cannot trigger across a boundary it declared out of scope. Either name the inbound event (and record it as an amendment — it is a new event id on a FROZEN surface), or restate the rule as "the guest cart is merged on the shopper's next authenticated cart access", which the cart phase *can* execute.

## W-12 — No rate-limit requirement, contradicting the author's own research and a repo guard rail (§1.4.5, §10 Q-11)

`platform-readiness-cart.md` states it plainly: *"The repo deliberately treats public data routes as a reviewed exception. The cart is exactly such a route, so its spec MUST carry an explicit rate-limit + abuse section, or code review will (correctly) block it"* (citing `packages/cli/src/lib/generators/__tests__/example-public-route-safety.test.ts:14`). The App Spec has **no rate-limit invariant** — INV-14 bounds payload *size*, not request *rate* — and Q-11 defers only the *budgets*. SPEC-029 defers rate limits to Phase 5 (line 25), so the parent does not cover it either. A public, unauthenticated, unbounded-write, row-creating endpoint with no stated rate-limit requirement is the one thing on this surface that turns into an incident rather than a bug.

**Fix:** add an invariant ("every cart endpoint is rate-limited per token and per IP via `rateLimiterService`; cart creation is separately limited") and leave only the numbers to Q-11.

## W-13 — `ecommerce.checkout.view` grants more than the Store Operator persona describes (§1.4.6, §2, §1.5 A-7)

The switch from `ecommerce.carts.view` to `ecommerce.checkout.view` (W-11 of pass 1) is right for namespace consistency, but the persona table now reads *"Carts in their store, read-only"* while the feature it names governs the **whole checkout aggregate** — including post-`open` sessions carrying `email`, `shipping_address` and `billing_address`. The App Spec is defining the read scope of a surface it declared out of scope, and giving a support persona PII access it does not describe. Either say so explicitly in A-7 (the feature covers all statuses; the cart phase is a filtered view) or scope the backoffice read by status.

Also: §1.4.6's backoffice row states no tenant/organization scoping. INV-11 is *store*-scoped, which is the public-surface rule; the internal surface needs the standard tenant/org predicate stated alongside it.

## W-14 — Verifiable claims in the document are slightly wrong, and specs get read as ground truth (§1.4.4)

*"Verified against all 387 event ids in the repo: snake_case multi-word actions dominate 19:3."* Re-counted: **420** unique ids across 31 `events.ts` files; multi-word action ratio **21:3**. The conclusion is correct and the three camelCase deviations are indeed all in `packages/checkout`. Also `pos.cart.completed` is cited as precedent — it is prose in root `AGENTS.md:202` and in two unimplemented specs; **no `pos` module exists**. §1.4.4 words it correctly ("root AGENTS.md's own example"), so this is a nit — but the numbers should be corrected or the "verified against all N" phrasing dropped, because the next reader will not re-derive them.

---

# RESOLVED (first-pass findings verified as genuinely fixed)

- **C-1** — A-8 + INV-16 + INV-11 close the bare-session-id credential hole and record it as an amendment to §12.1.
- **C-2** — A-3 reframed as promoting `customer_ref.id` to an indexed FK, `customer_ref` barred from carrying an id, INV-8 given a precedence rule. Three owner claims → one.
- **C-5** (items 1, 3, 4, 6, 7, 8) — §1.4.7 decides winner, collision, terminal state (`merged` via A-10), logout, empty-cart no-op, and INV-12 caps open carts per customer. Item 2 (currency) is not fixed — see CR-6.
- **C-6** — A-5's stored `abandoned_at`, edge-triggered emission, and named emitters per event make both scanner events emittable and idempotent.
- **C-7** — Customer User vs Customer Entity glossary rows, "customer id" banned, `customer_user_id` named correctly throughout.
- **C-8** — A-9 fixes all three breakages (credentials, `no-store`, topology) and picks the same-site proxy that preserves §6.3 `Host` resolution.
- **W-1** — §1.4.1 context map + §1.4.8 Cart Line Resolver named as the anti-corruption layer, with inputs and typed rejection cases.
- **W-2** — `availability_status` covers the three non-price drift cases; `pricing_basis_ref` replaces the unimplementable `catalog_version_ref` (though see W-9).
- **W-4** (5 of 6) — INV-11 (store-scoped predicate), INV-12, INV-13, INV-14, INV-15 all added. The sixth (`expires_at` on TTL change) is still missing — see W-6.
- **W-8** — §0.1 states the lifecycle-phase-not-bounded-context framing with an explicit handover table.
- **W-10** — merge-rate denominator restricted to non-empty guest carts; abandonment threshold/TTL coupling stated; amendment dependencies declared per metric.
- **W-11** — `ecommerce.checkout.view` replaces the `carts` namespace (though see W-13).
- **W-12** — §2's gating column corrected to ACL feature ids with the `requireRoles` warning; Guest Shopper restated as a bearer capability with a lifecycle.
- **W-13** — `cart_token_hash` is globally unique *and* INV-11 requires a store-scoped lookup predicate.
- **W-14** — reserved `adjustments: []` and `total_amount` ship now with the BC rationale stated.
- **W-15** — common payload, per-event extras, and `clientBroadcast` decided per event.
- **W-6 / W-7 / W-9** — correctly converted to tracked open questions (Q-8, Q-9, Q-10) rather than hand-waved. Q-10 is properly flagged as compliance.
- **Q-1 / Q-4 / Q-6** — closed with reasoning, and Q-1's `entity: 'checkout_session'` metadata condition carried into §1.4.4.

# OK

1. **§0.1 is the right structural addition** and the handover table is the correct artifact — it is *incomplete* (CR-4's workflow instance, CR-5's tax basis, CR-8's credential, W-11's inbound trigger), not wrong. Extending it is cheaper than any of the CRITICALs.
2. **INV-16 is the single best line in the document.** "The bare session id authorizes nothing on the storefront surface" converts a diffuse worry into a checkable rule, and A-8 correctly propagates it into the parent's contract rather than leaving a silent contradiction.
3. **The read-time advisory fields** (`price_changed_since_added`, `current_unit_price_amount`, `availability_status`) are the right resolution of Q-6: they surface drift without mutating the snapshot, preserving INV-9's actual purpose. Note they must be re-resolved in the *line's* basis, not the store's current one (CR-5).
4. **`merged` + `merged_into_session_id` is the right shape** for the absorbed cart, and excluding it from the conversion denominator is the correct metric consequence. Adding an enum value to an unimplemented schema is free; the only BC caution is that Phase 1's workflow definitions and any zod/TS enum must be authored knowing about it — which is an argument for landing A-10 *before* Phase 1, not after.
5. **The value-object boundary for Cart Lines still holds** under pressure, and the "revisit if inventory reservation enters scope" note is correctly placed. `line_id` as intra-aggregate addressing is right — the defect in CR-1 is *who assigns it*, not that it exists.
6. **The banned-phrasings table remains the most operationally useful artifact in §1**, and the Customer User / Customer Entity rows now make it complete.

---

# What would change the verdict

CR-1, CR-2, CR-3 and CR-4 are the blocking set — they are the four that Phase 1 would build *on top of* and discover *inside* workflow code. CR-5 is blocking for a different reason: it is a data-model decision that becomes a migration plus a `sales` sweep once orders exist. CR-6, CR-7 and CR-8 are each a paragraph of decision, not a redesign.

None of the eight requires re-opening §0. The single-aggregate decision is still right, and the fixes are all local to §1.4 and §1.5. Fix those and this is a strong Phase 0 document.
