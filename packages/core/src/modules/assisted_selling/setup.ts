import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

// Step 4.3's `admin: ['assisted_selling.*']` already covers every feature Step 4.4 adds via
// the wildcard. Step 4.4 (§6.9, D-R5-7/D-R5-34): "`employee` gets `assisted_selling.threads.
// view`, `.threads.participate` and `.messages.post`; `assisted_selling.proposals.author`...
// stay with `admin` or [are] granted by hand to the reps who sell — the least-privilege line."
// `messages.post` is not declared yet (acl.ts) — the route it gates (`POST /threads/:id/
// messages`) is a later Step's scope — so `employee`'s grant here is the two features that DO
// exist: a staff member can see and open conversations, but authoring a priced proposal is an
// admin-or-hand-granted capability until that Step ships. Existing tenants need `yarn mercato
// auth sync-role-acls` (S20) to pick up this additive grant.
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['assisted_selling.*'],
    employee: ['assisted_selling.threads.view', 'assisted_selling.threads.participate'],
  },
}

export default setup
