import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

// Step 4.3's `admin: ['assisted_selling.*']` already covers every feature later Steps add via
// the wildcard. Step 5.3 (§6.9, D-R5-7/D-R5-34): "`employee` gets `assisted_selling.threads.
// view`, `.threads.participate` and `.messages.post`; `assisted_selling.proposals.author`...
// stay with `admin` or [are] granted by hand to the reps who sell — the least-privilege line."
// `messages.post` now exists (`acl.ts`, this Step's own `POST /threads/:id/messages`), so the
// employee grant gains it: a staff member can see, open and converse in threads, but
// authoring a priced proposal stays an admin-or-hand-granted capability. Existing tenants need
// `yarn mercato auth sync-role-acls` (S20) to pick up this additive grant.
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['assisted_selling.*'],
    employee: ['assisted_selling.threads.view', 'assisted_selling.threads.participate', 'assisted_selling.messages.post'],
  },
}

export default setup
