import { createModuleEvents } from '@open-mercato/shared/modules/events'

// Step 4.4 (§6.8). The thread-open family (`.thread.opened`, `.participant.joined`,
// `.message.posted`) and the proposal-authoring-side family (`.proposal.published`,
// `.withdrawn`, `.superseded`). §6.8 also names `.thread.closed`, `.participant.left` and
// `.attribution.degraded` — written by mechanisms a LATER Step owns (the §5.10 retention/
// erasure sweepers, the §6.7 attribution subscriber), so they stay deliberately NOT declared,
// mirroring Step 4.3's own "defer a feature/event id until the thing that emits it exists"
// precedent. See NOTIFY.md's Step 4.4 entry.
//
// Step 4.4-fix (§6.6) adds `.proposal.accepted`/`.rejected`/`.expired` — the terminal-state
// subscriber's own emissions (`lib/terminalStateSubscriber.ts`), the three ids Step 4.4
// itself deferred for exactly this reason.
//
// Step 5.3 adds `.participant.left` — the console's own `POST /threads/:id/join`'s
// counterpart (`/leave`), the one remaining id §6.8's own table names that Step 4.4 had not
// yet built a writer for. `.thread.closed` and `.attribution.degraded` stay deferred —
// neither mechanism (the §5.10 retention/erasure sweepers, the §6.7 attribution subscriber)
// ships in this Step either.
//
// `clientBroadcast: true` on every one of them (§6.8: "on thread, participant, message and
// proposal events so the rep console updates without polling").
const events = [
  { id: 'assisted_selling.thread.opened', label: 'Assisted Selling Thread Opened', entity: 'thread', category: 'lifecycle', clientBroadcast: true },
  { id: 'assisted_selling.participant.joined', label: 'Assisted Selling Participant Joined', entity: 'participant', category: 'lifecycle', clientBroadcast: true },
  { id: 'assisted_selling.participant.left', label: 'Assisted Selling Participant Left', entity: 'participant', category: 'lifecycle', clientBroadcast: true },
  { id: 'assisted_selling.message.posted', label: 'Assisted Selling Message Posted', entity: 'message', category: 'crud', clientBroadcast: true },
  { id: 'assisted_selling.proposal.published', label: 'Assisted Selling Proposal Published', entity: 'proposal', category: 'lifecycle', clientBroadcast: true },
  { id: 'assisted_selling.proposal.withdrawn', label: 'Assisted Selling Proposal Withdrawn', entity: 'proposal', category: 'lifecycle', clientBroadcast: true },
  { id: 'assisted_selling.proposal.superseded', label: 'Assisted Selling Proposal Superseded', entity: 'proposal', category: 'lifecycle', clientBroadcast: true },
  { id: 'assisted_selling.proposal.accepted', label: 'Assisted Selling Proposal Accepted', entity: 'proposal', category: 'lifecycle', clientBroadcast: true },
  { id: 'assisted_selling.proposal.rejected', label: 'Assisted Selling Proposal Rejected', entity: 'proposal', category: 'lifecycle', clientBroadcast: true },
  { id: 'assisted_selling.proposal.expired', label: 'Assisted Selling Proposal Expired', entity: 'proposal', category: 'lifecycle', clientBroadcast: true },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'assisted_selling',
  events,
})

export const emitAssistedSellingEvent = eventsConfig.emit

export type AssistedSellingEventId = typeof events[number]['id']

export default eventsConfig
