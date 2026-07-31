/**
 * W4C-0 (#4556) Stage B — unit gates for the TS identity/advisory-lock/posture layer.
 *
 * Covers the amendment section 2 gates that are provable without a live database
 * (default×posture matrix, cross-source UUIDv5 rejection symmetry, final-derived-UUID
 * submission refusal, JSON-clone/spread/prototype forgery refusal, durable-reload drift
 * detection, TS golden UUIDv5 + signed-bigint outputs, pre-lock/post-lock input isolation)
 * plus the section 9 posture-resolver return-shape matrix against a stubbed transaction.
 * The SQL side of the golden-parity gate lives in
 * tests/integration/attendance-w4c0-identity-golden-parity.db.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as w4c0Identity from '../w4c0-identity'
import {
  ATTENDANCE_IMPORT_ITEM_NAMESPACE_V1,
  ATTENDANCE_INTEGRATION_ITEM_NAMESPACE_V1,
  ATTENDANCE_OPERATION_SOURCE_MATRIX_V1,
  ATTENDANCE_SCHEDULED_OPERATION_NAMESPACE_V1,
  AttendanceW4IdentityError,
  __setAttendanceW4DigestSeamForTests,
  acquireAttendanceCalculationRolloutLock,
  acquireAttendanceCalculationTargetLocks,
  acquireAttendanceImportReservationLocksV1,
  acquireAttendanceOperationalBulkTargetLockV1,
  acquireAttendanceResultOperationLocks,
  acquireAttendanceScheduledRunLock,
  buildAttendanceCalculationRolloutAdvisoryKey,
  buildAttendanceCalculationTargetAdvisoryKey,
  buildAttendanceLegacyIdempotencyAdvisoryKey,
  buildAttendanceOperationalBulkTargetAdvisoryKey,
  buildAttendanceResultOperationAdvisoryKey,
  buildAttendanceScheduledRunAdvisoryKey,
  createVerifiedAttendanceCalculationTargetIdentityV1,
  createVerifiedAttendanceOperationIdentityV1,
  createVerifiedAttendanceOrgIdentityV1,
  parseCanonicalAttendanceOrgKeyV1,
  parseCanonicalAttendanceLegacyIdempotencyKeyV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  parseCanonicalAttendanceScheduledRunKeyV1,
  parseCanonicalAttendanceUserIdV1,
  parseCanonicalAttendanceWorkDateV1,
  rehydrateVerifiedAttendanceOperationIdentityV1,
  rehydrateVerifiedAttendanceOrgIdentityV1,
  resolveSegmentCalculationPosture,
  type AttendanceOperationIdentityDurableRowV1,
  type AttendanceW4TransactionClientV1,
  type ResolvedSegmentCalculationPostureV1,
  type VerifiedAttendanceOrgIdentityV1,
} from '../w4c0-identity'

// ---------------------------------------------------------------------------
// Fixed fixtures (identical bytes are pinned on the SQL side in the golden-parity
// real-DB spec — do not change one side without the other).
// ---------------------------------------------------------------------------

const ORG = '55555555-5555-4555-8555-555555555555'
const IMPORT_ROOT = '11111111-1111-4111-8111-111111111111'
const INTEGRATION_ROOT = '22222222-2222-4222-8222-222222222222'
const SCHED_RUN = '33333333-3333-4333-8333-333333333333'
const SCHED_USER = '44444444-4444-4444-8444-444444444444'
const SCHED_DATE = '2026-03-01'
const DIRECT_ID = '66666666-6666-4666-8666-666666666666'
const FP_A = 'a'.repeat(64)
const FP_B = 'b'.repeat(64)

// Amendment section 2 gate 6: exact UUIDv5 goldens (verified against the Stage A SQL
// function `attendance_w4_uuidv5` on 2026-07-25; also pinned in the real-DB parity spec).
const GOLDEN_IMPORT_ITEM_UUID = 'e22b42e2-c607-50b4-8bcf-dcc383d15bc3'
const GOLDEN_INTEGRATION_ITEM_UUID = 'c3bf2b78-8f9e-5b45-a441-772905c30e4e'
const GOLDEN_SCHEDULED_UUID = '3e1fa29a-f411-5840-bed0-4c0f92c9f140'

// Amendment section 2 gate 6: exact signed-bigint goldens (SHA-256 big-endian extraction,
// low-62-bit mask, 00|10|11 class prefixes, two's-complement interpretation).
const GOLDEN_ROLLOUT_KEY_DEFAULT = 1320501217781065229n
const GOLDEN_ROLLOUT_KEY_ORG = 2207163269983992351n
const GOLDEN_OPERATION_KEY_ITEM = -9078275941089543826n
const GOLDEN_OPERATION_KEY_BATCH = -4625420971228601305n
const GOLDEN_TARGET_KEY = -4551290893819917091n
// W4C-2 amendment section 1.6 (PR #4617, RATIFIED): the fourth (class-01, scheduled-run)
// builder's golden, over (orgId=ORG, initiator='cron', workDate=SCHED_DATE).
const GOLDEN_SCHEDULED_RUN_KEY = 5091242802921227206n

const CLASS_01_MIN = 2n ** 62n
const CLASS_01_MAX_EXCLUSIVE = 2n ** 63n
const CLASS_10_MIN = -(2n ** 63n)
const CLASS_11_MIN = -(2n ** 62n)

function stubTrx(rows: Array<Record<string, unknown>> = []): AttendanceW4TransactionClientV1 & {
  calls: Array<{ sqlText: string; params: unknown[] }>
} {
  const calls: Array<{ sqlText: string; params: unknown[] }> = []
  return {
    calls,
    async query(sqlText: string, params: unknown[] = []) {
      calls.push({ sqlText, params })
      if (sqlText.startsWith('SELECT state, scope FROM attendance_calculation_rollout_state')) {
        return { rows }
      }
      return { rows: [] }
    },
  }
}

async function postureFor(
  orgId: string,
  stateRow: { state: string; scope?: string } | null,
): Promise<ResolvedSegmentCalculationPostureV1> {
  const rows = stateRow ? [{ state: stateRow.state, scope: stateRow.scope ?? 'synthetic_staging' }] : []
  return resolveSegmentCalculationPosture(stubTrx(rows), orgId)
}

async function orgIdentity(orgId: string, state: string | null): Promise<VerifiedAttendanceOrgIdentityV1> {
  const posture = await postureFor(orgId, state ? { state } : null)
  return createVerifiedAttendanceOrgIdentityV1({ orgKey: orgId, posture })
}

function expectCode(fn: () => unknown, code: string): void {
  let thrown: unknown
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(AttendanceW4IdentityError)
  expect((thrown as AttendanceW4IdentityError).code).toBe(code)
  // values-free: the message is the code alone, never input bytes
  expect((thrown as AttendanceW4IdentityError).message).toBe(code)
}

const ALLOWLIST_ENV = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'
const savedEnv = process.env[ALLOWLIST_ENV]

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ALLOWLIST_ENV]
  else process.env[ALLOWLIST_ENV] = savedEnv
  __setAttendanceW4DigestSeamForTests(null)
})

// ---------------------------------------------------------------------------
// Canonical parsers (lock section 4.1).
// ---------------------------------------------------------------------------

describe('canonical scalar parsers', () => {
  it('canonicalizes uppercase ASCII UUID input to the same lowercase identity', () => {
    expect(parseCanonicalAttendanceOrgKeyV1(ORG.toUpperCase())).toBe(ORG)
    expect(parseCanonicalAttendanceUserIdV1(SCHED_USER.toUpperCase())).toBe(SCHED_USER)
  })

  it('accepts the exact ASCII default sentinel and rejects case/whitespace aliases', () => {
    expect(parseCanonicalAttendanceRolloutOrgKeyV1('default')).toBe('default')
    for (const bad of ['Default', 'DEFAULT', ' default', 'default ', 'default\n']) {
      expectCode(() => parseCanonicalAttendanceRolloutOrgKeyV1(bad), 'W4C0_ROLLOUT_ORG_KEY_INVALID')
    }
  })

  it('rejects whitespace, braces, URN, NUL, lookalikes, overlength, trailing newline, and non-strings', () => {
    const bad: unknown[] = [
      ` ${ORG}`,
      `${ORG} `,
      `{${ORG}}`,
      `urn:uuid:${ORG}`,
      `${ORG}\n`,
      `${ORG}\u0000`,
      ORG.replace('5', '５'), // fullwidth digit lookalike
      `${ORG}00`,
      ORG.slice(0, 35),
      ORG.replace(/-/g, ''),
      null,
      undefined,
      42,
      { toString: () => ORG },
    ]
    for (const value of bad) {
      expectCode(() => parseCanonicalAttendanceOrgKeyV1(value), 'W4C0_ORG_KEY_INVALID')
    }
  })

  it('validates calendar dates strictly (ASCII digits, real calendar days, leap years)', () => {
    expect(parseCanonicalAttendanceWorkDateV1('2028-02-29')).toBe('2028-02-29')
    expect(parseCanonicalAttendanceWorkDateV1('2000-02-29')).toBe('2000-02-29')
    for (const bad of [
      '2027-02-29', // not a leap year
      '2100-02-29', // century non-leap
      '2026-02-30',
      '2026-13-01',
      '2026-00-10',
      '2026-04-31',
      '2026-04-00',
      '2026-3-01',
      '2026-03-1',
      ' 2026-03-01',
      '2026-03-01\n',
      '2026-03-01T00',
      '２026-03-01',
    ]) {
      expectCode(() => parseCanonicalAttendanceWorkDateV1(bad), 'W4C0_WORK_DATE_INVALID')
    }
  })
})

// ---------------------------------------------------------------------------
// Section 9 posture resolver matrix (single seam; stubbed transaction).
// ---------------------------------------------------------------------------

describe('resolveSegmentCalculationPosture return-shape matrix', () => {
  it('missing state resolves to the legacy row (posture legacy_projection_only)', async () => {
    process.env[ALLOWLIST_ENV] = ORG
    const posture = await postureFor(ORG, null)
    expect({ ...posture }).toEqual({
      orgKey: ORG,
      effectiveState: 'legacy',
      writePosture: 'legacy_projection_only',
      authorSegments: 'preview',
      referenceSegments: false,
      authoritativeResults: false,
      convertReferencedShift: false,
      deleteUnreferencedShift: true,
    })
  })

  it('persisted legacy resolves to the legacy row even when allowlisted', async () => {
    process.env[ALLOWLIST_ENV] = ORG
    const posture = await postureFor(ORG, { state: 'legacy' })
    expect(posture.effectiveState).toBe('legacy')
    expect(posture.writePosture).toBe('legacy_projection_only')
  })

  it('shadow synthetic resolves to writePosture shadow with full capability row', async () => {
    process.env[ALLOWLIST_ENV] = ORG
    const posture = await postureFor(ORG, { state: 'shadow' })
    expect({ ...posture }).toEqual({
      orgKey: ORG,
      effectiveState: 'shadow',
      writePosture: 'shadow',
      authorSegments: 'full',
      referenceSegments: true,
      authoritativeResults: false,
      convertReferencedShift: true,
      deleteUnreferencedShift: true,
    })
  })

  it('eligible synthetic normalizes writePosture to shadow (sole conversion seam)', async () => {
    process.env[ALLOWLIST_ENV] = ORG
    const posture = await postureFor(ORG, { state: 'eligible' })
    expect(posture.effectiveState).toBe('eligible')
    expect(posture.writePosture).toBe('shadow')
    expect(posture.authoritativeResults).toBe(false)
  })

  it('authoritative synthetic advertises authoritative results', async () => {
    process.env[ALLOWLIST_ENV] = ORG
    const posture = await postureFor(ORG, { state: 'authoritative' })
    expect({ ...posture }).toEqual({
      orgKey: ORG,
      effectiveState: 'authoritative',
      writePosture: 'authoritative',
      authorSegments: 'full',
      referenceSegments: true,
      authoritativeResults: true,
      convertReferencedShift: true,
      deleteUnreferencedShift: true,
    })
  })

  it('suspended resolves to blocked regardless of allowlist (fail-closed both ways)', async () => {
    for (const env of [ORG, '']) {
      process.env[ALLOWLIST_ENV] = env
      const posture = await postureFor(ORG, { state: 'suspended' })
      expect({ ...posture }).toEqual({
        orgKey: ORG,
        effectiveState: 'suspended',
        writePosture: 'blocked',
        authorSegments: 'none',
        referenceSegments: false,
        authoritativeResults: false,
        convertReferencedShift: false,
        deleteUnreferencedShift: false,
      })
    }
  })

  it('a non-allowlisted or wildcard-only env entry never advertises beyond legacy', async () => {
    process.env[ALLOWLIST_ENV] = ''
    expect((await postureFor(ORG, { state: 'shadow' })).effectiveState).toBe('legacy')
    process.env[ALLOWLIST_ENV] = '*'
    expect((await postureFor(ORG, { state: 'authoritative' })).effectiveState).toBe('legacy')
    process.env[ALLOWLIST_ENV] = `*,${ORG}`
    expect((await postureFor(ORG, { state: 'shadow' })).effectiveState).toBe('shadow')
  })

  it('rejects an unknown persisted state and a non-synthetic scope', async () => {
    process.env[ALLOWLIST_ENV] = ORG
    await expect(postureFor(ORG, { state: 'paused' })).rejects.toMatchObject({ code: 'W4C0_ROLLOUT_STATE_INVALID' })
    await expect(postureFor(ORG, { state: 'shadow', scope: 'production' })).rejects.toMatchObject({
      code: 'W4C0_ROLLOUT_SCOPE_INVALID',
    })
  })

  it('strict-parses the org before touching the transaction (pre-lock lexical parser)', async () => {
    const trx = stubTrx([])
    await expect(resolveSegmentCalculationPosture(trx, `{${ORG}}`)).rejects.toMatchObject({
      code: 'W4C0_ROLLOUT_ORG_KEY_INVALID',
    })
    expect(trx.calls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Amendment gate 1: default × posture matrix (including serialization/DB reload).
// ---------------------------------------------------------------------------

describe('default org × accepted write posture', () => {
  it('accepts default under legacy_projection_only', async () => {
    const org = await orgIdentity('default', null)
    expect(org.orgId).toBe('default')
    expect(org.acceptedWritePosture).toBe('legacy_projection_only')
  })

  it('rejects default under shadow and under eligible-normalized-to-shadow', async () => {
    process.env[ALLOWLIST_ENV] = 'default'
    for (const state of ['shadow', 'eligible', 'authoritative']) {
      const posture = await postureFor('default', { state })
      expectCode(
        () => createVerifiedAttendanceOrgIdentityV1({ orgKey: 'default', posture }),
        'W4C0_DEFAULT_ORG_POSTURE_REJECTED',
      )
    }
  })

  it('rejects default with a W4 posture on DB reload through the rehydrator', () => {
    const base: AttendanceOperationIdentityDurableRowV1 = {
      orgId: 'default',
      entrypoint: 'live_punch',
      kind: 'item',
      operationId: DIRECT_ID,
      acceptedWritePosture: 'shadow',
      identitySourceKind: 'direct_live_punch',
      sourceRootId: null,
      inputOrdinal: null,
      proofSemanticFingerprint: null,
      proofUserId: null,
      proofWorkDate: null,
    }
    expectCode(() => rehydrateVerifiedAttendanceOperationIdentityV1(base), 'W4C0_DEFAULT_ORG_POSTURE_REJECTED')
    expectCode(
      () => rehydrateVerifiedAttendanceOperationIdentityV1({ ...base, acceptedWritePosture: 'authoritative' }),
      'W4C0_DEFAULT_ORG_POSTURE_REJECTED',
    )
    const legacy = rehydrateVerifiedAttendanceOperationIdentityV1({ ...base, acceptedWritePosture: 'legacy_projection_only' })
    expect(legacy.org.orgId).toBe('default')
  })

  it('rejects the rollout-state domain (eligible/blocked) at the durable posture boundary', () => {
    const base: AttendanceOperationIdentityDurableRowV1 = {
      orgId: ORG,
      entrypoint: 'live_punch',
      kind: 'item',
      operationId: DIRECT_ID,
      acceptedWritePosture: 'eligible',
      identitySourceKind: 'direct_live_punch',
      sourceRootId: null,
      inputOrdinal: null,
      proofSemanticFingerprint: null,
      proofUserId: null,
      proofWorkDate: null,
    }
    expectCode(() => rehydrateVerifiedAttendanceOperationIdentityV1(base), 'W4C0_WRITE_POSTURE_INVALID')
    expectCode(
      () => rehydrateVerifiedAttendanceOperationIdentityV1({ ...base, acceptedWritePosture: 'blocked' }),
      'W4C0_WRITE_POSTURE_INVALID',
    )
  })

  it('org factory rejects a changed org key, forged posture witnesses, and blocked posture', async () => {
    const posture = await postureFor(ORG, null)
    expectCode(
      () => createVerifiedAttendanceOrgIdentityV1({ orgKey: 'default', posture }),
      'W4C0_ORG_KEY_CHANGED',
    )
    for (const forged of [
      { ...posture },
      JSON.parse(JSON.stringify(posture)),
      Object.assign(Object.create(Object.getPrototypeOf(posture) as object | null), posture),
    ]) {
      expectCode(
        () => createVerifiedAttendanceOrgIdentityV1({ orgKey: ORG, posture: forged }),
        'W4C0_POSTURE_WITNESS_REQUIRED',
      )
    }
    process.env[ALLOWLIST_ENV] = ORG
    const suspended = await postureFor(ORG, { state: 'suspended' })
    expectCode(
      () => createVerifiedAttendanceOrgIdentityV1({ orgKey: ORG, posture: suspended }),
      'W4C0_ORG_POSTURE_BLOCKED',
    )
  })
})

// ---------------------------------------------------------------------------
// Amendment gates 2/3: closed source matrix, derived identities, cross-source refusal.
// ---------------------------------------------------------------------------

describe('closed source matrix and derived identities', () => {
  it('covers all 15 closed source kinds with their fixed kind/entrypoint', async () => {
    const org = await orgIdentity(ORG, null)
    const sources: Record<string, Record<string, unknown>> = {
      direct_live_punch: { sourceKind: 'direct_live_punch', clientOperationId: DIRECT_ID },
      direct_request_create: { sourceKind: 'direct_request_create', clientOperationId: DIRECT_ID },
      direct_request_pending_edit: { sourceKind: 'direct_request_pending_edit', clientOperationId: DIRECT_ID },
      direct_request_decision: { sourceKind: 'direct_request_decision', clientOperationId: DIRECT_ID },
      direct_request_cancel: { sourceKind: 'direct_request_cancel', clientOperationId: DIRECT_ID },
      direct_manual_edit: { sourceKind: 'direct_manual_edit', clientOperationId: DIRECT_ID },
      direct_recompute: { sourceKind: 'direct_recompute', clientOperationId: DIRECT_ID },
      direct_import_rollback: { sourceKind: 'direct_import_rollback', clientOperationId: DIRECT_ID },
      direct_ops_retirement: { sourceKind: 'direct_ops_retirement', clientOperationId: DIRECT_ID },
      verified_delivery: { sourceKind: 'verified_delivery', deliveryLedgerId: DIRECT_ID },
      import_batch: { sourceKind: 'import_batch', batchCommandId: IMPORT_ROOT },
      import_item: { sourceKind: 'import_item', batchCommandId: IMPORT_ROOT, ordinal: 0, semanticFingerprint: FP_A },
      integration_batch: { sourceKind: 'integration_batch', syncRunId: INTEGRATION_ROOT },
      integration_item: { sourceKind: 'integration_item', syncRunId: INTEGRATION_ROOT, ordinal: '7', semanticFingerprint: FP_B },
      scheduled: { sourceKind: 'scheduled', scheduledRunId: SCHED_RUN, userId: SCHED_USER, workDate: SCHED_DATE },
    }
    expect(Object.keys(ATTENDANCE_OPERATION_SOURCE_MATRIX_V1).sort()).toEqual(Object.keys(sources).sort())
    for (const [sourceKind, source] of Object.entries(sources)) {
      const row = ATTENDANCE_OPERATION_SOURCE_MATRIX_V1[sourceKind]
      const identity = createVerifiedAttendanceOperationIdentityV1({
        org,
        kind: row.kind,
        entrypoint: row.entrypoint,
        source,
      })
      expect(identity.kind).toBe(row.kind)
      expect(identity.entrypoint).toBe(row.entrypoint)
      expect(identity.sourceProof.sourceKind).toBe(sourceKind)
      // wrong kind and wrong entrypoint both fail for every row
      const wrongKind = row.kind === 'item' ? 'batch' : 'item'
      expectCode(
        () => createVerifiedAttendanceOperationIdentityV1({ org, kind: wrongKind, entrypoint: row.entrypoint, source }),
        'W4C0_SOURCE_KIND_MISMATCH',
      )
      const wrongEntrypoint = row.entrypoint === 'scheduled' ? 'live_punch' : 'scheduled'
      expectCode(
        () => createVerifiedAttendanceOperationIdentityV1({ org, kind: row.kind, entrypoint: wrongEntrypoint, source }),
        'W4C0_SOURCE_ENTRYPOINT_MISMATCH',
      )
    }
  })

  it('derives the pinned golden UUIDv5 identities for all three namespaces', async () => {
    const org = await orgIdentity(ORG, null)
    const importItem = createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'item',
      entrypoint: 'import_batch',
      source: { sourceKind: 'import_item', batchCommandId: IMPORT_ROOT, ordinal: 0, semanticFingerprint: FP_A },
    })
    expect(importItem.id).toBe(GOLDEN_IMPORT_ITEM_UUID)
    const integrationItem = createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'item',
      entrypoint: 'integration_batch',
      source: { sourceKind: 'integration_item', syncRunId: INTEGRATION_ROOT, ordinal: 7, semanticFingerprint: FP_B },
    })
    expect(integrationItem.id).toBe(GOLDEN_INTEGRATION_ITEM_UUID)
    const scheduled = createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'item',
      entrypoint: 'scheduled',
      source: { sourceKind: 'scheduled', scheduledRunId: SCHED_RUN, userId: SCHED_USER, workDate: SCHED_DATE },
    })
    expect(scheduled.id).toBe(GOLDEN_SCHEDULED_UUID)
    // The three namespace constants are distinct and pinned.
    expect(new Set([
      ATTENDANCE_IMPORT_ITEM_NAMESPACE_V1,
      ATTENDANCE_INTEGRATION_ITEM_NAMESPACE_V1,
      ATTENDANCE_SCHEDULED_OPERATION_NAMESPACE_V1,
    ]).size).toBe(3)
  })

  it('changing ordinal, fingerprint, root, user, work date, or tuple boundary changes the derived identity', async () => {
    const org = await orgIdentity(ORG, null)
    const derive = (source: Record<string, unknown>) =>
      createVerifiedAttendanceOperationIdentityV1({ org, kind: 'item', entrypoint: 'import_batch', source }).id
    const base = { sourceKind: 'import_item', batchCommandId: IMPORT_ROOT, ordinal: 0, semanticFingerprint: FP_A }
    expect(derive({ ...base, ordinal: 1 })).not.toBe(GOLDEN_IMPORT_ITEM_UUID)
    expect(derive({ ...base, semanticFingerprint: FP_B })).not.toBe(GOLDEN_IMPORT_ITEM_UUID)
    expect(derive({ ...base, batchCommandId: INTEGRATION_ROOT })).not.toBe(GOLDEN_IMPORT_ITEM_UUID)
    const scheduledDerive = (source: Record<string, unknown>) =>
      createVerifiedAttendanceOperationIdentityV1({ org, kind: 'item', entrypoint: 'scheduled', source }).id
    const scheduledBase = { sourceKind: 'scheduled', scheduledRunId: SCHED_RUN, userId: SCHED_USER, workDate: SCHED_DATE }
    expect(scheduledDerive({ ...scheduledBase, userId: '99999999-9999-4999-8999-999999999999' })).not.toBe(GOLDEN_SCHEDULED_UUID)
    expect(scheduledDerive({ ...scheduledBase, workDate: '2026-03-02' })).not.toBe(GOLDEN_SCHEDULED_UUID)
    // tuple-boundary mutation: ordinal digits bleeding into the fingerprint must not collide
    expect(derive({ ...base, ordinal: 10, semanticFingerprint: FP_A })).not.toBe(
      derive({ ...base, ordinal: 1, semanticFingerprint: `0${FP_A.slice(1)}` }),
    )
  })

  it('rejects malformed ordinals, fingerprints, and non-canonical inputs', async () => {
    const org = await orgIdentity(ORG, null)
    const attempt = (patch: Record<string, unknown>, code: string) =>
      expectCode(
        () =>
          createVerifiedAttendanceOperationIdentityV1({
            org,
            kind: 'item',
            entrypoint: 'import_batch',
            source: { sourceKind: 'import_item', batchCommandId: IMPORT_ROOT, ordinal: 0, semanticFingerprint: FP_A, ...patch },
          }),
        code,
      )
    attempt({ ordinal: -1 }, 'W4C0_ORDINAL_INVALID')
    attempt({ ordinal: 1.5 }, 'W4C0_ORDINAL_INVALID')
    attempt({ ordinal: '00' }, 'W4C0_ORDINAL_INVALID')
    attempt({ ordinal: '01' }, 'W4C0_ORDINAL_INVALID')
    attempt({ ordinal: '+1' }, 'W4C0_ORDINAL_INVALID')
    attempt({ ordinal: '' }, 'W4C0_ORDINAL_INVALID')
    attempt({ ordinal: 2147483648 }, 'W4C0_ORDINAL_INVALID')
    attempt({ semanticFingerprint: FP_A.toUpperCase() }, 'W4C0_SEMANTIC_FINGERPRINT_INVALID')
    attempt({ semanticFingerprint: FP_A.slice(0, 63) }, 'W4C0_SEMANTIC_FINGERPRINT_INVALID')
    attempt({ semanticFingerprint: `${FP_A.slice(0, 63)}g` }, 'W4C0_SEMANTIC_FINGERPRINT_INVALID')
    attempt({ batchCommandId: `{${IMPORT_ROOT}}` }, 'W4C0_SOURCE_ROOT_INVALID')
  })

  it('a caller cannot submit a final derived UUID and assert its source kind (gate 3)', async () => {
    const org = await orgIdentity(ORG, null)
    // extra/unknown key (an operationId smuggled beside the derived tuple) fails exact-key intake
    expectCode(
      () =>
        createVerifiedAttendanceOperationIdentityV1({
          org,
          kind: 'item',
          entrypoint: 'import_batch',
          source: {
            sourceKind: 'import_item',
            batchCommandId: IMPORT_ROOT,
            ordinal: 0,
            semanticFingerprint: FP_A,
            operationId: GOLDEN_IMPORT_ITEM_UUID,
          },
        }),
      'W4C0_SOURCE_PROOF_INPUT_INVALID',
    )
    // presenting the final derived UUID as a direct client UUID mints a DIFFERENT
    // (direct_live_punch) identity — it cannot claim the import_item source kind, and the
    // derived source kinds accept no ID field at all.
    expectCode(
      () =>
        createVerifiedAttendanceOperationIdentityV1({
          org,
          kind: 'item',
          entrypoint: 'import_batch',
          source: { sourceKind: 'import_item', operationId: GOLDEN_IMPORT_ITEM_UUID },
        }),
      'W4C0_SOURCE_PROOF_INPUT_INVALID',
    )
    expectCode(
      () =>
        createVerifiedAttendanceOperationIdentityV1({
          org,
          kind: 'item',
          entrypoint: 'live_punch',
          source: { sourceKind: 'unknown_source', clientOperationId: DIRECT_ID },
        }),
      'W4C0_SOURCE_KIND_INVALID',
    )
  })

  it('rejects cross-source UUIDv5 reuse symmetrically on durable reload (gate 2)', () => {
    const derived: Record<string, { id: string; root: string; row: Partial<AttendanceOperationIdentityDurableRowV1> }> = {
      import_item: {
        id: GOLDEN_IMPORT_ITEM_UUID,
        root: IMPORT_ROOT,
        row: { entrypoint: 'import_batch', inputOrdinal: 0, proofSemanticFingerprint: FP_A },
      },
      integration_item: {
        id: GOLDEN_INTEGRATION_ITEM_UUID,
        root: INTEGRATION_ROOT,
        row: { entrypoint: 'integration_batch', inputOrdinal: 7, proofSemanticFingerprint: FP_B },
      },
      scheduled: {
        id: GOLDEN_SCHEDULED_UUID,
        root: SCHED_RUN,
        row: { entrypoint: 'scheduled', proofUserId: SCHED_USER, proofWorkDate: SCHED_DATE },
      },
    }
    for (const claimedKind of Object.keys(derived)) {
      for (const actualKind of Object.keys(derived)) {
        const claimed = derived[claimedKind]
        const actual = derived[actualKind]
        const row: AttendanceOperationIdentityDurableRowV1 = {
          orgId: ORG,
          entrypoint: claimed.row.entrypoint as string,
          kind: 'item',
          operationId: actual.id, // the OTHER source's UUIDv5 (or its own on the diagonal)
          acceptedWritePosture: 'shadow',
          identitySourceKind: claimedKind,
          sourceRootId: claimed.root,
          inputOrdinal: claimed.row.inputOrdinal ?? null,
          proofSemanticFingerprint: claimed.row.proofSemanticFingerprint ?? null,
          proofUserId: claimed.row.proofUserId ?? null,
          proofWorkDate: claimed.row.proofWorkDate ?? null,
        }
        if (claimedKind === actualKind) {
          expect(rehydrateVerifiedAttendanceOperationIdentityV1(row).id).toBe(claimed.id)
        } else {
          expectCode(() => rehydrateVerifiedAttendanceOperationIdentityV1(row), 'W4C0_IDENTITY_PROOF_DRIFT')
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Amendment gate 5: durable reload drift and proof-shape strictness.
// ---------------------------------------------------------------------------

describe('rehydration from durable proof', () => {
  const importRow: AttendanceOperationIdentityDurableRowV1 = {
    orgId: ORG,
    entrypoint: 'import_batch',
    kind: 'item',
    operationId: GOLDEN_IMPORT_ITEM_UUID,
    acceptedWritePosture: 'shadow',
    identitySourceKind: 'import_item',
    sourceRootId: IMPORT_ROOT,
    inputOrdinal: 0,
    proofSemanticFingerprint: FP_A,
    proofUserId: null,
    proofWorkDate: null,
  }

  it('re-runs the factory and returns a fresh witness for a congruent row', () => {
    const identity = rehydrateVerifiedAttendanceOperationIdentityV1(importRow)
    expect(identity.id).toBe(GOLDEN_IMPORT_ITEM_UUID)
    expect(identity.sourceProof.sourceKind).toBe('import_item')
    expect(identity.org.acceptedWritePosture).toBe('shadow')
    // and the fresh witness is accepted by the key builder
    expect(buildAttendanceResultOperationAdvisoryKey(identity)).toBeTypeOf('bigint')
  })

  it('detects operation-ID and every proof-field drift before a builder can accept it', () => {
    expectCode(
      () => rehydrateVerifiedAttendanceOperationIdentityV1({ ...importRow, operationId: DIRECT_ID }),
      'W4C0_IDENTITY_PROOF_DRIFT',
    )
    expectCode(
      () => rehydrateVerifiedAttendanceOperationIdentityV1({ ...importRow, inputOrdinal: 1 }),
      'W4C0_IDENTITY_PROOF_DRIFT',
    )
    expectCode(
      () => rehydrateVerifiedAttendanceOperationIdentityV1({ ...importRow, proofSemanticFingerprint: FP_B }),
      'W4C0_IDENTITY_PROOF_DRIFT',
    )
    expectCode(
      () => rehydrateVerifiedAttendanceOperationIdentityV1({ ...importRow, sourceRootId: INTEGRATION_ROOT }),
      'W4C0_IDENTITY_PROOF_DRIFT',
    )
  })

  it('rejects partial or extra proof fields for the selected source kind', () => {
    expectCode(
      () => rehydrateVerifiedAttendanceOperationIdentityV1({ ...importRow, inputOrdinal: null }),
      'W4C0_PROOF_SHAPE_INVALID',
    )
    expectCode(
      () => rehydrateVerifiedAttendanceOperationIdentityV1({ ...importRow, proofUserId: SCHED_USER }),
      'W4C0_PROOF_SHAPE_INVALID',
    )
    const directRow: AttendanceOperationIdentityDurableRowV1 = {
      orgId: ORG,
      entrypoint: 'live_punch',
      kind: 'item',
      operationId: DIRECT_ID,
      acceptedWritePosture: 'legacy_projection_only',
      identitySourceKind: 'direct_live_punch',
      sourceRootId: null,
      inputOrdinal: null,
      proofSemanticFingerprint: null,
      proofUserId: null,
      proofWorkDate: null,
    }
    expect(rehydrateVerifiedAttendanceOperationIdentityV1(directRow).id).toBe(DIRECT_ID)
    expectCode(
      () => rehydrateVerifiedAttendanceOperationIdentityV1({ ...directRow, sourceRootId: IMPORT_ROOT }),
      'W4C0_PROOF_SHAPE_INVALID',
    )
    // a missing/extra column (legacy null-version shape) fails the exact-key intake
    const { proofWorkDate: _omitted, ...truncated } = directRow
    expectCode(() => rehydrateVerifiedAttendanceOperationIdentityV1(truncated), 'W4C0_DURABLE_ROW_INVALID')
    expectCode(
      () => rehydrateVerifiedAttendanceOperationIdentityV1({ ...directRow, verified: true }),
      'W4C0_DURABLE_ROW_INVALID',
    )
  })

  it('rejects a JS Date in proofWorkDate (timezone-dependent decode is not canonical)', () => {
    const scheduledRow: AttendanceOperationIdentityDurableRowV1 = {
      orgId: ORG,
      entrypoint: 'scheduled',
      kind: 'item',
      operationId: GOLDEN_SCHEDULED_UUID,
      acceptedWritePosture: 'authoritative',
      identitySourceKind: 'scheduled',
      sourceRootId: SCHED_RUN,
      inputOrdinal: null,
      proofSemanticFingerprint: null,
      proofUserId: SCHED_USER,
      proofWorkDate: SCHED_DATE,
    }
    expect(rehydrateVerifiedAttendanceOperationIdentityV1(scheduledRow).id).toBe(GOLDEN_SCHEDULED_UUID)
    expectCode(
      () =>
        rehydrateVerifiedAttendanceOperationIdentityV1({
          ...scheduledRow,
          proofWorkDate: new Date('2026-03-01T00:00:00Z') as unknown as string,
        }),
      'W4C0_WORK_DATE_INVALID',
    )
  })
})

// ---------------------------------------------------------------------------
// Amendment gates 4/6: advisory keys, witness refusal, goldens, classes, helpers.
// ---------------------------------------------------------------------------

describe('advisory key builders and acquisition helpers', () => {
  it('pins the exact signed-bigint goldens for all four key classes', async () => {
    expect(buildAttendanceCalculationRolloutAdvisoryKey(parseCanonicalAttendanceRolloutOrgKeyV1('default'))).toBe(
      GOLDEN_ROLLOUT_KEY_DEFAULT,
    )
    expect(buildAttendanceCalculationRolloutAdvisoryKey(parseCanonicalAttendanceRolloutOrgKeyV1(ORG))).toBe(
      GOLDEN_ROLLOUT_KEY_ORG,
    )
    const org = await orgIdentity(ORG, null)
    const item = createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'item',
      entrypoint: 'live_punch',
      source: { sourceKind: 'direct_live_punch', clientOperationId: DIRECT_ID },
    })
    expect(buildAttendanceResultOperationAdvisoryKey(item)).toBe(GOLDEN_OPERATION_KEY_ITEM)
    const batch = createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'batch',
      entrypoint: 'import_batch',
      source: { sourceKind: 'import_batch', batchCommandId: IMPORT_ROOT },
    })
    expect(buildAttendanceResultOperationAdvisoryKey(batch)).toBe(GOLDEN_OPERATION_KEY_BATCH)
    const target = createVerifiedAttendanceCalculationTargetIdentityV1({ org, userId: SCHED_USER, workDate: SCHED_DATE })
    expect(buildAttendanceCalculationTargetAdvisoryKey(target)).toBe(GOLDEN_TARGET_KEY)
    const runKey = parseCanonicalAttendanceScheduledRunKeyV1({ orgId: ORG, initiator: 'cron', workDate: SCHED_DATE })
    expect(buildAttendanceScheduledRunAdvisoryKey(runKey)).toBe(GOLDEN_SCHEDULED_RUN_KEY)
  })

  // W4C-2 amendment section 1.6 (PR #4617, RATIFIED, gate 16): rewritten to (a) enumerate
  // every builder the module EXPORTS rather than naming three/four by hand, (b) assert the
  // run builder's key lands in [2^62, 2^63) and every OTHER builder's key does not, (c) fail
  // if an exported builder has no registered class expectation — so a future fifth builder
  // cannot repeat the gap the pre-amendment hand-written list had (adding this amendment's
  // fourth builder would NOT have failed the old hand-written-list form).
  const CLASS_EXPECTATIONS: Readonly<
    Record<string, { readonly min: bigint; readonly maxExclusive: bigint; readonly invoke: () => bigint }>
  > = {
    buildAttendanceCalculationRolloutAdvisoryKey: {
      min: 0n,
      maxExclusive: CLASS_01_MIN,
      invoke: () => buildAttendanceCalculationRolloutAdvisoryKey(parseCanonicalAttendanceRolloutOrgKeyV1(ORG)),
    },
    buildAttendanceScheduledRunAdvisoryKey: {
      min: CLASS_01_MIN,
      maxExclusive: CLASS_01_MAX_EXCLUSIVE,
      invoke: () =>
        buildAttendanceScheduledRunAdvisoryKey(
          parseCanonicalAttendanceScheduledRunKeyV1({ orgId: ORG, initiator: 'cron', workDate: SCHED_DATE }),
        ),
    },
    buildAttendanceResultOperationAdvisoryKey: {
      min: CLASS_10_MIN,
      maxExclusive: CLASS_11_MIN,
      invoke: () => GOLDEN_OPERATION_KEY_ITEM,
    },
    buildAttendanceLegacyIdempotencyAdvisoryKey: {
      min: CLASS_10_MIN,
      maxExclusive: CLASS_11_MIN,
      invoke: () =>
        buildAttendanceLegacyIdempotencyAdvisoryKey(
          parseCanonicalAttendanceLegacyIdempotencyKeyV1({
            orgId: ORG,
            idempotencyKey: 'retry-1',
          }),
        ),
    },
    buildAttendanceCalculationTargetAdvisoryKey: {
      min: CLASS_11_MIN,
      maxExclusive: 0n,
      invoke: () => GOLDEN_TARGET_KEY,
    },
    buildAttendanceOperationalBulkTargetAdvisoryKey: {
      min: CLASS_11_MIN,
      maxExclusive: 0n,
      invoke: () =>
        buildAttendanceOperationalBulkTargetAdvisoryKey(
          parseCanonicalAttendanceRolloutOrgKeyV1(ORG),
        ),
    },
  }

  function exportedAdvisoryKeyBuilderNames(): string[] {
    return Object.keys(w4c0Identity).filter((name) => /^build.*AdvisoryKey$/.test(name))
  }

  it('gate 16: enumerates every exported build*AdvisoryKey builder (not a hand-written list) and asserts each key falls in exactly one class range', () => {
    const names = exportedAdvisoryKeyBuilderNames()
    // Sanity: the enumeration itself must find every real builder, not silently zero.
    expect(names.sort()).toEqual(
      [
        'buildAttendanceCalculationRolloutAdvisoryKey',
        'buildAttendanceCalculationTargetAdvisoryKey',
        'buildAttendanceLegacyIdempotencyAdvisoryKey',
        'buildAttendanceOperationalBulkTargetAdvisoryKey',
        'buildAttendanceResultOperationAdvisoryKey',
        'buildAttendanceScheduledRunAdvisoryKey',
      ].sort(),
    )
    for (const name of names) {
      const expectation = CLASS_EXPECTATIONS[name]
      // (c): an exported builder with no registered class expectation fails the gate rather
      // than passing silently.
      if (!expectation) {
        throw new Error(`exported builder ${name} has no registered class-range expectation — add one`)
      }
      const key = expectation.invoke()
      expect(key >= expectation.min && key < expectation.maxExclusive).toBe(true)
      // Every OTHER registered builder's own range must NOT contain this key.
      for (const [otherName, other] of Object.entries(CLASS_EXPECTATIONS)) {
        if (otherName === name) continue
        if (
          other.min === expectation.min &&
          other.maxExclusive === expectation.maxExclusive
        ) {
          continue
        }
        expect(key >= other.min && key < other.maxExclusive).toBe(false)
      }
    }
  })

  it('gate 16 regression proof: a synthetic fifth builder with a deliberately wrong class assignment is caught by the cross-check (not passed silently)', () => {
    // The run key (real class 01) misregistered under class 00's range — the exact shape a
    // future fifth builder with a copy-paste class-prefix bug would produce.
    const runKey = CLASS_EXPECTATIONS.buildAttendanceScheduledRunAdvisoryKey.invoke()
    const buggyExpectation = { min: 0n, maxExclusive: CLASS_01_MIN }
    expect(runKey >= buggyExpectation.min && runKey < buggyExpectation.maxExclusive).toBe(false)
  })

  it('keeps the two-bit classes disjoint: 00 rollout, 10 operation, 11 target, 01 scheduled-run only', async () => {
    // class 00: [0, 2^62)
    expect(GOLDEN_ROLLOUT_KEY_DEFAULT >= 0n && GOLDEN_ROLLOUT_KEY_DEFAULT < CLASS_01_MIN).toBe(true)
    expect(GOLDEN_ROLLOUT_KEY_ORG >= 0n && GOLDEN_ROLLOUT_KEY_ORG < CLASS_01_MIN).toBe(true)
    // class 01: [2^62, 2^63) — assigned to the scheduled-run builder (OD-W4C-49=(a))
    expect(GOLDEN_SCHEDULED_RUN_KEY >= CLASS_01_MIN && GOLDEN_SCHEDULED_RUN_KEY < CLASS_01_MAX_EXCLUSIVE).toBe(true)
    // class 10: [-2^63, -2^62)
    for (const key of [GOLDEN_OPERATION_KEY_ITEM, GOLDEN_OPERATION_KEY_BATCH]) {
      expect(key >= CLASS_10_MIN && key < CLASS_11_MIN).toBe(true)
    }
    // class 11: [-2^62, 0)
    expect(GOLDEN_TARGET_KEY >= CLASS_11_MIN && GOLDEN_TARGET_KEY < 0n).toBe(true)
    // Forced equal raw digests still yield four distinct PostgreSQL keys (class
    // bits). Builders intentionally sharing a class collide to one key, which
    // the complete reservation helper de-duplicates before acquisition.
    __setAttendanceW4DigestSeamForTests(() => Buffer.alloc(32, 0x5a))
    try {
      const rolloutKey = buildAttendanceCalculationRolloutAdvisoryKey(parseCanonicalAttendanceRolloutOrgKeyV1(ORG))
      const org = await orgIdentity(ORG, null)
      const operation = createVerifiedAttendanceOperationIdentityV1({
        org,
        kind: 'item',
        entrypoint: 'live_punch',
        source: { sourceKind: 'direct_live_punch', clientOperationId: DIRECT_ID },
      })
      const operationKey = buildAttendanceResultOperationAdvisoryKey(operation)
      const legacyIdempotencyKey = buildAttendanceLegacyIdempotencyAdvisoryKey(
        parseCanonicalAttendanceLegacyIdempotencyKeyV1({
          orgId: ORG,
          idempotencyKey: 'retry-1',
        }),
      )
      const target = createVerifiedAttendanceCalculationTargetIdentityV1({ org, userId: SCHED_USER, workDate: SCHED_DATE })
      const targetKey = buildAttendanceCalculationTargetAdvisoryKey(target)
      const operationalBulkTargetKey =
        buildAttendanceOperationalBulkTargetAdvisoryKey(
          parseCanonicalAttendanceRolloutOrgKeyV1(ORG),
        )
      const runKey = buildAttendanceScheduledRunAdvisoryKey(
        parseCanonicalAttendanceScheduledRunKeyV1({ orgId: ORG, initiator: 'cron', workDate: SCHED_DATE }),
      )
      expect(operationKey).toBe(legacyIdempotencyKey)
      expect(targetKey).toBe(operationalBulkTargetKey)
      expect(
        new Set([
          rolloutKey,
          operationKey,
          legacyIdempotencyKey,
          targetKey,
          operationalBulkTargetKey,
          runKey,
        ]).size,
      ).toBe(4)
      // Only the run key lands in the 01 class range under forced-equal raw digests too.
      expect(runKey >= CLASS_01_MIN && runKey < CLASS_01_MAX_EXCLUSIVE).toBe(true)
      for (const key of [rolloutKey, operationKey, targetKey]) {
        expect(key >= CLASS_01_MIN && key < CLASS_01_MAX_EXCLUSIVE).toBe(false)
      }
    } finally {
      __setAttendanceW4DigestSeamForTests(null)
    }
  })

  it('uppercase UUID input produces the same identity and key', async () => {
    const org = await orgIdentity(ORG, null)
    const upper = createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'item',
      entrypoint: 'live_punch',
      source: { sourceKind: 'direct_live_punch', clientOperationId: DIRECT_ID.toUpperCase() },
    })
    expect(upper.id).toBe(DIRECT_ID)
    expect(buildAttendanceResultOperationAdvisoryKey(upper)).toBe(GOLDEN_OPERATION_KEY_ITEM)
  })

  it('rejects plain-object/JSON-clone/spread/prototype forgeries at every builder (gate 4)', async () => {
    const org = await orgIdentity(ORG, null)
    const identity = createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'item',
      entrypoint: 'live_punch',
      source: { sourceKind: 'direct_live_punch', clientOperationId: DIRECT_ID },
    })
    const target = createVerifiedAttendanceCalculationTargetIdentityV1({ org, userId: SCHED_USER, workDate: SCHED_DATE })
    const forgeries = (witness: object): unknown[] => [
      { ...(witness as Record<string, unknown>) },
      JSON.parse(JSON.stringify(witness)),
      Object.assign(Object.create(null), witness),
      Object.setPrototypeOf({ ...(witness as Record<string, unknown>) }, Object.getPrototypeOf(witness) as object | null),
    ]
    for (const forged of forgeries(identity)) {
      expectCode(
        () => buildAttendanceResultOperationAdvisoryKey(forged as never),
        'W4C0_OPERATION_WITNESS_REQUIRED',
      )
    }
    for (const forged of forgeries(target)) {
      expectCode(
        () => buildAttendanceCalculationTargetAdvisoryKey(forged as never),
        'W4C0_TARGET_WITNESS_REQUIRED',
      )
    }
    // a forged ORG inside an otherwise-valid factory input also fails
    expectCode(
      () =>
        createVerifiedAttendanceOperationIdentityV1({
          org: { ...(org as Record<string, unknown>) },
          kind: 'item',
          entrypoint: 'live_punch',
          source: { sourceKind: 'direct_live_punch', clientOperationId: DIRECT_ID },
        }),
      'W4C0_ORG_WITNESS_REQUIRED',
    )
    // verified witnesses are frozen: post-mint mutation is impossible
    expect(Object.isFrozen(identity)).toBe(true)
    expect(Object.isFrozen(identity.sourceProof)).toBe(true)
    expect(() => {
      ;(identity as unknown as Record<string, unknown>).id = DIRECT_ID
    }).toThrow(TypeError)
  })

  it('acquires locks in final signed-key numeric order with de-duplication', async () => {
    const org = await orgIdentity(ORG, null)
    const a = createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'item',
      entrypoint: 'live_punch',
      source: { sourceKind: 'direct_live_punch', clientOperationId: DIRECT_ID },
    })
    const b = createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'batch',
      entrypoint: 'import_batch',
      source: { sourceKind: 'import_batch', batchCommandId: IMPORT_ROOT },
    })
    const trx = stubTrx()
    // supply in DESCENDING key order plus a duplicate; helper must sort ascending and dedupe.
    // Stage C deadline protocol (lock 7.1): each final-key acquisition is preceded by a
    // transaction-local lock_timeout budget, and success restores the contract timeout.
    await acquireAttendanceResultOperationLocks(trx, [b, a, b])
    const acquisitions = trx.calls.filter((call) => call.sqlText.includes('pg_advisory'))
    expect(acquisitions.map((call) => call.sqlText)).toEqual([
      'SELECT pg_advisory_xact_lock($1::bigint)',
      'SELECT pg_advisory_xact_lock($1::bigint)',
    ])
    expect(acquisitions.map((call) => call.params[0])).toEqual([
      GOLDEN_OPERATION_KEY_ITEM.toString(), // -9078... < -4625...
      GOLDEN_OPERATION_KEY_BATCH.toString(),
    ])
    // Exact interleave: budget before EACH key; restore (5000ms) after the final key.
    expect(trx.calls.map((call) => call.sqlText)).toEqual([
      "SELECT set_config('lock_timeout', $1, true)",
      'SELECT pg_advisory_xact_lock($1::bigint)',
      "SELECT set_config('lock_timeout', $1, true)",
      'SELECT pg_advisory_xact_lock($1::bigint)',
      "SELECT set_config('lock_timeout', $1, true)",
    ])
    const budgets = trx.calls.filter((call) => call.sqlText.includes('set_config')).map((call) => Number(call.params[0]))
    expect(budgets[budgets.length - 1]).toBe(5000) // restore = W4_TRANSACTION_LOCK_TIMEOUT_MS
    expect(budgets.slice(0, -1).every((ms) => ms > 0 && ms <= 5000)).toBe(true)
  })

  it('forced same-final-key collision requires exactly one acquisition; crossed digests keep numeric order', async () => {
    const org = await orgIdentity(ORG, null)
    const a = createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'item',
      entrypoint: 'live_punch',
      source: { sourceKind: 'direct_live_punch', clientOperationId: DIRECT_ID },
    })
    const b = createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'item',
      entrypoint: 'manual_edit',
      source: { sourceKind: 'direct_manual_edit', clientOperationId: DIRECT_ID },
    })
    // same-final-key collision
    __setAttendanceW4DigestSeamForTests(() => Buffer.alloc(32, 0x11))
    let trx = stubTrx()
    await acquireAttendanceResultOperationLocks(trx, [a, b])
    expect(trx.calls.filter((call) => call.sqlText.includes('pg_advisory')).length).toBe(1)
    // crossed raw digests: whichever tuple hashes lower acquires first (numeric final key order)
    const digestByFirstByte = (preimage: Buffer): Buffer =>
      preimage.includes(Buffer.from('manual_edit', 'utf8')) ? Buffer.alloc(32, 0x01) : Buffer.alloc(32, 0x22)
    __setAttendanceW4DigestSeamForTests(digestByFirstByte)
    trx = stubTrx()
    await acquireAttendanceResultOperationLocks(trx, [a, b])
    const keys = trx.calls
      .filter((call) => call.sqlText.includes('pg_advisory'))
      .map((call) => BigInt(call.params[0] as string))
    expect(keys.length).toBe(2)
    expect(keys[0] < keys[1]).toBe(true)
  })

  it('normalizes the legacy key, takes the shipped compatibility lock first, then sorts class-10 keys', async () => {
    const org = await orgIdentity(ORG, null)
    const batch = createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'batch',
      entrypoint: 'import_batch',
      source: { sourceKind: 'import_batch', batchCommandId: IMPORT_ROOT },
    })
    const legacyKey = parseCanonicalAttendanceLegacyIdempotencyKeyV1({
      orgId: ORG,
      idempotencyKey: '  retry-1  ',
    })
    expect(legacyKey.idempotencyKey).toBe('retry-1')
    const key = buildAttendanceLegacyIdempotencyAdvisoryKey(legacyKey)
    expect(key >= CLASS_10_MIN && key < CLASS_11_MIN).toBe(true)

    const trx = stubTrx()
    await acquireAttendanceImportReservationLocksV1(trx, [batch], legacyKey)
    const advisoryCalls = trx.calls.filter((call) =>
      call.sqlText.includes('pg_advisory'),
    )
    expect(advisoryCalls[0]).toEqual({
      sqlText:
        'SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))',
      params: [ORG, 'retry-1'],
    })
    const acquired = advisoryCalls
      .slice(1)
      .map((call) => BigInt(call.params[0] as string))
    expect(acquired).toHaveLength(2)
    expect(acquired[0] < acquired[1]).toBe(true)

    __setAttendanceW4DigestSeamForTests(() => Buffer.alloc(32, 0x11))
    const collided = stubTrx()
    await acquireAttendanceImportReservationLocksV1(collided, [batch], legacyKey)
    expect(
      collided.calls.filter((call) => call.sqlText.includes('pg_advisory')),
    ).toHaveLength(2)
    expectCode(
      () =>
        parseCanonicalAttendanceLegacyIdempotencyKeyV1({
          orgId: ORG,
          idempotencyKey: ' ',
        }),
      'W4C3A_LEGACY_IDEMPOTENCY_KEY_INVALID',
    )
  })

  it('derives and acquires exactly one class-11 operational bulk sentinel', async () => {
    const org = parseCanonicalAttendanceRolloutOrgKeyV1(ORG)
    const key = buildAttendanceOperationalBulkTargetAdvisoryKey(org)
    expect(key >= CLASS_11_MIN && key < 0n).toBe(true)
    const trx = stubTrx()
    await acquireAttendanceOperationalBulkTargetLockV1(trx, org)
    expect(trx.calls.filter((call) => call.sqlText.includes('pg_advisory'))).toEqual([
      {
        sqlText: 'SELECT pg_advisory_xact_lock($1::bigint)',
        params: [key.toString()],
      },
    ])
  })

  it('rollout helper is the sole shared/exclusive selector and enum-rejects other modes', async () => {
    const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1('default')
    const trx = stubTrx()
    await acquireAttendanceCalculationRolloutLock(trx, orgKey, 'shared')
    await acquireAttendanceCalculationRolloutLock(trx, orgKey, 'exclusive')
    expect(trx.calls.filter((call) => call.sqlText.includes('pg_advisory'))).toEqual([
      { sqlText: 'SELECT pg_advisory_xact_lock_shared($1::bigint)', params: [GOLDEN_ROLLOUT_KEY_DEFAULT.toString()] },
      { sqlText: 'SELECT pg_advisory_xact_lock($1::bigint)', params: [GOLDEN_ROLLOUT_KEY_DEFAULT.toString()] },
    ])
    await expect(
      acquireAttendanceCalculationRolloutLock(trx, orgKey, 'try' as never),
    ).rejects.toMatchObject({ code: 'W4C0_LOCK_MODE_INVALID' })
    // pre-lock isolation: the rollout builder takes lexical parser output, not witnesses,
    // and re-validates it — a non-canonical raw string cannot reach the hash
    expectCode(
      () => buildAttendanceCalculationRolloutAdvisoryKey(`{${ORG}}` as never),
      'W4C0_ROLLOUT_ORG_KEY_INVALID',
    )
  })

  it('propagates a non-55P03 acquisition error unchanged (fail-closed) — gate P2-1', async () => {
    // Gate finding P2-1: the previous leg's stub threw on EVERY query, so it exploded at
    // set_config — which is OUTSIDE the try — and the isLockNotAvailable catch was never
    // entered. Neutering the guard to swallow everything left all tests green (the leg
    // passed for the wrong reason). This stub lets set_config succeed and fails ONLY the
    // pg_advisory acquisition, so the catch IS reached and the discrimination the lock
    // names twice verbatim ("a real 40001/40P01/42883 must propagate, never be relabelled
    // as routine lock contention") is actually exercised — on all three helpers.
    const acquisitionOnlyFailure = (code: string): AttendanceW4TransactionClientV1 => ({
      async query(sqlText: string) {
        if (sqlText.includes('pg_advisory')) {
          const e = new Error('acquisition failed') as Error & { code?: string }
          e.code = code // NOT 55P03 — must NOT be relabelled as "busy"
          throw e
        }
        return { rows: [] } // set_config succeeds, so the catch IS reached
      },
    })
    const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(ORG)
    await expect(
      acquireAttendanceCalculationRolloutLock(acquisitionOnlyFailure('42883'), orgKey, 'shared'),
    ).rejects.toMatchObject({ code: '42883' })

    const org = await orgIdentity(ORG, null)
    const op = createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'item',
      entrypoint: 'live_punch',
      source: { sourceKind: 'direct_live_punch', clientOperationId: DIRECT_ID },
    })
    await expect(
      acquireAttendanceResultOperationLocks(acquisitionOnlyFailure('40001'), [op]),
    ).rejects.toMatchObject({ code: '40001' })

    const target = createVerifiedAttendanceCalculationTargetIdentityV1({ org, userId: SCHED_USER, workDate: SCHED_DATE })
    await expect(
      acquireAttendanceCalculationTargetLocks(acquisitionOnlyFailure('40P01'), [target]),
    ).rejects.toMatchObject({ code: '40P01' })

    const runKey = parseCanonicalAttendanceScheduledRunKeyV1({ orgId: ORG, initiator: 'cron', workDate: SCHED_DATE })
    await expect(
      acquireAttendanceScheduledRunLock(acquisitionOnlyFailure('57014'), runKey),
    ).rejects.toMatchObject({ code: '57014' })
  })

  it('scheduled-run helper (section 1.6): acquires the exact class-01 golden key with the deadline protocol; its own 55P03 maps to values-free 503 ATTENDANCE_SCHEDULED_RUN_BUSY, lockClass=scheduled_run', async () => {
    const runKey = parseCanonicalAttendanceScheduledRunKeyV1({ orgId: ORG, initiator: 'cron', workDate: SCHED_DATE })
    const trx = stubTrx()
    await acquireAttendanceScheduledRunLock(trx, runKey)
    const acquisitions = trx.calls.filter((call) => call.sqlText.includes('pg_advisory'))
    expect(acquisitions).toEqual([
      { sqlText: 'SELECT pg_advisory_xact_lock($1::bigint)', params: [GOLDEN_SCHEDULED_RUN_KEY.toString()] },
    ])

    const busyStub: AttendanceW4TransactionClientV1 = {
      async query(sqlText: string) {
        if (sqlText.includes('pg_advisory')) {
          const e = new Error('lock not available') as Error & { code?: string }
          e.code = '55P03'
          throw e
        }
        return { rows: [] }
      },
    }
    await expect(acquireAttendanceScheduledRunLock(busyStub, runKey)).rejects.toMatchObject({
      code: 'ATTENDANCE_SCHEDULED_RUN_BUSY',
      httpStatus: 503,
      lockClass: 'scheduled_run',
    })

    // pre-lock isolation: the run-key builder re-validates its lexical input; a raw string
    // (not the parsed tuple shape) cannot bypass the parser.
    expectCode(
      () => buildAttendanceScheduledRunAdvisoryKey(`{${ORG}}` as never),
      'W4C0_SCHEDULED_RUN_KEY_INPUT_INVALID',
    )
  })

  it('rehydrateVerifiedAttendanceOrgIdentityV1 (reused by the W4C-2 scheduled-run identity layer): mints an org witness from durable proof and re-applies the default/posture door on every reload', () => {
    const witness = rehydrateVerifiedAttendanceOrgIdentityV1({ orgId: ORG, acceptedWritePosture: 'shadow' })
    expect(witness.orgId).toBe(ORG)
    expect(witness.acceptedWritePosture).toBe('shadow')
    // amendment gate 1's default/posture door: `default` + shadow|authoritative is rejected
    // even on a durable-reload path, not only on first mint.
    expectCode(
      () => rehydrateVerifiedAttendanceOrgIdentityV1({ orgId: 'default', acceptedWritePosture: 'shadow' }),
      'W4C0_DEFAULT_ORG_POSTURE_REJECTED',
    )
    expectCode(
      () => rehydrateVerifiedAttendanceOrgIdentityV1({ orgId: ORG, acceptedWritePosture: 'not-a-posture' }),
      'W4C0_WRITE_POSTURE_INVALID',
    )
    // partial/extra-field shapes are rejected (JSON-clone/spread forgery resistance).
    expectCode(
      () => rehydrateVerifiedAttendanceOrgIdentityV1({ orgId: ORG }),
      'W4C0_ORG_DURABLE_ROW_INVALID',
    )
    expectCode(
      () => rehydrateVerifiedAttendanceOrgIdentityV1({ orgId: ORG, acceptedWritePosture: 'shadow', extra: 1 }),
      'W4C0_ORG_DURABLE_ROW_INVALID',
    )
  })

  it('deadline uses a monotonic clock, not wall-clock — per-key budgets strictly decrease (gate P2-2)', async () => {
    // Gate finding P2-2 (implementer self-declared, gate upheld): performance.now() ->
    // Date.now() survived every leg, yet the lock names "using wall-clock time" as an
    // independently-failing mutation. Shape assertion, not a timing threshold: freeze
    // Date.now with NO clock seam installed and record the set_config('lock_timeout', …)
    // budget sequence across a multi-key acquisition where each acquisition burns real
    // monotonic time. On performance.now() the recorded budgets strictly decrease (real
    // time still elapses while Date.now is frozen); on Date.now() the deadline arithmetic
    // freezes with it, so every key sees the SAME budget — exactly the "resetting the
    // deadline per key" defect — and this leg turns red.
    const savedDateNow = Date.now
    Date.now = () => 1_000_000
    try {
      const budgets: number[] = []
      const recordingTrx: AttendanceW4TransactionClientV1 = {
        async query(sqlText: string, params?: readonly unknown[]) {
          if (sqlText.includes("set_config('lock_timeout'")) {
            budgets.push(Number(params?.[0]))
          }
          if (sqlText.includes('pg_advisory')) {
            const spinUntil = performance.now() + 6
            while (performance.now() < spinUntil) {
              // burn >5ms of real monotonic time per acquisition, immune to fake timers
            }
          }
          return { rows: [] }
        },
      }
      const org = await orgIdentity(ORG, null)
      const targets = [SCHED_USER, DIRECT_ID].map((userId) =>
        createVerifiedAttendanceCalculationTargetIdentityV1({ org, userId, workDate: SCHED_DATE }),
      )
      await acquireAttendanceCalculationTargetLocks(recordingTrx, targets)
      // budgets = [key1, key2, restore]; drop the trailing restore of the normal timeout.
      const perKey = budgets.slice(0, -1)
      expect(perKey.length).toBe(2)
      expect(perKey[1]).toBeLessThan(perKey[0])
    } finally {
      Date.now = savedDateNow
    }
  })

  it('forbids installing the digest seam outside a test runtime', () => {
    const savedVitest = process.env.VITEST
    const savedNodeEnv = process.env.NODE_ENV
    try {
      delete process.env.VITEST
      process.env.NODE_ENV = 'production'
      expectCode(() => __setAttendanceW4DigestSeamForTests(() => Buffer.alloc(32)), 'W4C0_DIGEST_SEAM_FORBIDDEN')
    } finally {
      if (savedVitest === undefined) delete process.env.VITEST
      else process.env.VITEST = savedVitest
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = savedNodeEnv
    }
  })
})
