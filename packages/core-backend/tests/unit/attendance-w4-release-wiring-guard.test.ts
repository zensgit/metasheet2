/**
 * P1-1 「连接销毁语义」(r6.1 §1.1), the part a real-database test cannot reach cheaply: the composition
 * root. Every W4 connection provider in `src/index.ts` forwards the error its boundary passes to
 * pg's `release(err?)` (seven closures: LSB, BND, REC, PROC, RES, SYNC, RB), and the two OPS entry
 * points receive the raw pool. The two transition CLIs are excluded from the rule only as process
 * entries (r6.1 §1.1, D.3.4): their pool is closed by the entry guard after `main()` returns, `main`
 * itself closes nothing, the entry guard's block is exactly those three statements (no borrow between
 * `main()` and the close), and no module imports the entry files. Boundary consumption is proven on a
 * real database (A05 / A06); this file pins what feeds it.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const BACKEND = path.join(REPO_ROOT, 'packages/core-backend')
const INDEX = path.join(BACKEND, 'src/index.ts')
const FORWARDING = '(error?: Error) => client.release(error)'

function parseText(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function parse(file: string): ts.SourceFile {
  return parseText(file, fs.readFileSync(file, 'utf8'))
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

/**
 * The statements of every `if (entry === import.meta.url)` in the file, one string per statement
 * (whitespace collapsed). A then-branch that is not a block, or an else-branch, is reported as an
 * extra entry so it can never match a pinned list.
 */
function entryGuardStatements(source: ts.SourceFile): string[][] {
  const guards: string[][] = []
  walk(source, (node) => {
    if (!ts.isIfStatement(node) || node.expression.getText(source) !== 'entry === import.meta.url') return
    const then = node.thenStatement
    const statements = ts.isBlock(then)
      ? then.statements.map((statement) => statement.getText(source).replace(/\s+/g, ' '))
      : [`<then is not a block> ${then.getText(source)}`]
    if (node.elseStatement) statements.push(`<else> ${node.elseStatement.getText(source)}`)
    guards.push(statements)
  })
  return guards
}

/** Exactly one entry guard, and its block is exactly `expected`, in order. */
function entryGuardIsPinned(source: ts.SourceFile, expected: readonly string[]): boolean {
  return JSON.stringify(entryGuardStatements(source)) === JSON.stringify([expected])
}

describe('W4 connection providers in the composition root', () => {
  const source = parse(INDEX)

  it('all seven acquireConnection closures forward the error to pg release', () => {
    const releases: string[] = []
    walk(source, (node) => {
      if (!ts.isPropertyAssignment(node) || !ts.isIdentifier(node.name) || node.name.text !== 'acquireConnection') return
      walk(node.initializer, (inner) => {
        if (ts.isPropertyAssignment(inner) && ts.isIdentifier(inner.name) && inner.name.text === 'release') releases.push(inner.initializer.getText(source))
      })
    })
    expect(releases).toHaveLength(7)
    expect(releases.filter((text) => text !== FORWARDING)).toEqual([])
  })

  it('the sweep and the admin abandon-run entry points receive the raw pool', () => {
    const firstArguments: Record<string, string[]> = {}
    walk(source, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return
      const name = node.expression.text
      if (name !== 'sweepAttendanceScheduledRunsOnceV1' && name !== 'abandonScheduledRunOnceV1') return
      ;(firstArguments[name] ??= []).push(node.arguments[0]?.getText(source) ?? '')
    })
    expect(firstArguments).toEqual({
      sweepAttendanceScheduledRunsOnceV1: ['poolManager.get().getInternalPool()'],
      abandonScheduledRunOnceV1: ['poolManager.get().getInternalPool()'],
    })
  })
})

describe('the two transition CLIs: excluded only as process entries', () => {
  const CLIS = ['scripts/ops/attendance-w4c5-rollout-transition.ts', 'scripts/ops/attendance-w7-context-source-transition.ts']

  for (const cli of CLIS) {
    it(`${path.basename(cli)}: the pool is closed only by the entry guard, after main(); main closes nothing`, () => {
      const source = parse(path.join(REPO_ROOT, cli))
      const closes: Array<{ inMain: boolean; inEntryGuard: boolean; afterMain: boolean }> = []
      walk(source, (node) => {
        if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'close') return
        if (node.expression.expression.getText(source) !== 'poolManager') return
        let inMain = false
        let guard: ts.IfStatement | null = null
        for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
          if (ts.isFunctionDeclaration(current) && current.name?.text === 'main') inMain = true
          if (ts.isIfStatement(current) && current.expression.getText(source) === 'entry === import.meta.url') guard = current
        }
        const guardText = guard ? guard.thenStatement.getText(source) : ''
        closes.push({ inMain, inEntryGuard: guard !== null, afterMain: guardText.indexOf('await main()') > -1 && guardText.indexOf('await main()') < guardText.indexOf('poolManager.close()') })
      })
      expect(closes).toEqual([{ inMain: false, inEntryGuard: true, afterMain: true }])
    })
  }

  // The exemption holds only while the entry guard does nothing between main() returning and the pool
  // closing, and nothing after it but hand the exit code to the process: no late borrow, no extra work
  // that could reach the pool (TEST-MATRIX A05). The guard's block is pinned statement by statement.
  const ENTRY_GUARD: Record<string, readonly string[]> = {
    'scripts/ops/attendance-w4c5-rollout-transition.ts': ['const exitCode = await main()', 'await poolManager.close()', 'process.exitCode = exitCode'],
    'scripts/ops/attendance-w7-context-source-transition.ts': ['const exitCode = await main()', 'await poolManager.close()', 'process.exit(exitCode)'],
  }

  for (const cli of CLIS) {
    it(`${path.basename(cli)}: the entry guard is exactly main(), close the pool, hand over the exit code`, () => {
      const source = parse(path.join(REPO_ROOT, cli))
      expect(entryGuardStatements(source)).toEqual([[...ENTRY_GUARD[cli]!]])
      expect(entryGuardIsPinned(source, ENTRY_GUARD[cli]!)).toBe(true)
    })

    // Negative controls: the same file with one statement added must not pass the pin.
    it(`${path.basename(cli)}: control: a late borrow between main() and close() breaks the pin`, () => {
      const text = fs.readFileSync(path.join(REPO_ROOT, cli), 'utf8')
      const anchor = '  const exitCode = await main()\n'
      expect(text.split(anchor).length - 1).toBe(1)
      const mutant = parseText(cli, text.replace(anchor, `${anchor}  const late = await poolManager.get('main').getInternalPool().connect(); late.release()\n`))
      const [first, ...rest] = ENTRY_GUARD[cli]!
      expect(entryGuardStatements(mutant)).toEqual([[
        first,
        "const late = await poolManager.get('main').getInternalPool().connect();",
        'late.release()',
        ...rest,
      ]])
      expect(entryGuardIsPinned(mutant, ENTRY_GUARD[cli]!)).toBe(false)
    })

    it(`${path.basename(cli)}: control: an extra harmless-looking statement after close() breaks the pin`, () => {
      const text = fs.readFileSync(path.join(REPO_ROOT, cli), 'utf8')
      const anchor = '  await poolManager.close()\n'
      expect(text.split(anchor).length - 1).toBe(1)
      const mutant = parseText(cli, text.replace(anchor, `${anchor}  console.error('transition finished')\n`))
      const [first, second, last] = ENTRY_GUARD[cli]!
      expect(entryGuardStatements(mutant)).toEqual([[first, second, "console.error('transition finished')", last]])
      expect(entryGuardIsPinned(mutant, ENTRY_GUARD[cli]!)).toBe(false)
    })
  }

  it('no module imports the CLI entry files (so main() never runs inside a long-lived process)', () => {
    const offenders: string[] = []
    const roots = ['packages', 'plugins', 'scripts', 'apps']
    const skip = new Set(['node_modules', 'dist', 'build', 'coverage', '.git'])
    const stack = roots.map((root) => path.join(REPO_ROOT, root))
    while (stack.length > 0) {
      const dir = stack.pop() as string
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!skip.has(entry.name)) stack.push(full)
          continue
        }
        if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) continue
        const relative = path.relative(REPO_ROOT, full).split(path.sep).join('/')
        if (CLIS.includes(relative)) continue
        const text = fs.readFileSync(full, 'utf8')
        if (/(?:from|import\(|require\()\s*['"][^'"]*attendance-(?:w4c5-rollout-transition|w7-context-source-transition)(?:\.ts)?['"]/.test(text)) offenders.push(relative)
      }
    }
    expect(offenders).toEqual([])
  })
})
