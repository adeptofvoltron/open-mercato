# Financial / Accounting Suite — Double-Entry Ledger Foundation & Phased Roadmap

> **Status:** Draft for review.
> **Scope:** OSS. `@open-mercato/core`, modules under `packages/core/src/modules/`.
> **Author:** spec-writing skill, 2026-06-02.
> **Source analysis:** Odoo `account` deep scan — `tmp/odooFinantialStructure/`.
> **Gate decisions (resolved):** full in-platform double-entry GL · sales documents are *source documents* linked by FK · AR-first, AP deferred · all OSS · **Phase 1 = ledger core** · full statutory controls (immutable postings, period lock dates, gap-free numbering, hash-chain audit) · tax = full compliance incl. statutory e-filing (later phase) · generic configurable chart of accounts + seed templates.

---

## TLDR

Open Mercato has a mature **commercial-document** layer (sales orders, sales invoices, credit memos, payments, payment-gateway integration, tax-rate config, multi-currency master data) but **no accounting layer**. This spec introduces a **statutory-grade, double-entry general ledger** as a new core module (`accounting`) and lays out a phased roadmap for the surrounding financial suite (receivables, tax determination + e-filing, payables, reporting/statements, FX revaluation, external-system sync).

The decisive architectural stance: **we do not copy Odoo's single polymorphic `account.move`.** Odoo overloads one model for invoices, bills, payments and journal entries. That violates Open Mercato's module-isolation and no-cross-module-ORM laws. Instead we keep three clearly separated concerns, linked only by **FK ids + the event bus**:

1. **Commercial documents** — already in `sales` (`SalesOrder`, `SalesInvoice`, …). Untouched.
2. **Financial/legal documents** — `receivables` (later phase): the legally-binding invoice/credit note, system-of-record for AR.
3. **General ledger postings** — `accounting` (Phase 1, this spec): chart of accounts, journals, immutable double-entry journal entries, fiscal periods, lock dates, hash-chain audit, trial balance.

Source documents *emit events*; `accounting` subscribes and creates balanced journal entries via configurable **posting rules**. No module reaches into another's tables.

**Phase 1 ships the ledger spine** so every later phase has somewhere to post.

---

## Problem Statement

Today Open Mercato can sell, invoice (commercially), take payment, and track payment status — but it cannot answer accounting questions: *What is my trial balance? My receivables by account? Are my books balanced, immutable and audit-traceable for a tax authority?* There is no chart of accounts, no double-entry, no period close, no statutory audit trail, and no path to VAT/SAF-T/JPK filing. Businesses must export to an external system and reconcile manually.

A real general ledger inside the platform is unusual for a commerce platform (Medusa and Saleor stop at orders/payments, exactly where Open Mercato is today) and is therefore a genuine differentiator — *if* it is built to statutory standards (immutability, gap-free numbering, lock dates, hash-chain integrity), not as a toy ledger.

## Goals

- A correct, balanced, **immutable** double-entry general ledger, multi-currency, tenant/organization-scoped.
- **Statutory controls from day one:** posted entries are immutable (reversal-only), period lock dates, gap-free sequential numbering assigned at post time, cryptographic hash-chain audit trail with an integrity report.
- **Configurable chart of accounts** with seed templates (generic + a Polish `pl` template), per tenant.
- **Posting rules** that turn source-document events (sales invoices, payments, future receivables/AP docs) into balanced journal entries, with `accounting` decoupled from source modules via the event bus.
- **Trial balance** report; foundation tables for P&L / balance sheet builders in a later reporting phase.
- A roadmap that lets receivables, tax (incl. e-filing), payables, reporting, FX revaluation and external sync land incrementally without reworking the ledger.

## Non-Goals (this spec / Phase 1)

- AP / vendor bills / suppliers (deferred phase — design leaves room).
- Tax determination matrix and statutory e-filing (later `tax` / `tax_filing` phases).
- Bank-statement import & reconciliation UI (reconciliation primitives are designed in Phase 1; the matching engine + bank import land with AR/payments).
- P&L / balance-sheet report engine (later `accounting_reports` phase; trial balance only in Phase 1).
- Migrating or changing existing `sales` invoice/payment behavior (source-document model — no migration).
- Replacing `payment_gateways` / `currencies` / `sales` tax calc — all reused.

---

## Competitive Research (challenge of requirements)

| System | Ledger model | What we take / reject |
|---|---|---|
| **Odoo `account`** | One polymorphic `account.move` (+`account.move.line`) for invoices/bills/payments/entries; fat models; `_inherit` extension. | **Take:** double-entry rigor, journals, reconciliation graph (partial→full), tax repartition concept, lock dates, hash-chain audit, configurable report engine, chart-template loader. **Reject:** the single-model polymorphism and fat-model active-record — it forces cross-domain coupling we cannot have across Open Mercato module boundaries. |
| **Xero / QuickBooks** | Double-entry hidden behind invoices/bills; opinionated CoA with templates; strong bank reconciliation; period lock. | **Take:** hide GL complexity behind document workflows for the common user; CoA seed templates; period locking UX. **Reject:** closed CoA flexibility limits — we keep CoA fully configurable. |
| **Medusa / Saleor** | No GL — stop at orders/payments. | Confirms the gap and the differentiation; nothing to take. |
| **Ledger libraries (e.g. double-entry append-only ledgers)** | Append-only immutable entries, hash chaining. | **Take:** append-only/immutability and hash chaining as first-class, not bolt-on. Reinforces the statutory-controls choice. |

**Resulting architectural decision (the spec's spine):** separate **source documents** (sales/receivables/AP) from **GL postings** (`accounting`), connect them with **FK + events + posting rules**. This is the inverse of Odoo's monolith and the only shape compatible with Open Mercato's "no direct ORM relationships between modules" and "Event Bus for side effects" laws.

---

## Current State — reuse, do not rebuild

| Existing capability | Module / entity | How Phase 1+ uses it |
|---|---|---|
| Orders, totals, payment status | `sales` → `SalesOrder` | Source document; FK from journal-entry `sourceDocument*`. |
| Commercial invoice + lines | `sales` → `SalesInvoice`, `SalesInvoiceLine` | Source document for AR posting (Phase: receivables emits, accounting posts). |
| Credit memo | `sales` → `SalesCreditMemo` | Source document for reversal/credit-note posting. |
| Payments / allocations / methods | `sales` → `SalesPayment`, `SalesPaymentAllocation`, `SalesPaymentMethod` | Source document for cash/bank postings + reconciliation anchor. |
| Gateway transactions / refunds / webhooks | `payment_gateways` → `GatewayTransaction` | Untouched; payments still flow here. |
| Tax rate config + line tax calc | `sales` → `SalesTaxRate`, `services/taxCalculationService` | Reused for tax amounts now; the future `tax` module supersedes determination. |
| Currencies + exchange rates + fetch | `currencies` → `Currency`, `ExchangeRate`, `CurrencyFetchConfig` | Multi-currency amounts + FX conversion + future revaluation. |
| Product tax rate | `catalog` → `CatalogProduct.taxRate*` | Reused; future tax module maps to tax classes. |
| Customers (person/company/address) | `customers` | Extended with VAT/tax-id/credit-terms in the tax/AR phases (no such fields today). |
| Credential/provider/health/log infra | `integrations` | External accounting-system connectors (later sync phase). |
| Streaming import/export + cursors | `data_sync` | External-system sync + SAF-T/JPK bulk export plumbing. |
| Money/decimal convention | `numeric(18,4)` string; rates `numeric(18,8)`; percent `numeric(7,4)` | Phase 1 matches exactly; no new Money wrapper. |

**Confirmed gaps Phase 1 fills:** chart of accounts, journals, double-entry journal entries + posting engine, fiscal periods, lock dates, gap-free numbering, hash-chain audit, trial balance.

---

## Module Decomposition & Roadmap

> Module folders follow Open Mercato's convention; entities/commands/events/feature-ids are **singular**. Names below are proposed; confirm at first use.

| Phase | Module | Delivers | Depends on |
|---|---|---|---|
| **1 (this spec, detailed)** | `accounting` | Chart of accounts, journals, journal entries (double-entry), posting engine + posting rules, fiscal years/periods, lock dates, gap-free numbering, hash-chain audit + integrity report, trial balance. Generic + `pl` CoA seed templates. | sales (events), currencies |
| 2 | `receivables` | Legal AR invoice + credit note (system-of-record), payment terms & installments, AR aging, payment allocation → posts to ledger; reconciliation matching engine (uses Phase-1 reconciliation primitives). | accounting, sales, customers |
| 3 | `tax` | Tax classes, jurisdiction/rule matrix, exemptions, customer VAT/tax-ids (extends `customers`), tax accounts & grids posted to ledger. | accounting, receivables, customers, catalog |
| 4 | `tax_filing` | Statutory outputs: VAT returns, SAF-T / JPK structured exports, withholding. Uses `data_sync` for bulk export. | tax, accounting |
| 5 | `accounting_reports` | Formula-driven report engine: P&L, balance sheet, custom statements, carryover. | accounting, tax |
| 6 | `payables` | Vendor/supplier entity, vendor bills, vendor payments (AP) — mirrors receivables on the credit side. | accounting, tax |
| 7 | `fx_revaluation` | Period-end currency revaluation, realized/unrealized gain/loss postings. | accounting, currencies |
| 8 | `accounting_sync` (provider packages) | Push documents/postings to external books (Odoo/Xero/SAP/…); `data_sync` adapters + `integrations` credentials. | accounting, data_sync, integrations |

Each phase: self-contained module, FK-only cross-module links, command-pattern writes, `makeCrudRoute` + `openApi`, `acl.ts` features + `setup.ts` `defaultRoleFeatures`, typed `events.ts`, `encryption.ts` for any PII/tax-id/bank field, and full integration-test coverage per `.ai/qa/AGENTS.md`.

---

# PHASE 1 — `accounting` (Ledger Core) — Detailed Design

## 1. Data model (entities — singular, snake_case tables)

All entities carry the common columns (`id` uuid PK `gen_random_uuid()`, `organization_id`, `tenant_id`, `created_at`, `updated_at`, `deleted_at`, `is_active` where applicable) following the customers reference (`packages/core/src/modules/customers/data/entities.ts`). MikroORM v7 decorators from `@mikro-orm/decorators/legacy`; money columns `numeric(18,4)` stored as string.

### `LedgerAccount` — table `ledger_accounts` (chart of accounts entry)
- `code` (text, unique per tenant+org), `name` (text), `account_type` (text enum: `asset`, `asset_receivable`, `asset_bank`, `asset_cash`, `liability`, `liability_payable`, `liability_tax`, `equity`, `income`, `expense`, `off_balance`), `internal_group` (computed-on-write: asset/liability/equity/income/expense), `parent_id` (uuid nullable → self, hierarchy), `currency_code` (text nullable → restrict account to one currency), `is_reconcilable` (bool), `is_active` (bool).
- Constraints: receivable/payable types MUST be reconcilable; off-balance MUST NOT be reconcilable; `code` unique per (tenant, org); no posting allowed to a parent (non-leaf) account.
- Index: `(organization_id, tenant_id, code)` unique; `(organization_id, tenant_id, account_type)`.

### `LedgerJournal` — table `ledger_journals`
- `code` (text, unique per tenant+org), `name`, `type` (text enum: `sale`, `purchase`, `bank`, `cash`, `general`), `default_debit_account_id` / `default_credit_account_id` (uuid nullable → LedgerAccount), `currency_code` (nullable), `restrict_mode_hash` (bool — enable hash chaining for this journal), `is_active`.
- Each journal owns its own numbering sequence (see `AccountingSequence`).

### `JournalEntry` — table `journal_entries` (the GL posting; *not* polymorphic with invoices)
- `entry_number` (text nullable until posted — assigned gap-free at post), `journal_id` (uuid → LedgerJournal), `date` (date — accounting date), `state` (text enum: `draft`, `posted`, `reversed`, `cancelled`), `reference` (text nullable), `narration` (text nullable — encrypted), `currency_code` (text), `source_document_type` (text nullable — e.g. `sales.invoice`, `sales.payment`, `receivables.invoice`), `source_document_id` (uuid nullable — FK id only, never an ORM relation), `posted_at` (timestamp nullable), `posted_by_user_id` (uuid nullable), `reversed_by_entry_id` (uuid nullable → self), `reverses_entry_id` (uuid nullable → self), `entry_hash` (text nullable), `previous_entry_hash` (text nullable), `total_debit` / `total_credit` (numeric(18,4), computed at post).
- Invariant enforced at post: `sum(lines.debit) == sum(lines.credit)` and total > 0.
- Index: `(organization_id, tenant_id, journal_id, entry_number)` unique where `entry_number not null`; `(organization_id, tenant_id, date)`; `(source_document_type, source_document_id)`.

### `JournalEntryLine` — table `journal_entry_lines`
- `entry_id` (uuid → JournalEntry, cascade on delete only while draft), `account_id` (uuid → LedgerAccount), `debit` (numeric(18,4) default 0), `credit` (numeric(18,4) default 0), `currency_code` (text), `amount_currency` (numeric(18,4) — signed, foreign-currency amount), `label` (text nullable — encrypted), `partner_type` (text nullable: `customer`/`supplier`), `partner_id` (uuid nullable — FK id), `tax_account_tag` (text nullable — reporting/tax grid tag for the future tax phase), `date_maturity` (date nullable — due date for AR/AP aging), `matching_number` (text nullable), `reconciliation_group_id` (uuid nullable → ReconciliationGroup).
- Constraint: exactly one of `debit`/`credit` is non-zero per line; no posting to a non-leaf or inactive account; account currency (if set) must match line currency.

### `FiscalYear` — table `fiscal_years`
- `name`, `date_from`, `date_to`, `state` (`open`/`closed`).

### `FiscalPeriod` — table `fiscal_periods`
- `fiscal_year_id` (uuid → FiscalYear), `name`, `date_from`, `date_to`, `state` (`open`/`closed`). Posting blocked into a `closed` period.

### `AccountingLockDate` — table `accounting_lock_dates`
- One soft-row per tenant+org per lock kind: `lock_kind` (`general`/`tax`), `locked_through` (date). Posting or modifying an entry dated `<= locked_through` is rejected (with a feature-gated exception path deferred to a later compliance phase).

### `AccountingSequence` — table `accounting_sequences`
- `journal_id` (uuid → LedgerJournal nullable for global sequences), `prefix` (text), `padding` (int), `next_number` (bigint), `period_scope` (`never`/`yearly`/`monthly` reset). Gap-free numbers are drawn atomically inside the posting transaction (`withAtomicFlush`), never at draft creation.

### `ReconciliationGroup` / `ReconciliationMatch` — tables `reconciliation_groups` / `reconciliation_matches` (primitives only in Phase 1)
- `ReconciliationGroup`: `is_full` (bool), `currency_code`. `ReconciliationMatch`: `debit_line_id` / `credit_line_id` (→ JournalEntryLine), `amount` (numeric(18,4)), `group_id` (→ ReconciliationGroup nullable). Phase 1 ships schema + a service stub; the matching engine + UI land with `receivables` (Phase 2) where payments make it meaningful.

### Relationship map
```
LedgerJournal 1──* JournalEntry 1──* JournalEntryLine *──1 LedgerAccount (*──1 self parent)
JournalEntry  ── source_document_(type,id) ──▶ sales.* / receivables.*   (FK id only, via event)
JournalEntry  ── reverses / reversed_by ──▶ JournalEntry (self)
JournalEntryLine *──* ReconciliationMatch ──1 ReconciliationGroup
FiscalYear 1──* FiscalPeriod ;  AccountingLockDate (per tenant+org per kind)
AccountingSequence 1──1 LedgerJournal
```

## 2. Posting engine & posting rules (module decoupling)

- **Posting rule** = a tenant-configurable mapping from a source-document event to a balanced set of journal lines. Stored as `PostingRule` (table `posting_rules`: `trigger_event` text, `journal_id`, `active`, plus a typed `template` JSON describing debit/credit legs and which source amount each leg reads). **Event reality (verified):** `sales` emits CRUD events only — `sales.invoice.created`/`.updated`, `sales.payment.created`/`.updated`, `sales.credit_memo.*` — there is no `posted`/`captured` lifecycle event. Phase 1 therefore binds built-in rule templates to `sales.invoice.created`/`.updated` and `sales.payment.created`/`.updated`, **gated on the source record's status** (e.g. invoice finalized / payment captured) read from the event payload, with **idempotency** keyed on `(source_document_type, source_document_id)` so re-fired update events don't double-post. (A cleaner dedicated lifecycle event — `receivables.invoice.posted` — arrives with Phase 2 and supersedes the status-gated binding; the posting engine is event-id-agnostic, so this is config, not rework.) Built-in templates: debit AR / credit income+tax on invoice; debit bank / credit AR on payment; plus a generic manual-entry path.
- **Flow:** source module emits a typed event → an `accounting` **subscriber** (`subscribers/*.ts`, persistent) resolves the posting rule → builds a draft `JournalEntry` via the create command → posts it via the post command. `accounting` never imports `sales` code; it only reads the event payload (amounts, ids, currency) and FK ids. This satisfies the Module-Isolation and Event-Bus heuristics.
- Manual journal entries (type `general`) are created and posted directly through the UI/API.

## 3. State machine & Undo Contract (statutory)

```
draft ──post──▶ posted ──reverse──▶ (new posted reversal entry) ; original → reversed
draft ──cancel──▶ cancelled
posted: IMMUTABLE — no edit, no delete
```
- **`draft` is fully editable and deletable.** No number, no hash.
- **`post`**: validates balanced + open period + lock date; atomically draws the gap-free `entry_number`; computes `entry_hash = SHA-256(canonical(previous_entry_hash, entry_number, date, journal, ordered lines))`; sets `previous_entry_hash` from the journal's last posted entry; sets `posted_at`/`posted_by`.
- **Undo Contract — explicit and intentional:** posting is **not** undoable by deletion (that would break statutory immutability and the hash chain). The business-level inverse of a posted entry is a **reversal entry** (`reverse` command) that creates a new posted entry with debit/credit swapped, dated per policy, linked via `reverses_entry_id`/`reversed_by_entry_id`. This is the canonical "undo" for the GL and is documented as such. The command framework's undo for `post` therefore **rejects** rather than silently deletes; `reverse` is the supported inverse operation. Draft create/update/delete remain normally undoable.

## 4. Commands (writes via command pattern)

Under `accounting/commands/` using `registerCommand` from `@open-mercato/shared/lib/commands`, helpers (`emitCrudSideEffects`, `emitCrudUndoSideEffects`, `withAtomicFlush`) and `findOneWithDecryption`:

- `accounting.account.create` / `.update` / `.archive` (soft) — CRUD side effects + indexer.
- `accounting.journal.create` / `.update`.
- `accounting.journalEntry.create` (draft) / `.updateDraft` / `.deleteDraft`.
- `accounting.journalEntry.post` — non-undoable (see §3); emits `accounting.journal_entry.posted`.
- `accounting.journalEntry.reverse` — creates reversal; emits `accounting.journal_entry.reversed`.
- `accounting.period.close` / `.reopen`; `accounting.lockDate.set`.
- All write commands run inside `withAtomicFlush`; all scoped by `organization_id` + `tenant_id`.

## 5. Events (`events.ts`, `createModuleEvents`, `as const`)

IDs `module.entity.action`, singular entity, past tense (from `@open-mercato/shared/modules/events`):
- `accounting.account.created` / `.updated` / `.archived`
- `accounting.journal.created` / `.updated`
- `accounting.journal_entry.created` / `.posted` / `.reversed` / `.cancelled`
- `accounting.period.closed` / `.reopened`
- `accounting.lock_date.set`

`accounting.journal_entry.posted` is the hook downstream phases (reporting, sync) subscribe to. No `clientBroadcast` needed in Phase 1. (Inbound: the posting subscriber binds to the existing `sales.*.created/updated` CRUD events — see §2 — not to any new sales event.)

## 6. Access control (`acl.ts`) & setup (`setup.ts`)

`acl.ts` features (`<module>.<entity>.<action>`):
`accounting.account.view|manage`, `accounting.journal.view|manage`, `accounting.entry.view|manage|post|reverse`, `accounting.period.manage`, `accounting.lockdate.manage`, `accounting.report.view`, `accounting.audit.view`.

`setup.ts` (`ModuleSetupConfig` from `@open-mercato/shared/modules/setup`):
- `seedDefaults`: load the **generic CoA template** + default journals (sale/purchase/bank/cash/general) + sequences + a fiscal year/periods for the current year, idempotently, scoped to tenant/org. CoA templates live as data files (`accounting/data/chart-templates/{generic,pl}.ts`); `pl` is selectable.
- `defaultRoleFeatures`: `admin: ['accounting.*']`; a new `accountant` role gets view+manage+post+reverse+period+report+audit; `employee` gets `accounting.*.view` + `accounting.report.view`.
- After adding features, run `yarn mercato auth sync-role-acls`.

## 7. Encryption (`encryption.ts`)

`defaultEncryptionMaps` (`ModuleEncryptionMap` from `@open-mercato/shared/modules/encryption`) for free-text that may carry personal/financial detail: `journal_entries.narration`, `journal_entry_lines.label`. Reads via `findWithDecryption`/`findOneWithDecryption`. (Customer VAT/tax-ids and bank details get encryption maps in their owning phases.)

## 8. Validation (`data/validators.ts`)

Zod schemas with `z.infer` types for every API input: account/journal/entry/period/lockdate create+update, and the post/reverse action payloads. Reject unbalanced entries, posting to non-leaf/inactive accounts, and dates inside locked/closed periods at the schema + command layers.

## 9. API routes (auto-discovery, `makeCrudRoute` + `openApi`)

`makeCrudRoute` from `@open-mercato/shared/lib/crud/factory`, `indexer: { entityType }` from `#generated/entities.ids.generated`, `openApi` exported per route:
- `api/accounts/route.ts`, `api/journals/route.ts`, `api/periods/route.ts`, `api/lock-dates/route.ts` — standard CRUD.
- `api/journal-entries/route.ts` — CRUD for **drafts only** (list/get all states; create/update/delete restricted to `draft`).
- `api/journal-entries/post/route.ts` and `.../reverse/route.ts` — domain action endpoints (POST), guarded by `accounting.entry.post` / `.reverse`, delegating to commands. Not plain CRUD because posting is a domain operation with side effects.
- `api/reports/trial-balance/route.ts` — aggregates posted lines by account over a date/period range (debit, credit, balance), tenant/org scoped, `accounting.report.view`.
- `api/audit/hash-integrity/route.ts` — verifies the hash chain per journal, reports first gap/break, `accounting.audit.view`.

## 10. Backend UI (DS-compliant)

Pages under `accounting/backend/`, using `apiCall`/`useGuardedMutation`, `CrudForm`, `DataTable`, `StatusBadge`, `LoadingMessage`/`Spinner`, `EmptyState`, lucide icons, dialog `Cmd/Ctrl+Enter` + `Escape`:
- Chart of accounts (`DataTable`, tree by `parent_id`), account create/edit (`CrudForm`).
- Journals list + edit.
- Journal entries list (filter by state/journal/period) + detail; draft uses `CrudForm` with a debit/credit line editor enforcing balance before enabling **Post**; posted entries render read-only with a **Reverse** action.
- Trial balance report page (date/period filters, export).
- Periods & lock dates admin page.
- Hash-integrity report page.
- Entry-state colors use semantic status tokens only (`draft`/`posted`/`reversed`/`cancelled` → `{property}-status-{status}-{role}`), never raw Tailwind colors.

### Frontend Architecture Contract (App Router)
- **Server/Client boundary:** list/report/detail-shell pages are Server Components fetching via server data calls; only the debit/credit line editor and action buttons are `"use client"`.
- **`"use client"` ledger:** journal-entry line editor (interactive balance calc), period/lock-date dialogs, reverse-confirm dialog — each justified by interactivity; no client-side fetching of full ledgers.
- **Budgets:** trial-balance and entry-list APIs paginate (`pageSize ≤ 100`); no unbounded client blobs; aggregation done server-side in SQL.
- **Hydration/perf evidence:** required before merge — route bundle size for the entry editor and a server-rendered trial-balance snapshot.

## 11. Custom entities / search

`ce.ts` registers `accounting:ledger_account`, `accounting:journal_entry` for query-index + custom-field extensibility. `search.ts` (optional Phase-1 tail) indexes accounts by code/name and entries by number/reference. `normalizeCustomFieldResponse()` on any read model exposing `customFields`.

## 12. Migrations

Module migrations under `packages/core/src/modules/accounting/migrations/Migration<TIMESTAMP>.ts` + `.snapshot-open-mercato.json`. Workflow: define entities → `yarn db:generate` → keep only the intended SQL (delete unrelated generator output) → review SQL + snapshot. Do **not** run `yarn db:migrate` to quiet the generator.

## 13. Integration tests (per `.ai/qa/AGENTS.md`, self-contained)

Cover every API path and key UI path; create fixtures via API in setup, clean up in teardown, no reliance on seeded demo data:
- Account/journal CRUD + uniqueness + non-leaf-posting rejection.
- Draft entry create/edit/delete; **post** balances-or-rejects; gap-free numbering under concurrency; lock-date and closed-period rejection.
- **Immutability:** posted entry edit/delete rejected; **reverse** creates a linked balanced reversal.
- Hash chain: integrity report passes on a clean chain and flags a tampered/broken link.
- Posting-rule subscriber: emitting `sales.invoice.posted` produces a balanced AR journal entry with correct accounts.
- Trial-balance correctness over a period; multi-currency line amounts.
- Tenant/org isolation: no cross-tenant entries/accounts ever returned.

---

## Implementation Plan — Phase 1 Steps (each step leaves the app working + tested)

1. **Scaffold module** `accounting` (`index.ts` metadata, enable in `apps/mercato/src/modules.ts`, `yarn generate`, structural cache purge). Empty `acl.ts` is forbidden — add features in this step.
2. **Entities + migration:** `LedgerAccount`, `LedgerJournal`, `JournalEntry`, `JournalEntryLine`, `FiscalYear`, `FiscalPeriod`, `AccountingLockDate`, `AccountingSequence`, `PostingRule`, `ReconciliationGroup`/`Match`. `yarn db:generate`, prune, review snapshot. `ce.ts`, `data/validators.ts`.
3. **Account & journal CRUD:** commands + `makeCrudRoute` routes + `openApi` + validators + unit tests. Constraints (unique code, leaf-only, reconcilable rules).
4. **Sequences + numbering service:** atomic gap-free draw inside `withAtomicFlush`; concurrency test.
5. **Draft journal entries:** create/update/delete-draft commands + CRUD route (draft-restricted) + line balance validation.
6. **Posting engine:** `post` command (balance + period + lock-date checks, number assignment, hash-chain compute), `events.ts`, `accounting.journal_entry.posted`. Immutability enforcement. Tests.
7. **Reversal:** `reverse` command + action endpoint + linkage; Undo Contract documented. Tests.
8. **Fiscal years/periods + lock dates:** entities CRUD, close/reopen, `lockDate.set`; posting guards. Tests.
9. **Posting rules + sales subscriber:** built-in rule templates; persistent subscriber consuming the real `sales.invoice.created`/`.updated` and `sales.payment.created`/`.updated` events, status-gated + idempotent on `(source_document_type, source_document_id)`; produces balanced entries. Tests with emitted events (incl. re-fired update → no double-post).
10. **Trial balance + hash-integrity reports:** aggregation route + integrity route. Tests.
11. **Backend UI:** CoA tree, journals, entry list/detail with line editor + Post/Reverse, trial balance, periods/lock dates, hash-integrity page. DS + Frontend Architecture Contract evidence.
12. **setup.ts:** generic + `pl` CoA templates, default journals/sequences/fiscal year, `defaultRoleFeatures`, `accountant` role; `yarn mercato auth sync-role-acls`.
13. **encryption.ts** maps; route reads through `findWithDecryption`.
14. **Validation gate:** `yarn generate && yarn build:packages && yarn typecheck && yarn lint && yarn test`, i18n checks, integration suite, `yarn build:app`.

---

## Backward Compatibility

New additive module only — no existing contract surface changes. `sales`, `payment_gateways`, `currencies`, `customers`, `catalog` are untouched (source-document model). New event IDs, ACL features, DI keys, API routes and DB tables are all additive. The `accounting` posting subscriber consumes the *existing, verified* sales CRUD events (`sales.invoice.created`/`.updated`, `sales.payment.created`/`.updated`) — no change to the emitters. Per `BACKWARD_COMPATIBILITY.md`, additive surfaces require no deprecation protocol.

## Open Questions remaining (non-blocking — defaults chosen)

- **Accountant role name/shape** — assumed a new `accountant` role; confirm vs. reusing an existing role set. *(Default: add `accountant`.)*
- **Reversal date policy** — reverse on original date vs. today vs. user-chosen. *(Default: user-chosen, defaulting to today, blocked if that date is locked.)*
- **`pl` CoA template depth** — minimal vs. full Polish statutory chart. *(Default: minimal seed now; full template can ship later without schema change.)*
- **Hash algorithm/canonicalization** — SHA-256 over a documented canonical JSON. *(Default: SHA-256; canonicalization spec'd in Step 6.)*

---

## Spec Checklist (self-review)

- ✅ Singular entities/commands/events/feature-ids (`accounting.journal_entry.posted`, `LedgerAccount`).
- ✅ FK ids only across modules; no cross-module ORM; event-bus decoupling for posting.
- ✅ `organization_id` + `tenant_id` on every entity; all reads/commands scoped.
- ✅ Undo Contract explicit (reversal is the GL inverse; posting non-deletable by design).
- ✅ Zod validation for all API inputs; `z.infer` types.
- ✅ Encryption maps for free-text/PII fields; reads via `findWithDecryption`.
- ✅ Canonical primitives: `makeCrudRoute`, `CrudForm`, `DataTable`, `apiCall`/`useGuardedMutation`, `createModuleEvents`, command pattern, `withAtomicFlush`.
- ✅ Design System tokens + shared primitives; Frontend Architecture Contract included.
- ✅ Integration coverage enumerated for all API + key UI paths.
- ✅ Migration + snapshot workflow; no manual `db:migrate`.
- ✅ Additive-only BC; `setup.ts` `defaultRoleFeatures` + `sync-role-acls`.
- ✅ Phasing: each step leaves a working, tested app; later phases at roadmap altitude.
