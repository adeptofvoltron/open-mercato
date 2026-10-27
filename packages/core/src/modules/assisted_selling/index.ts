import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

// Step 4.3 (D-R5-11/D-R5-36). Phase 1's author side wraps `cart.proposal.create` and reads
// `ecommerce.storeContextService.resolveForBuyer` (both arrive in Step 4.4/4.5), so neither is a
// hard `requires` here: this Step builds only the module scaffold and its store settings, which
// have no cross-module read at all. Every future peer (cart, ecommerce, customer_accounts) is a
// soft dependency resolved with `tryResolve`, per root AGENTS.md's Cross-Module Coupling guidance.
export const metadata: ModuleInfo = {
  name: 'assisted_selling',
  title: 'Assisted Selling',
  version: '0.1.0',
  description: 'Staff- and AI-authored priced proposals on a buyer\'s basket, accepted as a cart merge.',
  author: 'Open Mercato Team',
  license: 'MIT',
  ejectable: true,
}

export { features } from './acl'
