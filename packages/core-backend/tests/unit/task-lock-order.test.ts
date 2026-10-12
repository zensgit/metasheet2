/**
 * M5|7 lock-order control, the cells that need no database (design
 * docs/development/task-m5-pr4a-backend-design-20261010.md §4.2, §6.1; RULED(2026-10-09): [S09];
 * ASSUMPTION(task-m5a): [a-36]).
 *
 * - wrapper cells: rank order, the reverse-order cell, the two leader coexistence orders, errors of
 *   the helpers passed through unchanged and not recorded, one sequence per instance;
 * - static cell: in production code under `src/`, no identifier names one of the three lock helpers
 *   outside `src/db/task-advisory-locks.ts` (imports, re-exports, property reads, calls), with a
 *   positive control on in-memory sources.
 * The positive cells on real paths (structure writes, task creation, a scheduler tick) are real-DB
 * cells in `tests/integration/task-m5-schema.db.test.ts`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  setTaskLockOrderRecorderForTests,
  TASK_LOCK_RANKS,
  TaskLockOrderViolation,
  withTaskLockOrder,
  type TaskLockOrderLock,
} from '../../src/db/task-advisory-locks'

vi.mock('../../src/tasks/task-lock-keys', () => ({
  taskStructureLockKey: (orgId: string) => `sentinel-structure:${orgId}`,
  taskProjectionLockKey: (listId: string, taskId: string) => `sentinel-projection:${listId}:${taskId}`,
  tasksSchedulerLeaderLockKey: () => 'sentinel-scheduler',
}))

const LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtext($1))'

function recordingQuery(): { query: (sql: string, params?: unknown[]) => Promise<unknown>; sent: unknown[][] } {
  const sent: unknown[][] = []
  return {
    sent,
    query: async (sql: string, params?: unknown[]) => {
      sent.push([sql, ...(params ?? [])])
      return { rows: [] }
    },
  }
}

function installRecorder(): Map<number, TaskLockOrderLock[]> {
  const seen = new Map<number, TaskLockOrderLock[]>()
  setTaskLockOrderRecorderForTests((instance, lock) => {
    const list = seen.get(instance) ?? []
    list.push(lock)
    seen.set(instance, list)
  })
  return seen
}

async function violation(run: () => Promise<unknown>): Promise<TaskLockOrderViolation> {
  const caught = await run().then(() => null, (error: unknown) => error)
  expect(caught).toBeInstanceOf(TaskLockOrderViolation)
  return caught as TaskLockOrderViolation
}

afterEach(() => {
  setTaskLockOrderRecorderForTests(null)
})

describe('M5|7 lock-order control — wrapper (unit)', () => {
  it('ranks are structure 1, fence 2, projection 3', () => {
    expect(TASK_LOCK_RANKS).toEqual({ structure: 1, fence: 2, projection: 3 })
  })

  it('structure then projection: both taken through the helpers, recorded in order, nothing else sent', async () => {
    const seen = installRecorder()
    const { query, sent } = recordingQuery()
    const locks = withTaskLockOrder(query)
    await locks.structure('org-1')
    await locks.projection('list-1', 'task-1')
    expect(sent).toEqual([
      [LOCK_SQL, 'sentinel-structure:org-1'],
      [LOCK_SQL, 'sentinel-projection:list-1:task-1'],
    ])
    expect([...seen.values()]).toEqual([['structure', 'projection']])
  })

  it('the same rank twice is allowed (rank does not decrease)', async () => {
    const seen = installRecorder()
    const locks = withTaskLockOrder(recordingQuery().query)
    await locks.structure('org-1')
    await locks.structure('org-2')
    expect([...seen.values()]).toEqual([['structure', 'structure']])
  })

  it('reverse order: projection then structure throws TaskLockOrderViolation and sends no statement for structure', async () => {
    const seen = installRecorder()
    const { query, sent } = recordingQuery()
    const locks = withTaskLockOrder(query)
    await locks.projection('list-1', 'task-1')
    const error = await violation(() => locks.structure('org-1'))
    expect(error.code).toBe('TASK_LOCK_ORDER_VIOLATION')
    expect(error.held).toEqual(['projection'])
    expect(error.requested).toBe('structure')
    expect(sent).toEqual([[LOCK_SQL, 'sentinel-projection:list-1:task-1']])
    expect([...seen.values()]).toEqual([['projection']])
  })

  it('leader coexistence, structure first: the leader lock then throws (ASSUMPTION(task-m5a): [a-36])', async () => {
    const { query, sent } = recordingQuery()
    const locks = withTaskLockOrder(query)
    await locks.structure('org-1')
    const error = await violation(() => locks.schedulerLeader())
    expect(error.held).toEqual(['structure'])
    expect(error.requested).toBe('leader')
    expect(sent).toHaveLength(1)
  })

  it('leader coexistence, leader first: the structure lock then throws, and so does the projection lock (ASSUMPTION(task-m5a): [a-36])', async () => {
    const { query, sent } = recordingQuery()
    const locks = withTaskLockOrder(query)
    await locks.schedulerLeader()
    const structure = await violation(() => locks.structure('org-1'))
    expect(structure.held).toEqual(['leader'])
    expect(structure.requested).toBe('structure')
    const projection = await violation(() => locks.projection('list-1', 'task-1'))
    expect(projection.requested).toBe('projection')
    expect(sent).toEqual([[LOCK_SQL, 'sentinel-scheduler']])
  })

  it('a helper error reaches the caller as the same object, with its SQLSTATE, and is not recorded', async () => {
    const seen = installRecorder()
    const busy = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })
    const locks = withTaskLockOrder(async () => {
      throw busy
    })
    const caught = await locks.schedulerLeader().then(() => null, (error: unknown) => error)
    expect(caught).toBe(busy)
    expect((caught as { code?: string }).code).toBe('55P03')
    expect(seen.size).toBe(0)
  })

  it('a lock is recorded only after its helper resolves', async () => {
    const seen = installRecorder()
    let release!: () => void
    const locks = withTaskLockOrder(() => new Promise((resolve) => {
      release = () => resolve({ rows: [] })
    }))
    const pending = locks.structure('org-1')
    await Promise.resolve()
    expect(seen.size).toBe(0)
    release()
    await pending
    expect([...seen.values()]).toEqual([['structure']])
  })

  it('each wrapper instance keeps its own sequence: a new instance may take structure after another took projection', async () => {
    const seen = installRecorder()
    const first = withTaskLockOrder(recordingQuery().query)
    await first.projection('list-1', 'task-1')
    const second = withTaskLockOrder(recordingQuery().query)
    await second.structure('org-1')
    expect([...seen.values()]).toEqual([['projection'], ['structure']])
    const [a, b] = [...seen.keys()]
    expect(b).toBeGreaterThan(a)
  })

  it('without a recorder nothing is recorded and the locks are still taken', async () => {
    const { query, sent } = recordingQuery()
    await withTaskLockOrder(query).structure('org-1')
    expect(sent).toEqual([[LOCK_SQL, 'sentinel-structure:org-1']])
  })
})

// ── Static cell ──

const HELPERS = ['acquireTaskStructureLock', 'acquireTaskProjectionLock', 'acquireTasksSchedulerLeaderLock'] as const
const SRC_ROOT = new URL('../../src/', import.meta.url).pathname
const LOCKS_MODULE = 'db/task-advisory-locks.ts'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(path)
  }
  return out
}

/** Every identifier in `source` that names one of the three helpers, with its line. */
function helperIdentifiers(fileName: string, source: string): Array<{ name: string; line: number }> {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const hits: Array<{ name: string; line: number }> = []
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node)) && (HELPERS as readonly string[]).includes(node.text)) {
      hits.push({ name: node.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits
}

/** Module specifiers of static and dynamic imports in `source` that point at the lock module. */
function lockModuleImports(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.moduleSpecifier.text.endsWith('task-advisory-locks')) found.push(node.getText(sf).replace(/\s+/g, ' '))
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments
      if (arg && ts.isStringLiteral(arg) && arg.text.endsWith('task-advisory-locks')) found.push(node.getText(sf))
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

describe('M5|7 lock-order control — static: no production caller of the three helpers outside the wrapper', () => {
  const files = walk(SRC_ROOT)

  it('the scan sees the production tree (the lock module and both wrapper users are in it)', () => {
    const rel = files.map((f) => relative(SRC_ROOT, f))
    expect(rel).toContain(LOCKS_MODULE)
    expect(rel).toContain('services/task-records.ts')
    expect(rel).toContain('services/task-scheduler.ts')
    expect(files.length).toBeGreaterThan(100)
  })

  it('no file under src/ other than the lock module names a lock helper', () => {
    const offenders: string[] = []
    for (const file of files) {
      const rel = relative(SRC_ROOT, file)
      if (rel === LOCKS_MODULE) continue
      for (const hit of helperIdentifiers(rel, readFileSync(file, 'utf8'))) offenders.push(`${rel}:${hit.line} ${hit.name}`)
    }
    expect(offenders).toEqual([])
  })

  it('every import of the lock module under src/ takes only the wrapper or the query type', () => {
    const imports: Record<string, string[]> = {}
    for (const file of files) {
      const rel = relative(SRC_ROOT, file)
      const found = lockModuleImports(rel, readFileSync(file, 'utf8'))
      if (found.length > 0) imports[rel] = found
    }
    expect(imports).toEqual({
      'services/task-records.ts': ["import { withTaskLockOrder, type TaskAdvisoryQuery } from '../db/task-advisory-locks'"],
      'services/task-scheduler.ts': ["import { withTaskLockOrder } from '../db/task-advisory-locks'"],
    })
  })

  it('inside the lock module, each helper is declared once and called only by the wrapper', () => {
    const source = readFileSync(join(SRC_ROOT, LOCKS_MODULE), 'utf8')
    const sf = ts.createSourceFile(LOCKS_MODULE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const calls: Array<{ helper: string; inside: string }> = []
    const declared: string[] = []
    const visit = (node: ts.Node, fn: string): void => {
      let current = fn
      if (ts.isFunctionDeclaration(node) && node.name) {
        current = node.name.text
        if ((HELPERS as readonly string[]).includes(current)) declared.push(current)
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (HELPERS as readonly string[]).includes(node.expression.text)) {
        calls.push({ helper: node.expression.text, inside: current })
      }
      ts.forEachChild(node, (child) => visit(child, current))
    }
    visit(sf, '<module>')
    expect(declared.sort()).toEqual([...HELPERS].sort())
    expect(calls).toEqual([
      { helper: 'acquireTaskStructureLock', inside: 'withTaskLockOrder' },
      { helper: 'acquireTaskProjectionLock', inside: 'withTaskLockOrder' },
      { helper: 'acquireTasksSchedulerLeaderLock', inside: 'withTaskLockOrder' },
    ])
  })

  it('positive control: the same scans catch a direct import, a namespace read, a re-export and a dynamic import', () => {
    const direct = "import { acquireTaskStructureLock } from '../db/task-advisory-locks'\nawait acquireTaskStructureLock(q, o)\n"
    expect(helperIdentifiers('a.ts', direct).map((h) => h.name)).toEqual(['acquireTaskStructureLock', 'acquireTaskStructureLock'])
    expect(lockModuleImports('a.ts', direct)).toHaveLength(1)
    const namespace = "import * as locks from '../db/task-advisory-locks'\nawait locks.acquireTasksSchedulerLeaderLock(q)\n"
    expect(helperIdentifiers('b.ts', namespace).map((h) => h.name)).toEqual(['acquireTasksSchedulerLeaderLock'])
    expect(lockModuleImports('b.ts', namespace)).toEqual(["import * as locks from '../db/task-advisory-locks'"])
    const reexport = "export { acquireTaskProjectionLock as take } from '../db/task-advisory-locks'\n"
    expect(helperIdentifiers('c.ts', reexport).map((h) => h.name)).toEqual(['acquireTaskProjectionLock'])
    const dynamic = "const m = await import('../db/task-advisory-locks')\nawait m['acquireTaskStructureLock'](q, o)\n"
    expect(helperIdentifiers('d.ts', dynamic).map((h) => h.name)).toEqual(['acquireTaskStructureLock'])
    expect(lockModuleImports('d.ts', dynamic)).toHaveLength(1)
    // A comment that names a helper is not a caller.
    expect(helperIdentifiers('e.ts', '// taken through acquireTasksSchedulerLeaderLock\n')).toEqual([])
  })
})
