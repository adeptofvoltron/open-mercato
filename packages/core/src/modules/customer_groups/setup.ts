import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['customer_groups.*'],
    admin: ['customer_groups.*'],
    // Release 5 Phase 3 (D-R5-7, least privilege): `employee` gets the view-only credit
    // feature. `credit.manage`/`credit.adjust` stay with `admin` (covered by the
    // `customer_groups.*` wildcard above) or are granted by hand. `approvals.view` is
    // deferred alongside the ACL feature itself — see PLAN.md "Decisions taken without
    // the owner". Existing tenants need `yarn mercato auth sync-role-acls` (spec §8.4).
    employee: [
      'customer_groups.groups.view',
      'customer_groups.memberships.view',
      'customer_groups.terms.view',
      'customer_groups.credit.view',
    ],
  },
}

export default setup
