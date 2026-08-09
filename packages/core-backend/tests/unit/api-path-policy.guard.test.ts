/**
 * Guard: the shared API path policy must stay the ONLY place that decides what an API path is.
 *
 * The policy in `src/auth/api-path-policy.ts` is only a single source of truth for as long as call
 * sites import it instead of writing the test out again locally. A second copy is not a style problem:
 * two copies can answer the same question differently, and everything the consolidation bought is lost
 * the moment they do. This test scans `src/` for local re-implementations and fails on any that is not
 * declared below.
 *
 * If this test fails on code you just wrote: import from `auth/api-path-policy` instead of comparing
 * path literals. If your case genuinely is not a request-path policy test, add it to `EXEMPTIONS` with
 * a reason — deliberately, not reflexively.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, it, expect } from 'vitest'

const SRC_ROOT = join(__dirname, '..', '..', 'src')

/** The path-test forms a call site could use to re-implement the policy locally. */
const PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'startsWith with an /api literal', re: /\.startsWith\(\s*['"`]\/api/g },
  { name: 'endsWith with an /api literal', re: /\.endsWith\(\s*['"`]\/api/g },
  { name: 'includes with an /api literal', re: /\.includes\(\s*['"`]\/api/g },
  { name: 'equality against an /api literal', re: /[!=]==\s*['"`]\/api/g },
  { name: 'regexp anchored on /api', re: /\/\^\\\/api/g },
]

/**
 * Files allowed to carry their own `/api` path test, with the exact matched text that is allowed and
 * why. Pinning the TEXT (not just a count) means a different violation added to an exempted file still
 * fails, even if the number of matches happens to stay the same.
 */
const EXEMPTIONS: readonly { file: string; reason: string; allowed: readonly string[] }[] = [
  {
    file: 'auth/api-path-policy.ts',
    reason: 'The policy itself — this is the one definition every other call site imports.',
    allowed: ['/^\\/api'],
  },
  {
    file: 'multitable/oapi-read-allowlist.ts',
    reason:
      'Route-specific, fully anchored (^…$) method-bound allowlist for `mst_` API tokens. Each entry ' +
      'names one route that mounts its own apiTokenAuth + requireScope, and a miss falls through to the ' +
      'session gate (fail-closed). It answers "is this THAT route", not "is this an API path".',
    allowed: ['/^\\/api'],
  },
  {
    file: 'auth/jwt-middleware.ts',
    reason:
      'PUBLIC_FORM_SUBMIT_PATH — a fully anchored (^…$) single-route pattern for the public-form token ' +
      'bypass, which is request-shaped (token in query/body) rather than a path-prefix policy.',
    allowed: ['/^\\/api'],
  },
  {
    file: 'core/PluginManifestValidator.ts',
    reason:
      'Validates PLUGIN MANIFEST declarations at install time (rejecting plugins that claim core/system/' +
      'admin namespaces). It inspects a declared manifest string, not an inbound request path.',
    allowed: ['/^\\/api'],
  },
]

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue
      listTsFiles(full, out)
      continue
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full)
  }
  return out
}

type Finding = { file: string; pattern: string; text: string; line: number }

function scan(source: string, file: string): Finding[] {
  const findings: Finding[] = []
  for (const { name, re } of PATTERNS) {
    // Fresh lastIndex per file: a /g regexp reused across files silently skips matches otherwise.
    const rx = new RegExp(re.source, 'g')
    let m: RegExpExecArray | null
    while ((m = rx.exec(source)) !== null) {
      findings.push({
        file,
        pattern: name,
        text: m[0],
        line: source.slice(0, m.index).split('\n').length,
      })
    }
  }
  return findings
}

describe('API path policy — no call site may re-implement the path test locally', () => {
  const files = listTsFiles(SRC_ROOT)
  const findings = files.flatMap((f) => scan(readFileSync(f, 'utf8'), relative(SRC_ROOT, f).split(sep).join('/')))

  it('finds source files to scan and patterns that actually match something', () => {
    // Negative control for the scan window: an empty read would otherwise report a clean tree.
    expect(files.length).toBeGreaterThan(100)
    expect(findings.length, 'the scanner matched nothing at all — its patterns are not firing').toBeGreaterThan(0)
  })

  it('detects a local re-implementation when one is present (the scanner discriminates)', () => {
    // Positive control: prove each pattern fires on a synthetic violation, so a green sweep below means
    // "no violations found", not "the scanner cannot find violations".
    const synthetic = [
      "if (req.path.startsWith('/api/')) return true",
      "if (p.endsWith('/api/x')) return true",
      "if (p.includes('/api/x')) return true",
      "if (p === '/api/thing') return true",
      'const RE = /^\\/api\\/thing/',
    ].join('\n')
    const detected = scan(synthetic, 'synthetic.ts')
    expect(detected.map((d) => d.pattern).sort()).toEqual(PATTERNS.map((p) => p.name).sort())
  })

  it('every exemption names a real file that still carries the text it exempts', () => {
    // Stops the exemption list from rotting into permission for things that no longer exist — a stale
    // entry would silently widen what the guard tolerates.
    for (const ex of EXEMPTIONS) {
      const forFile = findings.filter((f) => f.file === ex.file)
      expect(forFile.length, `exemption for ${ex.file} matches nothing; remove it`).toBeGreaterThan(0)
      expect(ex.reason.trim().length).toBeGreaterThan(0)
      for (const allowed of ex.allowed) {
        expect(
          forFile.some((f) => f.text.includes(allowed) || allowed.includes(f.text)),
          `exemption for ${ex.file} allows ${JSON.stringify(allowed)}, which no longer appears there`,
        ).toBe(true)
      }
    }
  })

  it('no undeclared call site re-implements the API path test', () => {
    const undeclared = findings.filter((f) => {
      const ex = EXEMPTIONS.find((e) => e.file === f.file)
      if (!ex) return true
      return !ex.allowed.some((a) => f.text.includes(a) || a.includes(f.text))
    })

    expect(
      undeclared.map((f) => `${f.file}:${f.line} — ${f.pattern} (${f.text})`),
      'These compare request paths against /api literals instead of using the shared policy in ' +
        'auth/api-path-policy.ts. Import isApiPath / apiPathEquals / apiPathHasPrefix, or declare an ' +
        'exemption with a reason if the case genuinely is not a request-path policy test.',
    ).toEqual([])
  })
})
