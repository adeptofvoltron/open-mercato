import { z } from 'zod'

const uuid = () => z.string().uuid()

const scopedSchema = z.object({
  organizationId: uuid(),
  tenantId: uuid(),
})

// Release 5 (S10, D-R5-15): the validator refuses `ai`/`both` outright, even though the entity's
// own `mode` column keeps the full `ai | rep | both | off` enum reserved for Phase 3
// (`data/entities.ts`). This is the write-path guard the spec's finding describes: a store can
// never be put into an AI-authoring mode without an AI actor behind it in this release.
export const assistedSellingReleaseModeSchema = z.enum(['rep', 'off'])
export type AssistedSellingReleaseMode = z.infer<typeof assistedSellingReleaseModeSchema>

// §5.6: `PUT /settings/:storeId` is `.strict()` over exactly these five fields — a body carrying
// an `ai_*` field (or any other settings column) is a `400`, since nothing in Release 5 reads
// those columns yet.
export const assistedSellingStoreSettingsUpdateSchema = z
  .object({
    mode: assistedSellingReleaseModeSchema.optional(),
    proposalTtlSeconds: z.coerce.number().int().min(3600).max(1209600).optional(),
    maxProposalLines: z.coerce.number().int().min(1).max(500).optional(),
    conversationRetentionDays: z.coerce.number().int().min(1).max(3650).optional(),
    idleCloseDays: z.coerce.number().int().min(1).max(365).optional(),
  })
  .strict()
export type AssistedSellingStoreSettingsUpdateInput = z.infer<typeof assistedSellingStoreSettingsUpdateSchema>

export const assistedSellingStoreSettingsSaveSchema = scopedSchema
  .merge(assistedSellingStoreSettingsUpdateSchema)
  .extend({ storeId: uuid() })
  .strict()
export type AssistedSellingStoreSettingsSaveInput = z.infer<typeof assistedSellingStoreSettingsSaveSchema>
