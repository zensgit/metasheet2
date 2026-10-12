/**
 * Gate 19 (task feature design lock §12, §6.1): the set of grid cells that actually PASSED in a
 * vitest verbose run must equal the lock's `i-m2` identity list.
 *
 * Usage (run from packages/core-backend):
 *   NO_COLOR=1 CI=true pnpm exec vitest run --config vitest.integration.config.ts \
 *     --reporter=verbose -t 'gate19[|]' tests/integration < /dev/null > /tmp/gate19-verbose.txt
 *   pnpm exec tsx tests/helpers/gate19-identities.ts /tmp/gate19-verbose.txt <path-to-lock.md>
 * Exit 0 when the two sets are equal; exit 1 and print the difference otherwise.
 *
 * M4 (design task-m4-pr3a-backend-design-20260930.md §10.3, ASSUMPTION(task-m4): [own-20]): the
 * same extraction with `--fence=i-m4 --prefix='gate19m4|'`, `-t 'gate19m4[|]'`, and the design
 * document in place of the lock. The defaults (`i-m2`, `gate19|`) keep the M2 command unchanged.
 *
 * Only PASSED lines count: a line must carry the vitest pass mark (✓). Skipped, todo and failed
 * cases never contribute an identity, so a grid of skipped cells cannot satisfy the gate. ANSI
 * colour codes are stripped first, and an identity is only the characters [A-Za-z0-9|+_-].
 */
import { readFileSync } from 'fs'

const ANSI = /\u001b\[[0-9;]*m/g
const DEFAULT_FENCE = 'i-m2'
const DEFAULT_PREFIX = 'gate19|'

function identityPattern(prefix: string): RegExp {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}[A-Za-z0-9|+_-]+`, 'g')
}

export function passedIdentities(verboseOutput: string, opts: { prefix?: string } = {}): string[] {
  const identity = identityPattern(opts.prefix ?? DEFAULT_PREFIX)
  const found = new Set<string>()
  for (const raw of verboseOutput.split('\n')) {
    const line = raw.replace(ANSI, '')
    if (!/^\s*✓/.test(line)) continue
    for (const m of line.match(identity) ?? []) found.add(m)
  }
  return [...found].sort()
}

export function lockIdentities(lockMarkdown: string, opts: { fence?: string; prefix?: string } = {}): string[] {
  const fence = opts.fence ?? DEFAULT_FENCE
  const prefix = opts.prefix ?? DEFAULT_PREFIX
  const lines = lockMarkdown.split('\n')
  const start = lines.findIndex((l) => l.trim() === '```' + fence)
  if (start < 0) throw new Error(`gate19: no \`\`\`${fence} block in the lock`)
  const out: string[] = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i].trim()
    if (l.startsWith('```')) break
    if (l.startsWith(prefix)) out.push(l)
  }
  if (out.length === 0) throw new Error(`gate19: the ${fence} block is empty`)
  return [...new Set(out)].sort()
}

export function diffIdentities(passed: string[], expected: string[]): { missing: string[]; extra: string[] } {
  const p = new Set(passed)
  const e = new Set(expected)
  return {
    missing: expected.filter((x) => !p.has(x)),
    extra: passed.filter((x) => !e.has(x)),
  }
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined =>
    args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  const [verbosePath, lockPath] = args.filter((a) => !a.startsWith('--'))
  if (!verbosePath || !lockPath) {
    console.error('usage: tsx tests/helpers/gate19-identities.ts <verbose.txt> <lock.md> [--fence=i-m2] [--prefix=gate19|]')
    process.exit(2)
  }
  const fence = flag('fence') ?? DEFAULT_FENCE
  const prefix = flag('prefix') ?? DEFAULT_PREFIX
  const d = diffIdentities(
    passedIdentities(readFileSync(verbosePath, 'utf8'), { prefix }),
    lockIdentities(readFileSync(lockPath, 'utf8'), { fence, prefix }),
  )
  if (d.missing.length || d.extra.length) {
    console.error(JSON.stringify(d, null, 2))
    process.exit(1)
  }
  console.log(`gate19: passed identities equal the ${fence} list`)
}
