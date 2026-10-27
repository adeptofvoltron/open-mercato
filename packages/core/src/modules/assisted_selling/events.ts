import { createModuleEvents } from '@open-mercato/shared/modules/events'

// Step 4.4 (§6.8). Only the events this Step's own commands actually emit — the thread-open
// family (`.thread.opened`, `.participant.joined`, `.message.posted`) and the proposal-
// authoring-side family (`.proposal.published`, `.withdrawn`, `.superseded`). §6.8 also names
// `.thread.closed`, `.participant.left`, `.proposal.accepted`/`.rejected`/`.expired` and
// `.attribution.degraded` — all of them written by mechanisms a LATER Step owns (the §6.6
// terminal-state subscriber on `cart.proposal.*`, the §5.10 retention/erasure sweepers, the
// §6.7 attribution subscriber), so they are deliberately NOT declared yet, mirroring Step
// 4.3's own "defer a feature/event id until the thing that emits it exists" precedent. See
// NOTIFY.md's Step 4.4 entry for the full list of what is deferred and why.
//
// `clientBroadcast: true` on every one of them (§6.8: "on thread, participant, message and
// proposal events so the rep console updates without polling").
const events = [
  { id: 'assisted_selling.thread.opened', label: 'Assisted Selling Thread Opened', entity: 'thread', category: 'lifecycle', clientBroadcast: true },
  { id: 'assisted_selling.participant.joined', label: 'Assisted Selling Participant Joined', entity: 'participant', category: 'lifecycle', clientBroadcast: true },
  { id: 'assisted_selling.message.posted', label: 'Assisted Selling Message Posted', entity: 'message', category: 'crud', clientBroadcast: true },
  { id: 'assisted_selling.proposal.published', label: 'Assisted Selling Proposal Published', entity: 'proposal', category: 'lifecycle', clientBroadcast: true },
  { id: 'assisted_selling.proposal.withdrawn', label: 'Assisted Selling Proposal Withdrawn', entity: 'proposal', category: 'lifecycle', clientBroadcast: true },
  { id: 'assisted_selling.proposal.superseded', label: 'Assisted Selling Proposal Superseded', entity: 'proposal', category: 'lifecycle', clientBroadcast: true },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'assisted_selling',
  events,
})

export const emitAssistedSellingEvent = eventsConfig.emit

export type AssistedSellingEventId = typeof events[number]['id']

export default eventsConfig
