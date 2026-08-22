import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { up as phase1Up } from '../../src/db/migrations/zzzz20260821100000_add_approval_instance_org_id'
import { up as backfillBUp } from '../../src/db/migrations/zzzz20260823100000_backfill_approval_instance_org_id'

/**
 * Lock-10 (S1) Migration B — ordered org_id backfill over the residual NULL platform rows left
 * by Phase 1, real-DB acceptance (isolated schema).
 *
 * Harness shape copied from `approval-attachment-scan-purge-upgrade-migration.db.test.ts`: an
 * isolated `CREATE SCHEMA "<rand>"` + a `Pool` with `options: '-c search_path=<schema>'` + a
 * per-schema `Kysely`, minimal hand-built tables, migrations imported and run directly, `DROP
 * SCHEMA ... CASCADE` in `afterEach`.
 *
 * Both `up()`s are run in sequence in `beforeEach` (phase1Up first, against empty tables — a
 * no-op backfill, but it lands the `org_id` column + non-blank CHECK exactly as Phase 1 does in
 * every real environment), then each test seeds its own fixture and calls `backfillBUp` directly.
 * This is NOT a re-run of a recorded migration (kysely never does that); it is calling the
 * function bodies directly against a fresh isolated schema, which is what every sibling
 * `.db.test.ts` in this repo does.
 */

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

// Top-level anti-skip-green sentinel — copied VERBATIM from
// `approval-instance-readability-s1.db.test.ts:47-53`. Deliberately OUTSIDE describeIfDatabase.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

describeIfDatabase('Migration B — ordered org_id backfill over the residual NULL population (real DB, isolated schema)', () => {
  let adminPool: Pool
  let schema: string
  let testPool: Pool
  let testDb: Kysely<unknown>

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: dbUrl })
    schema = `migb_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    testPool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}` })
    testDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: testPool }) })

    // Minimal hand-built schema — no org_id column yet (phase1Up adds it below), matching the
    // shape it is added against in every real environment.
    await sql`
      CREATE TABLE approval_instances (
        id text PRIMARY KEY,
        status text NOT NULL DEFAULT 'pending',
        source_system text,
        template_id uuid,
        requester_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `.execute(testDb)
    await sql`
      CREATE TABLE approval_attachments (
        id text PRIMARY KEY,
        instance_id text REFERENCES approval_instances(id) ON DELETE CASCADE,
        org_id text NOT NULL
      )
    `.execute(testDb)
    await sql`
      CREATE TABLE user_orgs (
        user_id text NOT NULL,
        org_id text NOT NULL,
        is_active boolean NOT NULL DEFAULT true,
        PRIMARY KEY (user_id, org_id)
      )
    `.execute(testDb)

    // Simulate "Phase 1 already landed" — adds org_id (nullable, no default) + the non-blank
    // CHECK, and runs its own (here trivially empty) class-2 backfill.
    await phase1Up(testDb)
  })

  afterEach(async () => {
    await testDb.destroy()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
  })

  // ---- fixture helpers ----------------------------------------------------------------------

  async function seedInstance(opts: {
    id: string
    templateId?: string | null
    sourceSystem?: string | null
    requesterId?: string | null // undefined/null => requester_snapshot stays '{}' (no 'id' key)
    orgId?: string | null // pass to simulate an ALREADY-STAMPED row
  }): Promise<void> {
    const { id, templateId = null, sourceSystem = null, requesterId = null, orgId = null } = opts
    const snapshot = requesterId ? { id: requesterId } : {}
    await sql`
      INSERT INTO approval_instances (id, status, source_system, template_id, requester_snapshot, org_id)
      VALUES (
        ${id}, 'pending', ${sourceSystem}, ${templateId}::uuid, ${JSON.stringify(snapshot)}::jsonb, ${orgId}
      )
    `.execute(testDb)
  }

  async function seedAttachment(id: string, instanceId: string, orgId: string): Promise<void> {
    await sql`INSERT INTO approval_attachments (id, instance_id, org_id) VALUES (${id}, ${instanceId}, ${orgId})`.execute(testDb)
  }

  async function seedUserOrg(userId: string, orgId: string, isActive = true): Promise<void> {
    await sql`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES (${userId}, ${orgId}, ${isActive})`.execute(testDb)
  }

  async function orgIdOf(id: string): Promise<string | null> {
    const r = await sql<{ org_id: string | null }>`SELECT org_id FROM approval_instances WHERE id = ${id}`.execute(testDb)
    return r.rows[0]?.org_id ?? null
  }

  // ---- H1 / H2 / H3 — requester resolution + template residue + terminal abort --------------

  it('H1: platform, no template, no attachments, requester with EXACTLY ONE active org -> stamped by class 3', async () => {
    await seedInstance({ id: 'h1', sourceSystem: 'platform', requesterId: 'u_h1' })
    await seedUserOrg('u_h1', 'orgA', true)

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('h1')).toBe('orgA')
  })

  it('H2: multi-org requester + template_id NOT NULL -> NOT stamped, no abort (class-1 residue)', async () => {
    const templateId = randomUUID()
    await seedInstance({ id: 'h2', sourceSystem: 'platform', templateId, requesterId: 'u_h2' })
    await seedUserOrg('u_h2', 'default', true)
    await seedUserOrg('u_h2', 'orgB', true)

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('h2')).toBeNull()
  })

  it('positive control for H2: same multi-org user re-seeded as SINGLE-org, template_id NULL -> stamped', async () => {
    await seedInstance({ id: 'h2_pc', sourceSystem: 'platform', requesterId: 'u_h2pc' })
    await seedUserOrg('u_h2pc', 'orgC', true) // single membership only, unlike H2's user

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('h2_pc')).toBe('orgC')
  })

  it('H3: multi-org requester, template_id NULL, no attachments, platform -> ABORT (class 6 fires), no id leaked', async () => {
    await seedInstance({ id: 'h3', sourceSystem: 'platform', requesterId: 'u_h3' })
    await seedUserOrg('u_h3', 'default', true)
    await seedUserOrg('u_h3', 'orgB', true)

    await expect(backfillBUp(testDb)).rejects.toThrow(/class 6/i)
    await expect(backfillBUp(testDb)).rejects.not.toThrow(/h3/i)
  })

  // ---- H4 / H5 / H6 — zero-membership / requester-id-absent shapes --------------------------

  it('H4: zero-membership requester + template_id NOT NULL -> NOT stamped, no abort', async () => {
    const templateId = randomUUID()
    await seedInstance({ id: 'h4', sourceSystem: 'platform', templateId, requesterId: 'u_h4_none' })
    // deliberately NO user_orgs row for u_h4_none

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('h4')).toBeNull()
  })

  it("H5: requester_snapshot = '{}' (id absent) + template_id NOT NULL -> NOT stamped, no abort", async () => {
    const templateId = randomUUID()
    await seedInstance({ id: 'h5', sourceSystem: 'platform', templateId, requesterId: null })

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('h5')).toBeNull()
  })

  it("H6: requester_snapshot = '{}', template_id NULL, platform, no attachments -> ABORT (class 6 fires)", async () => {
    await seedInstance({ id: 'h6', sourceSystem: 'platform', requesterId: null })

    await expect(backfillBUp(testDb)).rejects.toThrow(/class 6/i)
    await expect(backfillBUp(testDb)).rejects.not.toThrow(/h6/i)
  })

  // ---- H7 / H8 — plm: prefix guard (class 2 and class 3) + positive controls ----------------

  it('H7: plm:<uuid> WITH a bound attachment carrying an org -> NOT stamped (class-2 prefix guard proof)', async () => {
    const id = `plm:${randomUUID()}`
    await seedInstance({ id, sourceSystem: 'plm' })
    await seedAttachment('att_h7', id, 'orgX')

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf(id)).toBeNull()
  })

  it('positive control for H7: identical fixture WITHOUT the plm: prefix IS stamped by class 2', async () => {
    const id = `nonplm-${randomUUID()}`
    await seedInstance({ id, sourceSystem: 'plm' })
    await seedAttachment('att_h7pc', id, 'orgX')

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf(id)).toBe('orgX')
  })

  it('H8: plm:<uuid> WITHOUT attachments, requester uniquely resolvable -> NOT stamped (class-3 prefix guard proof)', async () => {
    const id = `plm:${randomUUID()}`
    await seedInstance({ id, sourceSystem: 'plm', requesterId: 'u_h8' })
    await seedUserOrg('u_h8', 'orgD', true)

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf(id)).toBeNull()
  })

  it('positive control for H8: identical fixture WITHOUT the plm: prefix IS stamped by class 3', async () => {
    const id = `nonplm-${randomUUID()}`
    await seedInstance({ id, sourceSystem: 'plm', requesterId: 'u_h8pc' })
    await seedUserOrg('u_h8pc', 'orgD', true)

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf(id)).toBe('orgD')
  })

  // ---- H9 / H10 — afs: prefix guard (class 2 and class 6) + positive control ----------------

  it('H9: afs:<uuid> WITH a bound attachment -> NOT stamped, no abort', async () => {
    const id = `afs:${randomUUID()}`
    await seedInstance({ id, sourceSystem: 'platform' })
    await seedAttachment('att_h9', id, 'orgY')

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf(id)).toBeNull()
  })

  it('positive control for H9: identical fixture WITHOUT the afs: prefix IS stamped by class 2', async () => {
    const id = `nonafs-${randomUUID()}`
    await seedInstance({ id, sourceSystem: 'platform' })
    await seedAttachment('att_h9pc', id, 'orgY')

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf(id)).toBe('orgY')
  })

  // H10: NOTE — the spec's literal fixture text ("requester uniquely resolvable") does not
  // actually exercise the class-6 `id NOT LIKE 'afs:%'` clause: if the requester DOES resolve to
  // exactly one active org, class 6's own "NOT EXISTS a unique membership" clause is already
  // false, so removing the afs-prefix clause from class 6 would NOT flip the verdict — the named
  // mutation ("delete afs guard from class 6 -> H10 reds") would not actually red. To make the
  // mutation probe meaningful, this fixture instead gives the requester ZERO active memberships
  // (so every OTHER class-6 clause is satisfied) — this is the shape that actually needs the
  // explicit prefix exclusion to stay out of the terminal count, which is the property the row's
  // name claims to prove. Documented deviation from the literal spec text, not a silent narrowing.
  it('H10: afs:<uuid>, no attachments, zero-membership requester, source_system=platform -> NOT stamped, no abort (explicit afs guard in class 6, not source_system, keeps it out)', async () => {
    const id = `afs:${randomUUID()}`
    await seedInstance({ id, sourceSystem: 'platform', requesterId: 'u_h10_none' })
    // deliberately NO user_orgs row for u_h10_none

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf(id)).toBeNull()
  })

  // ---- H11 — non-platform, non-prefixed source_system --------------------------------------

  it("H11: platform-shaped id but source_system='plm' (no plm:/afs: prefix), no template, no attachments, unresolvable requester -> NOT stamped, no abort (outside class 6's platform predicate)", async () => {
    const id = `plainid-${randomUUID()}`
    await seedInstance({ id, sourceSystem: 'plm', requesterId: null })

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf(id)).toBeNull()
  })

  // ---- H12 — cross-class (class-2) conflict abort, values-free -----------------------------

  it('H12: instance with attachments in TWO different orgs -> ABORT (class-2 conflict), message has a count and no instance id', async () => {
    const id = `h12-${randomUUID()}`
    await seedInstance({ id, sourceSystem: 'platform' })
    await seedAttachment('att_h12_a', id, 'orgA')
    await seedAttachment('att_h12_b', id, 'orgB')

    await expect(backfillBUp(testDb)).rejects.toThrow(/class-2 cross-class FAIL LOUD/i)
    await expect(backfillBUp(testDb)).rejects.toThrow(/\d+ instance/)
    await expect(backfillBUp(testDb)).rejects.not.toThrow(new RegExp(id))
  })

  // ---- H13 — already-stamped rows are untouched (idempotent scoping) ------------------------

  it('H13: already-stamped row with conflicting attachments + a resolvable requester in a third org -> UNTOUCHED, no abort', async () => {
    const id = `h13-${randomUUID()}`
    await seedInstance({ id, sourceSystem: 'platform', requesterId: 'u_h13', orgId: 'orgSet' })
    await seedAttachment('att_h13_a', id, 'orgA')
    await seedAttachment('att_h13_b', id, 'orgB')
    await seedUserOrg('u_h13', 'orgC', true)

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf(id)).toBe('orgSet')
  })

  // ---- H14 — attachment-bearing platform row, source distinguished from requester's org -----

  it('H14: attachment-bearing platform row still NULL (p30 drift shape) -> stamped from the ATTACHMENT org, not the requester org', async () => {
    const id = `h14-${randomUUID()}`
    await seedInstance({ id, sourceSystem: 'platform', requesterId: 'u_h14' })
    await seedAttachment('att_h14', id, 'orgAttach')
    await seedUserOrg('u_h14', 'orgRequester', true) // deliberately DIFFERENT from the attachment org

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf(id)).toBe('orgAttach')
  })

  // ---- H15 — class-6 abort population equality (exactly one true positive) ------------------

  it('H15: one row matching every class-6 clause + one row failing EACH clause individually -> aborted count is exactly 1', async () => {
    // The TRUE POSITIVE — matches every class-6 clause.
    await seedInstance({ id: 'h15_true', sourceSystem: 'platform', requesterId: 'u_h15_true' })
    // deliberately no user_orgs row for u_h15_true (zero memberships)

    // Fails "org_id IS NULL" — already stamped.
    await seedInstance({ id: 'h15_stamped', sourceSystem: 'platform', orgId: 'orgZ' })

    // Fails "not plm:%".
    await seedInstance({ id: `plm:${randomUUID()}`, sourceSystem: 'plm' })

    // Fails "not afs:%".
    await seedInstance({ id: `afs:${randomUUID()}`, sourceSystem: 'platform' })

    // Fails "source_system = platform".
    await seedInstance({ id: 'h15_nonplatform', sourceSystem: 'plm' })

    // Fails "template_id IS NULL".
    await seedInstance({ id: 'h15_template', sourceSystem: 'platform', templateId: randomUUID() })

    // Fails "zero attachments" — carries a SINGLE-org attachment (not two-org, so this does not
    // also trip the class-2 conflict pre-flight, keeping this test's abort attributable to class 6
    // alone).
    await seedInstance({ id: 'h15_attach', sourceSystem: 'platform' })
    await seedAttachment('att_h15', 'h15_attach', 'orgSingle')

    // Fails "requester not uniquely resolvable" — resolves to exactly one active org.
    await seedInstance({ id: 'h15_resolvable', sourceSystem: 'platform', requesterId: 'u_h15_resolvable' })
    await seedUserOrg('u_h15_resolvable', 'orgResolvable', true)

    await expect(backfillBUp(testDb)).rejects.toThrow(/^approval_instance_org_id backfill \(Migration B\) aborted before any UPDATE: 1 instance\(s\)/)
  })

  // ---- H16 — lane guards: missing user_orgs / approval_attachments must not crash -----------

  it('H16a: user_orgs table absent -> backfillBUp resolves (guard fires, no crash)', async () => {
    await seedInstance({ id: 'h16a', sourceSystem: 'platform', requesterId: null }) // class-6 shaped if evaluated

    await sql`DROP TABLE user_orgs`.execute(testDb)
    // Positive control: prove the table is really gone from THIS schema (not a public-schema
    // fallback silently satisfying checkTableExists).
    await expect(sql`SELECT 1 FROM user_orgs`.execute(testDb)).rejects.toMatchObject({ code: '42P01' })

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
  })

  it('H16b: approval_attachments table absent -> backfillBUp resolves (guard fires, no crash)', async () => {
    await seedInstance({ id: 'h16b', sourceSystem: 'platform', requesterId: null }) // class-6 shaped if evaluated

    await sql`DROP TABLE approval_attachments`.execute(testDb)
    await expect(sql`SELECT 1 FROM approval_attachments`.execute(testDb)).rejects.toMatchObject({ code: '42P01' })

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
  })

  // ---- H17 — idempotency / replay ------------------------------------------------------------

  it('H17: running backfillBUp twice stamps 0 additional rows on the second pass', async () => {
    await seedInstance({ id: 'h17_c2', sourceSystem: 'platform' })
    await seedAttachment('att_h17', 'h17_c2', 'orgRepeat')
    await seedInstance({ id: 'h17_c3', sourceSystem: 'platform', requesterId: 'u_h17' })
    await seedUserOrg('u_h17', 'orgRepeat2', true)

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('h17_c2')).toBe('orgRepeat')
    expect(await orgIdOf('h17_c3')).toBe('orgRepeat2')

    // Second pass: everything already stamped, everything scoped `org_id IS NULL` -> no-op.
    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('h17_c2')).toBe('orgRepeat')
    expect(await orgIdOf('h17_c3')).toBe('orgRepeat2')
  })

  // ---- FIX-ROUND (gate report /tmp/migb-gate-20260822.md, head b6309c7486) ------------------
  //
  // H18-H26 close P2-1 (is_active untested in class 3 AND class 6, decides 257/271 of prod's
  // residual population), P2-2 (the afs: guard on the class-3 UPDATE had no backstop and no red-
  // proving test), P2-3 (the only prod-effective code path — template-originated + uniquely-
  // resolvable requester, stamped via class-3 ordered fall-through — was untested), and P3-2
  // (the class-2 conflict census's own plm:/afs: prefix guards were untested). H26 additionally
  // closes the migration file's own MUTATION-COVERAGE HONESTY NOTE gap (the class-6 `id NOT LIKE
  // 'plm:%'` clause) with a synthetic fixture — see that note's rewrite in this same PR for why
  // this is the only place in the suite a `plm:` row's `source_system` is deliberately set to
  // `'platform'` rather than mirroring `upsertPlmMirror`'s real shape.

  // ---- H18 / H19 / H20 — is_active is load-bearing in BOTH class 3 and class 6 --------------

  it('H18: requester with ONE INACTIVE (alphabetically-first) + ONE ACTIVE membership -> stamped from the ACTIVE org, not the inactive one', async () => {
    await seedInstance({ id: 'h18', sourceSystem: 'platform', requesterId: 'u_h18' })
    // Inactive org sorts BEFORE the active org (orgA < orgZ): if `is_active` were dropped from
    // class 3's subquery, `HAVING count(*) = 1` would fail (2 total memberships) and the row
    // would fall through unstamped; if `is_active` were also (or instead) dropped from class 6's
    // subquery, this row would be misclassified as class-6 TERMINAL (2 total memberships also
    // fails class 6's own `HAVING count(*) = 1`, flipping `NOT EXISTS` to TRUE) and the whole
    // migration would ABORT before ever reaching class 3 — either mutation reds this test.
    await seedUserOrg('u_h18', 'orgA', false) // inactive, sorts first
    await seedUserOrg('u_h18', 'orgZ', true) // active

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('h18')).toBe('orgZ')
  })

  it('H19: requester with EXACTLY ONE INACTIVE membership (zero active) -> ABORT (class 6 fires; a deactivated-only membership does not count as resolvable)', async () => {
    await seedInstance({ id: 'h19', sourceSystem: 'platform', requesterId: 'u_h19' })
    await seedUserOrg('u_h19', 'orgInactiveOnly', false)

    await expect(backfillBUp(testDb)).rejects.toThrow(/class 6/i)
    await expect(backfillBUp(testDb)).rejects.not.toThrow(/h19/i)
  })

  it('H20: template_id IS NOT NULL + requester with EXACTLY ONE INACTIVE membership -> stays NULL, no abort (the 257-row prod shape, asserted as a VALUE not masked by an abort)', async () => {
    const templateId = randomUUID()
    await seedInstance({ id: 'h20', sourceSystem: 'platform', templateId, requesterId: 'u_h20' })
    await seedUserOrg('u_h20', 'orgDeactivated', false)

    // Class 1 has no source (template_id IS NOT NULL excludes class 6); class 3 must NOT stamp
    // from the deactivated membership's org. Unlike H19, this fixture is NOT class-6-shaped
    // (template_id IS NOT NULL), so a regression that stamps from an inactive membership would
    // surface as a wrong VALUE here, not be hidden behind class 6's abort.
    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('h20')).toBeNull()
  })

  // ---- H21 — afs: prefix guard on the class-3 UPDATE (no source_system backstop, unlike plm:) --

  it('H21: afs:<uuid> WITHOUT attachments, requester uniquely resolvable -> NOT stamped (class-3 afs: prefix guard proof; class 3 has no source_system filter, so this guard is the ONLY thing keeping it out)', async () => {
    const id = `afs:${randomUUID()}`
    await seedInstance({ id, sourceSystem: 'platform', requesterId: 'u_h21' })
    await seedUserOrg('u_h21', 'orgE', true)

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf(id)).toBeNull()
  })

  // ---- H22 — the only prod-effective write path: template-originated + uniquely-resolvable ---

  it('H22: template_id IS NOT NULL + requester resolves to EXACTLY ONE active org -> STAMPED by class 3 via ordered fall-through (class 1 emits no SQL; matches the docblock and pins the only 2 rows Migration B stamps on prod today)', async () => {
    const templateId = randomUUID()
    await seedInstance({ id: 'h22', sourceSystem: 'platform', templateId, requesterId: 'u_h22' })
    await seedUserOrg('u_h22', 'orgFallthrough', true)

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('h22')).toBe('orgFallthrough')
  })

  // ---- H23 / H24 — the class-2 conflict census's OWN prefix guards (lines 233-234) -----------

  it('H23: plm:<uuid> with TWO conflicting-org attachments -> NO abort (conflict census excludes plm: rows), stays NULL', async () => {
    const id = `plm:${randomUUID()}`
    await seedInstance({ id, sourceSystem: 'plm' })
    await seedAttachment('att_h23_a', id, 'orgConflictA')
    await seedAttachment('att_h23_b', id, 'orgConflictB')

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf(id)).toBeNull()
  })

  it('H24: afs:<uuid> with TWO conflicting-org attachments -> NO abort (conflict census excludes afs: rows), stays NULL', async () => {
    const id = `afs:${randomUUID()}`
    await seedInstance({ id, sourceSystem: 'platform' })
    await seedAttachment('att_h24_a', id, 'orgConflictC')
    await seedAttachment('att_h24_b', id, 'orgConflictD')

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf(id)).toBeNull()
  })

  // ---- H25 — corrects the docblock's stay-NULL bullet 3 (P3-1) -------------------------------

  it("H25: source_system='erp' (non-platform, unprefixed), requester resolves to EXACTLY ONE active org -> STAMPED by class 3 (class 3 has no source_system filter; only class 6 does — this is NOT the unconditional stay-NULL shape the docblock previously implied)", async () => {
    const id = `erpid-${randomUUID()}`
    await seedInstance({ id, sourceSystem: 'erp', requesterId: 'u_h25' })
    await seedUserOrg('u_h25', 'orgErp', true)

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf(id)).toBe('orgErp')
  })

  // ---- H26 — closes the migration's own MUTATION-COVERAGE HONESTY NOTE gap -------------------

  it("H26: plm:<uuid> with source_system='platform' (synthetic — not upsertPlmMirror's real shape, but not forbidden), no attachments, unresolvable requester -> NO abort, stays NULL (proves class 6's `id NOT LIKE 'plm:%'` clause is independently load-bearing, not merely masked by the source_system clause)", async () => {
    const id = `plm:${randomUUID()}`
    await seedInstance({ id, sourceSystem: 'platform', requesterId: null })
    // Deliberately NO user_orgs row: every OTHER class-6 clause is satisfied (platform-shaped by
    // source_system, no template, no attachments, requester unresolvable) — only the id-prefix
    // clause keeps this row out of the terminal census. Without it, this migration would ABORT.

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf(id)).toBeNull()
  })

  // ---- FIX ROUND 3 (requalification report /tmp/migb-requal-20260822.md, head c8c7a22d508e97a) --
  //
  // H27-H29 close N1: the class-3 UPDATE's own correlation predicate
  // `r.user_id = i.requester_snapshot->>'id'` had NO red-proving fixture and is NOT inert — every
  // shipped fixture that seeds a resolvable user either (a) makes that user the SAME instance's own
  // requester (so the correlation's presence/absence is unobservable — same value either way), or
  // (b) is class-6-shaped, so the pre-flight aborts before the class-3 UPDATE ever runs. Deleting
  // this predicate (replacing only its text with `TRUE`, `WHERE` and every sibling clause untouched
  // — same single-variable isolation style as m20/m24/m25/m27) turns a requester-SCOPED backfill
  // into a blanket cross-tenant stamp: every eligible row gets `r`'s (arbitrary, or last-in-plan)
  // org, regardless of whose requester it actually is. These reproduce the requalification's
  // G1/G2/G3 shapes verbatim.

  it("H27 (requal G1): template-originated row whose requester has ZERO memberships, co-resident with a FOREIGN uniquely-resolvable user in a DIFFERENT org -> stays NULL (pins the class-3 correlation predicate; a correlation regression stamps this row from the stranger's org instead)", async () => {
    const templateId = randomUUID()
    await seedInstance({ id: 'h27', sourceSystem: 'platform', templateId, requesterId: 'u_h27_zero' })
    // deliberately NO user_orgs row for u_h27_zero (zero memberships) — class 1 has no source
    // (template_id excludes class 6), so this row can ONLY be reached by class 3's correlation.
    await seedUserOrg('u_h27_stranger', 'orgH27Stranger', true) // foreign, single-org, uniquely
    // resolvable: gives the class-3 subquery `r` a row to (mis)assign from if the correlation that
    // ties `r` to THIS row's own requester is ever dropped.

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('h27')).toBeNull()
  })

  it("H28 (requal G2): requester_snapshot = '{}' (id absent, prod's c3_requester_id_absent=12 shape) + template_id NOT NULL, co-resident with a FOREIGN uniquely-resolvable user -> stays NULL (same correlation pin as H27, id-absent variant)", async () => {
    const templateId = randomUUID()
    await seedInstance({ id: 'h28', sourceSystem: 'platform', templateId, requesterId: null })
    await seedUserOrg('u_h28_stranger', 'orgH28Stranger', true)

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('h28')).toBeNull()
  })

  it("H29 (requal G3): TWO eligible rows, TWO different uniquely-resolvable requesters in TWO different orgs -> each row is stamped from its OWN requester's org, never swapped (the only fixture that would catch cross-ASSIGNMENT between two tenants, not merely an incorrect stamp on one)", async () => {
    await seedInstance({ id: 'h29_a', sourceSystem: 'platform', requesterId: 'u_h29_a' })
    await seedUserOrg('u_h29_a', 'orgH29A', true)
    await seedInstance({ id: 'h29_b', sourceSystem: 'platform', requesterId: 'u_h29_b' })
    await seedUserOrg('u_h29_b', 'orgH29B', true)

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('h29_a')).toBe('orgH29A')
    expect(await orgIdOf('h29_b')).toBe('orgH29B')
  })
})
