import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely'
import { applyCoverageAdjustments, createCoverageAdjustments } from '../lib/coverage'

/**
 * `entity_index_coverage` carries one hot row per (entity type, tenant, organization), and
 * every indexed write adjusts it. Computing the new totals in JavaScript — read the row, add
 * the delta, write the total back — makes two overlapping adjustments read the same row and
 * write the same total, so one is silently lost and coverage drifts below the real count
 * (#5604). These tests pin the adjustment to a single statement that increments in SQL.
 *
 * A real Kysely instance on `DummyDriver` compiles the queries without a database, so the
 * assertions are about the SQL actually sent rather than about a hand-written fake's shape.
 *
 * What this file can and cannot prove: `DummyDriver` answers every statement with no rows, so
 * it pins the *shape* of what is sent and nothing about the counters that come back. It
 * therefore cannot catch a statement that is well-formed but matches the wrong rows — which is
 * exactly how the NULL-tenant conflict-target defect survived the first version of this suite.
 * `__integration__/TC-QIDX-5613-coverage-accumulation.spec.ts` asserts the resulting totals
 * against a real Postgres; the two are complements, not alternatives.
 */
function createRecordingDb() {
  const statements: string[] = []
  const executed: Array<{ sql: string; parameters: readonly unknown[] }> = []
  const db = new Kysely<any>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (instance: Kysely<any>) => new PostgresIntrospector(instance),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level !== 'query') return
      statements.push(event.query.sql)
      executed.push({ sql: event.query.sql, parameters: event.query.parameters })
    },
  })
  return { db, statements, executed }
}

function createEm(db: Kysely<any>) {
  return { getKysely: () => db } as any
}

const scope = {
  entityType: 'catalog:product',
  tenantId: '11111111-1111-1111-1111-111111111111',
  organizationId: '22222222-2222-2222-2222-222222222222',
}

describe('applyCoverageAdjustments (#5604)', () => {
  it('increments the stored counters in SQL instead of reading them first', async () => {
    const { db, statements } = createRecordingDb()

    await applyCoverageAdjustments(
      createEm(db),
      createCoverageAdjustments({ ...scope, baseDelta: 1, indexDelta: 1 })
    )

    const update = statements.find((sql) => sql.startsWith('update "entity_index_coverage"'))
    expect(update).toBeDefined()
    // The SET clause must add to the column's own value, not assign a precomputed total.
    expect(update).toContain('"base_count" +')
    expect(update).toContain('"indexed_count" +')
    expect(update).toContain('"vector_indexed_count" +')
    // Clamped in SQL too, so a concurrent decrement can never drive a counter negative.
    expect(update).toContain('greatest')
  })

  it('matches a null-tenant scope explicitly rather than through a conflict target', async () => {
    const { db, statements } = createRecordingDb()

    await applyCoverageAdjustments(
      createEm(db),
      createCoverageAdjustments({ ...scope, tenantId: null, baseDelta: 1, indexDelta: 1 })
    )

    // `entity_index_coverage_scope_idx` is a plain UNIQUE constraint and Postgres treats NULLs
    // in one as distinct, so `on conflict (…, tenant_id, …)` can never fire for this scope. The
    // incrementing statement has to find the row by a NULL-aware predicate of its own.
    const update = statements.find((sql) => sql.startsWith('update "entity_index_coverage"'))
    expect(update).toBeDefined()
    expect(update).toContain('"tenant_id" is null')
    expect(update).toContain('"base_count" +')
  })

  // The scope-initialization lock is a `select pg_advisory_xact_lock(…)`, but it names no
  // column of the coverage row — it takes the scope key as a bound parameter — so it does not
  // reintroduce the read this design removed.
  it('does not read the coverage row before writing it', async () => {
    const { db, statements } = createRecordingDb()

    await applyCoverageAdjustments(
      createEm(db),
      createCoverageAdjustments({ ...scope, baseDelta: 1, indexDelta: 0 })
    )

    const readsCoverage = statements.some(
      (sql) => sql.startsWith('select') && sql.includes('"entity_index_coverage"')
    )
    expect(readsCoverage).toBe(false)
  })

  it('aggregates adjustments for one scope into a single delta rather than one write each', async () => {
    const { db, executed } = createRecordingDb()

    await applyCoverageAdjustments(createEm(db), [
      ...createCoverageAdjustments({ ...scope, baseDelta: 1, indexDelta: 1 }),
      ...createCoverageAdjustments({ ...scope, baseDelta: 1, indexDelta: 1 }),
      ...createCoverageAdjustments({ ...scope, baseDelta: 1, indexDelta: 1 }),
    ])

    // The three `+1`s must reach the database as one `+3`. The delta is the first bound
    // parameter of the incrementing UPDATE.
    const increments = executed.filter((entry) => entry.sql.startsWith('update "entity_index_coverage"'))
    expect(increments.length).toBeGreaterThan(0)
    for (const increment of increments) {
      expect(increment.parameters[0]).toBe(3)
    }
    // One scope, so at most one row is ever created for it.
    const inserts = executed.filter((entry) => entry.sql.startsWith('insert into "entity_index_coverage"'))
    expect(inserts).toHaveLength(1)
  })

  it('serializes creating a scope that has no row instead of racing two inserts', async () => {
    const { db, statements } = createRecordingDb()

    // `DummyDriver` answers every statement with no rows, so the increment always reports "this
    // scope does not exist yet" — the branch a NULL-distinct unique constraint cannot protect,
    // where two concurrent callers would otherwise both insert and one delta would be dropped.
    await applyCoverageAdjustments(
      createEm(db),
      createCoverageAdjustments({ ...scope, tenantId: null, baseDelta: 1, indexDelta: 1 })
    )

    // Creating a scope must take the scope lock.
    const lockIndex = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock'))
    expect(lockIndex).toBeGreaterThanOrEqual(0)

    // Re-checking inside the lock is what makes it work: the caller that loses the race must
    // see the winner's committed row and increment it rather than insert a rival.
    const recheckIndex = statements.findIndex(
      (sql, index) => index > lockIndex && sql.startsWith('update "entity_index_coverage"')
    )
    expect(recheckIndex).toBeGreaterThan(lockIndex)

    const insertIndex = statements.findIndex((sql) => sql.startsWith('insert into "entity_index_coverage"'))
    // The insert only ever follows the re-check, never replaces it.
    expect(insertIndex).toBeGreaterThan(recheckIndex)
    // Holding the lock proves the scope is empty, so the insert seeds rather than increments;
    // the conflict clause is only a backstop against a writer that bypasses this path.
    expect(statements[insertIndex]).toContain('do nothing')
  })

  it('skips the database entirely when every delta cancels out', async () => {
    const { db, statements } = createRecordingDb()

    await applyCoverageAdjustments(
      createEm(db),
      createCoverageAdjustments({ ...scope, baseDelta: 0, indexDelta: 0 })
    )

    expect(statements).toHaveLength(0)
  })
})
