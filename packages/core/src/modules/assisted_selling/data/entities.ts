import { OptionalProps } from '@mikro-orm/core'
import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

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

// ---------------------------------------------------------------------------
// Step 4.4 — §5.1-§5.4. Thread/participant/message/proposal. Every cross-module reference
// (`store_id` -> ecommerce.EcommerceStore, `buyer_cart_id`/`proposal_cart_id`/`target_cart_id`
// -> cart.Cart, `customer_id` -> customers.CustomerEntity, `customer_user_id` ->
// customer_accounts.CustomerUser, `actor_id` -> auth.User, `merge_log_id` ->
// cart.CartMergeLog) stays a plain `uuid` property with no `@ManyToOne` — root AGENTS.md "no
// direct ORM relationships between modules", mirroring `AssistedSellingStoreSettings.storeId`'s
// own precedent two entities up.
// ---------------------------------------------------------------------------

export type AssistedSellingThreadStatus = 'open' | 'closed'

// §5.1. One row per conversation. `(tenant_id, buyer_cart_id)` is unique only among `status =
// 'open'` rows (a PARTIAL unique index — MikroORM's `@Unique` decorator cannot express a
// `WHERE` clause, so the real constraint is hand-authored SQL in the migration, matching this
// module's own `.snapshot-open-mercato.json`; `cart/data/entities.ts`'s own
// `cart_lines_unique_line_key` is the precedent for a decorator-declared `@Index` whose
// `expression` is the actual partial-unique SQL).
@Entity({ tableName: 'assisted_selling_threads' })
@Index({ name: 'assisted_selling_threads_tenant_org_idx', properties: ['tenantId', 'organizationId'] })
@Index({ name: 'assisted_selling_threads_store_status_activity_idx', properties: ['tenantId', 'storeId', 'status', 'lastActivityAt'] })
@Index({ name: 'assisted_selling_threads_store_assignee_status_idx', properties: ['tenantId', 'storeId', 'assignedActorId', 'status'] })
@Index({
  name: 'assisted_selling_threads_open_buyer_cart_unique_idx',
  expression:
    'create unique index "assisted_selling_threads_open_buyer_cart_unique_idx" on "assisted_selling_threads" ("tenant_id", "buyer_cart_id") where "status" = \'open\'',
})
export class AssistedSellingThread {
  [OptionalProps]?:
    | 'status'
    | 'liveProposalCount'
    | 'lastActivityAt'
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

  /** `cart.Cart.id` (`kind: 'basket'`). Re-pointed by the `cart.cart.merged`/`.adopted`
   * subscribers a later Step owns (§5.1) — this Step never rewrites it after creation. */
  @Property({ name: 'buyer_cart_id', type: 'uuid' })
  buyerCartId!: string

  /** `customers.CustomerEntity.id`. Set once the buyer is identified. */
  @Property({ name: 'customer_id', type: 'uuid', nullable: true })
  customerId?: string | null

  /** `customer_accounts.CustomerUser.id`. NULL for a guest. */
  @Property({ name: 'customer_user_id', type: 'uuid', nullable: true })
  customerUserId?: string | null

  @Property({ type: 'text', default: 'open' })
  status: AssistedSellingThreadStatus = 'open'

  /** The store `mode` in force when the thread opened — a later settings change does not
   * rewrite history (§5.6's own "not enforcement" note). */
  @Property({ name: 'mode_snapshot', type: 'text' })
  modeSnapshot!: string

  /** `auth.User.id`. Set by `/threads/:id/assign` (a later Step) — this Step never sets it. */
  @Property({ name: 'assigned_actor_id', type: 'uuid', nullable: true })
  assignedActorId?: string | null

  /** Maintained by the proposal commands and the §6.6 terminal-state subscriber. */
  @Property({ name: 'live_proposal_count', type: 'int', default: 0 })
  liveProposalCount: number = 0

  @Property({ name: 'last_activity_at', type: Date, onCreate: () => new Date() })
  lastActivityAt: Date = new Date()

  @Property({ name: 'closed_at', type: Date, nullable: true })
  closedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

export type AssistedSellingParticipantActorType = 'buyer' | 'rep' | 'ai_agent'
export type AssistedSellingParticipantPresenceState = 'absent' | 'present'

// §5.2. `display_name` is encrypted (`encryption.ts`) — a named natural person disclosed
// across a trust boundary. `presence_state`/`presence_updated_at` ship nullable/defaulted now
// (table shape frozen early per §5.2's own text) but nothing writes them before Phase 5.
// "Unique `(thread_id, actor_type, actor_id)` among non-deleted rows" (§5.2) is a PARTIAL
// unique index for the same reason `AssistedSellingThread`'s own open-buyer-cart constraint
// is — a hard-deleted-then-recreated row (retention/erasure, a later Step) must not collide
// with a soft-deleted one forever.
@Entity({ tableName: 'assisted_selling_participants' })
@Index({ name: 'assisted_selling_participants_tenant_org_idx', properties: ['tenantId', 'organizationId'] })
@Index({ name: 'assisted_selling_participants_thread_idx', properties: ['threadId'] })
@Index({
  name: 'assisted_selling_participants_thread_actor_unique_idx',
  expression:
    'create unique index "assisted_selling_participants_thread_actor_unique_idx" on "assisted_selling_participants" ("thread_id", "actor_type", "actor_id") where "deleted_at" is null',
})
export class AssistedSellingParticipant {
  [OptionalProps]?: 'presenceState' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'thread_id', type: 'uuid' })
  threadId!: string

  @Property({ name: 'actor_type', type: 'text' })
  actorType!: AssistedSellingParticipantActorType

  /** `customer_accounts.CustomerUser.id` for an identified buyer; `auth.User.id` for `rep`
   * and `ai_agent`. NULL only for a guest buyer. */
  @Property({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId?: string | null

  /** Snapshot, shown to the other party. Encrypted at rest (`encryption.ts`) — never
   * searched or filtered on (§5.2's own "encrypted means not searchable" rule). */
  @Property({ name: 'display_name', type: 'text' })
  displayName!: string

  @Property({ name: 'joined_at', type: Date, onCreate: () => new Date() })
  joinedAt: Date = new Date()

  @Property({ name: 'left_at', type: Date, nullable: true })
  leftAt?: Date | null

  /** Phase 5. Nullable/defaulted now so the table ships its final shape without a later
   * migration (§5.2). */
  @Property({ name: 'presence_state', type: 'text', default: 'absent' })
  presenceState: AssistedSellingParticipantPresenceState = 'absent'

  @Property({ name: 'presence_updated_at', type: Date, nullable: true })
  presenceUpdatedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

export type AssistedSellingMessageBodyFormat = 'text'

// §5.3. `body` is encrypted at rest (`encryption.ts`). `ai_input_flagged_at`/`ai_read_by_turn_id`
// ship as nullable columns now so Phase 3 needs no migration on a populated table (S10) —
// nothing in Release 5 writes or reads them.
@Entity({ tableName: 'assisted_selling_messages' })
@Index({ name: 'assisted_selling_messages_thread_sent_idx', properties: ['tenantId', 'threadId', 'sentAt', 'id'] })
export class AssistedSellingMessage {
  [OptionalProps]?: 'bodyFormat' | 'sentAt' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'thread_id', type: 'uuid' })
  threadId!: string

  /** `AssistedSellingParticipant.id` — the author. */
  @Property({ name: 'participant_id', type: 'uuid' })
  participantId!: string

  /** Encrypted at rest. The authoring `note` (S19) is stored here, nowhere else. */
  @Property({ type: 'text' })
  body!: string

  /** `text` is the only Release 5 value (S24). */
  @Property({ name: 'body_format', type: 'text', default: 'text' })
  bodyFormat: AssistedSellingMessageBodyFormat = 'text'

  /** `AssistedSellingProposal.id`. Set when this message is the one that carries a
   * proposal (§6.3 step 7). */
  @Property({ name: 'proposal_id', type: 'uuid', nullable: true })
  proposalId?: string | null

  @Property({ name: 'sent_at', type: Date, onCreate: () => new Date() })
  sentAt: Date = new Date()

  /** Phase 3. Buyer messages only — not written or read in Release 5. */
  @Property({ name: 'ai_input_flagged_at', type: Date, nullable: true })
  aiInputFlaggedAt?: Date | null

  /** Phase 3. Buyer messages only — not written or read in Release 5. No FK: the absence of
   * `assisted_selling_ai_turns` (Phase 3) does not matter (§5.3). */
  @Property({ name: 'ai_read_by_turn_id', type: 'uuid', nullable: true })
  aiReadByTurnId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

export type AssistedSellingProposalAuthoredByActorType = 'rep' | 'ai_agent'
export type AssistedSellingProposalStatus =
  | 'published'
  | 'accepted'
  | 'rejected'
  | 'withdrawn'
  | 'expired'
  | 'superseded'

// §5.4. "The metadata row, not a line model" — lines/quantities/prices/totals live entirely
// on the `cart.Cart` (`kind: 'proposal'`) this row points at via `proposal_cart_id`. Every
// status other than `published` is final (rev 6, D-R5-25) — see `commands/proposals.ts` for
// the transition table §5.4 defines.
@Entity({ tableName: 'assisted_selling_proposals' })
@Unique({ name: 'assisted_selling_proposals_proposal_cart_id_unique', properties: ['tenantId', 'proposalCartId'] })
@Unique({ name: 'assisted_selling_proposals_thread_idempotency_key_unique', properties: ['tenantId', 'threadId', 'idempotencyKey'] })
@Index({ name: 'assisted_selling_proposals_target_status_idx', properties: ['tenantId', 'targetCartId', 'status'] })
@Index({ name: 'assisted_selling_proposals_status_expires_idx', properties: ['tenantId', 'status', 'expiresAt'] })
export class AssistedSellingProposal {
  [OptionalProps]?:
    | 'status'
    | 'publishedAt'
    | 'createdAt'
    | 'updatedAt'
    | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'thread_id', type: 'uuid' })
  threadId!: string

  /** The `cart.Cart` with `kind: 'proposal'`. */
  @Property({ name: 'proposal_cart_id', type: 'uuid' })
  proposalCartId!: string

  /** Denormalized from `Cart.proposed_to_cart_id` so the console can list by target without
   * reaching into `cart`. */
  @Property({ name: 'target_cart_id', type: 'uuid' })
  targetCartId!: string

  @Property({ name: 'authored_by_actor_type', type: 'text' })
  authoredByActorType!: AssistedSellingProposalAuthoredByActorType

  /** `auth.User.id`. Non-nullable — an unattributable proposal is the defect R6 describes. */
  @Property({ name: 'authored_by_actor_id', type: 'uuid' })
  authoredByActorId!: string

  /** `auth.User.id` of the rep who confirmed an AI draft (§4.2). Always NULL in Release 5. */
  @Property({ name: 'approved_by_actor_id', type: 'uuid', nullable: true })
  approvedByActorId?: string | null

  @Property({ type: 'text', default: 'published' })
  status: AssistedSellingProposalStatus = 'published'

  @Property({ name: 'published_at', type: Date, onCreate: () => new Date() })
  publishedAt: Date = new Date()

  /** From the store's `proposal_ttl_seconds` at authoring time — mirrors the proposal
   * cart's own `expires_at`. */
  @Property({ name: 'expires_at', type: Date })
  expiresAt!: Date

  /** From the authoring body (§6.3). Unique per thread (S23) — see the entity-level
   * `@Unique` above. */
  @Property({ name: 'idempotency_key', type: 'text' })
  idempotencyKey!: string

  /** Digest of the normalized authoring body, so a replayed key with a different body is
   * detected (§6.3). */
  @Property({ name: 'request_digest', type: 'text' })
  requestDigest!: string

  /**
   * Additive, NOT in the spec's own §5.4 column table. `commands/proposals.ts`'s own header
   * comment explains why it exists: §6.3's "a replayed key with the SAME digest returns the
   * ORIGINAL 201 body" requires the original `rejectedLines` on hand, and `rejectedLines` is
   * request-time-only data this entity otherwise has nowhere to keep — mirrors `cart`'s own
   * `CartIdempotencyKey.responseBody` (`cart/data/entities.ts`), the identical "store the
   * literal replay body" column this module's own thread-scoped key cannot reuse directly
   * (`cart`'s key is scoped per-CART, and the proposal cart does not exist yet when THIS
   * module's lookup must run, per S23).
   */
  @Property({ name: 'response_snapshot', type: 'jsonb', nullable: true })
  responseSnapshot?: Record<string, unknown> | null

  @Property({ name: 'resolved_at', type: Date, nullable: true })
  resolvedAt?: Date | null

  /** Buyer-supplied, optional. Encrypted at rest (`encryption.ts`). */
  @Property({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason?: string | null

  /** Phase 3. Always NULL in Release 5. */
  @Property({ name: 'ai_pending_action_id', type: 'uuid', nullable: true })
  aiPendingActionId?: string | null

  /** Set when re-authored (§6.4). */
  @Property({ name: 'superseded_by_proposal_id', type: 'uuid', nullable: true })
  supersededByProposalId?: string | null

  /** `cart.CartMergeLog.id`, set on acceptance. Never cleared (D-R5-25). */
  @Property({ name: 'merge_log_id', type: 'uuid', nullable: true })
  mergeLogId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}
