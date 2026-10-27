// Step 4.3 declared only `assisted_selling.settings.manage`, deferring the thread/message/
// proposal/attribution features until the entities/routes they gate existed (Step 1.7's
// precedent). Step 4.4 added `threads.view` (GET /threads), `threads.participate` (POST
// /threads, and now /join, /leave, /assign — Step 5.3) and `proposals.author` (POST
// /threads/:id/proposals, /proposals/:id/withdraw, /proposals/:id/reauthor — §6.1's own table
// gates authoring on BOTH this feature and `cart.proposals.author`, by design: "a rep who may
// converse but not propose" is a meaningful configuration).
//
// Step 5.3 adds `messages.post` (`POST /threads/:id/messages`, the console's own composer) —
// the one feature §6.9's full table names that Step 4.4 deferred for exactly this reason.
// `attributions.view` (`GET /attributions`) stays undeclared: that route is Step 5.4's own
// scope, matching the same "don't declare ahead of the literal route table" discipline Step
// 4.3 and Step 2.6 both already set.
export const features = [
  { id: 'assisted_selling.settings.manage', title: 'Manage assisted-selling settings', module: 'assisted_selling' },
  { id: 'assisted_selling.threads.view', title: 'View selling conversations', module: 'assisted_selling' },
  { id: 'assisted_selling.threads.participate', title: 'Join selling conversations', module: 'assisted_selling' },
  { id: 'assisted_selling.proposals.author', title: 'Author proposals', module: 'assisted_selling' },
  { id: 'assisted_selling.messages.post', title: 'Post in selling conversations', module: 'assisted_selling' },
]

export default features
