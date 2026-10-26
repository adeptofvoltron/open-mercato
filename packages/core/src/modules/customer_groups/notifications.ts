import type { NotificationTypeDefinition } from '@open-mercato/shared/modules/notifications/types'

// Release 5 Phase 3 (G15, Step 1.8). Only the credit-specific notification is declared
// here: `approval.requested`/`approval.decided` are Step 2.7's scope (the entity they
// gate, `CustomerPurchaseApproval`, does not exist until Step 2.4). In-app only — spec
// §10.2 reserves e-mail for buyer-side approval deciders, and credit has no buyer-side
// decider in this release (G15: "Buyer-side notifications are NOT relevant here since
// credit has no buyer-side approver").
export const notificationTypes: NotificationTypeDefinition[] = [
  {
    type: 'customer_groups.credit.limit_exceeded',
    module: 'customer_groups',
    channels: ['in_app'],
    titleKey: 'customer_groups.notifications.creditLimitExceeded.title',
    bodyKey: 'customer_groups.notifications.creditLimitExceeded.body',
    icon: 'alert-triangle',
    severity: 'warning',
    // No static action: the deep link depends on whether the credit account's
    // customer resolves to a company or a person page (G11), so it is computed per
    // notification and passed as `linkHref` by the subscriber instead of a static
    // `{sourceEntityId}`-templated action href (only one path prefix is possible there).
    actions: [],
    expiresAfterHours: 168,
  },
]

export default notificationTypes
