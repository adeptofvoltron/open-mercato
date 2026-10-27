import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

// Step 4.3. Least privilege (D-R5-7's precedent): the only feature this Step declares,
// `assisted_selling.settings.manage`, is a manage-level action with no sibling `.view` in the
// spec's own route table (acl.ts), so it stays with `admin` only. `employee` gets nothing yet —
// Step 4.4/4.5 will add its own view-level features (threads, messages, proposals) and decide
// `employee`'s access to those on their own terms.
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['assisted_selling.*'],
  },
}

export default setup
