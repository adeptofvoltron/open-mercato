import { z } from 'zod'

const uuid = () => z.string().uuid()

const emptyStringToNull = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

// Plain optional string fields that map to nullable columns: blanking a previously-set
// value on edit must transmit null to clear it, not be silently dropped. Mirrors
// `clearableStringSchema` in `customers/data/validators.ts`.
const clearableStringSchema = (max: number) =>
  z.preprocess(emptyStringToNull, z.string().trim().max(max).nullable().optional())

const clearableDateSchema = z.preprocess(
  emptyStringToNull,
  z.coerce.date().nullable().optional(),
)

const clearableUuidSchema = z.preprocess(emptyStringToNull, uuid().nullable().optional())

const clearableMetadataSchema = z.preprocess(
  (value) => (value === '' ? null : value),
  z.record(z.string(), z.unknown()).nullable().optional(),
)

// Slug-safe identifier used as the stable code across imports and rules (spec §5.1:
// "stable identifier used in imports and rules"). Mirrors the `tagCreateSchema.slug`
// pattern in `customers/data/validators.ts`.
const codeSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9_-]+$/, 'Code must be lowercase and may contain dashes or underscores')

const nameSchema = z.string().trim().min(1).max(200)

// Spec §5.1: a group's ancestor chain (the group itself plus every parent up to the
// root) is capped at 5 levels. Also the walk limit of `customerGroupsService`'s
// ancestor resolution — anything deeper would silently lose inherited terms.
export const CUSTOMER_GROUP_MAX_ANCESTOR_DEPTH = 5

// Column bounds: without them an out-of-range value reaches Postgres and fails as a raw
// numeric-overflow 500 instead of a 400. `int4` is the `int` column type of `priority`
// and `payment_terms_days`; `numeric(16,2)` holds at most 14 integer digits.
const INT4_MAX = 2147483647
// Priorities are floored well above `int4`'s minimum: reorder parks rows below the
// tenant's lowest priority and adopt places placeholders 10 below it, and both must stay
// inside `int4` or they fail as a raw overflow 500.
const PRIORITY_MIN = -1000000000
const NUMERIC_16_2_MAX = 99999999999999.99

export const customerGroupKindValues = ['b2c', 'b2b', 'internal', 'partner'] as const
export const customerGroupKindSchema = z.enum(customerGroupKindValues)

export const customerGroupMembershipSourceValues = ['manual', 'import', 'rule', 'onboarding'] as const
export const customerGroupMembershipSourceSchema = z.enum(customerGroupMembershipSourceValues)

// Release 5 (D-R5-1): no `either` value — see `CustomerGroupTerms.approvalPolicy`.
export const customerGroupApprovalPolicyValues = ['buyer', 'merchant', 'both'] as const
export const customerGroupApprovalPolicySchema = z.enum(customerGroupApprovalPolicyValues)

// Release 5 Phase 3 (§5.5) — kept alongside the entity's own TS unions in
// `data/entities.ts` for the service layer (Step 1.6) and any future admin form to parse
// against.
export const customerCreditLedgerEntryTypeValues = ['reserve', 'release', 'settle', 'adjust'] as const
export const customerCreditLedgerEntryTypeSchema = z.enum(customerCreditLedgerEntryTypeValues)

export const customerCreditLedgerSourceTypeValues = ['checkout', 'order', 'invoice', 'payment', 'manual'] as const
export const customerCreditLedgerSourceTypeSchema = z.enum(customerCreditLedgerSourceTypeValues)

export const customerCreditLedgerActorTypeValues = ['staff_user', 'system'] as const
export const customerCreditLedgerActorTypeSchema = z.enum(customerCreditLedgerActorTypeValues)

// Default-free field set shared by the create and update schemas. Zod v4's `.partial()`
// keeps an inner `.default()`, so deriving the update schema from the create schema
// injected `isDefault: false` / `isActive: true` into every partial update and silently
// overwrote stored values. Defaults live on the create schema only.
const customerGroupBaseShape = {
  organizationId: uuid().nullable().optional(),
  tenantId: uuid(),
  code: codeSchema,
  name: nameSchema,
  description: clearableStringSchema(4000),
  kind: customerGroupKindSchema,
  parentId: clearableUuidSchema,
  // Not floored at 0: reconcile adopt places orphan placeholders below the tenant's
  // lowest priority (spec §8.2: "priority at the bottom"), which can be negative, and the
  // edit form must still be able to save such a group.
  priority: z.number().int().min(PRIORITY_MIN).max(INT4_MAX),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  metadata: clearableMetadataSchema,
}

export const customerGroupCreateSchema = z.object({
  ...customerGroupBaseShape,
  isDefault: z.boolean().optional().default(false),
  isActive: z.boolean().optional().default(true),
})

export type CustomerGroupCreateInput = z.infer<typeof customerGroupCreateSchema>

export const customerGroupUpdateSchema = z
  .object({
    id: uuid(),
  })
  .merge(z.object(customerGroupBaseShape).partial())

export type CustomerGroupUpdateInput = z.infer<typeof customerGroupUpdateSchema>

export const customerGroupDeleteSchema = z.object({
  id: uuid(),
})

export type CustomerGroupDeleteInput = z.infer<typeof customerGroupDeleteSchema>

const customerGroupMembershipCreateBaseSchema = z.object({
  organizationId: uuid().nullable().optional(),
  tenantId: uuid(),
  groupId: uuid(),
  customerId: uuid(),
  source: customerGroupMembershipSourceSchema.optional().default('manual'),
  validFrom: clearableDateSchema,
  validUntil: clearableDateSchema,
  assignedByUserId: clearableUuidSchema,
  notes: clearableStringSchema(2000),
})

// Server-owned fields: the tenant comes from the session, the organization from the
// referenced customer, and `assignedByUserId` from the acting user.
const membershipServerOwnedFields = { organizationId: true, tenantId: true, assignedByUserId: true } as const

export const customerGroupMembershipCreateRequestSchema =
  customerGroupMembershipCreateBaseSchema.omit(membershipServerOwnedFields)

export const customerGroupMembershipCreateSchema = customerGroupMembershipCreateBaseSchema
  .refine(
    (payload) =>
      !payload.validFrom || !payload.validUntil || payload.validFrom <= payload.validUntil,
    {
      message: 'validFrom must be before or equal to validUntil',
      path: ['validUntil'],
    },
  )

export type CustomerGroupMembershipCreateInput = z.infer<typeof customerGroupMembershipCreateSchema>

const customerGroupMembershipUpdateBaseSchema = z
  .object({
    id: uuid(),
  })
  .merge(
    z.object({
      organizationId: uuid().nullable().optional(),
      tenantId: uuid(),
      groupId: uuid().optional(),
      customerId: uuid().optional(),
      source: customerGroupMembershipSourceSchema.optional(),
      validFrom: clearableDateSchema,
      validUntil: clearableDateSchema,
      assignedByUserId: clearableUuidSchema,
      notes: clearableStringSchema(2000),
    }),
  )

export const customerGroupMembershipUpdateRequestSchema =
  customerGroupMembershipUpdateBaseSchema.omit(membershipServerOwnedFields)

export const customerGroupMembershipUpdateSchema = customerGroupMembershipUpdateBaseSchema.refine(
  (payload) =>
    !payload.validFrom || !payload.validUntil || payload.validFrom <= payload.validUntil,
  {
    message: 'validFrom must be before or equal to validUntil',
    path: ['validUntil'],
  },
)

export type CustomerGroupMembershipUpdateInput = z.infer<typeof customerGroupMembershipUpdateSchema>

export const customerGroupMembershipDeleteSchema = z.object({
  id: uuid(),
})

export type CustomerGroupMembershipDeleteInput = z.infer<typeof customerGroupMembershipDeleteSchema>

// Drag-reorder payload for the admin group list (Step 1.7): an ordered array of
// `CustomerGroup` ids. A full ordering renumbers `priority` in gaps of 10; a partial
// one permutes the listed groups' existing priorities — see commands/reorderGroups.ts.
export const customerGroupReorderSchema = z.object({
  tenantId: uuid(),
  ids: z.array(uuid()).min(1),
})

export type CustomerGroupReorderInput = z.infer<typeof customerGroupReorderSchema>

// Optional/nullable non-negative number field (payment days, credit/order thresholds):
// blanking a previously-set value on edit must transmit null to clear it (same rationale
// as `clearableStringSchema` above), and negative input is rejected server-side to match
// the UI's inline validation (spec acceptance criterion: "Numeric fields... reject
// negative input inline").
const clearableNonNegativeIntSchema = z.preprocess(
  emptyStringToNull,
  z.coerce.number().int().min(0).max(INT4_MAX).nullable().optional(),
)

const clearableNonNegativeNumberSchema = z.preprocess(
  emptyStringToNull,
  z.coerce.number().min(0).max(NUMERIC_16_2_MAX).nullable().optional(),
)

const currencyCodeSchema = clearableStringSchema(4)

export const assortmentScopeSchema = z
  .object({
    categoryIds: z.array(uuid()).optional(),
    tagIds: z.array(uuid()).optional(),
    excludeProductIds: z.array(uuid()).optional(),
    excludeCategoryIds: z.array(uuid()).optional(),
    excludeTagIds: z.array(uuid()).optional(),
  })
  .strict()
  .nullable()

export type AssortmentScopeInput = z.infer<typeof assortmentScopeSchema>

// Default-free, for the same reason as `customerGroupBaseShape` above.
const customerGroupTermsBaseShape = {
  organizationId: uuid().nullable().optional(),
  tenantId: uuid(),
  groupId: uuid(),
  priceKindId: clearableUuidSchema,
  paymentTermsDays: clearableNonNegativeIntSchema,
  allowPurchaseOnAccount: z.boolean().nullable().optional(),
  defaultCreditLimit: clearableNonNegativeNumberSchema,
  creditCurrencyCode: currencyCodeSchema,
  approvalRequiredAbove: clearableNonNegativeNumberSchema,
  minOrderValue: clearableNonNegativeNumberSchema,
  // Release 5 (D-R5-4): same clearable-string shape as `creditCurrencyCode` above —
  // `null`/blank means "not set on this group, inherit."
  termsCurrencyCode: currencyCodeSchema,
  // Release 5 (D-R5-1): nullable to inherit, same shape as `allowPurchaseOnAccount`.
  approvalPolicy: customerGroupApprovalPolicySchema.nullable().optional(),
  // Release 5 (D-R5-20/D-R5-28): nullable booleans, same shape as `allowPurchaseOnAccount`.
  allowQuoteRequests: z.boolean().nullable().optional(),
  requiresPoNumber: z.boolean().nullable().optional(),
  assortmentScope: assortmentScopeSchema.optional(),
  metadata: clearableMetadataSchema,
}

export const customerGroupTermsCreateSchema = z.object(customerGroupTermsBaseShape)

export type CustomerGroupTermsCreateInput = z.infer<typeof customerGroupTermsCreateSchema>

export const customerGroupTermsUpdateSchema = z
  .object({
    id: uuid(),
  })
  .merge(z.object(customerGroupTermsBaseShape).partial())

export type CustomerGroupTermsUpdateInput = z.infer<typeof customerGroupTermsUpdateSchema>

export const customerGroupTermsDeleteSchema = z.object({
  id: uuid(),
})

export type CustomerGroupTermsDeleteInput = z.infer<typeof customerGroupTermsDeleteSchema>

// Release 5 Phase 3 (§5.4): entity-shape validators for `CustomerCreditAccount`. The
// admin create/edit routes and `CrudForm` wiring are Step 1.7's job — these exist now so
// the entity itself has a validated input shape, matching this module's convention of a
// create/update/delete trio per entity.
const creditAccountHoldReasonRequiredWhenOnHold = (payload: {
  isOnHold?: boolean
  holdReason?: string | null
}) => !payload.isOnHold || !!payload.holdReason

const customerCreditAccountCreateBaseSchema = z.object({
  organizationId: uuid(),
  tenantId: uuid(),
  customerId: uuid(),
  currencyCode: z.string().trim().min(1).max(4),
  creditLimit: z.coerce.number().min(0).max(NUMERIC_16_2_MAX),
  isOnHold: z.boolean().optional().default(false),
  // Spec §5.4: "Required when is_on_hold = true (validator)."
  holdReason: clearableStringSchema(2000),
  updatedByUserId: clearableUuidSchema,
})

export const customerCreditAccountCreateSchema = customerCreditAccountCreateBaseSchema.refine(
  creditAccountHoldReasonRequiredWhenOnHold,
  { message: 'holdReason is required when isOnHold is true', path: ['holdReason'] },
)

export type CustomerCreditAccountCreateInput = z.infer<typeof customerCreditAccountCreateSchema>

// Release 5 Phase 3 (Step 1.11, G13/D-R5-5): the operator-facing body of
// `POST …/credit-accounts`. Tenant, organization and `updatedByUserId` come from the
// session, never the body, so the body is `.strict()` and rejects them. `creditLimit` is
// required: `default_credit_limit` only pre-fills the form (D-R5-5) and is never applied
// by the server. Money accepts a JSON number or a decimal string with up to 2 places.
const creditLimitInputSchema = z
  .union([
    z.number(),
    z.string().trim().regex(/^\d+(\.\d{1,2})?$/).transform((value) => Number(value)),
  ])
  .pipe(z.number().finite().min(0).max(NUMERIC_16_2_MAX))

export const customerCreditAccountCreateRequestBaseSchema = z
  .object({
    customerId: uuid(),
    currencyCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
    creditLimit: creditLimitInputSchema,
    isOnHold: z.boolean().optional(),
    holdReason: clearableStringSchema(2000),
  })
  .strict()

export const customerCreditAccountCreateRequestSchema = customerCreditAccountCreateRequestBaseSchema.refine(
  creditAccountHoldReasonRequiredWhenOnHold,
  { message: 'holdReason is required when isOnHold is true', path: ['holdReason'] },
)

export type CustomerCreditAccountCreateRequest = z.infer<typeof customerCreditAccountCreateRequestSchema>

export const customerCreditLedgerListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export type CustomerCreditLedgerListQuery = z.infer<typeof customerCreditLedgerListQuerySchema>

const customerCreditAccountUpdateBaseSchema = z
  .object({
    id: uuid(),
  })
  .merge(
    z.object({
      organizationId: uuid().optional(),
      tenantId: uuid().optional(),
      customerId: uuid().optional(),
      currencyCode: z.string().trim().min(1).max(4).optional(),
      creditLimit: z.coerce.number().min(0).max(NUMERIC_16_2_MAX).optional(),
      isOnHold: z.boolean().optional(),
      holdReason: clearableStringSchema(2000),
      updatedByUserId: clearableUuidSchema,
    }),
  )

export const customerCreditAccountUpdateSchema = customerCreditAccountUpdateBaseSchema.refine(
  creditAccountHoldReasonRequiredWhenOnHold,
  { message: 'holdReason is required when isOnHold is true', path: ['holdReason'] },
)

export type CustomerCreditAccountUpdateInput = z.infer<typeof customerCreditAccountUpdateSchema>

export const customerCreditAccountDeleteSchema = z.object({
  id: uuid(),
})

export type CustomerCreditAccountDeleteInput = z.infer<typeof customerCreditAccountDeleteSchema>

// Release 5 Phase 3 (Step 1.12, §6.5/§9): `POST …/credit-accounts/:id/adjust`. Signed
// decimal string, up to 14 integer digits and 2 fraction digits (the `numeric(16,2)`
// ledger column), never zero (§5.5: "adjust ... Never zero") — a zero-amount correction
// is not a correction. `note` is required (§5.5: "Required on `adjust`"), unlike every
// other free-text column in this module.
const adjustAmountNotZero = (payload: { amount: string }) => Number(payload.amount) !== 0

const customerCreditAdjustBaseSchema = z.object({
  amount: z
    .string()
    .trim()
    .regex(/^-?\d{1,14}(\.\d{1,2})?$/, 'amount must be a signed decimal string with up to 2 fraction digits'),
  note: z.string().trim().min(1).max(2000),
})

// The HTTP body (§9): `{ amount: string, note: string }`, `.strict()` so the account id
// (URL) and the tenant/organization/actor (session) can never be smuggled through it.
export const customerCreditAdjustRequestSchema = customerCreditAdjustBaseSchema
  .strict()
  .refine(adjustAmountNotZero, { message: 'amount must not be zero', path: ['amount'] })

export type CustomerCreditAdjustRequest = z.infer<typeof customerCreditAdjustRequestSchema>

// The command input (`customer_groups.credit.adjust`): the route-resolved account id
// joins the validated body before the command handler ever sees it.
export const customerCreditAdjustCommandSchema = customerCreditAdjustBaseSchema
  .extend({ creditAccountId: uuid() })
  .refine(adjustAmountNotZero, { message: 'amount must not be zero', path: ['amount'] })

export type CustomerCreditAdjustCommandInput = z.infer<typeof customerCreditAdjustCommandSchema>
