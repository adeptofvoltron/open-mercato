# Client-Broadcast SSE Coalescing for Bulk Writers

| Field | Value |
|-------|-------|
| Status | Implemented — pending review |
| Issue | [#5733](https://github.com/open-mercato/open-mercato/issues/5733) |
| Implementation | [#5896](https://github.com/open-mercato/open-mercato/pull/5896) (`feat/client-broadcast-sse-coalescing`) |
| Origin | Specification review of [#5609](https://github.com/open-mercato/open-mercato/pull/5609) (catalog bulk-create) |
| Packages | `@open-mercato/events`, `@open-mercato/shared`, `@open-mercato/core` (catalog) |

## 📝 Overview

The event bus delivers a `clientBroadcast: true` event to three destinations at once: in-process subscribers, the browser (through two SSE bridges and a `pg_notify` roundtrip that reaches other processes), and — when persistent — the queue. A bulk writer needs the first and third once per record, but the second only needs to say "something changed" often enough for an open list to look live.

This spec separates those two halves inside `bus.emit` and puts a coalescing scheduler in front of the browser half only, engaged per event declaration by a new optional field. It changes no wire format, no event id, no schema and no API route; it adds one optional `EventDefinition` field, one env knob and one internal module. Merging the mechanism is behavior-neutral because nothing opts in until an owner declares it, and the three catalog product events are the only declarations in scope here.

## 📝 TLDR

A `clientBroadcast: true` event emitted in a tight loop costs one serialized `pg_notify` roundtrip plus one tenant-wide SSE fan-out **per record**. The progress module already hit this and solved it privately with `OM_PROGRESS_BROADCAST_MIN_INTERVAL_MS`; every other bulk writer still pays the unthrottled cost. This spec gives the event bus the same coalescing as an opt-in property of an event declaration — `broadcastCoalescing: true` — so a burst collapses to at most one browser delivery per interval plus a guaranteed trailing delivery, while the domain event still fires once per record for subscribers, webhooks and the queue. Nothing changes for an event that does not opt in.

## 📝 Problem Statement

`bus.emit()` does four things in this order for a `clientBroadcast: true` event (`packages/events/src/bus.ts:437-505`):

1. runs the **global taps** — both the backoffice SSE endpoint (`packages/events/src/modules/events/api/stream/route.ts:209`) and the customer-portal SSE endpoint (`packages/core/src/modules/customer_accounts/api/portal/events/stream.ts:131`) register one, and each iterates the whole in-process connection set;
2. delivers **inline subscribers** (`bus.ts:465-469`);
3. `await publishCrossProcessEvent(...)` — a real `SELECT pg_notify($1, $2)` query on a dedicated pool (`packages/events/src/bridge.ts:201`), on the caller's critical path;
4. when persistent, enqueues the queue job.

Only (2) and (4) carry domain meaning. (1) and (3) exist solely so browsers see the change — and note they are **not adjacent**: inline delivery sits between them, which is why the architecture below keeps them as two seams rather than one block.

A 2,000-row product import therefore performs 2,000 Postgres roundtrips and 2,000 fan-outs to make DataTables refresh — and the three catalog events that pay this exist for exactly that reason, as their own declaration says (`packages/core/src/modules/catalog/events.ts:9-15`: *"bridge to the DataTable … so confirmed mutations auto-refresh the list"*). A DataTable does not need 2,000 refresh triggers; it needs the last one.

The progress module recognised this and fixed it for itself (`packages/core/src/modules/progress/lib/progressServiceImpl.ts:19-32`, `:187-251`): a leading-edge throttle behind `OM_PROGRESS_BROADCAST_MIN_INTERVAL_MS`, with database heartbeats kept on their own schedule so the stale-job sweep cannot starve. That throttle is private to one service. The catalog bulk-create work on [#5609](https://github.com/open-mercato/open-mercato/pull/5609) (spec still unmerged at the time of writing, so it is cited as a PR rather than a repo path) deliberately accepts the unthrottled cost for one endpoint, bounded by its 2,000-item cap — a reasonable trade that does not generalise, because it rests on that endpoint's own item cap rather than on anything about the event. Every future bulk writer of a broadcast entity inherits the cost with no lever to pull.

## 📝 Proposed Solution

Add a **coalescing scheduler in the events package** that wraps only the browser-facing half of `emit` — the global-tap fan-out and the cross-process publish — and is engaged per event by a new optional `EventDefinition` field:

```typescript
{ id: 'catalog.product.created', label: 'Product Created', clientBroadcast: true, broadcastCoalescing: true }
```

Semantics: **last-wins within a window, with a guaranteed trailing delivery.** The first emit of a burst is delivered immediately (leading edge). Subsequent emits sharing a coalescing key inside the window replace the pending payload rather than being delivered; a timer always flushes the survivor when the window closes. A burst of N emits therefore produces `1 + ceil(burst_duration / interval)` browser deliveries instead of N, and the final state always reaches the browser.

Two properties from the issue are structural, not incidental:

- **The domain event still fires per record.** Coalescing touches only the two browser-facing sinks; inline subscriber delivery and the queue enqueue are untouched and stay where they are. Webhooks, notification handlers, workflow triggers and indexers see byte-identical behavior.
- **The last event of a burst is delivered for as long as the emitting process lives.** The trailing timer is unconditional, which is where this design goes past the progress precedent: the progress service can drop the tail because its terminal transitions (`completeJob` / `failJob`) emit through a separate unthrottled path, and a generic mechanism has no such guaranteed epilogue.

  The qualifier is load-bearing and is stated deliberately rather than as a caveat. A pending browser delivery must never keep a process alive, so the trailing timer is `unref`'d; a process can therefore end with a tail still queued. Three exit paths do this — a natural exit once the event loop drains, a `SIGTERM`/`SIGINT` stop, and a `SIGKILL`. The first two are covered by the shutdown flush (Step 1.6, and the Edge Cases rows below); only `SIGKILL` genuinely drops the tail, bounded at one interval, and the browser's reconnect path re-syncs after it.

### Alternatives considered

| Option | Why it lost |
|--------|-------------|
| Global env interval applied to every `clientBroadcast` event | Silently changes delivery semantics for every existing consumer in one release, including single-event UI reactions that are not bursty. Fails the "never weaken a documented contract by default" rule. |
| Automatic coalescing for ids the bridge observes as high-frequency | Requires per-id rate state and a heuristic threshold; behavior becomes load-dependent and irreproducible between environments, which is a poor property for a delivery contract. |
| Lossless batching (N events delivered in one SSE frame / one envelope) | Preserves per-record fidelity but changes the SSE wire format and `useAppEvent`'s dispatch contract — a much larger blast radius for a benefit no current consumer needs (they refetch). Revisitable additively later. |
| Suppress the event entirely in bulk mode (`ctx.bulkImport.skipEvents`) | Already rejected by the catalog bulk-create design on [#5609](https://github.com/open-mercato/open-mercato/pull/5609) — it makes bulk-created records invisible to webhooks and integrations. This spec deliberately keeps the domain event. |

## 📝 Architecture

### The seam

```
bus.emit(event, payload, options)
  │
  ├─ A. global taps ───────── backoffice SSE fan-out + portal SSE fan-out
  │                           browser-facing
  ├─ B. inline subscriber delivery ────────────── unchanged, per record
  │
  ├─ C. publishCrossProcessEvent → pg_notify → other processes' SSE
  │                           browser-facing
  └─ D. queue enqueue (persistent) ───────────── unchanged, per record
```

The two browser-facing sinks (A and C) sit on **opposite sides** of inline delivery today, so they are wrapped as two closures — `runGlobalTaps()` and `publishToOtherProcesses()` — rather than merged into one block:

- **A non-opted-in event keeps the exact sequence above.** `runGlobalTaps()` is invoked at A and `publishToOtherProcesses()` at C, each at the position its code occupies today, so its emit is byte-identical — including the lazy resolution of `crossProcessOptions`, which must stay inside C so a non-coalesced event resolves scope at exactly the point it always did.
- **An opted-in event hands both closures to the coalescer as one dispatch**, submitted at position A. That is the one deliberate ordering change: for a coalesced event the cross-process publish travels with the taps and therefore precedes inline subscriber delivery instead of following it. It is recorded in the Edge Cases table rather than left implicit, and it is safe because C's consumers are other processes' SSE bridges, which have no ordering relationship with this process's inline subscribers.

Merging A and C into a single closure invoked at one position — the shape a first reading suggests — would move one of them across inline delivery **for every event, opted in or not**, which is why it is rejected here. The two closures must also preserve what differs between the sinks: the taps receive the raw `options`, while the publish receives `crossProcessOptions` from `resolveCrossProcessEmitOptions` and is gated on `isCrossProcessBroadcastEvent && hasTrustedTenantScope && isPrivateCrossProcessEventEmitter` (`bus.ts:474-479`). The taps carry no such gate.

Placing the seam at `emit` rather than inside the SSE route is what makes one mechanism cover both bridges and the `pg_notify` roundtrip at once: both SSE endpoints subscribe through `registerGlobalEventTap`, and the cross-process publish is the same statement. Coalescing inside `broadcastEventToConnections` would leave the Postgres roundtrips — half the cost the issue names — untouched.

### New module: `packages/events/src/broadcast-coalescer.ts`

Self-contained and dependency-free apart from the logger and the shared number parser. Public surface:

```typescript
export function submitBroadcast(
  key: string,
  dispatch: () => Promise<void>,
  options?: { intervalMs?: number },
): Promise<void>

export function flushPendingBroadcasts(): Promise<void>
export function resetBroadcastCoalescerForTests(): void
```

`intervalMs` is an explicit parameter rather than an ambient read so the unit tests can drive the window deterministically; see the testing note under the Implementation Plan.

State is a `Map<string, PendingBroadcast>` where `PendingBroadcast = { dispatch, timer, lastDispatchedAt, suppressed }`. Entries are deleted on flush, so the map is bounded by the number of distinct keys currently mid-window, not by burst length.

The map lives on `globalThis` under a namespaced key, following the `GLOBAL_EVENT_TAPS_KEY` / `EVENTS_PRODUCER_QUEUE_KEY` precedent in `bus.ts:62,140` — the event bus is rebuilt per request, so a per-bus map would coalesce nothing.

### Coalescing key

**The governing rule: the key must contain every dimension the delivery filter narrows on.** Coalescing suppresses a pending delivery in favour of a newer one sharing its key, so any audience dimension missing from the key lets an emit for audience X suppress a pending emit for audience Y. The two emits are not merged — the survivor is delivered correctly to its own audience — but Y's delivery is silently lost, indistinguishable from the event never having been emitted. Getting this wrong is the single highest-severity failure mode in the design, so the key is derived from an explicit enumeration rather than from an intuition about what "scope" means.

The backoffice filter is `matchesAudience` (`stream/route.ts:107-126`), fed by `normalizeAudience` (`stream/route.ts:51-105`). It narrows on **four** dimensions, not two:

| Dimension | Source in `normalizeAudience` |
|-----------|-------------------------------|
| tenant | trusted `options.tenantId`, else payload `tenantId` |
| organizations | trusted `options.organizationId` + `options.organizationIds`, else the payload equivalents |
| recipient users | payload `recipientUserId` + `recipientUserIds` (always payload — never options) |
| recipient roles | payload `recipientRoleId` + `recipientRoleIds` (always payload — never options) |

The portal filter (`portal/events/stream.ts:32-45`) narrows on tenant and organizations only, but reads **both from the payload**, because the portal tap is registered as `(eventName, payload) => …` and never receives `options` at all (`portal/events/stream.ts:131-133`).

The key is therefore:

```
${eventId}::${tenantId}::${sortedOrganizationIds}::${sortedRecipientUserIds}::${sortedRecipientRoleIds}
```

built by one function, `buildBroadcastCoalesceKey(event, payload, options)`, which is the **single source of truth** for scope resolution at this seam and mirrors `normalizeAudience`'s precedence exactly:

- tenant and organizations come from trusted `options` when `options` carries a `tenantId` property, and from the payload otherwise — the same `hasTrustedScope` test `normalizeAudience` applies, not the narrower `isBroadcastEvent`-gated promotion `resolveCrossProcessEmitOptions` performs;
- recipient users and roles always come from the payload, sorted, because that is the only place the filter reads them;
- lists are sorted with an explicit comparator so a multi-value audience keys identically however the caller ordered it.

Two failure cases this replaces, both of which a tenant-and-organization-only key admits:

- **Recipient-addressed events.** Two emits of one opted-in event, same tenant and organization, addressed to different users, share a key. One user's delivery is dropped.
- **Portal-only events.** An event declaring `portalBroadcast: true` without `clientBroadcast: true` carries its scope in the payload, since that is the only channel the portal tap reads. A key that only consults `options` — or that promotes payload scope only for `isBroadcastEvent` ids, as `resolveCrossProcessEmitOptions` does (`bus.ts:82`) — collapses every tenant onto `${eventId}::::`, letting tenant B's emit suppress tenant A's portal delivery.

Both get dedicated regression tests (Step 1.5). Deriving the key from `resolveCrossProcessEmitOptions` is specifically **not** sufficient and must not be used here: its payload promotion is gated on `isBroadcastEvent`, which is false for exactly the portal-only case above.

### Eligibility

An event is coalesced only when **all** hold:

1. its declaration sets `broadcastCoalescing: true`;
2. `isBroadcastEvent(id) || isPortalBroadcastEvent(id)` — there is a browser sink to coalesce. A declaration setting `broadcastCoalescing` with neither is rejected at declaration time, since it would coalesce nothing;
3. `crossProcessBroadcast !== true` — private cross-process coordination (cache invalidation, registry reloads) must stay immediate; delaying it would make another process serve stale data. A declaration combining `crossProcessBroadcast: true` with `broadcastCoalescing: true` is rejected at declaration time in `createModuleEvents` with a clear error rather than silently ignored;
4. the resolved interval is `> 0`.

Note what is deliberately **not** an eligibility condition: carrying recipient scope or being portal-only. Both are handled by putting those dimensions in the key rather than by excluding the events, so the mechanism stays available to the portal bridge as Resolved assumption #3 intends.

### Interval

`OM_BROADCAST_COALESCE_INTERVAL_MS`, default **250 ms**, parsed with `parseNumberWithDefault` from `@open-mercato/shared/lib/number` (`0` disables coalescing process-wide — the escape hatch, mirroring `OM_PROGRESS_BROADCAST_MIN_INTERVAL_MS=0`). 250 ms matches the progress module's default and sits below the browser's own 500 ms dedup window (`packages/ui/src/backend/injection/eventBridge.ts:13`), so coalescing never becomes the dominant source of perceived latency for a single interactive mutation — and a single mutation is delivered on the leading edge anyway, with no added latency at all.

## 📝 Data Model

No entities, columns, or migrations. All state is in-process and ephemeral.

## 📝 API Contracts

### Changed — `EventDefinition` (additive, optional)

```typescript
/**
 * When true, browser deliveries of this event coalesce: within
 * OM_BROADCAST_COALESCE_INTERVAL_MS, only the newest payload per
 * (event, tenant, organization) reaches the SSE bridges, and a trailing
 * flush guarantees the last one is delivered. Subscribers, webhooks and
 * the queue are unaffected — the domain event still fires per record.
 * Only declare it on events whose browser consumers react to the fact
 * that something changed (list refresh), not to each occurrence.
 * Default: false.
 */
broadcastCoalescing?: boolean
```

`BACKWARD_COMPATIBILITY.md:42` explicitly permits new optional fields on `EventDefinition`; nothing is renamed, removed, or narrowed.

### Unchanged

The SSE frame shape (`{ id, payload, timestamp, organizationId }`), `useAppEvent`, `AppEventPayload`, the audience filter, `isBroadcastEvent`, `isPortalBroadcastEvent`, `EmitOptions`, the queue job shape, and every event id. Suppression counts surface through the structured logger (`logger.debug('Coalesced broadcast', { event, suppressed })`), not through the wire format — deliberately, so this change carries no browser-contract risk.

### New environment variable

| Variable | Default | Meaning |
|----------|---------|---------|
| `OM_BROADCAST_COALESCE_INTERVAL_MS` | `250` | Minimum ms between browser deliveries of one coalescing key. `0` disables coalescing everywhere, restoring per-record delivery. |

## 📝 UI/UX

No UI work. The observable difference is that a bulk import refreshes an open DataTable a few times per second instead of once per row, and the table is correct when the burst ends. Nothing in `packages/ui` changes.

## 📝 Edge Cases & Failure Scenarios

| Scenario | Behavior |
|----------|----------|
| Process stopped by `SIGTERM` / `SIGINT` mid-window | `flushPendingBroadcasts()` runs from a **dedicated** hook this spec registers (Step 1.6), not from the producer-queue hook at `bus.ts:157-169` — that one is registered only from inside `getQueue()`'s shared-async branch (`bus.ts:244`), so a `local`-strategy process, a process with `OM_EVENTS_SHARED_PRODUCER=0`, or one that never enqueues has no such handler at all. |
| Process reaches a **natural** exit mid-window | The common case for the motivating workload, and the reason the shutdown hook cannot rely on signals alone. The trailing timer is `unref`'d so a pending browser delivery never keeps a process open, which means a CLI import or one-shot script finishes, the loop drains, and no signal ever fires. `beforeExit` runs at exactly that moment and flushes the tail. |
| Hard `SIGKILL` | The tail is genuinely lost — bounded at one interval, and the browser reconnect path already re-syncs. This is the only exit path the guarantee does not cover. |
| `pg_notify` fails inside a deferred flush | No caller is awaiting it any more, so the deferred path owns its own `try/catch` and logs at `error` with the event id — matching how `emit` already handles a synchronous publish failure (`bus.ts:481-485`). A failed flush does not block the next window. |
| Two tenants burst concurrently | Independent keys, independent timers, independent payloads. Regression test asserts no tenant's delivery is suppressed by another's. |
| Two recipients of one event burst concurrently | Independent keys, because recipient users and roles are part of the key. Without them in the key one recipient's delivery would be silently dropped; regression test asserts both are delivered. |
| A portal-only event bursts across tenants | Independent keys, because the key falls back to payload scope exactly as the portal tap does. Regression test covers a `portalBroadcast`-without-`clientBroadcast` declaration specifically, since that is the case a trusted-options-only key derivation gets wrong. |
| Ordering: cross-process publish vs inline subscribers, for a **coalesced** event | Deliberate change. The publish travels with the taps and therefore precedes inline delivery instead of following it. Safe because the publish's consumers are other processes' SSE bridges, which never had an ordering relationship with this process's inline subscribers. A non-coalesced event's sequence is untouched. |
| Ordering between a coalesced and a non-coalesced event | Per key, order is preserved (last wins). Across keys, a later immediate event can reach the browser before an earlier deferred one. Cross-event ordering over the bridge was never guaranteed — cross-process envelopes already race with local taps — but it is now documented rather than incidental. |
| An event opts in whose consumers need per-record fidelity | A real semantic hazard, and the reason this is opt-in per declaration rather than a global default. Documented in `packages/events/AGENTS.md` with the "react to the fact, not the occurrence" test. |
| Payload exceeds the 4096-byte SSE limit / 7000-byte bridge limit | Unchanged — truncation and drop happen inside the dispatch closure exactly as today. |
| Interval set to `0` | Every emit passes straight through. The code path is the same closure invoked synchronously, so behavior is byte-identical to today. |
| Serverless/scale-to-zero deployment where the process may not outlive the request | The trailing flush is a timer, so a frozen process can drop the tail. The Node deployment model this repo targets already relies on process-lifetime timers for SSE heartbeats (`stream/route.ts:274`), so the assumption is not new; the env knob is the opt-out. |

## 📝 Risks & Impact Review

**Blast radius.** Phase 1 changes `emit`'s internal structure but no observable behavior for any event that does not opt in — and, unlike a naive restructuring, that claim rests on the two-closure shape rather than on the coalescer being idle: `runGlobalTaps()` and `publishToOtherProcesses()` are each invoked at the position their code occupies today, so a non-opted-in emit is byte-identical. Since no event opts in during Phase 1, that covers every event. Phase 2 changes the browser delivery pattern of exactly three catalog events, and for those three the cross-process publish moves ahead of inline delivery (Edge Cases). The queue, subscriber, webhook and index paths are untouched in both phases.

**Backward compatibility.**

| Surface | Change | Verdict |
|---------|--------|---------|
| Type interface (`EventDefinition`) | New optional field `broadcastCoalescing?: boolean` | ✓ ADDITIVE — `BACKWARD_COMPATIBILITY.md:42` permits optional additions |
| Import paths / exports (`@open-mercato/events`) | New exports `submitBroadcast`, `flushPendingBroadcasts`, `resolveBroadcastCoalesceIntervalMs` | ✓ ADDITIVE — nothing removed or renamed |
| Test-only helper | `resetBroadcastCoalescerForTests` | ✓ ADDITIVE, but reachable only via the deep module path `@open-mercato/events/broadcast-coalescer` and NOT re-exported from the package root, so it does not become a supported public surface |
| Event IDs, API routes, DB schema, DI keys, ACL features | None | ✓ Unchanged |
| SSE frame shape | None | ✓ Unchanged |
| Env vars | New optional `OM_BROADCAST_COALESCE_INTERVAL_MS` | ✓ ADDITIVE |

**Rollback.** Two independent levers, no migration to reverse: set `OM_BROADCAST_COALESCE_INTERVAL_MS=0` to disable process-wide at runtime, or drop `broadcastCoalescing: true` from a single declaration to revert one event. Reverting the Phase 2 commit alone restores today's behavior while keeping the mechanism available.

**Security.** Two distinct properties, worth separating because only the second is about data exposure:

- *No payload is ever mixed.* Suppressed payloads are dropped, never merged, so no delivered payload is assembled from more than one record. No new data reaches the browser, and the audience filter is untouched — the surviving payload is filtered by `matchesAudience` exactly as it would have been without coalescing. This holds unconditionally and is what keeps the change out of cross-tenant-*leak* territory.
- *No audience's delivery is suppressed by another's.* This is the property that depends on the key being complete, and it is the one a partial key breaks. It is enforced by deriving the key from the full enumeration of filter dimensions (Architecture → Coalescing key) and verified by required Phase 1 regression tests covering all three cases a tenant-and-organization-only key gets wrong: two tenants, two recipient users, and a portal-only event scoped through the payload.

**Performance.** Expected reduction for a 2,000-row import at the 250 ms default: from 2,000 `pg_notify` roundtrips and 2,000 fan-outs to roughly `1 + (import_seconds × 4)` of each. Cost added: one `Map` entry and one timer per active key.

## 📋 Phasing

- **Phase 1 — the mechanism.** The coalescer, the declaration field, the eligibility guard, the env knob, the shutdown flush, and full unit coverage. No event opts in, so merging is behavior-neutral and independently shippable.
- **Phase 2 — the first consumers.** Opt the three catalog broadcast events in, document the mechanism and its "when to declare it" test, add the guard that a bulk write emits per-record domain events while coalescing browser deliveries, and cover the browser end of the guarantee with integration tests. Phase 2 is where behavior first changes, so it is the phase the QA gate applies to.

## 📋 Implementation Plan

**Testing note (applies to every step below).** The coalescer's contract is expressed in *when* things dispatch, so every assertion here spans a timer window. The unit tests use Jest fake timers and advance them explicitly; `submitBroadcast` takes `intervalMs` as a parameter precisely so a test can pin the window rather than mutate `process.env`. Without this, an assertion like Step 1.4's "≤3 tap invocations" cannot distinguish a working coalescer from a dead timer — a synchronous 100-emit loop lands entirely in one tick and produces exactly 2 dispatches either way. `resetBroadcastCoalescerForTests()` clears the `globalThis` map between tests so one suite's pending entries cannot leak into the next.

### Phase 1 — Coalescing mechanism (behavior-neutral)

**Step 1.1 — Declare the field.** Add `broadcastCoalescing?: boolean` with its JSDoc to `EventDefinition` (`packages/shared/src/modules/events/types.ts:20-41`) and an `isCoalescedBroadcastEvent(eventId)` reader beside `isBroadcastEvent` (`packages/shared/src/modules/events/factory.ts:143-195`). *Test:* the reader returns `true` only for a declared, opted-in event and `false` for undeclared ids and for opted-out ones.

**Step 1.2 — Reject the unsafe combination.** In `createModuleEvents`, throw when a declaration sets both `crossProcessBroadcast: true` and `broadcastCoalescing: true`, with a message naming the event id and why (private coordination must not be delayed). *Test:* the declaration throws; a `clientBroadcast` + `broadcastCoalescing` declaration does not.

**Step 1.3 — Add the coalescer.** New `packages/events/src/broadcast-coalescer.ts` with `submitBroadcast` / `flushPendingBroadcasts` / `resetBroadcastCoalescerForTests`, `globalThis`-backed state, leading-edge dispatch, unconditional trailing timer, per-key `try/catch` around the deferred dispatch, and a `logger.debug` suppression counter. *Test (unit, no bus):* a burst of 50 submissions on one key inside the window yields 1 immediate + 1 trailing dispatch and the trailing one is the newest closure; distinct keys never interfere; `intervalMs: 0` dispatches every submission synchronously; a throwing deferred dispatch is logged and does not poison the next window.

**Step 1.4 — Wire it into `emit`.** Wrap the tap fan-out as `runGlobalTaps()` and the guarded `publishCrossProcessEvent` block as `publishToOtherProcesses()`, each **left at its current position** (`bus.ts:441-449` and `bus.ts:474-487` respectively) so a non-opted-in emit is byte-identical; keep `resolveCrossProcessEmitOptions` inside the second closure so it still resolves lazily, after inline delivery. When the event is eligible, submit both closures to `submitBroadcast` as one dispatch at the taps' position and skip the later publish. Keep inline delivery and the queue enqueue exactly where they are. *Test:* for a non-opted-in event the call sequence and the point of scope resolution are unchanged; for an opted-in event a 100-emit burst produces 100 inline subscriber invocations and 100 queue enqueues but ≤3 tap invocations and ≤3 `publishCrossProcessEvent` calls; `crossProcessBroadcast` events are never deferred; the publish's three gates still hold on the coalesced path.

**Step 1.5 — Audience isolation.** Implement `buildBroadcastCoalesceKey(event, payload, options)` per Architecture → Coalescing key: tenant and organizations from trusted `options` when it carries a `tenantId` property and from the payload otherwise (mirroring `normalizeAudience`'s `hasTrustedScope` test, **not** `resolveCrossProcessEmitOptions`'s narrower `isBroadcastEvent`-gated promotion), recipient users and roles always from the payload, every list sorted with an explicit comparator. *Test:* three regression cases, one per dimension a partial key drops — concurrent bursts for two tenants and two organizations each deliver; two emits addressed to different `recipientUserId`s both deliver; a `portalBroadcast`-without-`clientBroadcast` event carrying scope only in the payload keys per tenant rather than collapsing to `${eventId}::::`. Plus the standing assertion that no delivered payload carries another audience's data.

**Step 1.6 — Shutdown flush.** Register a **dedicated** hook, `registerBroadcastCoalescerShutdownHook()`, from `createEventBus` — unconditionally, and idempotently via a `globalThis` key. It must not reuse the producer hook at `bus.ts:157-169`: that one is registered only from inside `getQueue()`'s shared-async branch (`bus.ts:244`), so a `local`-strategy process, `OM_EVENTS_SHARED_PRODUCER=0`, or a process that never enqueues would silently have no handler. Bind `flushPendingBroadcasts()` to `SIGTERM`, `SIGINT` **and `beforeExit`** — the last covers the natural-exit path an `unref`'d timer creates, which is the common one for a CLI import. *Test:* each of the three registered handlers dispatches a pending entry; the hook registers even when the bus never opens a queue; registering twice adds one handler set.

**Step 1.7 — Env knob.** Resolve `OM_BROADCAST_COALESCE_INTERVAL_MS` through `parseNumberWithDefault` (default 250, min 0) and document it in `apps/mercato/.env.example` — mirroring the template per the `create-app` Template Sync Checklist (`yarn template:sync:fix`). *Test:* unset → 250; `0` → passthrough; a negative or non-numeric value → 250.

### Phase 2 — First consumers and documentation

**Step 2.1 — Opt the catalog events in.** Add `broadcastCoalescing: true` to `catalog.product.{created,updated,deleted}` (`packages/core/src/modules/catalog/events.ts:13-15`) — the three events whose declared purpose is DataTable auto-refresh. Run `yarn generate`. *Test:* `isCoalescedBroadcastEvent` is true for the three and false for every other catalog event.

**Step 2.2 — Bulk-writer guard.** A test that drives a loop of catalog product creates through the bus and asserts the invariant the issue names: N domain deliveries to a subscriber, ≪N browser dispatches, and the final payload delivered to the browser is the last record's. *Test:* is the step.

**Step 2.3 — Document it.** Extend `packages/events/AGENTS.md` → DOM Event Bridge with a "Coalescing browser deliveries" subsection: the declaration, the env knob, the guarantee **and its process-lifetime qualifier**, the `crossProcessBroadcast` prohibition, the note that recipient-addressed and portal-only events are safe because the key covers their dimensions, and the "declare it only when browser consumers react to the fact that something changed, not to each occurrence" test. Add the same to `apps/docs` where the DOM bridge is described, and note in `packages/core/src/modules/progress/AGENTS.md` that `OM_PROGRESS_BROADCAST_MIN_INTERVAL_MS` remains the progress-local knob. *Test:* `yarn agents:check-budget`.

**Step 2.4 — Integration coverage.** The guarantee this spec is built on — *the browser is correct when the burst ends* — is a browser-observable property, and no unit test on the bus can prove it. Add a Playwright integration test at `packages/core/src/modules/catalog/__integration__/product-broadcast-coalescing.spec.ts`, following `.ai/qa/AGENTS.md` (module `__integration__` folder, shared helpers from `@open-mercato/core/helpers/integration/*`, self-contained fixtures created in setup and removed in teardown, no reliance on seeded data).

| Path | Coverage |
|------|----------|
| `GET /api/events/stream` (SSE, key UI path) | With the catalog products DataTable open, run a bulk product create; assert the table refreshes a bounded number of times rather than once per row, and that **after the burst settles the table lists every created product** — the trailing-flush guarantee, end to end. |
| `POST /api/catalog/products` bulk write | Assert the domain event still fires per record while browser deliveries are coalesced: N records created and N webhook/subscriber deliveries observed against ≪N refreshes. |
| `OM_BROADCAST_COALESCE_INTERVAL_MS=0` | The documented kill switch actually restores per-record delivery through the same UI path. |

No API contract changes, so there is no new endpoint to cover; these exercise existing paths under the new delivery pattern.

## 📝 Out of scope

- **Migrating `progress.job.updated` onto the generic mechanism.** Its throttle is entangled with heartbeat persistence and CAS-guarded writes (`progressServiceImpl.ts:187-254`); the migration is behavior-sensitive and buys no user-visible improvement. `OM_PROGRESS_BROADCAST_MIN_INTERVAL_MS` stays as-is and stays documented.
- **Lossless batching of distinct records into one frame.** Additive later if a consumer needs per-record fidelity under coalescing; nothing here forecloses it.
- **Re-coalescing envelopes received from other processes.** The publisher already collapsed them; a second stage would add latency without removing roundtrips.
- **Opting in events outside catalog.** Each is a one-line decision for the owning module, made against the Phase 2 documentation.

## Resolved assumptions (autonomous defaults)

Written by `om-spec-writing --autonomous`; every line below is a default this run chose, not a decision the issue made. Override any of them on the PR before merge.

| # | Question | Chosen default | Rationale |
|---|----------|----------------|-----------|
| 1 | Env-tunable global interval, per-event-definition option, or automatic detection for high-frequency ids? (the issue's explicit design question) | **Per-event-definition opt-in** (`broadcastCoalescing: true`) with an env-tunable interval | Smallest blast radius and most reversible: merging changes nothing until an owner opts an event in. A global default would silently alter delivery semantics for every existing consumer; automatic detection makes behavior load-dependent and irreproducible. |
| 2 | Coalescing semantics for a burst of *distinct* records: last-wins, or lossless batching? | **Last-wins with a guaranteed trailing flush** | It is what the issue's "must not drop the last event, or a DataTable ends the burst stale" describes, it matches the progress precedent, and it needs no change to the SSE wire format or `useAppEvent`. Batching is additive later. |
| 3 | Does the mechanism also cover the portal event bridge (`portalBroadcast`)? | **Yes** | Both SSE endpoints subscribe through the same `registerGlobalEventTap`, so coalescing at the `emit` seam covers both with one mechanism and no additional surface. Not quite free, though: the portal tap never receives `options` and scopes purely from the payload, so the coalescing key has to fall back to payload scope for portal-only events. That is one branch in the key builder, and it is a required Phase 1 test rather than an assumption. |
| 4 | Should `progress.job.updated` migrate onto the generic mechanism, retiring its private knob? | **No — out of scope** | The progress throttle is coupled to heartbeat persistence and CAS writes; migrating it is a behavior-sensitive refactor with no user-visible gain. Recorded as a follow-up. |
| 5 | Which events opt in as part of this work? | **The three `catalog.product.*` broadcast events only** | They are the ones the originating review measured, and their declaration already states their only purpose is DataTable refresh — the exact shape last-wins serves losslessly. |
| 6 | Does an opted-in event also need an env flag to activate? | **No — the declaration alone activates it**; `OM_BROADCAST_COALESCE_INTERVAL_MS=0` is the global kill switch | A second required flag would mean the shipped default does nothing; a single kill switch gives operators rollback without a deploy. |
| 7 | Should a coalesced SSE frame carry a `suppressed`/`coalesced` marker so consumers can detect gaps? | **No — observability via the structured logger only** | Keeps the browser wire contract completely unchanged, holding this spec's BC impact to one additive optional type field. A consumer that needs per-occurrence fidelity should not opt the event in. Additive later if asked for. |
| 8 | Default interval? | **250 ms** | Matches `OM_PROGRESS_BROADCAST_MIN_INTERVAL_MS`'s default and sits below the browser bridge's own 500 ms dedup window, so coalescing never becomes the dominant perceived latency; a single interactive mutation is delivered on the leading edge with no added latency at all. |

## 📋 Final Compliance Report

| Requirement | Status |
|-------------|--------|
| No cross-tenant data exposure | ✅ Suppressed payloads are dropped, never merged; the audience filter is untouched, so a delivered payload is filtered exactly as it would be without coalescing. |
| No audience's delivery silently suppressed by another's | ✅ The coalescing key enumerates all four dimensions `matchesAudience` narrows on, with three required regression tests (tenant, recipient, portal payload-scope). |
| Backward compatibility (`BACKWARD_COMPATIBILITY.md`) | ✅ One optional `EventDefinition` field (permitted explicitly at `BACKWARD_COMPATIBILITY.md:42`), additive exports, no removals or renames. No event id, API route, DB schema, DI key or ACL feature changes. |
| No direct cross-module ORM relationships | ✅ N/A — no entities. |
| Migrations | ✅ N/A — no schema change. |
| i18n / no hardcoded user-facing strings | ✅ N/A — the only new strings are `[internal]`-prefixed declaration-time errors and structured log messages. |
| Design system compliance | ✅ N/A — no UI changes. |
| Env vars mirrored into the create-app template | ⬜ Step 1.7 — `apps/mercato/.env.example` plus `yarn template:sync:fix`. |
| Unit coverage | ⬜ Steps 1.1–1.7, 2.1–2.2. |
| Integration coverage for affected API and key UI paths | ⬜ Step 2.4. |
| Docs and AGENTS.md updated | ⬜ Step 2.3, gated on `yarn agents:check-budget`. |
| Validation gate | ⬜ `yarn build:packages`, `yarn generate`, `yarn build:packages`, `yarn i18n:check-sync`, `yarn i18n:check-usage`, `yarn typecheck`, `yarn test`, `yarn build:app`. |

⬜ items are carried by the implementation PR [#5896](https://github.com/open-mercato/open-mercato/pull/5896), not by this document.

## 📋 Changelog

| Date | Change |
|------|--------|
| 2026-09-04 | Initial specification, written from issue #5733 with autonomous defaults for the eight open questions recorded above. |
| 2026-09-06 | Specification review (#5895). Reworked the coalescing key to enumerate **all four** dimensions `matchesAudience` narrows on — recipient users and roles were missing, and portal-only events keyed to the empty string for every tenant because the key consulted trusted options only; both allowed one audience's burst to silently suppress another's. Corrected Step 1.6: the shutdown flush now registers its own unconditional hook including `beforeExit`, because the producer hook it previously named exists only on the shared-async queue path and misses the natural-exit case an `unref`'d timer creates. Reworked Step 1.4 into two closures left at their existing positions, since the tap fan-out and the cross-process publish sit on opposite sides of inline delivery and merging them would reorder every event. Added the Overview, Final Compliance Report and Changelog sections required by `.ai/specs/AGENTS.md`, integration coverage as Step 2.4, and a testing note pinning the fake-timer strategy. Fixed a citation pointing at a spec path that exists only on unmerged #5609. |
