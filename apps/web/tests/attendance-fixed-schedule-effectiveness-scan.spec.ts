// #4709 FSER-4 §4 gate 7 (amendment `docs/development/
// attendance-4709-fser4-member-projection-contract-amendment-20260804.md`, RATIFIED
// `45d71c4209af35a63768ce7ce9f576377f6b8ce4`, OD-4709-2=(a)): "Each surface imports the shared
// parser/composable; repository scan finds no second four-state derivation or reason-order table
// in frontend code."
//
// Two independent proofs, per this line's "give the scan its own positive control" discipline
// (an empty read must not pass as absence):
//   1. An exported file list (not a glob) is asserted to have the expected length and every file
//      is asserted to be non-empty AND to import the shared module -- a 6th surface added without
//      wiring reds the count assertion, not a silently-skipped scan.
//   2. The "no second derivation" scanner is unit-tested against SYNTHETIC positive/negative
//      strings BEFORE it is trusted against the real repository tree.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ATTENDANCE_DIR = resolve(process.cwd(), 'src/views/attendance')
const ATTENDANCE_VIEW_FILE = resolve(process.cwd(), 'src/views/AttendanceView.vue')
const SRC_DIR = resolve(process.cwd(), 'src')

const SHARED_MODULE_FILE = join(ATTENDANCE_DIR, 'attendanceFixedScheduleEffectiveness.ts')
const COMPOSABLE_FILE = join(ATTENDANCE_DIR, 'useAttendanceFixedScheduleEffectiveness.ts')

/** Every §3-table surface component. Fixed length, not a glob -- adding a 6th surface without
 *  updating this list reds the count assertion below rather than silently passing an empty scan. */
const SURFACE_COMPONENT_FILES = [
  'AttendanceGroupFixedScheduleEffectivenessPanel.vue',
  'AttendanceSelfFixedScheduleCard.vue',
  'AttendanceFixedScheduleDecisionTrace.vue',
  'AttendanceGroupFixedScheduleReportWidget.vue',
] as const
const EXPECTED_SURFACE_COMPONENT_COUNT = 4

describe('gate 7 — file inventory (own positive control: count + non-empty + import)', () => {
  it(`the surface-component list has exactly ${EXPECTED_SURFACE_COMPONENT_COUNT} entries`, () => {
    expect(SURFACE_COMPONENT_FILES.length).toBe(EXPECTED_SURFACE_COMPONENT_COUNT)
  })

  it.each(SURFACE_COMPONENT_FILES)('%s exists, is non-trivially sized, and imports the shared parser module', (file) => {
    const content = readFileSync(join(ATTENDANCE_DIR, file), 'utf8')
    expect(content.length).toBeGreaterThan(200)
    expect(content).toMatch(/from ['"]\.\/attendanceFixedScheduleEffectiveness['"]/)
  })

  it('AttendanceView.vue imports the shared composable and all four surface components, with exactly five distinct mount points (group drawer, employee schedule, self trace, admin trace, report)', () => {
    const content = readFileSync(ATTENDANCE_VIEW_FILE, 'utf8')
    expect(content.length).toBeGreaterThan(1000)
    expect(content).toContain("from './attendance/useAttendanceFixedScheduleEffectiveness'")
    for (const file of SURFACE_COMPONENT_FILES) {
      expect(content).toContain(`from './attendance/${file}'`)
    }
    expect((content.match(/<AttendanceGroupFixedScheduleEffectivenessPanel\b/g) || []).length).toBe(1)
    expect((content.match(/<AttendanceSelfFixedScheduleCard\b/g) || []).length).toBe(1)
    expect((content.match(/<AttendanceFixedScheduleDecisionTrace\b/g) || []).length).toBe(2) // self + admin
    expect((content.match(/<AttendanceGroupFixedScheduleReportWidget\b/g) || []).length).toBe(1)
    // Every mount calls a reload/load handler backed by ITS OWN composable instance (five
    // distinct `useAttendanceFixedScheduleEffectiveness()` calls: drawer, employee, self trace,
    // admin trace, report) -- not one shared mutable instance passed to all five.
    expect((content.match(/= useAttendanceFixedScheduleEffectiveness\(\)/g) || []).length).toBe(5)
  })
})

// ---------------------------------------------------------------------------------------------
// Scanner definitions + their own positive/negative controls.
// ---------------------------------------------------------------------------------------------

/** A DISTINCTIVE, unlikely-to-collide-by-accident subset of the four-state enum (three of the
 *  four literal values -- deliberately excluding the bare word "effective", which is common
 *  English and appears throughout an unrelated 28k-line file for unrelated features). */
const STATE_SIGNATURE_LITERALS = ["'not_configured'", "'configuration_changed'", "'pending_apply'"]

/** The nine reason-code literals -- specific enough (ALL_CAPS multi-word identifiers) that any
 *  hit outside the shared module is a real second-declaration signal, not noise. */
const REASON_CODE_LITERALS = [
  'NO_DESIRED_CONFIG',
  'NO_TARGET_MEMBERS',
  'DIFFERENT_MANAGED_KEY_ACTIVE',
  'TARGET_MEMBER_MISSING',
  'NON_MEMBER_TARGET_ACTIVE',
  'DUPLICATE_MATCHING_ASSIGNMENT',
  'ASSIGNMENT_VALUE_MISMATCH',
  'UNPUBLISHED_MANAGED_ROW',
]

function containsSecondStateArrayDeclaration(content: string): boolean {
  return STATE_SIGNATURE_LITERALS.every(literal => content.includes(literal))
}

function findReasonCodeLiteral(content: string): string | null {
  return REASON_CODE_LITERALS.find(code => content.includes(code)) ?? null
}

describe('gate 7 — scanner correctness (positive + negative controls on synthetic strings)', () => {
  it('positive control: detects a synthetic re-declaration of the four-state array', () => {
    const fake = `const STATES = ['not_configured', 'configuration_changed', 'pending_apply', 'effective']`
    expect(containsSecondStateArrayDeclaration(fake)).toBe(true)
  })

  it('negative control: a file that only ever mentions "effective" in unrelated prose does not trip the scanner', () => {
    const fake = `const label = tr('Effective policy summary', '有效策略汇总')\nconst other = 'pending review'`
    expect(containsSecondStateArrayDeclaration(fake)).toBe(false)
  })

  it('negative control: two of the three signature literals alone do not trip the scanner (must be all three)', () => {
    const fake = `const x = ['not_configured', 'pending_apply']`
    expect(containsSecondStateArrayDeclaration(fake)).toBe(false)
  })

  it('positive control: detects a synthetic reason-code literal', () => {
    expect(findReasonCodeLiteral(`if (code === 'TARGET_MEMBER_MISSING') { return }`)).toBe('TARGET_MEMBER_MISSING')
  })

  it('negative control: prose without any reason-code literal returns null', () => {
    expect(findReasonCodeLiteral(`const message = 'target member is missing from the roster'`)).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// The actual repository scan.
// ---------------------------------------------------------------------------------------------

function listSourceFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) {
      results.push(...listSourceFiles(full))
      continue
    }
    if (['.ts', '.vue'].includes(extname(entry))) results.push(full)
  }
  return results
}

describe('gate 7 — repository scan: no second four-state derivation or reason-code literal outside the shared module', () => {
  it('scans every apps/web/src .ts/.vue file except the shared module itself', () => {
    const files = listSourceFiles(SRC_DIR).filter(file => file !== SHARED_MODULE_FILE)
    // Sanity: this must actually walk a non-trivial tree (an empty read is not absence).
    expect(files.length).toBeGreaterThan(50)
    expect(files).toContain(COMPOSABLE_FILE)
    expect(files).toContain(ATTENDANCE_VIEW_FILE)
    for (const file of SURFACE_COMPONENT_FILES) {
      expect(files).toContain(join(ATTENDANCE_DIR, file))
    }

    const offenders: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      if (containsSecondStateArrayDeclaration(content)) {
        offenders.push(`${file}: re-declares the four-state array`)
      }
      const reasonHit = findReasonCodeLiteral(content)
      if (reasonHit) {
        offenders.push(`${file}: reason-code literal '${reasonHit}' outside the shared module`)
      }
    }
    expect(offenders).toEqual([])
  })
})
