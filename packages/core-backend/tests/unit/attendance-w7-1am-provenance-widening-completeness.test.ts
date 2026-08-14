/**
 * W7-1a-M (#4556) — the LOAD-BEARING completeness test.
 *
 * Ratified per #4556 comments 5293034619 + 5293478713, whose 执行序 makes a
 * "derive-and-diff 完备性测试" the承重 deliverable for this slice: walk the
 * derived consumer table and assert every point is widened — 漏一点即红.
 *
 * The source-text surface is checked here. The DB surface is checked in
 * `../integration/attendance-w7-1am-provenance-widening.db.test.ts`, derived
 * from the live catalogue rather than from migration text (see that file and the
 * scanner's header for why migration text cannot be the source of truth).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_PROJECTION_OWNERS_SQL_LIST_V1,
  ATTENDANCE_PROJECTION_OWNERS_V1,
  ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_SQL_LIST_V1,
  ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_V1,
  ATTENDANCE_TRACE_SOURCE_KINDS_V1,
  isAttendanceProjectionOwnerV1,
  isAttendanceProjectionOwnerWithCalculationPointerV1,
} from '../../src/attendance/w7-provenance-domain'
import {
  W7_PROVENANCE_WIDENING_LEDGER_V1,
  deriveProvenanceWideningSurfaceV1,
  diffProvenanceWideningV1,
  resolveRepoRootV1,
  type W7DerivedSiteV1,
} from '../utils/w7-provenance-widening-scan'

const repoRoot = resolveRepoRootV1()
const derivation = deriveProvenanceWideningSurfaceV1({ repoRoot })

function sitesIn(fileSuffix: string): W7DerivedSiteV1[] {
  return derivation.sites.filter((site) => site.file.endsWith(fileSuffix))
}

describe('W7-1a-M provenance widening — derive-and-diff completeness', () => {
  it('every derived site is widened or carries a satisfied neutrality rule', () => {
    const violations = diffProvenanceWideningV1(derivation, W7_PROVENANCE_WIDENING_LEDGER_V1)
    expect(violations.map((violation) => `${violation.kind}: ${violation.detail}`)).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Non-vacuity. A derivation that found nothing would pass the diff trivially,
  // so the shape of what it found is asserted, not just the empty violation set.
  // -------------------------------------------------------------------------

  it('non-vacuity: the derivation actually walked the tree', () => {
    expect(derivation.scannedFileCount).toBeGreaterThan(500)
    expect(derivation.anchoredFileCount).toBeGreaterThanOrEqual(10)
    expect(derivation.sites.length).toBeGreaterThanOrEqual(80)
    expect(W7_PROVENANCE_WIDENING_LEDGER_V1.length).toBeGreaterThanOrEqual(80)
  })

  it('non-vacuity: the alias taint hop found real aliases', () => {
    // `owner` (w4c2-authoritative-calculation-core) and `projectionOwner`
    // (the `projection_owner AS "projectionOwner"` SQL rename + local consts).
    expect(derivation.aliasIdentifiers).toContain('owner')
    expect(derivation.aliasIdentifiers).toContain('projectionOwner')
  })

  it('non-vacuity: the derivation covers every kind of consumer the ruling names', () => {
    // TS union.
    expect(sitesIn('src/services/AttendanceDecisionTrace.ts').length).toBeGreaterThan(0)
    // TS closed-set array behind a runtime `isClosedValue` gate.
    expect(sitesIn('src/services/AttendanceW4CalculationDetail.ts').length).toBeGreaterThan(0)
    // Exhaustive validations (two independent copies) + the pointer derivation.
    expect(sitesIn('src/attendance/w4c3a-import-rollback.ts').length).toBeGreaterThanOrEqual(5)
    // Silent-downgrade folds — the sites that contain NO target string.
    expect(sitesIn('src/attendance/w4c2-authoritative-calculation-core.ts').length).toBeGreaterThan(0)
    expect(sitesIn('src/attendance/w4c2-live-scheduled-boundary.ts').length).toBeGreaterThan(0)
    // SQL embedded in TS.
    expect(sitesIn('src/attendance/w4c3a-import-rollback-boundary.ts').length).toBeGreaterThan(0)
    // OpenAPI enum.
    expect(sitesIn('packages/openapi/src/base.yml').length).toBeGreaterThan(0)
    // The web app's INDEPENDENT copy: closed array + exhaustive switch. The W7-0
    // record asserted no exhaustive consumer of this union existed anywhere —
    // the derivation refutes that, which is why enumeration was refused.
    expect(sitesIn('apps/web/src/views/attendance/attendanceDecisionTrace.ts').length).toBeGreaterThanOrEqual(6)
    // Ops scripts.
    expect(sitesIn('scripts/ops/staging-attendance-tooling-teardown.mjs').length).toBeGreaterThan(0)
  })

  it('non-vacuity: every ledger rule name is actually exercised', () => {
    const used = new Set(W7_PROVENANCE_WIDENING_LEDGER_V1.map((entry) => entry.rule))
    for (const rule of [
      'closed_set_member_list',
      'exhaustive_switch_arm',
      'widened_predicate',
      'widened_predicate_continuation',
      'legacy_polarity',
      'write_side_emitter',
      'null_default',
      'domain_definition',
      'w7_0_recorded_snapshot',
    ]) {
      expect(used).toContain(rule)
    }
  })

  // -------------------------------------------------------------------------
  // Planted consumers. The diff must RED on an un-widened consumer, and the
  // scanner must SEE a consumer that contains no target string at all.
  // -------------------------------------------------------------------------

  function scanPlanted(fileName: string, source: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w7-1am-planted-'))
    try {
      fs.mkdirSync(path.join(dir, 'planted'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'planted', fileName), source, 'utf8')
      return deriveProvenanceWideningSurfaceV1({ repoRoot: dir, roots: ['planted'] })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('planted consumer: an un-widened membership test is derived and REDS the diff', () => {
    const planted = scanPlanted(
      'planted-consumer.ts',
      [
        'export function parse(row: { projection_owner: string }) {',
        "  if (row.projection_owner !== 'legacy_untracked' && row.projection_owner !== 'w4') {",
        "    throw new Error('unsupported')",
        '  }',
        '  return row.projection_owner',
        '}',
        '',
      ].join('\n'),
    )
    expect(planted.sites.length).toBeGreaterThan(0)

    // Against the real ledger it is unledgered; that alone must fail.
    const violations = diffProvenanceWideningV1(planted, W7_PROVENANCE_WIDENING_LEDGER_V1)
    expect(violations.some((violation) => violation.kind === 'unledgered_site')).toBe(true)

    // And even if someone ledgers it as widened, the evidence check still fails —
    // so the ledger cannot be used to wave a real gap through.
    const ledgered = diffProvenanceWideningV1(
      planted,
      planted.sites.map((site) => ({
        file: site.file,
        text: site.text,
        rule: 'widened_predicate' as const,
      })),
    )
    expect(ledgered.some((violation) => violation.kind === 'not_widened')).toBe(true)
  })

  it('planted consumer: a SILENT-DOWNGRADE fold containing no target string is still derived', () => {
    // This is the shape the ratification calls out: no `w4_group` anywhere in it,
    // so any derivation that grepped for the new value would miss it entirely.
    const planted = scanPlanted(
      'planted-fold.ts',
      [
        'export function fold(row: { projection_owner: string }) {',
        "  return { projectionOwner: row.projection_owner === 'w4' ? 'w4' : 'legacy_untracked' }",
        '}',
        '',
      ].join('\n'),
    )
    const foldSites = planted.sites.filter((site) => site.text.includes('legacy_untracked'))
    expect(foldSites.length).toBeGreaterThan(0)
    expect(foldSites.every((site) => !site.text.includes('w4_group'))).toBe(true)
    expect(
      diffProvenanceWideningV1(planted, W7_PROVENANCE_WIDENING_LEDGER_V1).some(
        (violation) => violation.kind === 'unledgered_site',
      ),
    ).toBe(true)
  })

  it('planted consumer: an exhaustive SWITCH arm is derived even though it names no field', () => {
    // A `case 'w4':` line mentions neither the column nor an alias, and `'w4'` is
    // an AMBIGUOUS member — so the anchor rule alone would make this whole
    // consumer class invisible. This is the class that actually exists in
    // `apps/web` for the trace family, where it was caught only because
    // `policy_gate` happens to be distinctive. Owner-family switches have no such
    // luck, hence the dedicated case-arm rule.
    const planted = scanPlanted(
      'planted-switch.ts',
      [
        'export function label(projectionOwner: string): string {',
        '  switch (projectionOwner) {',
        "    case 'w4':",
        "      return 'W4 owned'",
        '    default:',
        "      return 'other'",
        '  }',
        '}',
        '',
      ].join('\n'),
    )
    const arms = planted.sites.filter((site) => site.text.startsWith('case '))
    expect(arms.length).toBeGreaterThan(0)
    // Negative control: the arm really does NOT name the field, so it could only
    // have been derived by the case-arm rule.
    expect(arms.every((site) => !/projection_owner|projectionOwner/.test(site.text))).toBe(true)
    expect(
      diffProvenanceWideningV1(planted, W7_PROVENANCE_WIDENING_LEDGER_V1).some(
        (violation) => violation.kind === 'unledgered_site',
      ),
    ).toBe(true)
  })

  it('planted consumer: a stale ledger entry (construct removed) REDS the diff', () => {
    const violations = diffProvenanceWideningV1(derivation, [
      ...W7_PROVENANCE_WIDENING_LEDGER_V1,
      {
        file: 'packages/core-backend/src/attendance/w7-provenance-domain.ts',
        text: "const THIS_CONSTRUCT_DOES_NOT_EXIST = 'legacy_untracked'",
        rule: 'domain_definition',
      },
    ])
    expect(violations.some((violation) => violation.kind === 'stale_ledger_entry')).toBe(true)
  })
})

describe('W7-1a-M provenance widening — domain semantics', () => {
  it('the widened owner domain is exactly the pre-widening set plus w4_group', () => {
    expect([...ATTENDANCE_PROJECTION_OWNERS_V1]).toEqual(['legacy_untracked', 'w4', 'w4_group'])
  })

  it('w4_group inherits w4 NON-NULL pointer semantics; legacy_untracked is the only NULL member', () => {
    expect([...ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_V1]).toEqual(['w4', 'w4_group'])
    expect(isAttendanceProjectionOwnerWithCalculationPointerV1('w4_group')).toBe(true)
    expect(isAttendanceProjectionOwnerWithCalculationPointerV1('w4')).toBe(true)
    expect(isAttendanceProjectionOwnerWithCalculationPointerV1('legacy_untracked')).toBe(false)
    // Every member is either pointer-owning or the single NULL-pointer member.
    for (const owner of ATTENDANCE_PROJECTION_OWNERS_V1) {
      expect(isAttendanceProjectionOwnerWithCalculationPointerV1(owner)).toBe(
        owner !== 'legacy_untracked',
      )
    }
  })

  it('the widening does NOT open the domain generally', () => {
    for (const novel of ['w4_team', 'w5', 'group', '', 'W4_GROUP', 'w4_group ', null, undefined, 7]) {
      expect(isAttendanceProjectionOwnerV1(novel)).toBe(false)
      expect(isAttendanceProjectionOwnerWithCalculationPointerV1(novel)).toBe(false)
    }
  })

  it('the SQL literal lists render exactly the widened members', () => {
    // `w4c3a-import-rollback-boundary.ts` interpolates the second constant into a
    // query, so its rendered text IS the deployed predicate. Pinned here because
    // a malformed list would only surface at query time.
    expect(ATTENDANCE_PROJECTION_OWNERS_SQL_LIST_V1).toBe("'legacy_untracked', 'w4', 'w4_group'")
    expect(ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_SQL_LIST_V1).toBe("'w4', 'w4_group'")
  })

  it('the interpolated closure predicate appears verbatim in the boundary query', () => {
    const source = fs.readFileSync(
      path.join(repoRoot, 'packages/core-backend/src/attendance/w4c3a-import-rollback-boundary.ts'),
      'utf8',
    )
    expect(source).toContain(
      'projection_owner IN (${ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_SQL_LIST_V1})',
    )
    // Negative control: the pre-widening spelling is gone, so this is not a
    // substring that would match either way.
    expect(source).not.toContain("projection_owner = 'w4'")
  })

  it('the web app trace source-kind copy is member-equal to the backend domain', () => {
    // apps/web cannot import backend source, so equality is held by this test.
    const webFile = path.join(
      repoRoot,
      'apps/web/src/views/attendance/attendanceDecisionTrace.ts',
    )
    const source = fs.readFileSync(webFile, 'utf8')
    const block = /export const ATTENDANCE_TRACE_SOURCE_KINDS = \[([\s\S]*?)\] as const/.exec(source)
    expect(block).not.toBeNull()
    const webMembers = [...(block as RegExpExecArray)[1].matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1])
    expect(webMembers).toEqual([...ATTENDANCE_TRACE_SOURCE_KINDS_V1])
    // Negative control: the parse really extracted members, not an empty match.
    expect(webMembers).toContain('group_policy_snapshot')
    expect(webMembers.length).toBeGreaterThanOrEqual(7)
  })
})
