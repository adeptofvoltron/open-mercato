import { OptionalProps } from '@mikro-orm/core'
import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

// Full column enum per spec §5.6 — `ai`/`both` stay reserved so Phase 3 adds behaviour without a
// migration (S10, D-R5-15). The Release 5 WRITE-PATH validator (`data/validators.ts`) is the
// thing that actually refuses them; the column itself has room for them already.
export type AssistedSellingStoreMode = 'ai' | 'rep' | 'both' | 'off'

// §5.6. One row per `(tenant_id, organization_id, store_id)`. `store_id` is an opaque
// `ecommerce.EcommerceStore`-shaped id — no ORM relation, no existence check against `ecommerce`,
// mirroring `availability.AvailabilityPolicy.storeId`'s own precedent for a cross-module store
// reference (that module doesn't verify the store exists either). A caller can only ever read or
// write a row scoped to its own `organizationId`, which is what gives the spec's "404 for a store
// outside the caller's organizations" behaviour for free, without a second cross-module read.
@Entity({ tableName: 'assisted_selling_store_settings' })
@Unique({
  name: 'assisted_selling_store_settings_scope_unique',
  properties: ['tenantId', 'organizationId', 'storeId'],
})
export class AssistedSellingStoreSettings {
  [OptionalProps]?:
    | 'mode'
    | 'aiProposalsRequireRepApproval'
    | 'proposalTtlSeconds'
    | 'maxProposalLines'
    | 'aiMaxProposalsPerThreadPerHour'
    | 'aiMaxTurnsPerThreadPerHour'
    | 'conversationRetentionDays'
    | 'idleCloseDays'
    | 'aiAgentUserId'
    | 'createdAt'
    | 'updatedAt'
    | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  /** `ecommerce.EcommerceStore.id`. */
  @Property({ name: 'store_id', type: 'uuid' })
  storeId!: string

  /** Release 5 validator accepts only `rep | off` (S10). Default `off`, per §5.6. */
  @Property({ type: 'text', default: 'off' })
  mode: AssistedSellingStoreMode = 'off'

  /** Phase 3 (§4.2). Not exposed by the Release 5 route — `.strict()` refuses the field (§5.6). */
  @Property({ name: 'ai_proposals_require_rep_approval', type: 'boolean', default: false })
  aiProposalsRequireRepApproval: boolean = false

  /** Seconds, bounded 3600–1209600 at the write path (S5). */
  @Property({ name: 'proposal_ttl_seconds', type: 'int', default: 259200 })
  proposalTtlSeconds: number = 259200

  @Property({ name: 'max_proposal_lines', type: 'int', default: 50 })
  maxProposalLines: number = 50

  /** Phase 3. Not exposed by the Release 5 route. */
  @Property({ name: 'ai_max_proposals_per_thread_per_hour', type: 'int', default: 4 })
  aiMaxProposalsPerThreadPerHour: number = 4

  /** Phase 3. Not exposed by the Release 5 route. */
  @Property({ name: 'ai_max_turns_per_thread_per_hour', type: 'int', default: 20 })
  aiMaxTurnsPerThreadPerHour: number = 20

  @Property({ name: 'conversation_retention_days', type: 'int', default: 365 })
  conversationRetentionDays: number = 365

  @Property({ name: 'idle_close_days', type: 'int', default: 30 })
  idleCloseDays: number = 30

  /** `auth.User.id` with `kind: 'agent'` (§4.3). Phase 3. Not exposed by the Release 5 route. */
  @Property({ name: 'ai_agent_user_id', type: 'uuid', nullable: true })
  aiAgentUserId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}
