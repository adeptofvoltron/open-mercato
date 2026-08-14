# Challenger Gate — DDD Review of `2026-08-13-app-spec-storefront-cart.md` (§0, §1, §2)

Reviewer role: domain-driven-design expert. Scope: §0, §1.1–§1.5, §2. Sections 3+ intentionally unwritten — not reported.

**Verdict: 8 CRITICAL, 15 WARNING.** The section is well-written and the §0 decision is right, but the domain model is not yet safe to build from. The concentration of defects is in three places: (a) *who owns a cart* (three competing owner claims, no precedence, no token lifecycle), (b) *what a money amount means* (tax basis undefined), and (c) *two of the eight domain events cannot be emitted from the model as specified*. Each is a Phase 0 error — cheap now, expensive after the migration lands.

## Ground truth verified

| Claim | Verified |
|---|---|
| `packages/core/src/modules/ecommerce/` does not exist | ✅ confirmed — 41 modules present, no `ecommerce` |
| `apps/storefront/` does not exist | ✅ confirmed — only `apps/docs`, `apps/mercato` |
| SPEC-029 §7.4 "checkout session is also the cart" | ✅ verbatim at line ~276 |
| SPEC-029 references `CartLine`/`CartTotals` but never defines them | ✅ confirmed — §7.4 and §12.1 reference only |
| SPEC-029 §7.5.1 puts the idempotency key in `sessionStorage`, "lost on tab close" | ✅ line 319 |
| SPEC-029 TTL / idempotency-key expiry = 24h | ✅ §7.5.1 |
| `CheckoutCartItem` is merchant-authored, admin-only, "No public cart mutation" | ✅ `2026-03-19-checkout-simple-checkout.md` line 386 |

Consequence worth stating up front: **nothing is implemented**, so every schema fix below costs one line in a migration that has not been written. There is no backward-compatibility excuse for deferring any of the CRITICALs to a later phase.

---

# CRITICAL

## C-1 — The bare session id is still the cart credential; A-1 adds a token but never revokes id-based access (§0, §1.4.6, §1.5 A-1)

SPEC-029 §12.1 specifies `GET/PATCH /api/ecommerce/storefront/checkout/sessions/:id` on a **public, `requireAuth: false`** surface. In that contract, possession of the session UUID *is* the authorization. §1.4.6 of this App Spec instead asserts reads/updates belong to "Bearer of the Cart Token" — a different rule — and §1.5 A-1 adds `cart_token` **without amending the API surface to stop honouring a bare `:id`**.

The result is two authorization models on the same endpoint, and the weaker one is the one written into the parent contract. Session ids leak through Referer headers, analytics, support tickets, server logs, and shared URLs — this is exactly INV-8's "worst failure in this domain", and the App Spec has declared it fixed while leaving the mechanism intact.

Also note this App Spec claims (§0) to be an *elaboration*, never a contradiction, of SPEC-029. §1.4.6 is a silent contradiction of §12.1. Either it is an amendment or it is not; right now it is neither.

**Fix:** extend A-1 to state that (a) the session id is an opaque identifier and MUST NOT authorize anything on the storefront surface; (b) every guest cart read/write requires the Cart Token; (c) the token lookup is store-scoped in the query, not merely unique-per-store in the schema (see W-15).

## C-2 — Three competing owner claims on one row, no precedence rule — INV-8 is unenforceable by construction (§1.5 A-3, §1.4.5)

After A-1 and A-3, `ecommerce_checkout_sessions` carries **three** independent claims of ownership:

1. `cart_token` (A-1, new)
2. `customer_id` (A-3, new)
3. `customer_ref.id` — **already in SPEC-029 §7.4** (`jsonb, nullable, { id?, name?, phone? }`)

A-3's justification — *"SPEC-029 has no owner column for the cart phase (only `email`, written at checkout)"* — is factually wrong. `customer_ref` exists, and SPEC-029 §7.4's design note already states *"An authenticated user's session is assigned to them on creation or login association."* The parent already models the concept; what it lacks is an **indexed FK** (you cannot efficiently answer "my carts across devices" from a jsonb blob).

INV-8 says a cart has "at most one owner: `customer_id` set, or reachable by Cart Token, never contradictory". With three fields and no stated precedence, "contradictory" is the default state, not the exception: what is the truth when `customer_id = A`, `customer_ref.id = B`, and a live token exists? The invariant names the failure without giving the system any way to prevent it.

**Fix:** reframe A-3 as *"promote `customer_ref.id` to an indexed nullable FK; `customer_ref` retains display-only fields (name, phone) and MUST NOT carry an id"*. State the precedence rule explicitly: FK when set, else token; and state whether a token remains valid after the FK is set (see C-5).

## C-3 — No idempotency on line mutations + INV-2 permitting duplicate variant lines = silent double-add on retry (§1.4.4, §1.4.5 INV-2/INV-7)

SPEC-029 §7.5 scopes `Idempotency-Key` to **session creation only**. Mutations are protected solely by the `version` integer. That is a concurrency control, not an idempotency control, and the two are not interchangeable:

> Client sends `PATCH {version: 3, add line X}`. Server commits, `version → 4`, response is lost to a network timeout. Client retries with `version: 3` → 409. Per §7.5.2 the client "re-fetches the session to get the current state before retrying" — and re-applies the add. Line X is now in the cart twice.

Ordinarily a cart dedupes by variant and this is self-healing. **INV-2 explicitly removes that safety net** ("`variant_id` is *not* required to be unique"), so the duplicate looks like legitimate shopper intent and nothing detects it.

Worse, INV-2's stated justification — *"same variant, different personalization"* — is **unsupported by the `CartLine` model in §1.4.3**, which has no personalization, metadata, or custom-attribute field. Two lines with the same `variant_id` are byte-identical apart from `line_id` and timestamps. The invariant permits a state that the model cannot make meaningful, and that state is indistinguishable from the retry bug.

This lands hardest because §1.2 nominates the cart as *"the reference implementation for public, unauthenticated, concurrency-safe APIs on this platform."* As specified it is a reference implementation of a double-charge precursor.

**Fix:** pick one and write it down —
- **(a)** require `Idempotency-Key` on line mutations with a stored key→(session, resulting version) map, or
- **(b)** make add-to-cart a client-supplied-`line_id` upsert (natural idempotency: retry targets the same `line_id`), or
- **(c)** drop INV-2, dedupe by `variant_id`, and add duplicates back only when a `line_attributes` field exists to justify them.

(b) is the cheapest and composes with INV-2. Whichever is chosen, INV-7 ("increments `version` by exactly 1") must be restated to exempt idempotent replays, which by definition must **not** increment.

## C-4 — `subtotal_amount` has no defined tax basis, while the parent spec already has a per-store tax-display switch (§1.4.3)

SPEC-029 §7.1.1 defines `settings.features.showPriceIncludingTax: boolean` (default **true**). For an EU/PL B2C merchant — the platform's stated primary market — catalog prices are gross and the shopper-facing subtotal *is* tax-inclusive. For a B2B store the same field is net.

`CartTotals.subtotal_amount` is defined only as "Sum of `line_total_amount`", and `CartLine.unit_price_amount` only as "Snapshot at add time". Neither says whether the snapshot is net or gross. The same field therefore means two different things in two stores, and the ambiguity crosses the checkout boundary into `sales`, where the order will recompute against a possibly different basis.

The §1.4.3 note *"Deliberately absent from CartTotals: tax, shipping, discounts, grand total"* reads as if tax were merely deferred. It is not deferrable: **every amount already in the model is either tax-inclusive or it is not.** Excluding a *tax breakdown* and a *grand total* is fine; leaving the basis of the numbers you do store undefined is not.

**Fix:** add `tax_mode: 'gross' | 'net'` to `CartTotals` (snapshotted from `showPriceIncludingTax` at creation, immutable alongside `currency_code`) and state that `unit_price_amount` is expressed in that mode. This also answers the "is the cart demoable" question — see the Q-4 verdict.

## C-5 — Cart Merge is undefined for the case that actually happens, the absorbed cart has no representable status, and no token rotation is specified (§1.4.5 INV-8, §2)

The reviewer's scenario — authenticated shopper with a non-empty customer cart logs in while holding a non-empty guest cart — is the common case, and the spec answers none of it. Concretely undefined:

1. **Which survives.** Not stated anywhere in §1.3, §1.4 or §2.
2. **Currency conflict.** Guest cart EUR, customer cart PLN. INV-4 locks `currency_code` per session, so a merge is *impossible* without discarding one cart. No rule.
3. **Duplicate lines.** INV-2 forbids collapsing same-variant lines, so the merged cart shows the identical product twice — one from each cart. This is INV-2's first visible production bug.
4. **The absorbed cart's status.** The parent's enum is `open | locked | submitted | completed | canceled | expired`. None means "merged away". Implementers will pick `canceled` (pollutes the §1.2 conversion denominator) or `expired` (lies about TTL). **A domain event exists for a state transition the aggregate cannot represent.**
5. **Token lifecycle.** Nothing says the guest Cart Token is invalidated on merge or rotated on login. If it survives, an attacker who planted or learned that token now reads an **authenticated** shopper's cart — which will later hold `email`, and after the checkout boundary, addresses. This is textbook session fixation, transplanted to carts.
6. **Logout.** Does the customer's cart revert to a guest cart? Does the browser keep a token pointing at it? Unanswered — and on a shared device this is a direct cross-shopper leak.
7. **Empty-guest merge.** Logging in on device B with an empty guest cart must be a no-op that emits **no** `cart.merged` event, or the §1.2 merge-rate metric inflates to ~100%.
8. **No "one open cart per customer" invariant.** Without it, "the cart of a customer who just authenticated" (§1.3) is ambiguous when three open carts exist, and cross-device continuity is undefined.

Additionally, A-1 proposes storing `cart_token` as a plain `text` column. The repo's own precedent for bearer material is hashing — `CustomerUser.emailHash`, `CustomerUserSession` — so a raw-token column is both inconsistent and a database-dump credential leak.

**Fix:** a merge-rules subsection with an explicit precedence table (winner, currency conflict resolution, line-collision rule, absorbed-cart terminal state, `merged_into_session_id` pointer), plus: rotate the token on merge and on login, invalidate on logout, store `cart_token_hash` not `cart_token`, and add the missing invariant *"at most one `open` session per (store, customer)"*.

## C-6 — `cart.abandoned` and `cart.recovered` are not derivable from the model as specified (§1.4.4, §1.3, §1.2)

§1.3 defines Abandoned Cart as a **derived state, not a status value**, computed from `last_activity_at` vs the store threshold. But §1.4.4 lists `ecommerce.cart.abandoned` and `ecommerce.cart.recovered` as domain events, and §1.2 makes cart-abandonment rate a headline metric.

A purely derived state cannot produce edge-triggered events:

- **`abandoned`:** requires a scanner job (unmentioned — no emitter is named for this event, unlike the others which ride mutations). With no stored marker, every scan pass re-emits `abandoned` for the same cart, forever. Recovery campaigns downstream will re-mail the same shopper on every tick.
- **`recovered`:** requires knowing the cart *was* abandoned. With Abandoned computed at read time, any activity after the threshold emits `recovered` — including activity from a cart that was never observed as abandoned — so recovery attribution counts carts nobody tried to recover.

Both events are, as written, non-idempotent or unemittable, and two of the four §1.2 metrics depend on them.

**Fix:** a fifth amendment — add `abandoned_at datetime null` (set by the scanner, cleared on activity, which is the edge that emits `recovered`). Name the emitter for every event in §1.4.4; the two that are not mutation-driven are the ones that need it most. Reconsider whether "derived state, not a status value" is still the right call once a column exists to store it — the phrasing in §1.3 is what caused the gap.

## C-7 — "Customer" has three referents in this repo and the glossary — whose stated purpose is one-term-one-meaning — disambiguates none of them (§1.3, §1.5 A-3, §2)

`packages/core/src/modules/customer_accounts/data/entities.ts` defines `CustomerUser` (portal/storefront login) carrying **both** `personEntityId` and `customerEntityId`. `packages/core/src/modules/customers/` separately owns `CustomerEntity` (the CRM customer/company record). So "customer id" in this codebase can mean a login, a person, or a company.

The glossary bans "user" and "customer" for the Shopper (good), then §1.5 A-3 introduces a bare **`customer_id`** with no statement of which of the three it references, and §2 says the Authenticated Shopper's identity comes from "`customer_accounts`, `requireCustomerAuth`" — implying `CustomerUser`, i.e. the field should be `customer_user_id`. SPEC-029's pre-existing `customer_ref.id` is equally unresolved.

A glossary that fixes the *cart* collision while leaving the *customer* collision open has done half the job, and the unfixed half is the one that becomes a foreign key.

**Fix:** glossary rows for **Customer User** (login, `customer_accounts.CustomerUser`) vs **Customer Entity** (CRM record, `customers.CustomerEntity`), add both to the banned-phrasings table ("customer id" → name the entity), and rename A-3's column `customer_user_id`.

## C-8 — A-1's cookie transport is incompatible with the parent's own storefront architecture (§1.5 A-1)

A-1 specifies an **HTTP-only, SameSite=Lax cookie**. SPEC-029 §14 puts the storefront in a **separate Next.js app** that "MUST NOT depend on `@open-mercato/*`" and reaches the API through `API_BASE = process.env.NEXT_PUBLIC_STOREFRONT_API_URL`. Three concrete breakages:

1. **Separate origin + `SameSite=Lax` = no cookie on any cart mutation.** Lax sends cookies only on top-level GET navigations; every `POST`/`PATCH` XHR from `firda.pl` to an API on another origin sends nothing. The guest cart is unreachable — precisely the failure A-1 exists to fix, and it would be discovered in staging, not review.
2. **`storefrontFetch` (§14.3) sets no `credentials: 'include'`.** Even same-site, cookies are not attached by default for cross-origin fetch. A-1 must amend §14.3, and it does not mention it.
3. **`next: { revalidate: opts?.revalidate ?? 30 }` on every `storefrontFetch` call.** Cart reads through this client land in Next's **shared, server-side** data cache for 30 seconds, keyed by URL. A cart `GET` cached server-side and replayed to another visitor is a direct INV-8 violation — the same class of bug as C-1, arriving through the framework rather than the API.

**Fix:** A-1 must state the deployment constraint (API served same-site with the storefront — e.g. `/api` proxied under the store host — with `SameSite=Lax`; or `SameSite=None; Secure` plus CORS credentials if truly cross-origin), amend §14.3 to send credentials, and mandate `cache: 'no-store'` for all session endpoints. Note this interacts with SPEC-029 §6.3's host-based store resolution: a proxied same-site API is the option that keeps `Host` resolution working, so it is likely the right call — but it must be *chosen*, not left implicit.

---

# WARNING

## W-1 — No context map, and no anti-corruption layer for catalog → `CartLine` (§1.4)

§1.4.1 names one aggregate and stops. The genuinely dangerous boundaries in this design are the ones it never names: `ecommerce ↔ catalog` (prices, titles, options, variant existence), `ecommerce ↔ customer_accounts` (identity), `ecommerce ↔ currencies`, `ecommerce ↔ sales` (the handoff after `open`).

`CartLine` is a snapshot of foreign data with **no stated translation rule**. Unanswered: which price kind (SPEC-029 §6.3 provides `channelBinding.priceKindId` — is it mandatory?), does it come from `catalog.selectBestPrice` (§6.2), which locale resolves `title_snapshot` (§10 resolves per request, but the cart locks `locale` at creation), and what happens when the variant is outside the store's `catalog_scope` (§7.3)? Each implementer will answer differently, and the answers are money.

**Fix:** one subsection naming the ACL: the single function that turns (variant id, quantity, store context) into a validated `CartLine`, its inputs, and its rejection cases. That function is the anti-corruption layer; right now it is unnamed, which is why §1.4 reads as if catalog data simply appears.

## W-2 — INV-9 covers price drift only; A-2 multiplies its exposure 30× without revisiting it (§1.4.5, §1.5 A-2)

INV-9's eventual-consistency call is defensible in isolation — re-pricing every read makes the cart unstable. Two problems:

1. **It is scoped to price alone.** The catalog can also *delete* a variant, *unpublish* a product, move it out of `catalog_scope`, or change its option schema. A cart line pointing at a non-existent variant is not price drift; it is a dangling reference that no invariant addresses. INV-9 reads as "catalog changes are handled" when it covers one of four cases.
2. **A-2 raises the TTL from 24h to 30 days.** The window in which a snapshot may diverge grows 30×, and INV-9's deferral ("resolved at the checkout boundary, out of scope") becomes 30 days of accumulated divergence resolved in a place this spec does not own. Neither §1.4.5 nor §1.5 acknowledges that A-2 changes INV-9's risk profile. This is the clearest instance of the scope boundary leaking (W-8).

Related: `CartTotals.catalog_version_ref` is described as an "opaque marker of the pricing basis". Opaque to whom? No producer, no comparison semantics, no type. It is unimplementable as written and should either be specified (e.g. price-list version + resolved-at timestamp) or removed.

## W-3 — The locking mechanism diverges from the platform's own optimistic-locking contract (§1.4.2, §1.4.5 INV-7, §1.2)

Root `AGENTS.md` makes `updated_at`-based optimistic locking **default ON** for every user-editable entity, with the version carried in a request *header* via `buildOptimisticLockHeader(record.updatedAt)`, and it is enforced by `packages/core/src/__tests__/optimistic-lock-editable-entities.test.ts` and `optimistic-lock-ui-coverage.test.ts`. SPEC-029 instead uses a `version` integer in the request *body*.

§1.4.2's cart-scope field table lists `version` and **no `updated_at` at all**. The coverage test does carve out "state-machine rows guarded by an explicit status check", which may well apply here — but the App Spec neither claims that exemption nor argues it, and `updated_at` is a standard column in this repo (root `AGENTS.md` → Conventions) that the field table omits.

This matters more than usual because §1.2 promotes the cart to *"the reference implementation for public, unauthenticated, concurrency-safe APIs on this platform."* A reference implementation that uses a second, incompatible locking mechanism teaches the wrong pattern to every module that copies it.

**Fix:** state the position explicitly — either "the storefront surface deliberately uses body `version` because it has no `CrudForm`/`apiCall` client, and here is why the coverage-test exemption applies", or adopt the platform header. Do not leave it as an unremarked divergence.

## W-4 — Missing invariants (§1.4.5)

The 10 are individually reasonable (modulo INV-2, INV-7, INV-9 above) but the set is incomplete. Absent:

| Missing | Why it matters |
|---|---|
| **Store/tenant scoping** — a session is readable/mutable only within the store context that owns it | §1.4.6 states this in prose. On a public unauthenticated API this is the single most important rule in the document and it is not an invariant. Cross-tenant exposure is a root-`AGENTS.md` "Never". |
| **At most one `open` session per (store, customer)** | Without it, merge-on-login (C-5) and cross-device continuity are ambiguous. |
| **`subtotal_amount` = Σ `line_total_amount`; `line_total_amount` = `unit_price_amount` × `quantity`** | Stated as prose in the §1.4.3 field notes; INV-6 only says totals are server-derived, never that they *agree* with the lines. Stored redundant money with no stated equality is how audit mismatches start. |
| **Bounded `line_snapshot`** — max lines per cart, max quantity per line | Public, unauthenticated, unbounded jsonb growth in a single column. A trivial script inflates rows to megabytes (TOAST churn, slow reads, memory). No rate limiting is mentioned anywhere either. |
| **Cart Token entropy / storage / rotation** | ≥128 bits, hashed at rest, rotated on merge and login, invalidated on logout (C-5). |
| **`expires_at` behaviour when a store changes its TTL** | A-2 makes TTL store-configurable; nothing says whether existing carts re-derive. |

## W-5 — "Four amendments" undercounts; at least three more are introduced elsewhere in the same document (§1.5, §2, §1.4.6)

§0 sets the rule: anything SPEC-029 does not provide is recorded as an amendment in §1.5. The document then breaks its own rule three times:

- **§2** gates guest carts on "a per-store setting in `EcommerceStore.settings.features`" — SPEC-029 §7.1.1 defines that object as a **closed TypeScript type** with six keys. Adding `allowGuestCart` is a schema amendment, unrecorded.
- **§1.4.6 / §2** introduce ACL feature `ecommerce.carts.view` — SPEC-029 §12.3 defines a fixed feature list including `ecommerce.checkout.manage` and `ecommerce.orders.view`. Unrecorded, and see W-11.
- **C-1's** API-surface change (token required, id insufficient) is an amendment to §12.1 that is not written down at all.

Add C-6's `abandoned_at` and the count is at least eight. The number itself does not matter; **the parent's changelog being wrong does**, because §0 makes §1.5 the mechanism by which SPEC-029 stays true.

## W-6 — Currency lifecycle over a 30-day cart is unspecified (§1.4.2, §1.4.5 INV-4)

`currency_code` is "locked at creation" and INV-4 enforces per-line agreement. Over a 30-day TTL: the store's `default_currency_code` can change, the `currencies` module can deactivate a currency, and a multi-currency storefront may let the shopper switch. SPEC-029 §7.1 stores only a single `default_currency_code` per store, so where a session's currency comes from on a multi-currency store is undefined to begin with.

Consequences: a shopper switching currency either silently loses the cart (INV-4 makes in-place conversion illegal) or sees a mixed-currency cart (INV-4 violated). Neither is chosen. At minimum state: currency switch = new session, old session terminal state X, and a rule for carts denominated in a currency the store no longer supports.

## W-7 — Locale drift: snapshots freeze language, the platform resolves it per request (§1.4.3, §1.4.2)

`title_snapshot` and `option_values_snapshot` are frozen at add time; `locale` is locked at session creation; SPEC-029 §10 resolves locale per request (query → `X-Locale` → store default). A shopper who adds two items in Polish, switches to English, and adds a third gets a cart in two languages — on a platform whose §10 makes localization a headline capability.

Decide: re-resolve display strings at read time from the current locale (snapshot stays the audit record), or lock the locale hard and prevent switching mid-cart. Either is fine; silence is not.

## W-8 — The scope boundary is a lifecycle phase, not a bounded context — and it already leaks (§0, §1.3)

§0 states *"Scope boundary = the status enum."* As a **work-scoping** device this is legitimate and the glossary's "Cart is a phase, not an entity" framing is the right call. As a **bounded-context** boundary it is not one, and the document never says so — there is exactly one bounded context here (Ecommerce Checkout), and `open` is a slice of one aggregate's lifecycle inside it.

The leaks are already visible in §1 and each one is a place where "out of scope" produces an unowned decision:

| Leak | Where |
|---|---|
| Price/availability drift accumulates for 30 days in the cart phase, is resolved at the transition — by nobody in this spec | INV-9 + A-2 (W-2) |
| Merge can be requested while the session is `locked` (login during checkout) — INV-1 forbids mutation, merge is a mutation | INV-1 vs §1.3 Cart Merge |
| The absorbed cart needs a terminal status the cart phase does not own | C-5 |
| `email` is "read-only in cart phase; written by checkout", yet recovery (a cart-phase concern) depends on it | §1.4.2 |
| `CartTotals` deliberately omits tax/shipping/discounts, so the object handed across the boundary is knowingly incomplete and checkout must recompute from lines | §1.4.3 |

**Fix:** one paragraph stating that the boundary is a lifecycle phase within a single bounded context, and listing which decisions the cart phase *hands over* (drift resolution, totals completion) versus which it *owns*. That sentence prevents implementers from treating `open` as a module boundary.

## W-9 — Retention and PII over a 30-day TTL (§1.4.6, §1.5 A-2)

The access-control table lists Deletes = "System (expiry job)", but per SPEC-029 the expiry job sets `status='expired'` — it does not delete. Carts can hold `email` (§1.4.2, for recovery) and, once past the boundary, addresses. A-2 extends the retention window to 30 days by default and makes it merchant-configurable upward.

No retention rule, no erasure path, and no reference to the platform's encryption/GDPR helpers (root `AGENTS.md` → Encryption: `findWithDecryption`, GDPR fields). For an EU-market platform this is a compliance gap authored, not inherited — SPEC-029's 24h window largely sidestepped it.

## W-10 — Two of the four §1.2 metrics are not computable as defined (§1.2)

- **Guest→account merge rate** = "carts merged ÷ guest carts whose owner logged in". The denominator counts logins by shoppers holding *any* guest cart, including empty ones, which can never merge (C-5 item 7). The rate is therefore bounded by cart-fill rate, not merge quality, and will read as a failure at ~15% when merging works perfectly.
- **Cart abandonment rate** depends on a threshold that Q-3 leaves open (1h proposed). A 1h threshold against a 30-day TTL means nearly every cart is "abandoned" within the first hour and most are subsequently "recovered" — the metric will hover near 100% and carry no signal. The threshold and the TTL must be chosen together.

Also: "Cart survival rate" is defined via `last_activity_at`, a column that does not exist until A-3 lands — fine, but the metric table should say so, since §1.2 currently reads as if the data source were available.

## W-11 — `ecommerce.carts.view` reintroduces "carts" as an entity in the ACL surface (§1.4.6, §2)

§0 says there is no Cart entity; the glossary bans "the Cart entity"; §1.4.4 then agonizes over whether events may say `cart`. Meanwhile §1.4.6 quietly mints an ACL feature named `ecommerce.carts.view` — a *plural entity* namespace, matching the pattern of `ecommerce.stores.view`/`ecommerce.stores.manage`, which **do** denote entities.

ACL features are a FROZEN/ADDITIVE-ONLY contract surface per `BACKWARD_COMPATIBILITY.md`, and SPEC-029 §12.3 already ships `ecommerce.checkout.manage`. Inventing a parallel `carts` namespace both contradicts §0 harder than the event ids do and splits a permission surface the parent already defined.

**Fix:** use `ecommerce.checkout.view` (additive to the parent's list, entity-faithful), or justify the split. This is a cheaper fix than it looks and it removes the inconsistency the spec spends a paragraph worrying about in the wrong place.

## W-12 — Persona table column errors and the "no identity" mischaracterization (§2)

- The **Role key** column holds `ecommerce.carts.view` for Store Operator. That is an ACL *feature id*, not a role key. Roles are mutable names; features are immutable ids — root `AGENTS.md` is emphatic about not conflating them ("avoid `requireRoles`"). As written it invites `requireRoles('ecommerce.carts.view')`, which is both wrong and a security anti-pattern the repo explicitly calls out.
- **Guest Shopper identity = "anonymous — no identity"** is misleading in the way that matters. The Guest Shopper holds a long-lived (30-day) bearer capability granting read/write to a record containing PII. "No identity" is true of the *person* and false of the *credential*, and the phrasing is what lets A-1 propose a raw `text` token column with no rotation, expiry, or revocation (C-5). Say instead: "no account; authenticated by a bearer capability with the following lifecycle rules."

Otherwise the three-surface model is coherent and the portal decision is right (see OK-6).

## W-13 — `?storeSlug=` dev override + "unique per store" tokens (§1.5 A-1, SPEC-029 §6.3)

SPEC-029 §6.3 resolves the store from `Host` **or `?storeSlug=` for dev**. A-1 makes `cart_token` "unique per store" — not globally. If any deployment leaves the dev override enabled (they do), and if token lookup is not itself store-scoped, a token can be presented against a different store's context. Require global uniqueness *and* a store-scoped lookup predicate, and state that the `storeSlug` override must be disabled wherever cart endpoints are served.

## W-14 — `CartTotals` needs a forward-compatible adjustments slot now (§1.4.3, Q-4)

Promotions are out of scope, and that is defensible (see the Q-4 verdict). But `totals_snapshot` is a **jsonb payload shape**, which `BACKWARD_COMPATIBILITY.md` treats as a contract surface: every consumer that reads it — analytics, recovery campaigns, the checkout handoff — breaks or drifts when the shape changes. Adding `adjustments: []` (empty, reserved) and `total_amount` semantics *now*, while nothing is implemented, costs nothing; adding them after Phase 3 is a migration plus a consumer sweep.

## W-15 — Event payload contract is unspecified (§1.4.4)

The table lists ids, triggers and consumers, but no payloads. For tenant-scoped subscribers on this platform, every event needs at minimum `sessionId`, `storeId`, `tenantId`, `organizationId`; `line_*` events need `lineId` + `variantId`; `merged` needs both session ids (`sourceSessionId`, `targetSessionId` — see C-5's `merged_into_session_id`). Also unstated: whether any of these carry `clientBroadcast: true` (root `AGENTS.md` → Conventions), which is a real decision for a cart — a second tab should update, and the DOM Event Bridge is the platform's answer.

---

# Explicit verdicts on the questions asked

## Q-1 — `ecommerce.cart.*` vs `ecommerce.checkout_session.*` → **KEEP `ecommerce.cart.*`.** Confirmed.

Three grounds, one of which the spec does not yet make and which is the strongest:

1. **Precedent.** The platform already ships non-entity middle segments: `auth.login.failed`, `auth.login.success`, `auth.password.changed`, `catalog.price.*`. Root `AGENTS.md`'s *own example* of the convention is `pos.cart.completed`. The middle segment in practice names the concept the event is about, not a table. The "convention-pure" alternative is purer than the convention.
2. **The names would be wrong.** `ecommerce.checkout_session.abandoned` is not the same fact as `ecommerce.cart.abandoned`. A session abandoned at the payment step (post-`open`) is a different business event with different consumers, and SPEC-029 Phase 3 will need it. Collapsing both into one namespace forces a future rename — the expensive kind, since event ids are FROZEN per `BACKWARD_COMPATIBILITY.md`.
3. **Reserving the namespace is the actual win.** `ecommerce.cart.*` for the `open` phase and `ecommerce.checkout_session.*` for everything after gives the phase boundary an observable expression — the one genuinely good consequence of the §0 decision. State it that way and the "exception" stops being an exception.

Conditions on the verdict:
- In `events.ts`, set `entity: 'checkout_session'` on these definitions (the `entity` metadata is what feeds filtering/subscription UIs and should name the real aggregate) while the id stays `ecommerce.cart.*`. Document the split in the glossary as §1.4.4 proposes.
- Reserve `ecommerce.checkout_session.*` explicitly in this spec so Phase 3 does not re-litigate.
- `ecommerce.cart.line_added` (rather than `ecommerce.cart_line.added`) is correct — Cart Line is a value object with no independent identity, so the aggregate is the right subject.
- Q-1 can be closed. It is the least consequential open question in §10 and is consuming attention that C-1..C-8 need.

## Q-4 — Are promotions/discounts table stakes? → **Excluding them is defensible; the current `CartTotals` is not.**

Excluding a *grand total* is correct and the §1.4.3 trust argument is right: a cart promising a number it cannot honour is worse than a cart that says "shipping and tax calculated at checkout". Every major storefront (Shopify, Medusa, commercetools) ships a subtotal-only cart.

But the cart is **not** demoable to a real merchant as specified, for a reason unrelated to discounts: **C-4**. A merchant asks "is that 100 zł gross or net?" and the spec has no answer. Fix `tax_mode` and the cart demos fine without promotions. Add W-14's reserved `adjustments` slot and it also survives promotions arriving later without a payload-shape break.

## Q-6 — Does the cart owe the shopper a visible drift warning? → **Yes. Silence is not acceptable at a 30-day TTL.**

At SPEC-029's 24h TTL, silence was defensible. A-2 makes 30 days the default, which means a shopper can return to a cart whose prices are a month stale and discover the change only at payment — the highest-abandonment moment in the funnel, directly against §1.2's primary goal. In several EU jurisdictions the displayed price must be honoured or the change disclosed before payment.

Recommended resolution that preserves INV-9 intact: compute drift **at read time** and return a per-line advisory flag (`price_changed_since_added`, with the current amount) **without mutating the snapshot**. The stored snapshot stays authoritative and stable — which is INV-9's actual purpose — and the shopper is told. Drift *resolution* (which price wins) stays at the checkout boundary as scoped. Q-6 closes as "surface, do not resolve", and INV-9's wording should be amended from "Drift is surfaced, not prevented" (currently unimplemented — nothing in §1.4.3 surfaces it) to name the mechanism.

## Are the jsonb value-object Cart Lines the right boundary? → **Yes, for this scope.** See OK-2.

## Is the §1.5 amendment set right? → **All four are necessary; two are misjustified and one creates a defect.**

| # | Verdict |
|---|---|
| **A-1** | Necessary, **misjustified, and under-scoped**. The rationale blames `sessionStorage` for the idempotency key — but the key is a retry-safety device, not the cart's identity. The real gaps are (a) SPEC-029 defines no client persistence for the *session id* and (b) the bare id is an unauthenticated capability (C-1). Restate on those grounds, add the transport constraints (C-8) and the token lifecycle (C-5). Not over-reach — under-reach. |
| **A-2** | Necessary and correct. One omission: SPEC-029 §7.5.1 ties idempotency-key expiry to the session TTL ("24 hours, same as session TTL"). A-2 must decouple them explicitly, or keys live 30 days and the creation-idempotency table grows unbounded. |
| **A-3** | `last_activity_at` necessary. `customer_id` is **partial over-reach that creates C-2**: SPEC-029 already models the owner via `customer_ref.id` and already describes login association. Reframe as promoting that id to an indexed FK named `customer_user_id`, and state that `customer_ref` no longer carries an id. As written it ships two owner fields that can disagree — a defect introduced by the amendment meant to prevent one. |
| **A-4** | Necessary, correct, and the highest-value item in the document. Verified: SPEC-029 references both types twice and defines neither. |
| **Missing** | `abandoned_at` (C-6), `settings.features.allowGuestCart` (W-5), the ACL feature (W-5/W-11), the §12.1 API-surface change (C-1), and the §14.3 client changes (C-8). |

---

# OK

1. **§0 is the right decision, well recorded.** Accepting the parent's single-aggregate model rather than re-litigating it, with a rejected-alternatives table naming *why* (a review-hardened decision; store-context duplication), is exactly how a Phase 0 document should handle an inherited constraint. The "Cart is a phase, not an entity" framing is domain-accurate.

2. **Cart Lines as jsonb value objects is the correct aggregate boundary — verified against the pressure test.** Nothing external needs to reference a line: SPEC-029 §5 explicitly non-goals "inventory reservation at browse time" (the usual reason lines acquire identity), promotions are excluded (line-level discount allocation is the second reason), and per-line fulfillment lives in `sales` after order creation. `line_id` provides intra-aggregate addressing without conferring external identity. The boundary should be **revisited** if inventory reservation enters scope — worth a one-line note, not a change.

3. **The ubiquitous-language work on "cart" is genuine and the collision is correctly diagnosed.** I verified `CheckoutCartItem` in `2026-03-19-checkout-simple-checkout.md`: merchant-authored, admin-CRUD only, and line 386 states "No public cart mutation: public APIs cannot add/remove/reprice line items". It is a different actor, aggregate, and package — the glossary's ⚠️ row is right, and the banned-phrasings table is the most operationally useful artifact in §1. (It is undermined only by the unfixed "customer" collision — C-7.)

4. **INV-5 (integer minor units) and INV-6 (server-derived totals, never client-accepted).** Both correct and both load-bearing on a public unauthenticated API. INV-6 in particular is the invariant that prevents price tampering; it is stated in the right place with the right consequence.

5. **§1.4.2's read/write classification per field** is a good technique — marking `shipping_address`, `workflow_instance_id`, `sales_order_id` as checkout-scope and null throughout the cart phase makes the phase boundary checkable rather than aspirational.

6. **The portal decision (§2) is correct and correctly argued.** Building the cart on `customer_accounts` would force login before add-to-cart, which is the single most damaging possible choice against the §1.2 goal. Separating "identity comes from `customer_accounts`" from "the surface is the storefront" is the right distinction, and deferring portal cart history to §10 rather than deciding it now is good scope discipline.

7. **§1.2's separation of leading (survival) from lagging (conversion) indicators**, with the explicit note that only survival is movable within this scope, is honest goal-setting — it prevents the spec being judged on an outcome the checkout owns. The metric *definitions* need work (W-10); the framing does not.

8. **§1.1's flywheel is a real reinforcing loop, not a benefits list.** "A cart that dies on tab close produces no observation at all" is the correct articulation of why persistence is the constraint.
