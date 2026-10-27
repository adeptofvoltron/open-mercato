import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  { id: 'checkout.template.created', label: 'Template Created', entity: 'template', category: 'crud' },
  { id: 'checkout.template.updated', label: 'Template Updated', entity: 'template', category: 'crud' },
  { id: 'checkout.template.deleted', label: 'Template Deleted', entity: 'template', category: 'crud' },
  { id: 'checkout.link.created', label: 'Link Created', entity: 'link', category: 'crud' },
  { id: 'checkout.link.updated', label: 'Link Updated', entity: 'link', category: 'crud' },
  { id: 'checkout.link.deleted', label: 'Link Deleted', entity: 'link', category: 'crud' },
  { id: 'checkout.link.published', label: 'Link Published', entity: 'link', category: 'lifecycle', clientBroadcast: true },
  { id: 'checkout.link.locked', label: 'Link Locked', entity: 'link', category: 'lifecycle', clientBroadcast: true },
  { id: 'checkout.transaction.created', label: 'Transaction Created', entity: 'transaction', category: 'crud' },
  { id: 'checkout.transaction.customerDataCaptured', label: 'Customer Data Captured', entity: 'transaction', category: 'lifecycle' },
  { id: 'checkout.transaction.sessionStarted', label: 'Payment Session Started', entity: 'transaction', category: 'lifecycle' },
  { id: 'checkout.transaction.completed', label: 'Transaction Completed', entity: 'transaction', category: 'lifecycle', clientBroadcast: true },
  { id: 'checkout.transaction.failed', label: 'Transaction Failed', entity: 'transaction', category: 'lifecycle', clientBroadcast: true },
  { id: 'checkout.transaction.cancelled', label: 'Transaction Cancelled', entity: 'transaction', category: 'lifecycle' },
  { id: 'checkout.transaction.expired', label: 'Transaction Expired', entity: 'transaction', category: 'lifecycle' },
  { id: 'checkout.link.usageLimitReached', label: 'Usage Limit Reached', entity: 'link', category: 'lifecycle', clientBroadcast: true },
  // Release 5, Step 2.12 (B.1, §10). State signals only — no checkout event sends a
  // notification to a buyer or approver (D-R5-32). The full §10 family (`.step_changed`,
  // `.submitted`, `.completed`, `.failed`, `.expired`, `.approval_*`, `checkout.payment.*`,
  // `checkout.compensation.*`) is declared incrementally as the Step that emits it lands
  // (Steps 2.13/3.5/4.1/4.2) — declaring an event with no emitter yet is the same dead-
  // surface this run's own precedent (Step 2.7) avoided for `customer_groups.approval.decided`.
  { id: 'checkout.session.created', label: 'Checkout Session Created', entity: 'session', category: 'lifecycle' },
  { id: 'checkout.session.canceled', label: 'Checkout Session Canceled', entity: 'session', category: 'lifecycle' },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'checkout', events })
export const emitCheckoutEvent = eventsConfig.emit
export default eventsConfig
