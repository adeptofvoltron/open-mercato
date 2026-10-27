import { handleCartMergedForProposalRetarget } from '../lib/proposalRetarget'

// Step 3.3 (rev 10 — D-R5-14/S11) — see `lib/proposalRetarget.ts`'s own header comment for
// why this lives in `cart` as a provisional mechanism rather than in `assisted_selling`
// (which does not exist as code yet). Persistent: a login merge's re-author/supersede pass
// does real work (another command dispatch) and must survive a worker restart, same
// `persistent: true` convention `subscribers/approval-approved.ts` and its siblings already
// use for this module's other cross-cutting cart-lifecycle subscribers.
export const metadata = {
  event: 'cart.cart.merged',
  persistent: true,
  id: 'cart:proposal-retarget-on-merge',
}

export default handleCartMergedForProposalRetarget
