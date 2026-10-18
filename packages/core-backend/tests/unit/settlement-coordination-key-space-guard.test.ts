/**
 * Key-space guard ① for the attendance settlement coordination key: no source file outside the
 * coordination module and its own tests may use 1297297987 / 0x4D533243 (the reserved two-int4
 * key1). The population is the repository's source tree, walked from disk — not a hand-kept list
 * — and the walk asserts it actually reached the module that defines the constant, so a scan that
 * silently covers the wrong tree fails instead of passing.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const ROOTS = ['packages', 'plugins', 'scripts', 'apps']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.turbo', '.vite', '.next', 'out'])
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.cjs', '.mjs', '.vue', '.sql'])
const RESERVED = /1297297987|0x4d533243/i

const DEFINING_MODULE = 'packages/core-backend/src/attendance/coordination/settlement-coordination-key.ts'
const ALLOWED_FILES = new Set([
  DEFINING_MODULE,
  'packages/core-backend/src/attendance/__tests__/settlement-coordination-key.test.ts',
  'packages/core-backend/src/attendance/__tests__/settlement-coordination-statements.test.ts',
  'packages/core-backend/tests/unit/settlement-coordination-key-space-guard.test.ts',
])
const ALLOWED_PREFIXES = [
  'packages/core-backend/tests/integration/attendance-coordination-',
  'packages/core-backend/tests/helpers/settlement-coordination-',
]

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out)
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full)
    }
  }
}

describe('settlement coordination key space — guard ①', () => {
  it('no source file outside the coordination module uses the reserved key1', () => {
    const files: string[] = []
    for (const root of ROOTS) walk(path.join(REPO_ROOT, root), files)
    const relative = files.map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))

    // The walk must cover the real tree: it has to reach the defining module and a known sibling.
    expect(relative).toContain(DEFINING_MODULE)
    expect(relative).toContain('packages/core-backend/src/attendance/w4c0-identity.ts')
    expect(relative.length).toBeGreaterThan(1000)

    const offenders: string[] = []
    let definingModuleMatched = false
    for (let i = 0; i < files.length; i += 1) {
      const rel = relative[i]
      const text = fs.readFileSync(files[i], 'utf8')
      if (!RESERVED.test(text)) continue
      if (rel === DEFINING_MODULE) definingModuleMatched = true
      const allowed = ALLOWED_FILES.has(rel) || ALLOWED_PREFIXES.some((prefix) => rel.startsWith(prefix))
      if (!allowed) offenders.push(rel)
    }
    expect(definingModuleMatched).toBe(true)
    expect(offenders).toEqual([])
  })
})
