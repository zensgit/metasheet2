/**
 * Structural guard for subscription webhook delivery (whole `src`).
 *
 * U6 — the delivery tables are touched only by the webhook service (plus the DB type map and migrations);
 *      the webhook request is sent in exactly one place, inside `executeDelivery`, after the delivery check;
 *      a delivery row is written only after the delivery check allowed it; the rules module only uses the
 *      strict (error-propagating) row-deny reads.
 * U11 — no production `new WebhookService(...)` passes anything beyond `(db, fetchFn)`.
 *
 * Each scan is also run against planted violations (G6 / G11) so the scan itself cannot pass vacuously.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = join(__dirname, '../../src')

function listSourceFiles(includeMigrations: boolean): string[] {
  const out: string[] = []
  const walk = (absDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const abs = join(absDir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue
        if (!includeMigrations && entry.name === 'migrations') continue
        walk(abs)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) continue
      out.push(relative(SRC, abs).split(sep).join('/'))
    }
  }
  walk(SRC)
  return out.sort()
}

function readSources(files: string[]): Record<string, string> {
  return Object.fromEntries(files.map((f) => [f, readFileSync(join(SRC, f), 'utf8')]))
}

const SERVICE = 'multitable/webhook-service.ts'
const RULES = 'multitable/webhook-delivery-authority.ts'
const TABLE_FILES_ALLOWED = new Set([SERVICE, RULES, 'db/types.ts'])

/** Body of the `async name(...) {` definition (balanced braces from its opening `{`). */
function bodyOf(src: string, name: string): string | null {
  const re = new RegExp(`async\\s+${name}\\s*\\([^{]*\\{`)
  const m = re.exec(src)
  if (!m) return null
  let depth = 0
  for (let i = m.index + m[0].length - 1; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(m.index, i + 1)
    }
  }
  return null
}

const count = (s: string, needle: string) => s.split(needle).length - 1

export function scanWebhookDeliveryStructure(sources: Record<string, string>): string[] {
  const violations: string[] = []
  for (const [file, src] of Object.entries(sources)) {
    if (file.startsWith('db/migrations/')) continue
    if (TABLE_FILES_ALLOWED.has(file)) continue
    if (/multitable_webhook(s|_deliveries)\b/.test(src)) violations.push(`table-name:${file}`)
  }
  const service = sources[SERVICE] ?? ''
  if (count(service, 'this.fetchFn(') !== 1) violations.push('fetch-count')
  const execute = bodyOf(service, 'executeDelivery') ?? ''
  const fetchAt = execute.indexOf('this.fetchFn(')
  const checkAt = execute.indexOf('authorizeWebhookDelivery(')
  if (fetchAt < 0 || checkAt < 0 || checkAt > fetchAt) violations.push('fetch-before-check')
  // createDeliveryRecord calls (not the definition) must sit in deliverEvent after the check + its refusal exit.
  const createCalls = count(service, 'this.createDeliveryRecord(')
  const deliver = bodyOf(service, 'deliverEvent') ?? ''
  const deliverCheckAt = deliver.indexOf('authorizeWebhookDelivery(')
  const refusalExitAt = deliver.indexOf('decision.deliver === false')
  const createAt = deliver.indexOf('this.createDeliveryRecord(')
  if (
    createCalls !== 1
    || deliverCheckAt < 0
    || refusalExitAt < deliverCheckAt
    || createAt < refusalExitAt
  ) {
    violations.push('row-before-check')
  }
  const rules = sources[RULES] ?? ''
  if (/\bloadRowLevelReadDenyEnabled\(/.test(rules)) violations.push('non-strict-flag-read')
  if (/\bisRecordReadDeniedForUser\(/.test(rules)) violations.push('non-strict-deny-read')
  return violations
}

/** `new WebhookService(...)` call sites passing more than (db, fetchFn). */
export function scanWebhookServiceConstruction(sources: Record<string, string>): string[] {
  const violations: string[] = []
  for (const [file, src] of Object.entries(sources)) {
    let from = 0
    for (;;) {
      const at = src.indexOf('new WebhookService(', from)
      if (at < 0) break
      from = at + 'new WebhookService('.length
      let depth = 1
      let args = 0
      let sawArg = false
      for (let i = from; i < src.length && depth > 0; i += 1) {
        const ch = src[i]
        if (ch === '(' || ch === '{' || ch === '[') depth += 1
        else if (ch === ')' || ch === '}' || ch === ']') depth -= 1
        else if (ch === ',' && depth === 1) args += 1
        if (depth >= 1 && !/\s/.test(ch) && ch !== ',') sawArg = true
      }
      const argc = sawArg ? args + 1 : 0
      if (argc > 2) violations.push(`extra-constructor-arg:${file}`)
    }
    if (/from ['"][^'"]*(\/tests\/|__mocks__)[^'"]*['"]/.test(src)) violations.push(`imports-test-module:${file}`)
  }
  return violations
}

const RUNTIME = readSources(listSourceFiles(true))

describe('U6 subscription webhook delivery structure', () => {
  test('the real source tree has no violations', () => {
    expect(scanWebhookDeliveryStructure(RUNTIME)).toEqual([])
  })

  test('G6: each planted violation is reported, and a strict-only rules module is not', () => {
    const plant = (patch: Record<string, string>) => scanWebhookDeliveryStructure({ ...RUNTIME, ...patch })
    expect(plant({ 'multitable/new-reader.ts': "db.selectFrom('multitable_webhook_deliveries')" })).toContain(
      'table-name:multitable/new-reader.ts',
    )
    expect(plant({ [SERVICE]: `${RUNTIME[SERVICE]}\nasync function extra() { await this.fetchFn('x') }` })).toContain(
      'fetch-count',
    )
    const service = RUNTIME[SERVICE]
    const createLine = service.slice(service.indexOf('const delivery = await this.createDeliveryRecord('))
    const movedCreate = service.replace(
      'const decision = await authorizeWebhookDelivery(this.db, wh, event, payload)',
      'await this.createDeliveryRecord(wh.id, event, payload, eventId)\n      const decision = await authorizeWebhookDelivery(this.db, wh, event, payload)',
    )
    expect(createLine.length).toBeGreaterThan(0)
    expect(movedCreate).not.toBe(service)
    expect(plant({ [SERVICE]: movedCreate })).toContain('row-before-check')
    expect(plant({ [RULES]: `${RUNTIME[RULES]}\nawait loadRowLevelReadDenyEnabled(query, sheetId)` })).toContain(
      'non-strict-flag-read',
    )
    expect(plant({ [RULES]: `${RUNTIME[RULES]}\nawait isRecordReadDeniedForUser(query, a, b, c)` })).toContain(
      'non-strict-deny-read',
    )
    expect(
      plant({
        [RULES]: `${RUNTIME[RULES]}\nawait loadRowLevelReadDenyEnabledStrict(query, s)\nawait isRecordReadDeniedForUserStrict(query, a, b, c)`,
      }),
    ).toEqual([])
  })
})

describe('U11 WebhookService construction', () => {
  test('no production construction passes more than (db, fetchFn)', () => {
    expect(scanWebhookServiceConstruction(RUNTIME)).toEqual([])
  })

  test('G11: a planted extra constructor argument is reported', () => {
    expect(
      scanWebhookServiceConstruction({ 'x.ts': 'const s = new WebhookService(db, fetchFn, { decide: () => true })' }),
    ).toEqual(['extra-constructor-arg:x.ts'])
    expect(scanWebhookServiceConstruction({ 'y.ts': 'const s = new WebhookService(db)' })).toEqual([])
  })
})
