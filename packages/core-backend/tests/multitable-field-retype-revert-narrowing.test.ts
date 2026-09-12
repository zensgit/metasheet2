/**
 * Pure unit lock for the T9-W Tier 2 (#3298) field-retype-revert predicates — `isFieldRetypeRevert` (structural gate
 * that drives the per-tier flag) and `isSupportedFieldRetypeRevert` (the confirmable/executable scalar-safe subset).
 * DB-free (the real-DB wiring is tests/integration/multitable-field-retype-revert-realdb.test.ts).
 *
 * CI REALITY CHECK (re-corrected 2026-09-11, F8A — the FIRST "correction" in this spot was itself wrong and
 * claimed this file runs nowhere; it does run): this file IS executed by the required `test (18.x/20.x)` check.
 * .github/workflows/plugin-tests.yml:844 runs a BLANKET `pnpm --filter @metasheet/core-backend test` step in
 * job `test:` (:174, matrix [18.x, 20.x]; the workflow's `on.pull_request` has only a branches filter, no
 * paths filter). That script is `vitest` (package.json:26) under vitest.config.ts, which declares NO `include`
 * — so the default glob collects this file, and the only non-integration entry in its `exclude` is
 * 'tests/e2e/**'. What is true is the weaker statement: no workflow names this file INDIVIDUALLY; it is
 * collected by a glob. Verified by running the file under the default config (68 passed).
 * The same load-bearing claims (route refusal before any write, the one new direction, the truth-table mirror)
 * are ALSO duplicated into tests/integration/multitable-context.api.test.ts — a REDUNDANT second copy in the
 * real-DB lane (plugin-tests.yml:1306, same `test` job, 20.x + DATABASE_URL), not the closing of a gap.
 * Both copies read the same fixture, so they cannot disagree about the table.
 *
 * Mirrors the Tier-1 lock from #3297. Tier 2's supported surface is defined by EXCLUSION (everything scalar except
 * FIELD_RETYPE_EXCLUDED_TYPES), so the "silent future widening" risk is REMOVING a type from that exclusion set (or a
 * new side-effect type slipping in unexcluded). The excluded-endpoint cases below pin the exclusion set BEHAVIORALLY:
 * removing any of the 11 locked types flips its `→ not supported` assertion red, forcing a T9-W design-lock update +
 * goldens first. (FIELD_RETYPE_EXCLUDED_TYPES is module-private; if it's later exported, an exact-set `.toEqual`
 * tripwire could replace this loop — kept behavioral to stay tests-only.)
 *
 * N2 (single-transaction atomicity) is intentionally NOT here — it's a heavier real-DB follow-up; the generic
 * transaction/rollback mechanism is already proven by the Tier-1 atomicity golden.
 *
 * F8A (2026-09-11) — this file also owns the FORWARD side of the same boundary now: the lossless retype
 * whitelist that `PATCH /fields/:fieldId` enforces (src/multitable/field-retype-whitelist.ts), its mirror
 * against the shared truth table, and the route wiring (the detailed matrix; a redundant subset is re-pinned in
 * tests/integration/multitable-context.api.test.ts's real-DB lane — see the CI REALITY CHECK above). Same subject (which (source → target) pairs a raw
 * `UPDATE meta_fields` may perform), opposite direction, so the two locks live side by side instead of
 * drifting apart in separate files.
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'node:url'

import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { isFieldRetypeRevert, isSupportedFieldRetypeRevert, type ConfigRevisionRow } from '../src/multitable/config-restore'
import {
  assertLosslessFieldRetype,
  FieldRetypeNotLosslessError,
  FIELD_RETYPE_EXCLUDED_TYPES,
  FIELD_RETYPE_NOT_LOSSLESS_CODE,
  isLosslessFieldRetype,
  LOSSLESS_FIELD_RETYPE,
  losslessRetypeTargets,
} from '../src/multitable/field-retype-whitelist'
import { usePinnedServer } from './utils/pinned-server'

// The 11 side-effect types design-locked as EXCLUDED (forward retype runs handlers — autoNumber sequence, formula/
// lookup/rollup deps, link join-table, attachment blobs, system-managed — that a raw schema UPDATE would skip).
const EXCLUDED_TYPES = [
  'formula', 'lookup', 'rollup', 'link', 'attachment', 'button',
  'autoNumber', 'createdTime', 'modifiedTime', 'createdBy', 'modifiedBy',
] as const

const rev = (over: Partial<ConfigRevisionRow>): ConfigRevisionRow => ({
  id: 'rev1', sheet_id: 's1', entity_type: 'field', entity_id: 'f1', action: 'update',
  before: { type: 'text' }, after: { type: 'number' }, changed_keys: ['type'],
  ...over,
}) as ConfigRevisionRow

describe('field-retype revert predicates — T9-W Tier 2 (#3298)', () => {
  test('supported: a scalar→scalar type-changing retype (type, or type+property)', () => {
    expect(isFieldRetypeRevert(rev({ changed_keys: ['type'] }))).toBe(true)
    expect(isSupportedFieldRetypeRevert(rev({ changed_keys: ['type'] }))).toBe(true)
    expect(isSupportedFieldRetypeRevert(rev({ changed_keys: ['type', 'property'] }))).toBe(true)
    expect(isSupportedFieldRetypeRevert(rev({ changed_keys: ['name', 'order', 'type'] }))).toBe(true)
  })

  test('malformed changed_keys (non-array, forged row) → not a retype, not thrown', () => {
    for (const bad of [undefined, null, 'type'] as const) {
      expect(isFieldRetypeRevert(rev({ changed_keys: bad as unknown as string[] }))).toBe(false)
      expect(isSupportedFieldRetypeRevert(rev({ changed_keys: bad as unknown as string[] }))).toBe(false)
    }
  })

  test('create/delete (action ≠ update) → gated, not supported', () => {
    for (const action of ['create', 'delete'] as const) {
      expect(isFieldRetypeRevert(rev({ action }))).toBe(false)
      expect(isSupportedFieldRetypeRevert(rev({ action }))).toBe(false)
    }
  })

  test('property-only retype → structural gate true, but NOT supported (v1 type-change-only; property-only deferred)', () => {
    const propOnly = rev({ changed_keys: ['property'] })
    expect(isFieldRetypeRevert(propOnly)).toBe(true)        // touches a retype key → drives the flag
    expect(isSupportedFieldRetypeRevert(propOnly)).toBe(false) // no `type` change → deferred, stays gated/422
  })

  test('unknown / mixed-unknown changed_keys → not a retype', () => {
    expect(isFieldRetypeRevert(rev({ changed_keys: ['someUnknownKey'] }))).toBe(false)
    expect(isFieldRetypeRevert(rev({ changed_keys: ['type', 'someUnknownKey'] }))).toBe(false) // every() must hold
  })

  test('non-string type (forged before/after) → not supported, not thrown', () => {
    expect(isSupportedFieldRetypeRevert(rev({ before: { type: 123 }, after: { type: 'number' } }))).toBe(false)
    expect(isSupportedFieldRetypeRevert(rev({ before: { type: 'text' }, after: {} }))).toBe(false)
    expect(isSupportedFieldRetypeRevert(rev({ before: null, after: null }))).toBe(false)
  })

  test('wrong entity_type is never a field retype', () => {
    for (const entity_type of ['sheet_config', 'view', 'permission'] as const) {
      expect(isFieldRetypeRevert(rev({ entity_type }))).toBe(false)
      expect(isSupportedFieldRetypeRevert(rev({ entity_type }))).toBe(false)
    }
  })

  // BEHAVIORAL TRIPWIRE (N1): each excluded type stays UNSUPPORTED as either endpoint. Removing one from
  // FIELD_RETYPE_EXCLUDED_TYPES (silently widening Tier 2 to a side-effect type a raw UPDATE can't safely revert)
  // flips its assertion red → forces a T9-W design-lock update + handler/goldens first.
  test('TRIPWIRE: every excluded (side-effect) type stays gated as either retype endpoint', () => {
    for (const t of EXCLUDED_TYPES) {
      // still a structural retype (drives the flag) ...
      expect(isFieldRetypeRevert(rev({ before: { type: t }, after: { type: 'number' } }))).toBe(true)
      // ... but NOT confirmable/executable from OR to that type
      expect(isSupportedFieldRetypeRevert(rev({ before: { type: t }, after: { type: 'number' } }))).toBe(false)
      expect(isSupportedFieldRetypeRevert(rev({ before: { type: 'text' }, after: { type: t } }))).toBe(false)
    }
  })

  // N3 — native `person` 口径: type='person' (value = userId[]) is NOT in the exclusion list, so a person↔scalar
  // retype IS supported. This is intentional and safe despite person being ARRAY-VALUED (not a traditional scalar):
  // the revert is SCHEMA-ONLY (raw meta_fields UPDATE, never touches meta_records), so stored userId[] values are
  // left raw and the read path tolerates the type mismatch — symmetric with the non-migrating forward retype. The
  // side-effect-bearing legacy person field is persisted as type='link' (refKind:'user'), which IS excluded. So
  // "schema-only safe but array-valued" — locked here so a later reclassification of person is a conscious change.
  test('N3: native person (array-valued, schema-only-safe) is a SUPPORTED retype endpoint', () => {
    expect(isSupportedFieldRetypeRevert(rev({ before: { type: 'person' }, after: { type: 'text' } }))).toBe(true)
    expect(isSupportedFieldRetypeRevert(rev({ before: { type: 'singleLineText' }, after: { type: 'person' } }))).toBe(true)
    // contrast: legacy person = link = excluded → stays gated
    expect(isSupportedFieldRetypeRevert(rev({ before: { type: 'link' }, after: { type: 'person' } }))).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// F8A ①：无损白名单的真值表镜像（服务端侧）
//
// 同一份 JSON 也被 apps/web/tests/multitable-field-manager.spec.ts 回放到
// apps/web/src/multitable/utils/field-retype.ts 上。口径写准（照 #5626）：**只改一侧实现、不动表**
// ⇒ 那一侧自己红；**改表** ⇒ 另一侧也红。两条加起来，单侧漂移无法安静落地。
// 本 describe 只钉"代数"（这一对算不算无损）；在哪儿强制、哪些配对让给既有副作用守卫，见 ②。
// ═══════════════════════════════════════════════════════════════════════════════════════════════
const TRUTH_TABLE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/field-retype-truth-table.json',
)

interface RetypeTruthTable {
  excludedTargetTypes: string[]
  table: Record<string, string[]>
  targetCases: Array<{ name: string; sourceType: string; property?: unknown; expected: string[] }>
  pairCases: Array<{ name: string; sourceType: string; property?: unknown; targetType: string; lossless: boolean }>
}

const retypeTable = JSON.parse(fs.readFileSync(TRUTH_TABLE_PATH, 'utf8')) as RetypeTruthTable

describe('F8A lossless retype whitelist — server side of the shared truth table', () => {
  test('reads a non-trivial table (a silently emptied fixture must not pass as green)', () => {
    expect(retypeTable.targetCases.length).toBeGreaterThanOrEqual(20)
    expect(retypeTable.pairCases.length).toBeGreaterThanOrEqual(20)
    expect(retypeTable.targetCases.some((row) => row.expected.length === 0)).toBe(true)
    expect(retypeTable.pairCases.some((row) => row.lossless === false)).toBe(true)
    expect(retypeTable.pairCases.some((row) => row.lossless === true)).toBe(true)
  })

  test('the implementation table IS the fixture table, row for row', () => {
    expect(LOSSLESS_FIELD_RETYPE).toEqual(retypeTable.table)
    expect(Array.from(FIELD_RETYPE_EXCLUDED_TYPES).sort()).toEqual([...retypeTable.excludedTargetTypes].sort())
  })

  test.each(retypeTable.targetCases.map((row) => [row.name, row] as const))(
    'losslessRetypeTargets: %s',
    (_name, row) => {
      expect(losslessRetypeTargets(row.sourceType, row.property)).toEqual(row.expected)
    },
  )

  test.each(retypeTable.pairCases.map((row) => [row.name, row] as const))(
    'isLosslessFieldRetype: %s',
    (_name, row) => {
      expect(isLosslessFieldRetype(row.sourceType, row.targetType, row.property)).toBe(row.lossless)
    },
  )

  test('null/undefined endpoints are never lossless (fail-closed)', () => {
    expect(isLosslessFieldRetype(null, 'string', undefined)).toBe(false)
    expect(isLosslessFieldRetype('number', null, undefined)).toBe(false)
    expect(isLosslessFieldRetype(undefined, undefined, undefined)).toBe(false)
    expect(losslessRetypeTargets(null, undefined)).toEqual([])
  })

  // B3（裁决 2026-09-12）：`property` 缺省时按"非富文本"处理是 fail-OPEN —— 漏传的调用方会让
  // 富文本长文本 → 文本一路放行。所以两个入口都把 property 改成必传。tsconfig 把 `**/*.test.ts`
  // exclude 掉了（packages/core-backend/tsconfig.json），类型签名管不到测试与 JS 调用方，因此
  // 必传是靠**运行时 arity 检查**兜底的；本用例就是那条检查的锁：把 property 改回可选 ⇒ 这里红。
  test('property 是必传参数：漏传直接抛，绝不退化成"按非富文本放行"', () => {
    const targetsAnyArity = losslessRetypeTargets as unknown as (source: string) => string[]
    const assertAnyArity = assertLosslessFieldRetype as unknown as (current: string, next: string) => void
    const isLosslessAnyArity = isLosslessFieldRetype as unknown as (source: string, target: string) => boolean

    expect(() => targetsAnyArity('longText')).toThrow(/property/)
    // 三个导出都挡，否则换个函数名就能拿回那个静默缺省
    expect(() => isLosslessAnyArity('longText', 'string')).toThrow(/property/)
    // arity 检查排在"同类型直接放行"之前，所以任何分支都换不到静默通过
    expect(() => assertAnyArity('longText', 'string')).toThrow(/property/)
    expect(() => assertAnyArity('date', 'date')).toThrow(/property/)
    // 传了就正常工作（值可以是 undefined —— 那是"这个字段库里没有 property"，不是"我没传"）
    expect(losslessRetypeTargets('longText', undefined)).toEqual(['string'])
    expect(losslessRetypeTargets('longText', { rich: true })).toEqual([])
  })

  test('assertLosslessFieldRetype: the three pass-through cases and the refusal', () => {
    // 1) 同类型 → 同类型不是改类型
    expect(() => assertLosslessFieldRetype('date', 'date', undefined)).not.toThrow()
    // 2) 任一端是副作用类型 ⇒ 白名单不表态（**不等于"有人接手"**：只有 link/formula/lookup/rollup
    //    作目标时真有既有校验；attachment 与 4 个系统戳作目标零守卫；autoNumber 作目标是主 UPDATE
    //    之后的整列覆写。见 ② 与 tests/integration/multitable-context.api.test.ts 的 KNOWN SEAM 用例）
    for (const excluded of FIELD_RETYPE_EXCLUDED_TYPES) {
      expect(() => assertLosslessFieldRetype('string', excluded, undefined)).not.toThrow()
      expect(() => assertLosslessFieldRetype(excluded, 'string', undefined)).not.toThrow()
    }
    // 3) 白名单内放行；白名单外抛（message 中文、不含 fieldId）
    expect(() => assertLosslessFieldRetype('longText', 'string', {})).not.toThrow()
    expect(() => assertLosslessFieldRetype('string', 'number', undefined)).toThrow(FieldRetypeNotLosslessError)
    expect(() => assertLosslessFieldRetype('longText', 'string', { rich: true })).toThrow(FieldRetypeNotLosslessError)
    try {
      assertLosslessFieldRetype('string', 'number', undefined)
      throw new Error('unreachable: the whitelist must have refused')
    } catch (err) {
      expect(err).toBeInstanceOf(FieldRetypeNotLosslessError)
      expect(String((err as Error).message)).not.toMatch(/fld[_-]/)
      expect(String((err as Error).message)).toContain('不可读')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// F8A ②：白名单在写口 PATCH /fields/:fieldId 上的强制（裁决 b：边界放后端，不是前端装饰）
// 假 pool + pinned server，DB-free。每个用例都顺带断言"库里那一行有没有真的被改"。
// ═══════════════════════════════════════════════════════════════════════════════════════════════
const RT_SHEET = 'sheet_retype_1'

type RtRow = { id: string; sheet_id: string; name: string; type: string; property: Record<string, unknown>; order: number }
type RtResult = { rows: any[]; rowCount?: number }

function createRetypeStore(fields: RtRow[]) {
  const byId = new Map(fields.map((f) => [f.id, { ...f, property: { ...f.property } }]))
  /** 记录所有改到**记录数据**的写 —— 本刀声称"不碰 meta_records"，那就要能看得见，不是嘴上说。 */
  const recordWrites: Array<{ sql: string; params: unknown[] }> = []
  const handler = (sql: string, params?: unknown[]): RtResult => {
    if (/UPDATE\s+meta_records/i.test(sql)) recordWrites.push({ sql, params: params ?? [] })
    if (sql.includes('FROM meta_sheets WHERE id = $1')) {
      return { rows: [{ id: String(params?.[0] ?? RT_SHEET), base_id: 'base_retype', name: 'Sheet', description: null, deleted_at: null }] }
    }
    if (sql.includes('SELECT id, sheet_id FROM meta_fields WHERE id = $1')) {
      const f = byId.get(String(params?.[0]))
      return { rows: f ? [{ id: f.id, sheet_id: f.sheet_id }] : [] }
    }
    if (sql.includes('SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
      const f = byId.get(String(params?.[0]))
      return { rows: f ? [{ ...f }] : [] }
    }
    // 真实语句是多行的 `UPDATE meta_fields SET name = $2, ...` —— 用列名片段匹配，避开 order 位移那几条
    if (sql.includes('UPDATE meta_fields') && sql.includes('SET name = $2, type = $3')) {
      const [, name, type, propertyJson, order] = params as [string, string, string, string, number]
      const existing = byId.get(String(params?.[0]))
      if (!existing) return { rows: [] }
      existing.name = name
      existing.type = type
      existing.property = JSON.parse(propertyJson)
      existing.order = order
      return { rows: [{ id: existing.id, name, type, property: existing.property, order }] }
    }
    if (sql.includes('FROM meta_fields WHERE sheet_id = $1')) {
      return { rows: Array.from(byId.values()).map((f) => ({ id: f.id, name: f.name, type: f.type, property: f.property, order: f.order })) }
    }
    return { rows: [], rowCount: 0 }
  }
  return { byId, recordWrites, handler }
}

async function createRetypeApp(handler: (sql: string, params?: unknown[]) => RtResult) {
  vi.resetModules()
  vi.doMock('../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue(['multitable:read', 'multitable:write', 'multitable:manage-schema']),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  const { poolManager } = await import('../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../src/routes/univer-meta')
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (
      sql.includes('FROM spreadsheet_permissions')
      || sql.includes('FROM field_permissions')
      || sql.includes('FROM view_permissions')
      || sql.includes('FROM meta_view_permissions')
      || sql.includes('FROM record_permissions')
      || sql.includes('FROM formula_dependencies')
    ) {
      return { rows: [], rowCount: 0 }
    }
    return handler(sql, params)
  })
  const mockPool = { query, transaction: vi.fn(async (fn: (c: { query: typeof query }) => Promise<unknown>) => fn({ query })) }
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: 'user_retype', roles: [], perms: ['multitable:read', 'multitable:write', 'multitable:manage-schema'] } as any
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return app
}

const retypePinned = usePinnedServer()

describe('PATCH /fields/:fieldId — the lossless whitelist is enforced server-side (F8A)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  const field = (over: Partial<RtRow>): RtRow => ({
    id: 'fld_retype_1', sheet_id: RT_SHEET, name: 'F', type: 'string', property: {}, order: 0, ...over,
  })

  const patch = async (store: ReturnType<typeof createRetypeStore>, body: Record<string, unknown>) => {
    retypePinned.setApp(await createRetypeApp(store.handler))
    return request(retypePinned.url()).patch('/api/multitable/fields/fld_retype_1').send(body)
  }

  test('文本 → 数字（白名单外，最典型的有损方向）⇒ 400 稳定码，库里那行没动', async () => {
    const store = createRetypeStore([field({ type: 'string' })])
    const res = await patch(store, { type: 'number' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(FIELD_RETYPE_NOT_LOSSLESS_CODE)
    // values-free：文案里不许出现字段 id / 表 id
    expect(String(res.body.error.message)).not.toMatch(/fld[_-]/)
    expect(String(res.body.error.message)).not.toContain(RT_SHEET)
    expect(store.byId.get('fld_retype_1')?.type).toBe('string')
  })

  test('富文本长文本 → 文本 ⇒ 400（HTML 会以裸文本暴露），判的是库里的 property 不是请求体', async () => {
    const store = createRetypeStore([field({ type: 'longText', property: { rich: true } })])
    // 请求体里把 rich 关掉也没用：守卫看的是 currentProperty
    const res = await patch(store, { type: 'string', property: { rich: false } })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(FIELD_RETYPE_NOT_LOSSLESS_CODE)
    expect(store.byId.get('fld_retype_1')?.type).toBe('longText')
  })

  test('非富文本长文本 → 文本 ⇒ 200（正控：这一刀新增的唯一方向，真的落库了）', async () => {
    const store = createRetypeStore([field({ type: 'longText', property: {} })])
    const res = await patch(store, { type: 'string' })

    expect(res.status).toBe(200)
    expect(res.body.data.field.type).toBe('string')
    expect(store.byId.get('fld_retype_1')?.type).toBe('string')
  })

  test('数字 → 文本 ⇒ 200（既有白名单方向不受影响）', async () => {
    const store = createRetypeStore([field({ type: 'number' })])
    const res = await patch(store, { type: 'string' })

    expect(res.status).toBe(200)
    expect(store.byId.get('fld_retype_1')?.type).toBe('string')
  })

  test('同类型 → 同类型不算改类型：带 type 的纯改名照旧 200', async () => {
    const store = createRetypeStore([field({ type: 'date', name: 'D' })])
    const res = await patch(store, { type: 'date', name: '交付日期' })

    expect(res.status).toBe(200)
    expect(store.byId.get('fld_retype_1')?.name).toBe('交付日期')
    expect(store.byId.get('fld_retype_1')?.type).toBe('date')
  })

  test('不带 type 的 PATCH（纯改名 / 纯调序 / 纯改 property）永远不过这道门', async () => {
    const store = createRetypeStore([field({ type: 'date', name: 'D' })])
    const res = await patch(store, { name: '交付日期' })

    expect(res.status).toBe(200)
    expect(store.byId.get('fld_retype_1')?.type).toBe('date')
  })

  test('副作用类型的既有路径不变 ①：公式 → 文本 仍然 200（白名单对这一对不表态）', async () => {
    const store = createRetypeStore([field({ type: 'formula', property: { expression: '=1' } })])
    const res = await patch(store, { type: 'string' })

    expect(res.status).toBe(200)
    expect(store.byId.get('fld_retype_1')?.type).toBe('string')
  })

  // KNOWN SEAM (characterization) —— 富文本长文本的**两步**绕过，B3（裁决 2026-09-12）。
  // 单次请求买不到通行证（上面那条用例），但两次可以，而且两步都是既有行为，本刀一个门都没加：
  //   第一步 PATCH {property:{}}：`assertRichLongTextToggleAllowed` 只判 OFF→ON（field-codecs.ts:812-823），
  //     关掉 rich 不在它的判据里；`sanitizeFieldPropertyByType` 没有 longText 分支，property 原样落成 {}；
  //     这一步只改 schema，单元格里的 HTML 一个字节没动。
  //   第二步 PATCH {type:'string'}：白名单读的是**库里**的 property，此时已是 {} ⇒ 非富文本 ⇒ 放行 200。
  // 结果：HTML 以裸文本呈现给用户。本用例只钉现状（两步都 200 + 记录数据零改写），让这条路径可见；
  // 要不要给 rich ON→OFF 加「已有数据则拒」的门是 owner 决策（PR 正文 owner 待办），不在本刀。
  test('KNOWN SEAM（两步绕过，characterization）：先关 rich 再改类型 ⇒ 两步都 200，本刀不加门', async () => {
    const store = createRetypeStore([field({ type: 'longText', property: { rich: true } })])

    // 第一步：只改 property，把 rich 关掉
    const step1 = await patch(store, { property: {} })
    expect(step1.status).toBe(200)
    expect(store.byId.get('fld_retype_1')?.type).toBe('longText')
    expect(store.byId.get('fld_retype_1')?.property).toEqual({})

    // 第二步：同一个字段现在在库里已经是非富文本，白名单据此放行
    const step2 = await patch(store, { type: 'string' })
    expect(step2.status).toBe(200)
    expect(store.byId.get('fld_retype_1')?.type).toBe('string')

    // 两步都没有改写任何记录数据 —— 原来的 HTML 就原样留在单元格里
    expect(store.recordWrites).toEqual([])
  })

  test('副作用类型的既有路径不变 ②：文本 → 关联(缺目标表) 仍然给更具体的那个稳定码', async () => {
    const store = createRetypeStore([field({ type: 'string' })])
    const res = await patch(store, { type: 'link' })

    expect(res.status).toBe(400)
    // 既有守卫的理由更具体，优先级保持不变 —— 本门只在没人反对时兜底
    expect(res.body.error.code).toBe('LINK_FIELD_FOREIGN_SHEET_REQUIRED')
    expect(store.byId.get('fld_retype_1')?.type).toBe('string')
  })
})
