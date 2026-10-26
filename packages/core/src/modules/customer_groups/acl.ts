export const features = [
  { id: 'customer_groups.groups.view', title: 'View customer groups', module: 'customer_groups' },
  { id: 'customer_groups.groups.manage', title: 'Manage customer groups', module: 'customer_groups', dependsOn: ['customer_groups.groups.view'] },
  { id: 'customer_groups.memberships.view', title: 'View group memberships', module: 'customer_groups' },
  { id: 'customer_groups.memberships.manage', title: 'Manage group memberships', module: 'customer_groups', dependsOn: ['customer_groups.memberships.view'] },
  { id: 'customer_groups.terms.view', title: 'View commercial terms', module: 'customer_groups' },
  { id: 'customer_groups.terms.manage', title: 'Manage commercial terms', module: 'customer_groups', dependsOn: ['customer_groups.terms.view'] },
  // Release 5 Phase 3 (G16, spec §9.1). `credit.manage` (the limit/hold edit route this
  // Step ships) and `credit.adjust` (the ledger `/adjust` command — not shipped until a
  // later Step) are separate on purpose: different kinds of financial authority tenants
  // will want to grant to different roles. Both depend on `credit.view` only, not on each
  // other. `approvals.*` is deferred to Step 2.6 — see PLAN.md "Decisions taken without
  // the owner": `CustomerPurchaseApproval` does not exist yet (Step 2.4), so declaring an
  // ACL feature with nothing behind it is premature.
  { id: 'customer_groups.credit.view', title: 'View credit accounts', module: 'customer_groups' },
  { id: 'customer_groups.credit.manage', title: 'Manage credit limits', module: 'customer_groups', dependsOn: ['customer_groups.credit.view'] },
  { id: 'customer_groups.credit.adjust', title: 'Post credit adjustments', module: 'customer_groups', dependsOn: ['customer_groups.credit.view'] },
]

export default features
