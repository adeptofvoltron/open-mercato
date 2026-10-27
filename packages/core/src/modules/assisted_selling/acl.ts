// Step 4.3 scope only. The spec's §6.1 staff route table gates BOTH
// `GET /settings/:storeId` and `PUT /settings/:storeId` on the single feature
// `assisted_selling.settings.manage` — there is no separate `.settings.view` in the spec's own
// route table, so one is not invented here (same "don't declare ahead of the literal route
// table" precedent Step 2.6 set for the portal approvals routes). The thread/message/proposal/
// attribution features named by §6.1/§6.2 are Step 4.4/4.5's own scope and are deliberately not
// declared yet, mirroring Step 1.7's "defer a feature id until the entity/route it gates exists"
// precedent.
export const features = [
  { id: 'assisted_selling.settings.manage', title: 'Manage assisted-selling settings', module: 'assisted_selling' },
]

export default features
