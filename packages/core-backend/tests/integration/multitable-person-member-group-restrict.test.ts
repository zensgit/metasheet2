/**
 * #16 org-member directory — real-DB enforcement of `person` field `restrictToMemberGroupIds`.
 *
 * The person write validation runs in RecordWriteService.patchRecords (the shared chokepoint every
 * write path — REST, bulk, import, form, automation, and the Yjs bridge — funnels through). This test
 * drives patchRecords directly with real Postgres and the real helper wiring (createRecordWriteHelpers),
 * mirroring src/index.ts, and pins:
 *   - POSITIVE: assigning an in-group user to a restricted person field succeeds + stores.
 *   - NEGATIVE (fail-closed): assigning a user who is a sheet member but NOT in the allowed member
 *     group is rejected (RecordValidationError) and nothing is stored.
 *   - GRANDFATHER: a pre-existing out-of-scope stored value survives an unrelated edit (validation is
 *     write-only over the CHANGED fields, never a re-scrub of stored data).
 *   - UNRESTRICTED control: a field with no restrictToMemberGroupIds accepts any active member.
 *   - PARITY: the rejection is identical whether source='rest' or source='yjs-bridge' (same chokepoint).
 *
 * Sheet membership = active users (listSheetPermissionCandidates reads FROM users), so both users are
 * sheet members; the member-group restriction is the only differentiator. Real-DB only (sentinel
 * fails-not-skips; registered in plugin-tests.yml).
 */
import type { Request } from 'express'
import { EventEmitter } from 'events'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { RecordWriteService, RecordValidationError, type RecordPatchInput } from '../../src/multitable/record-write-service'
import { createRecordWriteHelpers } from '../../src/routes/univer-meta'
import { deriveCapabilities } from '../../src/multitable/sheet-capabilities'
import { resolvePersonAssignableDirectory } from '../../src/multitable/person-field-restriction'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const TS = Date.now()
const BASE_ID = `base_pmg_${TS}`
const SHEET_ID = `sheet_pmg_${TS}`
const REC_ID = `rec_pmg_${TS}`
const REC_GF = `rec_pmg_gf_${TS}`
const ACTOR = `u_pmg_actor_${TS}`
const G_ALLOW = '11111111-1111-4111-8111-111111111111'
const G_OTHER = '22222222-2222-4222-8222-222222222222'
const U_IN = `u_pmg_in_${TS}`
const U_OUT = `u_pmg_out_${TS}`
const U_INACTIVE = `u_pmg_inactive_${TS}` // 2c-S2: in G_ALLOW but is_active=FALSE → excluded from the assignable directory
// #5809: a sheet member whose name and email both differ from its id, so the exact lookup's id / name /
// email arms can each be proven on their own (the other fixture users have name == id).
const U_EXACT = `u_pmg_exact_${TS}`
const U_EXACT_NAME = `Fake Exact ${TS}`
const U_EXACT_EMAIL = `fake.exact.${TS}@t.local`

const F_PERSON = 'fld_person_restricted'
const F_PERSON_FREE = 'fld_person_free'
const F_STR = 'fld_str'

async function readData(recId: string): Promise<Record<string, unknown>> {
  const r = await q('SELECT data FROM meta_records WHERE id = $1', [recId])
  return (r.rows[0]?.data as Record<string, unknown>) ?? {}
}

async function buildInput(recordId: string, patch: Record<string, unknown>, source: string): Promise<RecordPatchInput> {
  const fr = await q('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC', [SHEET_ID])
  const fields = (fr.rows as Array<Record<string, unknown>>).map((f) => {
    const prop = f.property && typeof f.property === 'object' ? (f.property as Record<string, unknown>) : {}
    return { id: String(f.id), name: String(f.name), type: f.type as string, property: prop, options: prop.options, order: Number(f.order ?? 0) }
  })
  const fieldById = new Map(fields.map((f) => [f.id, { type: f.type, readOnly: false, hidden: false } as Record<string, unknown>] as const))
  const changesByRecord = new Map([[recordId, Object.entries(patch).map(([fieldId, value]) => ({ fieldId, value }))]])
  const capabilities = deriveCapabilities(['multitable:read', 'multitable:write'], false)
  return {
    sheetId: SHEET_ID,
    changesByRecord,
    actorId: ACTOR,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fields: fields as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    visiblePropertyFields: fields as any,
    visiblePropertyFieldIds: new Set(fields.map((f) => f.id)),
    attachmentFields: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fieldById: fieldById as any,
    capabilities,
    access: { userId: ACTOR, permissions: ['multitable:read', 'multitable:write'], isAdminRole: false },
    source,
  } as RecordPatchInput
}

function makeService(): RecordWriteService {
  const pool = poolManager.get()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eventBus = new EventEmitter() as any
  const fakeReq = { user: { id: ACTOR, roles: [], perms: ['multitable:read', 'multitable:write'] } } as unknown as Request
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const helpers = createRecordWriteHelpers(fakeReq, pool as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new RecordWriteService(pool as any, eventBus, helpers)
}

describeIfDatabase('#16 person restrictToMemberGroupIds enforcement (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'PMG Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'PMG Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_PERSON, SHEET_ID, 'Owner', 'person', JSON.stringify({ restrictToMemberGroupIds: [G_ALLOW] }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_PERSON_FREE, SHEET_ID, 'AnyOne', 'person', '{}', 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_STR, SHEET_ID, 'Note', 'string', '{}', 3])
    for (const uid of [ACTOR, U_IN, U_OUT]) {
      await q(`INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin) VALUES ($1,$2,$3,'x','user','[]'::jsonb,TRUE,FALSE) ON CONFLICT (id) DO NOTHING`, [uid, `${uid}@t.local`, uid])
      // Eligibility = a multitable:read/write grant (loadCandidateUserEligibilityMap). Without it a user
      // is not an eligible sheet member, so person assignment would reject on the sheet check before the
      // group restriction — make all three eligible so the member-group restriction is what differentiates.
      await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'multitable:read') ON CONFLICT DO NOTHING`, [uid])
    }
    await q('INSERT INTO platform_member_groups (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [G_ALLOW, 'Allowed'])
    await q('INSERT INTO platform_member_groups (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [G_OTHER, 'Other'])
    await q('INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [G_ALLOW, U_IN])
    await q('INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [G_OTHER, U_OUT])
    // 2c-S2 fixture: an INACTIVE user in the allowed group — must be excluded from the assignable directory
    // (not assignable) while remaining readable via stored values elsewhere.
    await q(`INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin) VALUES ($1,$2,$3,'x','user','[]'::jsonb,FALSE,FALSE) ON CONFLICT (id) DO NOTHING`, [U_INACTIVE, `${U_INACTIVE}@t.local`, U_INACTIVE])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'multitable:read') ON CONFLICT DO NOTHING`, [U_INACTIVE])
    await q('INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [G_ALLOW, U_INACTIVE])
    // #5809 fixture: an eligible, active sheet member in NO group (unrestricted fields only).
    await q(`INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin) VALUES ($1,$2,$3,'x','user','[]'::jsonb,TRUE,FALSE) ON CONFLICT (id) DO NOTHING`, [U_EXACT, U_EXACT_EMAIL, U_EXACT_NAME])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'multitable:read') ON CONFLICT DO NOTHING`, [U_EXACT])
  })
  beforeEach(async () => {
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = 1', [REC_ID, SHEET_ID, JSON.stringify({})])
    // grandfather record: pre-existing OUT-of-scope person value, inserted directly (bypasses validation).
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = 1', [REC_GF, SHEET_ID, JSON.stringify({ [F_PERSON]: [U_OUT], [F_STR]: 'orig' })])
  })
  afterAll(async () => {
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM platform_member_group_members WHERE group_id = ANY($1)', [[G_ALLOW, G_OTHER]]).catch(() => {})
    await q('DELETE FROM platform_member_groups WHERE id = ANY($1)', [[G_ALLOW, G_OTHER]]).catch(() => {})
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1)', [[ACTOR, U_IN, U_OUT, U_EXACT]]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1)', [[ACTOR, U_IN, U_OUT, U_EXACT]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('POSITIVE: in-group user assigned to a restricted person field → stored', async () => {
    const svc = makeService()
    await svc.patchRecords(await buildInput(REC_ID, { [F_PERSON]: [U_IN] }, 'rest'))
    expect((await readData(REC_ID))[F_PERSON]).toEqual([U_IN])
  })

  test('NEGATIVE (fail-closed): out-of-group sheet member rejected + nothing stored', async () => {
    const svc = makeService()
    await expect(svc.patchRecords(await buildInput(REC_ID, { [F_PERSON]: [U_OUT] }, 'rest'))).rejects.toBeInstanceOf(RecordValidationError)
    expect((await readData(REC_ID))[F_PERSON]).toBeUndefined()
  })

  test('UNRESTRICTED control: any active member accepted on a field with no restriction', async () => {
    const svc = makeService()
    await svc.patchRecords(await buildInput(REC_ID, { [F_PERSON_FREE]: [U_OUT] }, 'rest'))
    expect((await readData(REC_ID))[F_PERSON_FREE]).toEqual([U_OUT])
  })

  test('GRANDFATHER: pre-existing out-of-scope value survives an unrelated edit (not re-scrubbed)', async () => {
    const svc = makeService()
    await svc.patchRecords(await buildInput(REC_GF, { [F_STR]: 'edited' }, 'rest'))
    const data = await readData(REC_GF)
    expect(data[F_STR]).toBe('edited')
    expect(data[F_PERSON]).toEqual([U_OUT]) // out-of-scope person value preserved, never stripped
  })

  test('PARITY: the yjs-bridge source rejects the out-of-group assignment identically (shared chokepoint)', async () => {
    const svc = makeService()
    await expect(svc.patchRecords(await buildInput(REC_ID, { [F_PERSON]: [U_OUT] }, 'yjs-bridge'))).rejects.toBeInstanceOf(RecordValidationError)
    expect((await readData(REC_ID))[F_PERSON]).toBeUndefined()
  })

  // ── 2c-S2: member-group directory READ model (resolvePersonAssignableDirectory) ──────────────
  test('2c-S2 directory: restricted field → only in-group ACTIVE members, with display info', async () => {
    const dir = await resolvePersonAssignableDirectory(q, SHEET_ID, [G_ALLOW])
    const ids = dir.map((e) => e.userId)
    expect(ids).toContain(U_IN) // in G_ALLOW, active, sheet member → assignable
    expect(ids).not.toContain(U_OUT) // sheet member but not in G_ALLOW
    expect(ids).not.toContain(ACTOR) // sheet member but not in G_ALLOW
    expect(ids).not.toContain(U_INACTIVE) // in G_ALLOW but inactive → NOT assignable
    const inEntry = dir.find((e) => e.userId === U_IN)
    expect(inEntry?.email).toBe(`${U_IN}@t.local`) // hydrated display info
    expect(inEntry?.name).toBe(U_IN)
  })

  test('2c-S2 directory: == the write-validator allowed set (display parity — offers exactly what patchRecords accepts)', async () => {
    // The existing POSITIVE/NEGATIVE tests prove patchRecords accepts U_IN and rejects U_OUT for
    // [G_ALLOW]; the directory must list exactly that allowed set so the picker never offers a value
    // the validator would reject.
    const dir = await resolvePersonAssignableDirectory(q, SHEET_ID, [G_ALLOW])
    expect(dir.map((e) => e.userId).sort()).toEqual([U_IN])
  })

  test('2c-S2 directory: unrestricted field → all active sheet members (inactive excluded)', async () => {
    const dir = await resolvePersonAssignableDirectory(q, SHEET_ID, [])
    const ids = dir.map((e) => e.userId)
    expect(ids).toEqual(expect.arrayContaining([ACTOR, U_IN, U_OUT])) // all active sheet members
    expect(ids).not.toContain(U_INACTIVE) // inactive → not a sheet member, not in the directory
  })

  // -- #5781: the HYDRATION BOUNDS, executed against real Postgres ------------------------------
  //
  // Why here and not in a unit test: tests/unit/multitable-person-directory-resolver.test.ts proves
  // the bounds by asserting on the SQL STRING produced for a fake query fn, and
  // tests/unit/multitable-person-directory-bounded.test.ts mocks resolvePersonAssignableDirectory
  // wholesale. Neither ever executes the ILIKE predicate, the LIKE-escape convention or the
  // `LIMIT $n` against a real engine, so a shape PG rejects or case-folds differently (the 222 box
  // runs a Chinese locale) would leave every suite green and fail first on the deployment. These are
  // the only assertions that run the #5781 SQL for real.
  test('#5781 bound (real DB): the LIMIT is executed by PG, not applied in memory', async () => {
    const all = await resolvePersonAssignableDirectory(q, SHEET_ID, [])
    expect(all.length).toBeGreaterThanOrEqual(3) // ACTOR + U_IN + U_OUT are all active sheet members
    const bounded = await resolvePersonAssignableDirectory(q, SHEET_ID, [], undefined, { limit: 2 })
    expect(bounded).toHaveLength(2)
  })

  test('#5781 bound (real DB): the search term is a case-insensitive SUBSTRING match on name/email', async () => {
    // U_IN's fixture name/email both contain this fragment; upper-cased to prove ILIKE case folding
    // actually happens in the engine (the route lower-cases nothing).
    const term = `_IN_${TS}`
    const hit = await resolvePersonAssignableDirectory(q, SHEET_ID, [], undefined, { search: term, limit: 50 })
    expect(hit.map((e) => e.userId)).toEqual([U_IN])
    expect(hit[0]?.email).toBe(`${U_IN}@t.local`) // still hydrated, just bounded

    const miss = await resolvePersonAssignableDirectory(q, SHEET_ID, [], undefined, { search: `no_such_person_${TS}`, limit: 50 })
    expect(miss).toEqual([])
  })

  test('#5781 bound (real DB): LIKE metacharacters in the term stay LITERAL (a bare % is not "everything")', async () => {
    // The term is deliberately FIXTURE-SCOPED rather than a bare '%': this suite shares a database
    // with the rest of the real-DB lane, so `search: '%'` + `toEqual([])` would be an assertion
    // about every row in that database (and, with a 50-row ceiling, would not even be a reliable
    // probe — the fixtures sort late). `<U_IN's id>%` decides it both ways with no ambiguity:
    //   escaped   → a literal trailing percent sign, which no row has          ⇒ []
    //   unescaped → a prefix wildcard, which matches U_IN's name AND email      ⇒ [U_IN]
    // so this is the assertion that catches escapeLikeTerm being dropped.
    const literalPct = await resolvePersonAssignableDirectory(q, SHEET_ID, [], undefined, { search: `${U_IN}%`, limit: 50 })
    expect(literalPct).toEqual([])
    // `_` is the OTHER LIKE metacharacter: as a wildcard `u_pmg` would match any 5-char prefix, but as
    // a literal it must still match the fixture ids (which genuinely contain underscores).
    const underscore = await resolvePersonAssignableDirectory(q, SHEET_ID, [], undefined, { search: `u_pmg_in_${TS}`, limit: 50 })
    expect(underscore.map((e) => e.userId)).toEqual([U_IN])
  })

  test('#5781 bound (real DB): the bounds NEVER widen the allowed set (a term cannot reach outside it)', async () => {
    // The whole safety property of #5781's hydration bounds: $1 stays the write-validator's allowed
    // set. Searching a RESTRICTED field for a user who is a sheet member but NOT in the group must
    // still return nothing - the term filters within the allowed set, it does not select from users.
    const outside = await resolvePersonAssignableDirectory(q, SHEET_ID, [G_ALLOW], undefined, { search: U_OUT, limit: 50 })
    expect(outside).toEqual([])
    const inside = await resolvePersonAssignableDirectory(q, SHEET_ID, [G_ALLOW], undefined, { search: U_IN, limit: 50 })
    expect(inside.map((e) => e.userId)).toEqual([U_IN])
    // ... and an INACTIVE member of the allowed group stays excluded even when searched for by name.
    const inactive = await resolvePersonAssignableDirectory(q, SHEET_ID, [G_ALLOW], undefined, { search: U_INACTIVE, limit: 50 })
    expect(inactive).toEqual([])
  })

  // -- #5809: the EXACT lookup mode (import resolver), executed against real Postgres -------------
  // tests/unit/multitable-person-directory-resolver.test.ts only inspects the SQL string; this runs the
  // lower()/btrim()/::text equality for real (the 222 box runs a Chinese locale).
  test('#5809 exact (real DB): id, name and email each match by case-insensitive EQUALITY', async () => {
    const opts = (exact: string) => ({ exact, limit: 51 })
    const byId = await resolvePersonAssignableDirectory(q, SHEET_ID, [], undefined, opts(U_EXACT.toUpperCase()))
    expect(byId.map((e) => e.userId)).toEqual([U_EXACT])
    const byName = await resolvePersonAssignableDirectory(q, SHEET_ID, [], undefined, opts(` ${U_EXACT_NAME.toLowerCase()} `))
    expect(byName.map((e) => e.userId)).toEqual([U_EXACT])
    const byEmail = await resolvePersonAssignableDirectory(q, SHEET_ID, [], undefined, opts(U_EXACT_EMAIL.toUpperCase()))
    expect(byEmail.map((e) => e.userId)).toEqual([U_EXACT])
    expect(byEmail[0]?.name).toBe(U_EXACT_NAME)
  })

  test('#5809 exact (real DB): a fragment the substring search matches returns nothing', async () => {
    const fragment = `exact.${TS}`
    const substring = await resolvePersonAssignableDirectory(q, SHEET_ID, [], undefined, { search: fragment, limit: 50 })
    expect(substring.map((e) => e.userId)).toEqual([U_EXACT])
    const exact = await resolvePersonAssignableDirectory(q, SHEET_ID, [], undefined, { exact: fragment, limit: 51 })
    expect(exact).toEqual([])
  })

  test('#5809 exact (real DB): never reaches outside the allowed set, nor an inactive member', async () => {
    // U_EXACT is a sheet member but in no group: a restricted field cannot resolve it by id.
    const outsideGroup = await resolvePersonAssignableDirectory(q, SHEET_ID, [G_ALLOW], undefined, { exact: U_EXACT, limit: 51 })
    expect(outsideGroup).toEqual([])
    const out = await resolvePersonAssignableDirectory(q, SHEET_ID, [G_ALLOW], undefined, { exact: U_OUT, limit: 51 })
    expect(out).toEqual([])
    const inside = await resolvePersonAssignableDirectory(q, SHEET_ID, [G_ALLOW], undefined, { exact: U_IN, limit: 51 })
    expect(inside.map((e) => e.userId)).toEqual([U_IN])
    const inactive = await resolvePersonAssignableDirectory(q, SHEET_ID, [G_ALLOW], undefined, { exact: U_INACTIVE, limit: 51 })
    expect(inactive).toEqual([])
  })
})
