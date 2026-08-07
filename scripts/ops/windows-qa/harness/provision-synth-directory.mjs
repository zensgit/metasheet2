#!/usr/bin/env node
/**
 * Attendance Windows-native QA v2 — synthetic directory + user provisioner (owner gate 1).
 *
 * Draft/HOLD. Synthetic data only. No deployment/staging authorization.
 * Pinned product SOURCE_SHA: 0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b (unchanged by QA tooling).
 *
 * Creates the synthetic org anchors and users THROUGH THE PRODUCT PATH — no hardcoded user ids,
 * no test-only insert bypass:
 *   1. `getOrCreateLocalIntegration(orgId)` — the local directory anchor for each explicit-by-design
 *      synthetic org (local-directory-org.ts:22: org identity is caller-supplied, never minted).
 *   2. `authService.register(email, password, name)` — the product user-creation path; it mints the
 *      id with crypto.randomUUID() (AuthService.ts:400) and creates a real, loginable user
 *      (activation_status='activated', local_password_set=TRUE — createUser INSERT AuthService.ts:647).
 *      The minted id is captured; nothing in the tree knows it before this runs.
 *   3. `createLocalAccount({orgId, localUserId})` — links the minted user to the org (directory
 *      account + ACTIVE user_orgs membership in one transaction).
 *
 * Writes an identity-ONLY map (owner security boundary): {orgs, users:{key:{id,email,username}},
 * memberships}. NO password / hash / token — the synthetic password is read from env
 * QA_SYNTH_PASSWORD and never written to any file.
 *
 * Run under tsx against source (macOS proof) or plain node against dist (Windows package):
 *   QA_SYNTH_PASSWORD=... DATABASE_URL=postgresql://<local>/metasheet_windows_qa \
 *     node --import tsx scripts/ops/windows-qa/harness/provision-synth-directory.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_IDENTITIES_PATH,
  assertLocalIsolatedTarget,
  importProduct,
  parseArg,
  readSyntheticPassword,
} from './qa-runtime.mjs'
import { QA_SYNTH_ORGS, QA_SYNTH_USER_INPUTS } from './qa-identities.mjs'

const PINNED_SHA = '0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b'

// Which synthetic orgs each user is an ACTIVE member of (covers every PQA case's substrate).
// NOTE: QA_SYNTH_ORGS.orgB is deliberately ABSENT from every list — it is PQA-07's dedicated
// cross-org probe target, an org NO synthetic user is a member of. Its directory anchor is still
// created (the org loop below covers all QA_SYNTH_ORGS), so the cross-org 403 target exists turnkey.
const MEMBERSHIPS = {
  admin: [QA_SYNTH_ORGS.orgA, QA_SYNTH_ORGS.orgShadow, QA_SYNTH_ORGS.orgLegacy],
  u1: [QA_SYNTH_ORGS.orgA, QA_SYNTH_ORGS.orgShadow, QA_SYNTH_ORGS.orgLegacy],
  u2: [QA_SYNTH_ORGS.orgA],
  u3: [QA_SYNTH_ORGS.orgA],
}

async function main() {
  const outPath = parseArg('--out', DEFAULT_IDENTITIES_PATH)
  assertLocalIsolatedTarget()
  const password = readSyntheticPassword()

  const { authService } = await importProduct('auth/AuthService')
  // getOrCreateLocalIntegration is the B1 anchor primitive, exported by directory-sync and
  // re-used (not reimplemented) by local-directory-org (see that file's header).
  const { getOrCreateLocalIntegration } = await importProduct('directory/directory-sync')
  const { createLocalAccount, LocalDirectoryConflictError } = await importProduct(
    'directory/local-directory-org',
  )
  const { query } = await importProduct('db/pg')

  // Live safety re-check against the actual connection (not just the URL string).
  const dbRow = await query('SELECT current_database() AS db')
  const liveDb = dbRow.rows[0]?.db
  if (liveDb !== 'metasheet_windows_qa') {
    throw new Error(`Refusing: connected database is "${liveDb}", not metasheet_windows_qa.`)
  }

  // Gate 1(b): create each org's local directory anchor FIRST, as its own observable step.
  const orgs = {}
  for (const [key, orgId] of Object.entries(QA_SYNTH_ORGS)) {
    const integration = await getOrCreateLocalIntegration(orgId)
    orgs[key] = orgId
    console.log(`[provision] org anchor ${key}=${orgId} -> integration ${integration?.id ?? '(id?)'}`)
  }

  // Gate 1(c/d): create each user via the product path (mints id), capture the returned id.
  const users = {}
  for (const [key, input] of Object.entries(QA_SYNTH_USER_INPUTS)) {
    const created = await authService.register(input.email, password, input.name)
    if (!created || !created.id) {
      // register() returns null on BOTH duplicate-email and DB error — disambiguate and fail LOUD.
      const existing = await query('SELECT id FROM users WHERE email = $1', [input.email])
      if (existing.rows.length > 0) {
        throw new Error(
          `Refusing: synthetic user ${input.email} already exists (id ${existing.rows[0].id}). The DB is ` +
            `NOT fresh — run reset-isolated-db.mjs (drop/recreate) before provisioning.`,
        )
      }
      throw new Error(`Product user-creation (register) failed for ${input.email} with no existing row.`)
    }
    users[key] = { id: created.id, email: input.email, username: input.username }
    console.log(`[provision] user ${key} minted id=${created.id} (${input.email})`)
  }

  // Link each minted user to its org(s): directory account + ACTIVE user_orgs membership.
  const memberships = []
  for (const [key, orgIds] of Object.entries(MEMBERSHIPS)) {
    const u = users[key]
    if (!u) continue
    for (const orgId of orgIds) {
      try {
        await createLocalAccount({
          orgId,
          localUserId: u.id,
          name: QA_SYNTH_USER_INPUTS[key].name,
          email: u.email,
        })
      } catch (error) {
        if (LocalDirectoryConflictError && error instanceof LocalDirectoryConflictError) {
          throw new Error(
            `Refusing: local account for ${u.email} in ${orgId} already exists — DB is NOT fresh.`,
          )
        }
        throw error
      }
      memberships.push({ user: key, org: orgId })
      console.log(`[provision] membership ${key} -> ${orgId}`)
    }
  }

  const payload = {
    _README:
      'Identity-ONLY map (owner security boundary): synthetic user UUIDs, emails/usernames, org ' +
      'mappings. NO password/hash/token. User ids are product-minted (crypto.randomUUID via ' +
      'AuthService.register); orgs are explicit-by-design (local-directory-org.ts:22). Gitignored.',
    sourceSha: PINNED_SHA,
    databaseName: 'metasheet_windows_qa',
    orgs,
    users,
    memberships,
    generatedAt: new Date().toISOString(),
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`)
  console.log(`[provision] wrote identity map -> ${outPath}`)
  console.log(`[provision] OK: ${Object.keys(orgs).length} orgs, ${Object.keys(users).length} users, ${memberships.length} memberships`)
}

main()
  .then(() => {
    // The product pool (poolManager) keeps the event loop alive; exit explicitly so the CLI returns.
    process.exit(process.exitCode ?? 0)
  })
  .catch((error) => {
    console.error(`[provision] ERROR: ${error?.message ?? error}`)
    process.exit(1)
  })
