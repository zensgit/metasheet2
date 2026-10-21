import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { up as phase1Up } from '../../src/db/migrations/zzzz20260821100000_add_approval_instance_org_id'
import { up as recovery09Up } from '../../src/db/migrations/zzzz20260823040000_recovery09_prepare_legacy_default_org'
import { up as provisioningUp } from '../../src/db/migrations/zzzz20260823050000_provision_zero_membership_active_users'
import { up as backfillBUp } from '../../src/db/migrations/zzzz20260823100000_backfill_approval_instance_org_id'

/**
 * Lock-10 (S1) Migration B — ordered org_id backfill over the residual NULL platform rows left
 * by Phase 1, real-DB acceptance (isolated schema). EXTENDED at the Lock-11 §10 D-8(β) revision
 * (docs/development/approval-lock11-writer-org-derivation-20260822.md, owner sixth by-reference
 * reply, 2026-08-22) to also cover the companion provisioning migration
 * `zzzz20260823050000_provision_zero_membership_active_users.ts` (H32-H37, H41, H42) and the revised
 * class-6 arm of `backfillBUp` itself (H15 audited + H38-H40).
 *
 * Harness shape copied from `approval-attachment-scan-purge-upgrade-migration.db.test.ts`: an
 * isolated `CREATE SCHEMA "<rand>"` + a `Pool` with `options: '-c search_path=<schema>'` + a
 * per-schema `Kysely`, minimal hand-built tables (now including a minimal `users` table, added
 * for the D-8(β) provisioning gates), migrations imported and run directly, `DROP SCHEMA ...
 * CASCADE` in `afterEach`.
 *
 * `phase1Up` is run in `beforeEach` (against empty tables — a no-op backfill, but it lands the
 * `org_id` column + non-blank CHECK exactly as Phase 1 does in every real environment); each test
 * then seeds its own fixture and calls `backfillBUp` directly (D-8(β) tests additionally call
 * `provisioningUp` first, matching the ratified ORDER — provisioning migration merges/runs
 * BEFORE the revised backfill). This is NOT a re-run of a recorded migration (kysely never does
 * that); it is calling the function bodies directly against a fresh isolated schema, which is
 * what every sibling `.db.test.ts` in this repo does.
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
    // Minimal `users` table — added for the D-8(β) provisioning migration's gates (H32-H37,
    // H40). Not needed by any pre-existing H1-H31 fixture (`backfillBUp` never reads `users`).
    await sql`
      CREATE TABLE users (
        id text PRIMARY KEY,
        is_active boolean NOT NULL DEFAULT true
      )
    `.execute(testDb)
    await sql`
      CREATE TABLE directory_integrations (
        id text PRIMARY KEY,
        org_id text NOT NULL,
        status text NOT NULL DEFAULT 'active'
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

  // Added for the D-8(β) provisioning gates (H32-H37, H40).
  async function seedUser(id: string, isActive = true): Promise<void> {
    await sql`INSERT INTO users (id, is_active) VALUES (${id}, ${isActive})`.execute(testDb)
  }

  async function seedDirectoryIntegration(id: string, orgId: string): Promise<void> {
    await sql`INSERT INTO directory_integrations (id, org_id) VALUES (${id}, ${orgId})`.execute(testDb)
  }

  async function activeMembershipCount(userId: string): Promise<number> {
    const r = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM user_orgs WHERE user_id = ${userId} AND is_active = TRUE
    `.execute(testDb)
    return Number(r.rows[0]?.n ?? '0')
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

  // ---- H15 — class-6 population equality (exactly one true positive), AUDITED at D-8(β) -----
  //
  // AUDIT (Lock-11 §10 D-8(β) revision, ruled consequence, not a silent change): this fixture's
  // ONLY `user_orgs` row is `u_h15_resolvable` -> `orgResolvable` (active) — so in THIS isolated
  // schema `SELECT DISTINCT org_id FROM user_orgs WHERE is_active` returns exactly ONE row. That
  // means the D-8(β) single-org premise HOLDS here, and the ruled outcome for a class-6 TERMINAL
  // row changed from "the whole migration ABORTS" to "the terminal row is STAMPED with the
  // unique active org". This is exactly the shape the ratification names ("this ruling unblocks
  // #5103... it is an owner amendment of the class-6 arm") — the fixture is UNCHANGED, its
  // discriminating decoys are UNCHANGED, only the migration's ruled response to the true positive
  // changed, so the test's ASSERTION changes with it rather than the fixture being reshaped to
  // dodge the change. Contrast H3/H6/H19 below (still ABORT — audited, unchanged: H3 seeds TWO
  // distinct active orgs, H6 and H19 seed ZERO/ZERO-ACTIVE orgs, so the single-org premise FAILS
  // for all three and the original ABORT still fires verbatim).
  it('H15: one row matching every class-6 clause + one row failing EACH clause individually -> the true positive is STAMPED with the unique active org (single-org premise holds), every decoy unaffected', async () => {
    // The TRUE POSITIVE — matches every class-6 clause.
    await seedInstance({ id: 'h15_true', sourceSystem: 'platform', requesterId: 'u_h15_true' })
    // deliberately no user_orgs row for u_h15_true (zero memberships)

    // Fails "org_id IS NULL" — already stamped.
    await seedInstance({ id: 'h15_stamped', sourceSystem: 'platform', orgId: 'orgZ' })

    // Fails "not plm:%".
    const plmId = `plm:${randomUUID()}`
    await seedInstance({ id: plmId, sourceSystem: 'plm' })

    // Fails "not afs:%".
    const afsId = `afs:${randomUUID()}`
    await seedInstance({ id: afsId, sourceSystem: 'platform' })

    // Fails "source_system = platform".
    await seedInstance({ id: 'h15_nonplatform', sourceSystem: 'plm' })

    // Fails "template_id IS NULL".
    await seedInstance({ id: 'h15_template', sourceSystem: 'platform', templateId: randomUUID() })

    // Fails "zero attachments" — carries a SINGLE-org attachment (not two-org, so this does not
    // also trip the class-2 conflict pre-flight).
    await seedInstance({ id: 'h15_attach', sourceSystem: 'platform' })
    await seedAttachment('att_h15', 'h15_attach', 'orgSingle')

    // Fails "requester not uniquely resolvable" — resolves to exactly one active org. This row is
    // ALSO the fixture's sole source of the single active org (`orgResolvable`) that makes the
    // D-8(β) premise hold for `h15_true` above.
    await seedInstance({ id: 'h15_resolvable', sourceSystem: 'platform', requesterId: 'u_h15_resolvable' })
    await seedUserOrg('u_h15_resolvable', 'orgResolvable', true)

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()

    // The true positive: stamped with THE unique active org, not left NULL and not aborted.
    expect(await orgIdOf('h15_true')).toBe('orgResolvable')
    // Every decoy: exactly the outcome it had before the D-8(β) revision (none of them are
    // class-6-shaped, so none of them are touched by the revision).
    expect(await orgIdOf('h15_stamped')).toBe('orgZ')
    expect(await orgIdOf(plmId)).toBeNull()
    expect(await orgIdOf(afsId)).toBeNull()
    expect(await orgIdOf('h15_nonplatform')).toBeNull()
    expect(await orgIdOf('h15_template')).toBeNull()
    expect(await orgIdOf('h15_attach')).toBe('orgSingle')
    expect(await orgIdOf('h15_resolvable')).toBe('orgResolvable')
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

  it('H20: template_id IS NOT NULL + requester with EXACTLY ONE INACTIVE membership -> stays NULL, no abort (a class-1-residue shape with ZERO instances on prod today — prod\'s 257-row c3_zero_membership population is template_id IS NULL, i.e. c6_terminal-shaped, not this fixture\'s shape; asserted as a VALUE not masked by an abort)', async () => {
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

  // ---- H30/H31 — a post-push self-scan (before any external re-review) found the round-3
  // docblock's own "every clause falls into one of three categories" claim was itself unmeasured
  // for several clauses. Two of those turned out to be genuine, undiscriminated gaps (not inert),
  // structurally analogous to N1. Closed here rather than merely disclosed.

  it("H30: an ALREADY-STAMPED instance with TWO conflicting-org attachments, co-resident with a SEPARATE bare eligible instance -> the already-stamped one stays untouched, NO false-positive conflict abort (pins the conflict census's JOIN condition `i.id = a.instance_id`; a widened join lets the already-stamped instance borrow the co-resident bare instance's eligibility and false-abort the whole migration)", async () => {
    await seedInstance({ id: 'h30_stamped', sourceSystem: 'platform', orgId: 'orgAlreadySet' })
    await seedAttachment('att_h30_a', 'h30_stamped', 'orgConflictX')
    await seedAttachment('att_h30_b', 'h30_stamped', 'orgConflictY')
    // A separate, bare, eligible instance (org_id IS NULL, unprefixed, zero attachments) co-resident
    // in the SAME schema, with a uniquely-resolvable requester so it does not itself trigger the
    // class-6 terminal abort (which would mask this test's real target behind an unrelated abort).
    await seedInstance({ id: 'h30_bare', sourceSystem: 'platform', requesterId: 'u_h30_bare' })
    await seedUserOrg('u_h30_bare', 'orgBare', true)

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('h30_stamped')).toBe('orgAlreadySet')
    expect(await orgIdOf('h30_bare')).toBe('orgBare')
  })

  it("H31: an instance with TWO attachments carrying the SAME org (non-conflicting duplicates) -> NOT flagged as a conflict, stamped by class 2 from that org (pins the conflict census's `count(DISTINCT a.org_id) > 1` — without DISTINCT, `count(a.org_id) > 1` would false-flag ANY instance with 2+ same-org attachments as a conflict and abort the whole migration)", async () => {
    const id = `h31-${randomUUID()}`
    await seedInstance({ id, sourceSystem: 'platform' })
    await seedAttachment('att_h31_a', id, 'orgSameTwice')
    await seedAttachment('att_h31_b', id, 'orgSameTwice')

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf(id)).toBe('orgSameTwice')
  })

  // ============================================================================================
  // Lock-11 §10 D-8(β) REVISION (ratified 2026-08-22, owner sixth by-reference reply). Two groups:
  //   H32-H37, H41: the companion provisioning migration
  //            `zzzz20260823050000_provision_zero_membership_active_users.ts`, standalone.
  //   H38-H40: the revised class-6 arm of `backfillBUp`, plus the end-to-end ordering.
  // ============================================================================================

  // ---- H32-H37, H41 — provisioning migration ------------------------------------------------------

  it('H32: a zero-membership ACTIVE user is provisioned into the single active org', async () => {
    // Establish the single active org via a pre-existing, unrelated membership.
    await seedUser('u_h32_seed', true)
    await seedUserOrg('u_h32_seed', 'orgOnly32', true)
    // The population: an ACTIVE user with NO user_orgs row at all.
    await seedUser('u_h32_target', true)

    await expect(provisioningUp(testDb)).resolves.toBeUndefined()

    expect(await activeMembershipCount('u_h32_target')).toBe(1)
    const row = await sql<{ org_id: string; is_active: boolean }>`
      SELECT org_id, is_active FROM user_orgs WHERE user_id = 'u_h32_target'
    `.execute(testDb)
    expect(row.rows).toEqual([{ org_id: 'orgOnly32', is_active: true }])
  })

  it('H33: a user who ALREADY holds an active membership is left completely untouched by provisioning (no duplicate row, no value change)', async () => {
    await seedUser('u_h33', true)
    await seedUserOrg('u_h33', 'orgOnly33', true)

    await expect(provisioningUp(testDb)).resolves.toBeUndefined()

    // Still exactly one row, unchanged value — NOT EXISTS excluded it from the INSERT's source
    // set entirely (no ON CONFLICT branch was even reached for this user).
    const rows = await sql<{ org_id: string }>`SELECT org_id FROM user_orgs WHERE user_id = 'u_h33'`.execute(testDb)
    expect(rows.rows).toEqual([{ org_id: 'orgOnly33' }])
  })

  it('H34: TWO distinct active orgs exist repo-wide -> provisioning ABORTS before any INSERT, values-free (the (i)-guard)', async () => {
    await seedUser('u_h34_seed_a', true)
    await seedUserOrg('u_h34_seed_a', 'orgH34A', true)
    await seedUser('u_h34_seed_b', true)
    await seedUserOrg('u_h34_seed_b', 'orgH34B', true)
    await seedUser('u_h34_target', true) // the zero-membership population this migration would touch

    await expect(provisioningUp(testDb)).rejects.toThrow(
      /^provision_zero_membership_active_users \(Lock-11 D-8\(β\)\) aborted before any INSERT: found 2 distinct active org\(s\)/,
    )
    // Values-free: neither org id appears in the rejection.
    await expect(provisioningUp(testDb)).rejects.not.toThrow(/orgH34A/)
    await expect(provisioningUp(testDb)).rejects.not.toThrow(/orgH34B/)
    // No partial write: the target user still has zero memberships.
    expect(await activeMembershipCount('u_h34_target')).toBe(0)
  })

  it('H35: running provisioning TWICE provisions 0 additional rows on the second pass (idempotence)', async () => {
    await seedUser('u_h35_seed', true)
    await seedUserOrg('u_h35_seed', 'orgOnly35', true)
    await seedUser('u_h35_target', true)

    await expect(provisioningUp(testDb)).resolves.toBeUndefined()
    expect(await activeMembershipCount('u_h35_target')).toBe(1)

    // Second pass: NOT EXISTS now excludes u_h35_target (it has an active row); ON CONFLICT is a
    // second, independent guard against the same effect. Either alone would make this pass a
    // no-op; both together is the file's stated "belt-and-suspenders" posture.
    await expect(provisioningUp(testDb)).resolves.toBeUndefined()
    expect(await activeMembershipCount('u_h35_target')).toBe(1)
    const rows = await sql<{ n: string }>`SELECT count(*)::text AS n FROM user_orgs WHERE user_id = 'u_h35_target'`.execute(testDb)
    expect(rows.rows[0]?.n).toBe('1') // not 2 — no duplicate row, not merely "still active"
  })

  it('H36: a user whose ONLY membership is INACTIVE is still provisioned (matches U1b/D-9\'s single-is_active population exactly, not merely "zero rows at all")', async () => {
    await seedUser('u_h36_seed', true)
    await seedUserOrg('u_h36_seed', 'orgOnly36', true)
    await seedUser('u_h36_target', true)
    await seedUserOrg('u_h36_target', 'orgStaleInactive', false) // deactivated membership, different org

    await expect(provisioningUp(testDb)).resolves.toBeUndefined()

    expect(await activeMembershipCount('u_h36_target')).toBe(1)
    const active = await sql<{ org_id: string }>`
      SELECT org_id FROM user_orgs WHERE user_id = 'u_h36_target' AND is_active = TRUE
    `.execute(testDb)
    expect(active.rows).toEqual([{ org_id: 'orgOnly36' }])
    // The stale inactive row is untouched (non-resurrecting posture, same precedent as
    // zzzz20260721150000): still exactly one row for that (user_id, org_id) pair, still inactive.
    const stale = await sql<{ is_active: boolean }>`
      SELECT is_active FROM user_orgs WHERE user_id = 'u_h36_target' AND org_id = 'orgStaleInactive'
    `.execute(testDb)
    expect(stale.rows).toEqual([{ is_active: false }])
  })

  it('H37: a zero-membership user whose users.is_active = FALSE is NOT provisioned (scope precision — this migration is narrower than its two precedents)', async () => {
    await seedUser('u_h37_seed', true)
    await seedUserOrg('u_h37_seed', 'orgOnly37', true)
    await seedUser('u_h37_target', false) // inactive user, zero memberships

    await expect(provisioningUp(testDb)).resolves.toBeUndefined()

    expect(await activeMembershipCount('u_h37_target')).toBe(0)
  })

  it("H41/R09: a zero-ACTIVE-membership user whose ONLY row is DEACTIVATED is excluded from the executable population, does not trigger the org premise, and is never resurrected", async () => {
    await seedUser('u_h41_seed', true)
    await seedUserOrg('u_h41_seed', 'orgOnly41', true) // establishes the sole active org
    await seedUser('u_h41_target', true)
    // The ONLY (user_id, org_id) pair for this user is INACTIVE, and its org_id is the SAME
    // value the single-org premise would resolve to. Recovery09 excludes this actionless conflict
    // from the source set because the non-resurrection contract means no write can be permitted.
    await seedUserOrg('u_h41_target', 'orgOnly41', false)

    await expect(provisioningUp(testDb)).resolves.toBeUndefined()

    // Non-resurrecting, same posture as zzzz20260721150000 and zzzz20260114110000's own backfill:
    // the pre-existing row is left EXACTLY as it was, still inactive — provisioning does not
    // reactivate a membership a live unbind/deactivation already recorded.
    const row = await sql<{ is_active: boolean }>`
      SELECT is_active FROM user_orgs WHERE user_id = 'u_h41_target' AND org_id = 'orgOnly41'
    `.execute(testDb)
    expect(row.rows).toEqual([{ is_active: false }])
    expect(await activeMembershipCount('u_h41_target')).toBe(0)
  })

  it('R09-1: four-org staging shape -> default-anchored repair preserves synthetic memberships, never resurrects a deactivated row, and leaves Migration B no class-6 residue', async () => {
    await seedDirectoryIntegration('di_default', 'default')
    await seedUser('r09_default_witness')
    await seedUserOrg('r09_default_witness', 'default')
    for (const [userId, orgId] of [
      ['r09_synth_a', 'synth_a'],
      ['r09_synth_b', 'synth_b'],
      ['r09_synth_c', 'synth_c'],
    ] as const) {
      await seedUser(userId)
      await seedUserOrg(userId, orgId)
    }

    await seedUser('r09_no_row')
    await seedUser('r09_deactivated_only')
    await seedUserOrg('r09_deactivated_only', 'default', false)
    await seedUser('r09_stale_other')
    await seedUserOrg('r09_stale_other', 'retired_org', false)
    await seedInstance({ id: 'r09_by_user', sourceSystem: 'platform', requesterId: 'r09_no_row' })
    await seedInstance({ id: 'r09_by_stale_user', sourceSystem: 'platform', requesterId: 'r09_stale_other' })
    await seedInstance({ id: 'r09_missing_user', sourceSystem: 'platform', requesterId: 'r09_absent' })

    await expect(recovery09Up(testDb)).resolves.toBeUndefined()
    await expect(provisioningUp(testDb)).resolves.toBeUndefined()
    await expect(backfillBUp(testDb)).resolves.toBeUndefined()

    expect(await activeMembershipCount('r09_no_row')).toBe(1)
    expect(await activeMembershipCount('r09_deactivated_only')).toBe(0)
    expect(await activeMembershipCount('r09_stale_other')).toBe(1)
    expect(await orgIdOf('r09_by_user')).toBe('default')
    expect(await orgIdOf('r09_by_stale_user')).toBe('default')
    expect(await orgIdOf('r09_missing_user')).toBe('default')
    const synthetic = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM user_orgs
       WHERE (user_id, org_id, is_active) IN (
         ('r09_synth_a', 'synth_a', TRUE),
         ('r09_synth_b', 'synth_b', TRUE),
         ('r09_synth_c', 'synth_c', TRUE)
       )
    `.execute(testDb)
    expect(synthetic.rows[0]?.n).toBe('3')
    const stale = await sql<{ is_active: boolean }>`
      SELECT is_active FROM user_orgs WHERE user_id = 'r09_stale_other' AND org_id = 'retired_org'
    `.execute(testDb)
    expect(stale.rows).toEqual([{ is_active: false }])
  })

  it('R09-2: more than one directory org anchor -> fail before membership or approval writes, values-free', async () => {
    await seedDirectoryIntegration('di_a', 'default')
    await seedDirectoryIntegration('di_b', 'another_org')
    await seedUser('r09_anchor_witness')
    await seedUserOrg('r09_anchor_witness', 'default')
    await seedUser('r09_target')
    await seedInstance({ id: 'r09_anchor_instance', sourceSystem: 'platform', requesterId: 'missing_r09' })

    await expect(recovery09Up(testDb)).rejects.toThrow(/exactly the repo-owned legacy anchor/i)
    await expect(recovery09Up(testDb)).rejects.not.toThrow(/another_org|r09_anchor_instance|r09_target/i)
    expect(await activeMembershipCount('r09_target')).toBe(0)
    expect(await orgIdOf('r09_anchor_instance')).toBeNull()
  })

  it('R09-3: terminal row owned by a deactivated-only requester remains unsupported and rolls back all candidate writes', async () => {
    await seedDirectoryIntegration('di_default_r09_3', 'default')
    await seedUser('r09_3_witness')
    await seedUserOrg('r09_3_witness', 'default')
    await seedUser('r09_3_insert_candidate')
    await seedUser('r09_3_deactivated')
    await seedUserOrg('r09_3_deactivated', 'default', false)
    await seedInstance({ id: 'r09_3_unsupported', sourceSystem: 'platform', requesterId: 'r09_3_deactivated' })

    await expect(recovery09Up(testDb)).rejects.toThrow(/neither requester-missing nor active-requester-with-no-membership-row/i)
    expect(await activeMembershipCount('r09_3_insert_candidate')).toBe(0)
    expect(await orgIdOf('r09_3_unsupported')).toBeNull()
  })

  it("H42: EMPTY population (fresh/CI-shaped DB — zero `users` rows at all, hence zero distinct active orgs) -> provisioning resolves as a safe no-op, does NOT abort on the FAIL-LOUD single-org guard (regression pin for a P1 CI outage this migration's first cut shipped: `approval-realdb-org-backfill-b` and `migration-prod-image-parity (postgres:15-alpine)` both caught 'found 0 distinct active org(s)' aborting db:migrate on every fresh-DB CI lane before the pre-flight population check was added)", async () => {
    // Deliberately NO seedUser / seedUserOrg calls at all — `users` and `user_orgs` both exist
    // (created in beforeEach) but are completely empty, exactly like every CI lane's fresh DB.
    await expect(provisioningUp(testDb)).resolves.toBeUndefined()

    const orgCount = await sql<{ n: string }>`SELECT count(*)::text AS n FROM user_orgs`.execute(testDb)
    expect(orgCount.rows[0]?.n).toBe('0')
  })

  // ---- H43-H45 — provisioning's own missing-table guard, the H16a/H16b equivalent -----------
  //
  // The docblock claims "a fresh DB, or one where zzzz20260114110000 has not landed yet, skips
  // cleanly rather than throwing" — checked via `checkTableExists(db, 'users')` AND
  // `checkTableExists(db, 'user_orgs')`, either missing short-circuits to a no-op return before
  // any query runs. H16a/H16b prove this shape for `backfillBUp`'s OWN guards
  // (user_orgs / approval_attachments); provisioning had no equivalent before this round. H42
  // covers the table-present-but-EMPTY case; these three cover table-ABSENT, a materially
  // different guard (`checkTableExists`, not a population count of zero).

  it('H43: user_orgs table absent -> provisioningUp resolves (guard fires, no crash)', async () => {
    await sql`DROP TABLE user_orgs`.execute(testDb)
    await expect(sql`SELECT 1 FROM user_orgs`.execute(testDb)).rejects.toMatchObject({ code: '42P01' })

    await expect(provisioningUp(testDb)).resolves.toBeUndefined()
  })

  it('H44: users table absent -> provisioningUp resolves (guard fires, no crash)', async () => {
    await sql`DROP TABLE users`.execute(testDb)
    await expect(sql`SELECT 1 FROM users`.execute(testDb)).rejects.toMatchObject({ code: '42P01' })

    await expect(provisioningUp(testDb)).resolves.toBeUndefined()
  })

  it('H45: BOTH users and user_orgs absent (pre-zzzz20260114110000 schema shape) -> provisioningUp resolves (guard fires, no crash)', async () => {
    await sql`DROP TABLE user_orgs`.execute(testDb)
    await sql`DROP TABLE users`.execute(testDb)

    await expect(provisioningUp(testDb)).resolves.toBeUndefined()
  })

  // ---- H46 — composed ordering, F2: a class-1-RESIDUE row (template_id IS NOT NULL) whose ------
  // requester is provisioned by D-8(β) -> resolved by class 3 with the ACTIVE org, not left NULL
  //
  // H40 already proves the composed class-6/class-3 ordering for TERMINAL (template_id IS NULL)
  // rows. This fixture is the other composed shape the D-8(β) revision changes: a template-
  // originated row (class 1 emits no SQL for it either way) whose requester is a zero-membership
  // ACTIVE user. Run backfillBUp ALONE first (control), matching H20's shape, then re-seed and
  // run provisioningUp -> backfillBUp (treatment) to pin BOTH the direction (composed order
  // resolves it, isolated does not) and the VALUE (the active org, never a stale inactive one).

  it("H46: template_id IS NOT NULL + requester with ZERO memberships who IS an active `users` row -> stays NULL under backfillBUp alone, but STAMPED with the active org once provisioningUp runs first (composed-order class-3 resolution; F2 fixture)", async () => {
    await seedUser('u_h46_seed', true)
    await seedUserOrg('u_h46_seed', 'orgOnly46', true) // establishes the sole active org

    const templateId = randomUUID()
    await seedUser('u_h46_target', true) // ACTIVE, zero user_orgs memberships
    await seedInstance({ id: 'h46', sourceSystem: 'platform', templateId, requesterId: 'u_h46_target' })

    // CONTROL — same shape as H20: backfillBUp alone cannot resolve a zero-membership requester,
    // and template_id IS NOT NULL excludes class 1 too, so the row stays NULL, no abort.
    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('h46')).toBeNull()

    // TREATMENT — provisioningUp runs first (the ratified order): u_h46_target gains an active
    // membership to the sole org, so class 3's `HAVING count(*) = 1` now matches and the SECOND
    // backfillBUp pass (still scoped `org_id IS NULL`, per H17) stamps it via the ordinary,
    // finer-grained class-3 mechanism — the ACTIVE org, not a stale/inactive one.
    await expect(provisioningUp(testDb)).resolves.toBeUndefined()
    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('h46')).toBe('orgOnly46')
    expect(await activeMembershipCount('u_h46_target')).toBe(1)
  })

  // ---- H38-H40 — the revised class-6 arm of backfillBUp --------------------------------------

  it('H38: SINGLE-org fixture — a class-6 TERMINAL row is STAMPED with the unique active org (dedicated, uncluttered gate; H15 above covers the same outcome amid decoys)', async () => {
    await seedUser('u_h38_seed', true)
    await seedUserOrg('u_h38_seed', 'orgOnly38', true) // the sole active org in this schema
    await seedInstance({ id: 'h38', sourceSystem: 'platform', requesterId: 'u_h38_unresolvable' })
    // deliberately no user_orgs row for u_h38_unresolvable — genuinely unresolvable requester

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('h38')).toBe('orgOnly38')
  })

  it('H39: TWO-org fixture — a class-6 TERMINAL row still ABORTS, with the ORIGINAL ruled message VERBATIM, values-free', async () => {
    await seedUserOrg('u_h39_seed_a', 'orgH39A', true)
    await seedUserOrg('u_h39_seed_b', 'orgH39B', true)
    await seedInstance({ id: 'h39', sourceSystem: 'platform', requesterId: 'u_h39_unresolvable' })

    // VERBATIM match against the pre-D-8(β) ABORT text — the ruling requires this text to be
    // byte-for-byte unchanged in the abort arm, not merely "still an error".
    await expect(backfillBUp(testDb)).rejects.toThrow(
      /^approval_instance_org_id backfill \(Migration B\) aborted before any UPDATE: 1 instance\(s\) matched Lock-10 §2\.2\(b\) class 6 \(TERMINAL — no derivable org source\)\. Instance ids are NOT interpolated \(values-free discipline\)\. To enumerate them, run the predicate reproduced in this file's CLASS_6_PREDICATE comment against the same database\.$/,
    )
    await expect(backfillBUp(testDb)).rejects.not.toThrow(/h39/i)
    await expect(backfillBUp(testDb)).rejects.not.toThrow(/orgH39A|orgH39B/)
    expect(await orgIdOf('h39')).toBeNull()
  })

  it('H40: 269-shape end-to-end — provisioning THEN the revised backfill resolve EVERY previously-unresolvable platform row (p20 -> 0 equivalent), by TWO different mechanisms', async () => {
    // The single active org, established independently of every row this test cares about.
    await seedUserOrg('u_h40_seed', 'orgOnly40', true)

    // Population 1 (the "12 zero-membership actives" shape): requesters with ZERO memberships
    // who ARE known `users` rows -> provisioning gives them a membership -> class 3 (NOT class 6)
    // resolves their instance in the ordinary, finer-grained, already-ratified way.
    await seedUser('u_h40_a', true)
    await seedInstance({ id: 'h40_a', sourceSystem: 'platform', requesterId: 'u_h40_a' })
    await seedUser('u_h40_b', true)
    await seedInstance({ id: 'h40_b', sourceSystem: 'platform', requesterId: 'u_h40_b' })

    // Population 2 (the genuinely-unresolvable shape provisioning CANNOT help, because there is
    // no `users` row for this id at all — the requester snapshot names an id no admission path
    // ever created): resolved ONLY by the revised class-6 STAMP.
    await seedInstance({ id: 'h40_c', sourceSystem: 'platform', requesterId: 'u_h40_c_no_such_user' })

    // Sanity: before either migration runs, all three are exactly p20's shape (org_id NULL,
    // unprefixed, platform).
    const before = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM approval_instances
       WHERE org_id IS NULL AND id NOT LIKE 'plm:%' AND id NOT LIKE 'afs:%'
         AND COALESCE(source_system, 'platform') = 'platform'
    `.execute(testDb)
    expect(before.rows[0]?.n).toBe('3')

    await expect(provisioningUp(testDb)).resolves.toBeUndefined()

    // ORDERING GATE (the claim H40's title makes, measured, not merely implied by the final
    // values): after provisioning but BEFORE the revised backfill runs, the class-6 CENSUS
    // predicate (CLASS_6_PREDICATE, reproduced from the migration file) must already read 1, not
    // 3 — h40_a/h40_b now resolve to exactly one active membership (provisioning gave them one),
    // so they no longer match class 6's "requester not uniquely resolvable" clause; only h40_c
    // (no `users` row at all, provisioning could never touch it) still matches. If provisioning
    // had NOT run first, or had not actually granted an ACTIVE membership, this count would still
    // be 3 and the final org_id values (asserted below) would be reached via class 6 for all
    // three instead of via class 3 for two of them — a different mechanism the final values alone
    // cannot distinguish, because every arm converges on the SAME single org.
    const midCensus = await sql<{ n: string }>`
      SELECT count(*)::text AS n
        FROM approval_instances i
       WHERE i.org_id IS NULL
         AND i.id NOT LIKE 'plm:%'
         AND i.id NOT LIKE 'afs:%'
         AND COALESCE(i.source_system, 'platform') = 'platform'
         AND i.template_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM approval_attachments a WHERE a.instance_id = i.id)
         AND NOT EXISTS (
           SELECT 1 FROM user_orgs uo
            WHERE uo.user_id = i.requester_snapshot->>'id'
              AND uo.is_active = TRUE
            GROUP BY uo.user_id
           HAVING count(*) = 1
         )
    `.execute(testDb)
    expect(midCensus.rows[0]?.n).toBe('1')

    await expect(backfillBUp(testDb)).resolves.toBeUndefined()

    // All three now stamped, all with the SAME (only) org — but via the ordering PROVEN above:
    // h40_a/h40_b via class 3 (their requester now resolves), h40_c via the class-6 stamp (its
    // requester id names no user at all, so provisioning could never have touched it).
    expect(await orgIdOf('h40_a')).toBe('orgOnly40')
    expect(await orgIdOf('h40_b')).toBe('orgOnly40')
    expect(await orgIdOf('h40_c')).toBe('orgOnly40')
    // Independent corroboration that h40_a/h40_b went through class 3, not class 6: provisioning
    // actually gave them a real active membership row (class 6 stamps the instance directly and
    // never touches user_orgs).
    expect(await activeMembershipCount('u_h40_a')).toBe(1)
    expect(await activeMembershipCount('u_h40_b')).toBe(1)
    expect(await activeMembershipCount('u_h40_c_no_such_user')).toBe(0)

    // p20 -> 0 equivalent: zero rows remain in the population this test started with.
    const after = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM approval_instances
       WHERE org_id IS NULL AND id NOT LIKE 'plm:%' AND id NOT LIKE 'afs:%'
         AND COALESCE(source_system, 'platform') = 'platform'
    `.execute(testDb)
    expect(after.rows[0]?.n).toBe('0')
  })
})
