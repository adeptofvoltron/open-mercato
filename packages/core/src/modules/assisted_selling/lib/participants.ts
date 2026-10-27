import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { User } from '@open-mercato/core/modules/auth/data/entities'
import { AssistedSellingParticipant } from '../data/entities'

// Step 4.4. Shared by `commands/threads.ts` (the opening rep participant) and
// `commands/proposals.ts` (the message author on an authored/re-authored proposal) so a rep
// gets exactly ONE `AssistedSellingParticipant` row per thread (`@Unique(['threadId',
// 'actorType', 'actorId'])`) regardless of which route first creates it.

export function resolveDisplayName(user: User | null, fallbackActorId: string): string {
  const name = user?.name?.trim()
  if (name) return name
  const email = user?.email?.trim()
  if (email) return email
  return `[internal] staff user ${fallbackActorId}`
}

/**
 * Finds the thread's existing `rep` participant for `actorId`, or builds (but does not
 * persist) a new one with an explicit, pre-generated id so callers can reference
 * `.id` before the enclosing `withAtomicFlush` phase actually flushes it.
 */
export async function resolveOrBuildRepParticipant(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string; threadId: string },
  actorId: string,
): Promise<{ participant: AssistedSellingParticipant; isNew: boolean }> {
  const existing = await em.findOne(AssistedSellingParticipant, {
    tenantId: scope.tenantId,
    threadId: scope.threadId,
    actorType: 'rep',
    actorId,
    deletedAt: null,
  })
  if (existing) return { participant: existing, isNew: false }

  const user = await em.findOne(User, { id: actorId })
  const displayName = resolveDisplayName(user, actorId)
  const now = new Date()
  const participant = em.create(AssistedSellingParticipant, {
    id: randomUUID(),
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    threadId: scope.threadId,
    actorType: 'rep' as const,
    actorId,
    displayName,
    joinedAt: now,
    createdAt: now,
    updatedAt: now,
  })
  return { participant, isNew: true }
}
