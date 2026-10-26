import { OptionalProps } from '@mikro-orm/core'
import { Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'
import type { AssortmentScope } from '@open-mercato/shared/lib/catalog-visibility'

export type CustomerGroupKind = 'b2c' | 'b2b' | 'internal' | 'partner'
export type CustomerGroupMembershipSource = 'manual' | 'import' | 'rule' | 'onboarding'
// Release 5 (D-R5-1): which side(s) must sign an approval request. No `either` value.
export type CustomerGroupApprovalPolicy = 'buyer' | 'merchant' | 'both'
// Release 5 (§5.5): append-only credit ledger. `reserve` is positive; `release`/`settle`
// are negative; `adjust` is either and never zero.
export type CustomerCreditLedgerEntryType = 'reserve' | 'release' | 'settle' | 'adjust'
export type CustomerCreditLedgerSourceType = 'checkout' | 'order' | 'invoice' | 'payment' | 'manual'
// Service calls made by checkout or a subscriber are `system`; `/adjust` is `staff_user`.
export type CustomerCreditLedgerActorType = 'staff_user' | 'system'

// Groups are tenant-scoped, not organization-scoped — spec §5 note: "groups are
// tenant-scoped here, consistent with `CatalogPriceKind`, which allows a null
// `organization_id`" (see .ai/specs/2026-08-14-customer-groups-and-b2b-terms.md §Open
// Questions #2). `organizationId` is kept as a nullable column (mirroring
// `CatalogPriceKind`) rather than dropped, so a future per-organization private-group
// phase (explicitly out of scope here) can scope rows without a schema change.
@Entity({ tableName: 'customer_groups' })
@Index({ name: 'customer_groups_tenant_idx', properties: ['tenantId'] })
@Index({ name: 'customer_groups_parent_idx', properties: ['parentId'] })
@Index({
  // Partial for the same reason as the priority index below: a soft-deleted group must
  // not keep its code reserved, otherwise recreating it hits a raw unique violation.
  name: 'customer_groups_tenant_code_unique',
  expression:
    'create unique index "customer_groups_tenant_code_unique" on "customer_groups" ("tenant_id", "code") where "deleted_at" is null',
})
@Index({
  // Partial (not @Unique) so a soft-deleted group's old priority value doesn't stay
  // permanently reserved — found during Step 1.6/1.7: the admin list's drag-reorder
  // rewrites priorities in gaps of 10, which would otherwise collide with any
  // previously-deleted row's still-unique priority and 409 forever, not just on a
  // transient race. Mirrors `customer_groups_tenant_default_unique` below.
  name: 'customer_groups_tenant_priority_unique',
  expression:
    'create unique index "customer_groups_tenant_priority_unique" on "customer_groups" ("tenant_id", "priority") where "deleted_at" is null',
})
@Index({
  // "At most one is_default per tenant" (spec §5.1) is primarily an application-level
  // invariant enforced in the create/update command, but a partial unique index gives
  // defense-in-depth against races/direct writes at negligible cost — this repo already
  // has the identical shape for "at most one is_primary per deal" (see
  // `customer_deal_people_primary_uq` in the customers module). Soft-deleted rows are
  // excluded so a deleted former default doesn't block promoting a new one.
  name: 'customer_groups_tenant_default_unique',
  expression:
    'create unique index "customer_groups_tenant_default_unique" on "customer_groups" ("tenant_id") where "is_default" and "deleted_at" is null',
})
export class CustomerGroup {
  [OptionalProps]?: 'isDefault' | 'isActive' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ type: 'text' })
  code!: string

  @Property({ type: 'text' })
  name!: string

  @Property({ type: 'text', nullable: true })
  description?: string | null

  @Property({ type: 'text' })
  kind!: CustomerGroupKind

  // Self-referencing hierarchy stored as a plain uuid column (not a MikroORM
  // `@ManyToOne` self-relation) to match this codebase's established pattern for
  // parent/child ids within the same module — see `CatalogCategory.parentId` in
  // `packages/core/src/modules/catalog/data/entities.ts`. Cycle prevention (depth
  // capped at 5 per spec §5.1) is enforced in the create/update command, not the ORM.
  @Property({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId?: string | null

  @Property({ type: 'int' })
  priority!: number

  // DB-level defense-in-depth is `customer_groups_tenant_default_unique` above; the
  // primary enforcement (clear-and-set semantics when reassigning the default) is the
  // create/update command's job, not the ORM's.
  @Property({ name: 'is_default', type: 'boolean', default: false })
  isDefault: boolean = false

  @Property({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean = true

  @Property({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown> | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

// `group_id`/`customer_id` are plain uuid columns rather than MikroORM relations:
// `customerId` crosses into the `customers` module, which the root AGENTS.md forbids
// ("Never create direct ORM relationships between modules" — FK id only, resolved
// separately). `groupId` stays a plain column too (not `@ManyToOne(() => CustomerGroup)`)
// for symmetry with the customer-id column and to match this codebase's convention for
// scoped junction/assignment tables that reference a same-module parent by id only
// (e.g. `CustomerPipelineStage.pipelineId` in the customers module).
@Entity({ tableName: 'customer_group_memberships' })
@Index({ name: 'customer_group_memberships_tenant_idx', properties: ['tenantId'] })
@Index({
  name: 'customer_group_memberships_hot_path_idx',
  properties: ['tenantId', 'customerId', 'validFrom', 'validUntil'],
})
@Index({
  // Spec §5.2: unique `(tenant_id, group_id, customer_id)` among rows with
  // `deleted_at IS NULL` — expressed as a partial unique index (not `@Unique`, which
  // has no WHERE clause) so a removed (soft-deleted) membership can be re-added without
  // colliding with its own tombstoned row. Mirrors
  // `customer_person_company_links_active_unique` in the customers module.
  name: 'customer_group_memberships_active_unique',
  expression:
    'create unique index "customer_group_memberships_active_unique" on "customer_group_memberships" ("tenant_id", "group_id", "customer_id") where "deleted_at" is null',
})
export class CustomerGroupMembership {
  [OptionalProps]?: 'source' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'group_id', type: 'uuid' })
  groupId!: string

  @Property({ name: 'customer_id', type: 'uuid' })
  customerId!: string

  @Property({ type: 'text', default: 'manual' })
  source: CustomerGroupMembershipSource = 'manual'

  @Property({ name: 'valid_from', type: Date, nullable: true })
  validFrom?: Date | null

  @Property({ name: 'valid_until', type: Date, nullable: true })
  validUntil?: Date | null

  @Property({ name: 'assigned_by_user_id', type: 'uuid', nullable: true })
  assignedByUserId?: string | null

  @Property({ type: 'text', nullable: true })
  notes?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

// `group_id` is a plain uuid column rather than a MikroORM relation, for the same
// reason as `CustomerGroupMembership.groupId` above: this repo's convention for
// scoped assignment tables that reference a same-module parent by id only (e.g.
// `CustomerPipelineStage.pipelineId`). `priceKindId` crosses into the `catalog`
// module, so it stays an FK id only (no relation) per the root AGENTS.md ban on
// cross-module ORM relationships.
//
// Terms rows are optional per group (spec: "a group with no terms row yet shows...
// inheriting"), so a terms row can be removed and later re-created for the same
// group — the unique constraint on `group_id` is therefore a partial index scoped
// to `deleted_at IS NULL`, mirroring `customer_group_memberships_active_unique`
// above (and `customer_groups_tenant_priority_unique`'s soft-delete fix), rather
// than a plain `@Unique`.
//
// `organizationId` mirrors `CustomerGroup.organizationId`: tenant-scoped, not
// organization-scoped (spec §5 note re: `CatalogPriceKind`'s nullable
// `organization_id`), kept nullable rather than dropped for a future
// per-organization phase.
@Entity({ tableName: 'customer_group_terms' })
@Index({ name: 'customer_group_terms_tenant_idx', properties: ['tenantId'] })
@Index({
  name: 'customer_group_terms_group_unique',
  expression:
    'create unique index "customer_group_terms_group_unique" on "customer_group_terms" ("group_id") where "deleted_at" is null',
})
export class CustomerGroupTerms {
  [OptionalProps]?:
    | 'createdAt'
    | 'updatedAt'
    | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'group_id', type: 'uuid' })
  groupId!: string

  @Property({ name: 'price_kind_id', type: 'uuid', nullable: true })
  priceKindId?: string | null

  @Property({ name: 'payment_terms_days', type: 'int', nullable: true })
  paymentTermsDays?: number | null

  // Nullable like every other terms field: `null` means "not set on this group, inherit
  // from the parent chain / tenant default", so a group can override only some fields.
  @Property({ name: 'allow_purchase_on_account', type: 'boolean', nullable: true })
  allowPurchaseOnAccount?: boolean | null

  @Property({ name: 'default_credit_limit', type: 'numeric', precision: 16, scale: 2, nullable: true })
  defaultCreditLimit?: string | null

  @Property({ name: 'credit_currency_code', type: 'text', nullable: true })
  creditCurrencyCode?: string | null

  @Property({ name: 'approval_required_above', type: 'numeric', precision: 16, scale: 2, nullable: true })
  approvalRequiredAbove?: string | null

  @Property({ name: 'min_order_value', type: 'numeric', precision: 16, scale: 2, nullable: true })
  minOrderValue?: string | null

  // Release 5 (D-R5-4): currency of `approvalRequiredAbove`/`minOrderValue`. Nullable and
  // inherited exactly like `creditCurrencyCode` above (same `text` typing, no FX
  // conversion); the base-currency fallback (D-R5-37) is a `resolveTerms` read-time
  // concern (Step 1.6), not a column constraint.
  @Property({ name: 'terms_currency_code', type: 'text', nullable: true })
  termsCurrencyCode?: string | null

  // Release 5 (D-R5-1): `null` = not set on this group, inherit from the parent chain,
  // same nullable/inherited shape as `allowPurchaseOnAccount` above; the tenant default
  // (`buyer`) is a `resolveTerms` concern, not a DB default.
  @Property({ name: 'approval_policy', type: 'text', nullable: true })
  approvalPolicy?: CustomerGroupApprovalPolicy | null

  // Release 5 (D-R5-20): whether checkout offers the `request_quote` payment method.
  // Nullable/inherited like `allowPurchaseOnAccount`; tenant default (`false`) is a
  // `resolveTerms` concern.
  @Property({ name: 'allow_quote_requests', type: 'boolean', nullable: true })
  allowQuoteRequests?: boolean | null

  // Release 5 (D-R5-28): whether checkout requires a PO number (written to
  // `SalesQuote.customer_reference`). Nullable/inherited like `allowPurchaseOnAccount`;
  // tenant default (`false`) is a `resolveTerms` concern.
  @Property({ name: 'requires_po_number', type: 'boolean', nullable: true })
  requiresPoNumber?: boolean | null

  @Property({ name: 'assortment_scope', type: 'jsonb', nullable: true })
  assortmentScope?: AssortmentScope | null

  @Property({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown> | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

// Release 5 Phase 3 (§5.4). One row per customer per currency; the limit here is
// authoritative, the group's `defaultCreditLimit` (above) only pre-fills it on create.
// `customerId` is a plain uuid FK-id column, not a MikroORM relation, per the same
// cross-module-FK rule as `CustomerGroupMembership.customerId` above — for a B2B buyer
// this is the company entity (§6.5 identity rule). `organizationId` is **NOT NULL** here,
// unlike `CustomerGroup.organizationId`: groups are tenant-scoped, but customers, carts
// and orders — and so credit — are organization-scoped (§5.4 header).
//
// `holdReason` is typed as plain `text`, matching every other free-text column this
// codebase later wires into `encryption.ts` (see `customers/encryption.ts`:
// `customer_entity.description`, `customer_activity.body`) — encryption is a storage-time
// transform over a `text` column, not a distinct column type, so no change is needed here
// when Step 1.7 declares it.
//
// Optimistic locking: standard `updated_at` (no `version` counter, §5.4). Reservations
// lock this row (§6.3, Step 1.6) but never write to it, so they cannot cause a false 409
// on a concurrent admin edit.
@Entity({ tableName: 'customer_credit_accounts' })
@Index({ name: 'customer_credit_accounts_tenant_idx', properties: ['tenantId'] })
@Index({ name: 'customer_credit_accounts_customer_idx', properties: ['tenantId', 'customerId'] })
@Index({
  // Partial, not `@Unique`, so a soft-deleted account doesn't permanently reserve its
  // (tenant, organization, customer, currency) tuple — same soft-delete-safe pattern as
  // `customer_group_terms_group_unique` above.
  name: 'customer_credit_accounts_tenant_org_customer_currency_unique',
  expression:
    'create unique index "customer_credit_accounts_tenant_org_customer_currency_unique" on "customer_credit_accounts" ("tenant_id", "organization_id", "customer_id", "currency_code") where "deleted_at" is null',
})
export class CustomerCreditAccount {
  [OptionalProps]?: 'isOnHold' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'customer_id', type: 'uuid' })
  customerId!: string

  @Property({ name: 'currency_code', type: 'text' })
  currencyCode!: string

  @Property({ name: 'credit_limit', type: 'numeric', precision: 16, scale: 2 })
  creditLimit!: string

  @Property({ name: 'is_on_hold', type: 'boolean', default: false })
  isOnHold: boolean = false

  @Property({ name: 'hold_reason', type: 'text', nullable: true })
  holdReason?: string | null

  @Property({ name: 'updated_by_user_id', type: 'uuid', nullable: true })
  updatedByUserId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

// Release 5 Phase 3 (§5.5). Append-only: no `updatedAt`, no `deletedAt` (corrections are
// compensating entries, not edits) — exempt from optimistic locking per root AGENTS.md.
// `organizationId` is the account's organization (G2).
//
// `creditAccountId` uses the same `@ManyToOne(..., { mapToPk: true })` shape as
// `PromotionUsage.promotionId` in `promotions/data/entities.ts` — a same-module FK is
// allowed to be a real ORM relation (unlike `customerId`/`linkedOrderId` below, which
// cross into `customers`/`sales` and stay plain FK-id columns per the root AGENTS.md ban
// on cross-module ORM relationships). `deleteRule: 'restrict'` for the same compliance
// reason as `PromotionUsage.promotionId`: a ledger row must outlive the account it audits.
//
// `relatedEntryId` is a self-referencing FK (the `reserve` entry a `release`/`settle`
// belongs to, or the `adjust` entry an undo compensates) kept as a plain nullable uuid
// column rather than a self `@ManyToOne`, mirroring `CustomerGroup.parentId`'s
// plain-column precedent for self-referencing ids in this module.
//
// `amount`/`balanceAfter` are `numeric(16,2)` surfaced as decimal strings (G14) — never a
// JS `number` — matching `PromotionUsage.totalDiscountAmount`'s typing.
//
// `note` is plain `text`, typed for the same future-encryption reason as
// `CustomerCreditAccount.holdReason` above.
@Entity({ tableName: 'customer_credit_ledger_entries' })
@Unique({ name: 'customer_credit_ledger_entries_tenant_idempotency_unique', properties: ['tenantId', 'idempotencyKey'] })
@Index({ name: 'customer_credit_ledger_entries_account_created_idx', properties: ['tenantId', 'creditAccountId', 'createdAt'] })
@Index({ name: 'customer_credit_ledger_entries_related_entry_idx', properties: ['tenantId', 'relatedEntryId'] })
@Index({ name: 'customer_credit_ledger_entries_linked_order_idx', properties: ['tenantId', 'linkedOrderId'] })
export class CustomerCreditLedgerEntry {
  [OptionalProps]?: 'createdAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @ManyToOne(() => CustomerCreditAccount, { fieldName: 'credit_account_id', deleteRule: 'restrict', mapToPk: true })
  creditAccountId!: string

  @Property({ name: 'entry_type', type: 'text' })
  entryType!: CustomerCreditLedgerEntryType

  @Property({ type: 'numeric', precision: 16, scale: 2 })
  amount!: string

  @Property({ name: 'source_type', type: 'text' })
  sourceType!: CustomerCreditLedgerSourceType

  @Property({ name: 'source_id', type: 'uuid', nullable: true })
  sourceId?: string | null

  @Property({ name: 'related_entry_id', type: 'uuid', nullable: true })
  relatedEntryId?: string | null

  @Property({ name: 'linked_order_id', type: 'uuid', nullable: true })
  linkedOrderId?: string | null

  @Property({ name: 'idempotency_key', type: 'text' })
  idempotencyKey!: string

  @Property({ name: 'balance_after', type: 'numeric', precision: 16, scale: 2 })
  balanceAfter!: string

  @Property({ name: 'created_by_actor_type', type: 'text' })
  createdByActorType!: CustomerCreditLedgerActorType

  @Property({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId?: string | null

  @Property({ name: 'note', type: 'text', nullable: true })
  note?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}
