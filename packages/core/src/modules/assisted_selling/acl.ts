// Step 4.3 declared only `assisted_selling.settings.manage`, deferring the thread/message/
// proposal/attribution features until the entities/routes they gate existed (Step 1.7's
// precedent). Step 4.4 adds exactly the three features its own staff routes gate:
// `threads.view` (GET /threads), `threads.participate` (POST /threads) and `proposals.author`
// (POST /threads/:id/proposals, /proposals/:id/withdraw, /proposals/:id/reauthor — §6.1's own
// table gates authoring on BOTH this feature and `cart.proposals.author`, by design: "a rep
// who may converse but not propose" is a meaningful configuration). `messages.post` (§6.1's
// `POST /threads/:id/messages`) and `attributions.view` (`GET /attributions`) stay undeclared —
// neither route ships in this Step, matching the same "don't declare ahead of the literal
// route table" discipline Step 4.3 and Step 2.6 both already set.
export const features = [
  { id: 'assisted_selling.settings.manage', title: 'Manage assisted-selling settings', module: 'assisted_selling' },
  { id: 'assisted_selling.threads.view', title: 'View selling conversations', module: 'assisted_selling' },
  { id: 'assisted_selling.threads.participate', title: 'Join selling conversations', module: 'assisted_selling' },
  { id: 'assisted_selling.proposals.author', title: 'Author proposals', module: 'assisted_selling' },
]

export default features
