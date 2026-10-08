// W5-2 (Wave 5 explainability design-lock 2026-07-22, RATIFIED §6/§9 W5-2): pure-module contract
// for the contextual-help closed-set content — charter §4.6 (L216-225) four categories, per-context
// distribution, values-free assertion (L225 six-item list), reuse-not-duplication of the existing
// closed-set taxonomies (setup templates / xlsx-guard failure codes / W5-1 deep-link builder).
// All content is byte-fixed literal (no fixtures needed — this module takes no runtime input beyond
// a closed-set contextId and a translator function).
import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_CONTEXT_HELP_CATEGORIES,
  ATTENDANCE_CONTEXT_HELP_CONTEXTS,
  ATTENDANCE_IMPORT_HELP_BLOCKED_KINDS,
  ATTENDANCE_IMPORT_HELP_CONVERT_FAILURES,
  attendanceContextHelpCategoryLabel,
  getAttendanceContextHelpEntries,
  isAttendanceContextHelpContextId,
  type AttendanceContextHelpEntry,
} from '../src/views/attendance/attendanceContextHelp'
import { ATTENDANCE_SETUP_TEMPLATES } from '../src/views/attendance/attendanceSetupTemplates'
import { xlsxConvertFailureMessage, type AttendanceXlsxConvertFailure } from '../src/views/attendance/importXlsxConvert'
import { blockedSpreadsheetMessage, type BlockedSpreadsheetKind } from '../src/views/attendance/importFileGuard'
import { buildAttendanceSelfDecisionTraceDeepLink } from '../src/views/attendance/attendanceDecisionTrace'

const trZh = (_en: string, zh: string): string => zh
const trEn = (en: string, _zh: string): string => en

describe('attendanceContextHelp — closed sets', () => {
  it('ATTENDANCE_CONTEXT_HELP_CATEGORIES is exactly the charter §4.6 four bullets, in charter order', () => {
    expect(ATTENDANCE_CONTEXT_HELP_CATEGORIES).toEqual([
      'applicable_scenarios',
      'save_impact',
      'failure_recovery',
      'evidence_link',
    ])
  })

  it('ATTENDANCE_CONTEXT_HELP_CONTEXTS is exactly the three task-picked mount contexts', () => {
    expect(ATTENDANCE_CONTEXT_HELP_CONTEXTS).toEqual(['setup-wizard', 'import', 'self-request-center'])
  })

  it('isAttendanceContextHelpContextId: positive for all three, fail-closed for everything else', () => {
    for (const id of ATTENDANCE_CONTEXT_HELP_CONTEXTS) {
      expect(isAttendanceContextHelpContextId(id)).toBe(true)
    }
    for (const bad of ['setup', 'Import', 'self-request', '', null, undefined, 42, {}, ['import']]) {
      expect(isAttendanceContextHelpContextId(bad)).toBe(false)
    }
  })
})

describe('attendanceContextHelp — category title copy door (charter L220-223 verbatim zh)', () => {
  it('zh leg is byte-for-byte the charter wording', () => {
    expect(attendanceContextHelpCategoryLabel('applicable_scenarios', trZh)).toBe('适用于什么场景')
    expect(attendanceContextHelpCategoryLabel('save_impact', trZh)).toBe('保存后影响谁、何时生效')
    expect(attendanceContextHelpCategoryLabel('failure_recovery', trZh)).toBe('常见失败与如何恢复')
    expect(attendanceContextHelpCategoryLabel('evidence_link', trZh)).toBe('查看计算依据/审计记录')
  })

  it('en leg is locale-routed (a distinct, stable translation — not a leaked zh string)', () => {
    for (const category of ATTENDANCE_CONTEXT_HELP_CATEGORIES) {
      const en = attendanceContextHelpCategoryLabel(category, trEn)
      const zh = attendanceContextHelpCategoryLabel(category, trZh)
      expect(en).not.toBe(zh)
      expect(/[一-鿿]/.test(en)).toBe(false)
    }
  })
})

describe("attendanceContextHelp — 'setup-wizard' context (categories ①②)", () => {
  it('carries EXACTLY applicable_scenarios + save_impact, in that order — no other category', () => {
    const entries = getAttendanceContextHelpEntries('setup-wizard', trZh)
    expect(entries.map((entry) => entry.category)).toEqual(['applicable_scenarios', 'save_impact'])
  })

  it('① applicable_scenarios reuses the four ATTENDANCE_SETUP_TEMPLATES entries verbatim (no hand-copy drift)', () => {
    const entries = getAttendanceContextHelpEntries('setup-wizard', trZh)
    const scenarios = entries.find((entry) => entry.category === 'applicable_scenarios')!
    const expectedTemplateLines = ATTENDANCE_SETUP_TEMPLATES.map((template) => `${template.name.zh} — ${template.description.zh}`)
    // Every template name+description pair from the shared constant module must appear verbatim —
    // proves this module READS the four templates rather than re-typing a parallel description.
    for (const line of expectedTemplateLines) {
      expect(scenarios.body).toContain(line)
    }
    expect(ATTENDANCE_SETUP_TEMPLATES.length).toBe(4)
  })

  it('② save_impact never carries a link (this category is prose-only here)', () => {
    const entries = getAttendanceContextHelpEntries('setup-wizard', trZh)
    const saveImpact = entries.find((entry) => entry.category === 'save_impact')!
    expect(saveImpact.link).toBeUndefined()
  })
})

describe("attendanceContextHelp — 'import' context (category ③, existing closed-set code reuse)", () => {
  it('carries EXACTLY failure_recovery — no other category', () => {
    const entries = getAttendanceContextHelpEntries('import', trZh)
    expect(entries.map((entry) => entry.category)).toEqual(['failure_recovery'])
  })

  it('body has EXACTLY one line per closed-set failure code — 2 BlockedSpreadsheetKind + 4 AttendanceXlsxConvertFailure, zero invented/extra entries', () => {
    const entries = getAttendanceContextHelpEntries('import', trZh)
    const failureRecovery = entries.find((entry) => entry.category === 'failure_recovery')!
    // Anchored on the module's OWN Record-derived closed set (never re-transcribed here): a spec
    // that keeps its own copy of the literals is a same-source guard, and a drifting union walks
    // straight past it (gate finding P2-1). Adding a union member now (a) fails `vue-tsc` at the
    // Record literal and (b) grows this derived length past the pinned 6 below — two doors.
    expect(failureRecovery.body).toHaveLength(
      ATTENDANCE_IMPORT_HELP_BLOCKED_KINDS.length + ATTENDANCE_IMPORT_HELP_CONVERT_FAILURES.length,
    )
    expect(failureRecovery.body).toHaveLength(6)
    // The derived sets ARE the real union — an omitted key would shrink these, a renamed one would
    // change them. Pinned member-wise so a silent substitution cannot keep the count at 6.
    expect([...ATTENDANCE_IMPORT_HELP_BLOCKED_KINDS]).toEqual(['xlsx', 'xls'])
    expect([...ATTENDANCE_IMPORT_HELP_CONVERT_FAILURES]).toEqual(['too-large', 'encrypted', 'empty', 'unreadable'])
  })

  it('no help line is manual-length — "不复制手册" has a mechanical door, not just intent (lock §9 W5-2)', () => {
    // Every context, every line: contextual help is a task-scoped hint, not a pasted manual
    // paragraph. 280 chars ≈ two short sentences in either locale; a copied handbook section runs
    // several times that. Gate finding P3-3 (longest line at the time: 243).
    for (const contextId of ATTENDANCE_CONTEXT_HELP_CONTEXTS) {
      for (const tr of [trZh, trEn]) {
        for (const entry of getAttendanceContextHelpEntries(contextId, tr)) {
          for (const line of entry.body) {
            expect(line.length).toBeGreaterThan(0)
            expect(line.length).toBeLessThanOrEqual(280)
          }
        }
      }
    }
  })

  it('each line mentions the format it is about (.xlsx/.xls/CSV) — the closed set drives distinct, on-topic copy', () => {
    const entries = getAttendanceContextHelpEntries('import', trZh)
    const [xlsxLine, xlsLine, tooLargeLine, encryptedLine, emptyLine, unreadableLine] = entries[0].body
    expect(xlsxLine).toContain('.xlsx')
    expect(xlsLine).toContain('.xls')
    for (const line of [xlsxLine, xlsLine, tooLargeLine, encryptedLine, emptyLine, unreadableLine]) {
      expect(line).toContain('CSV')
    }
    // Six distinct lines — no two failure codes collapsed into duplicate copy.
    expect(new Set(entries[0].body).size).toBe(6)
  })

  it('en leg renders en copy, distinct from the zh leg, for every line', () => {
    const zhEntries = getAttendanceContextHelpEntries('import', trZh)
    const enEntries = getAttendanceContextHelpEntries('import', trEn)
    expect(enEntries[0].body).toHaveLength(zhEntries[0].body.length)
    enEntries[0].body.forEach((line, index) => {
      expect(line).not.toBe(zhEntries[0].body[index])
      expect(/[一-鿿]/.test(line)).toBe(false)
    })
  })

  // Regression guard (found while wiring W5-2 into AttendanceView.vue, apps/web/tests/
  // attendance-import-preview-regression.spec.ts): the import section is always mounted
  // (`v-show`, not `v-if`), so this ALWAYS-present help copy must NEVER be byte-identical to the
  // REACTIVE xlsx-guard banner text (`blockedSpreadsheetMessage` / `xlsxConvertFailureMessage`) —
  // otherwise an assertion elsewhere that the reactive banner is absent (before any file is
  // selected) would false-positive-match this permanently-present help copy instead.
  it('regression guard: none of the help lines are byte-identical to the REACTIVE xlsx-guard banner text (zh + en, both closed sets)', () => {
    const blockedKinds: readonly BlockedSpreadsheetKind[] = ['xlsx', 'xls']
    const convertFailures: readonly AttendanceXlsxConvertFailure[] = ['too-large', 'encrypted', 'empty', 'unreadable']
    const reactiveTexts = [
      ...blockedKinds.flatMap((kind) => {
        const message = blockedSpreadsheetMessage(kind)
        return [message.en, message.zh]
      }),
      ...convertFailures.flatMap((reason) => {
        const message = xlsxConvertFailureMessage(reason)
        return [message.en, message.zh]
      }),
    ]
    for (const tr of [trZh, trEn]) {
      const helpLines = getAttendanceContextHelpEntries('import', tr)[0].body
      for (const helpLine of helpLines) {
        expect(reactiveTexts).not.toContain(helpLine)
      }
    }
  })
})

describe("attendanceContextHelp — 'self-request-center' context (category ④, W5-1 deep-link reuse)", () => {
  it('carries EXACTLY evidence_link — no other category', () => {
    const entries = getAttendanceContextHelpEntries('self-request-center', trZh)
    expect(entries.map((entry) => entry.category)).toEqual(['evidence_link'])
  })

  it('link.href is EXACTLY buildAttendanceSelfDecisionTraceDeepLink() — reused, not reassembled', () => {
    const entries = getAttendanceContextHelpEntries('self-request-center', trZh)
    const link = entries[0].link!
    expect(link.href).toBe(buildAttendanceSelfDecisionTraceDeepLink())
    expect(link.href).toBe('/attendance?section=attendance-overview-decision-trace')
  })

  it('R2: the href is canonical QUERY form — zero hash, anywhere', () => {
    const entries = getAttendanceContextHelpEntries('self-request-center', trZh)
    const link = entries[0].link!
    expect(link.href.includes('#')).toBe(false)
  })

  it('presets missing_punch — the literal 1:1 match for a makeup-punch (补卡申请) request card', () => {
    const entries = getAttendanceContextHelpEntries('self-request-center', trZh)
    expect(entries[0].link!.presetCategory).toBe('missing_punch')
  })
})

describe('attendanceContextHelp — every context is a distinct non-empty entry list', () => {
  it('the union of categories across all three contexts is exactly the four charter categories, each exactly once', () => {
    const seen: string[] = []
    for (const contextId of ATTENDANCE_CONTEXT_HELP_CONTEXTS) {
      const entries = getAttendanceContextHelpEntries(contextId, trZh)
      for (const entry of entries) seen.push(entry.category)
    }
    expect([...seen].sort()).toEqual([...ATTENDANCE_CONTEXT_HELP_CATEGORIES].sort())
  })

  it('every entry has a non-empty title and at least one non-empty body line, in both locales', () => {
    for (const contextId of ATTENDANCE_CONTEXT_HELP_CONTEXTS) {
      for (const tr of [trZh, trEn]) {
        const entries = getAttendanceContextHelpEntries(contextId, tr)
        expect(entries.length).toBeGreaterThan(0)
        for (const entry of entries) {
          expect(entry.title.length).toBeGreaterThan(0)
          expect(entry.body.length).toBeGreaterThan(0)
          for (const line of entry.body) expect(line.length).toBeGreaterThan(0)
        }
      }
    }
  })
})

// -------------------------------------------------------------------------------------------------
// Values-free (charter L225 verbatim six-item list): "不包含客户标识、真实用户、token、主机、
// 内部日志路径或环境秘密" — every title/body/link.label string across every context, both locales,
// must be free of each of the six categories. All content is static literal text (zero runtime
// interpolation of request/user/env values), so this is a closed, exhaustive scan — not a sample.
// -------------------------------------------------------------------------------------------------
describe('attendanceContextHelp — values-free (L225 six-item list, per-item zero-occurrence)', () => {
  function allStrings(): string[] {
    const out: string[] = []
    for (const contextId of ATTENDANCE_CONTEXT_HELP_CONTEXTS) {
      for (const tr of [trZh, trEn]) {
        const entries: AttendanceContextHelpEntry[] = getAttendanceContextHelpEntries(contextId, tr)
        for (const entry of entries) {
          out.push(entry.title)
          out.push(...entry.body)
          if (entry.link) {
            out.push(entry.link.label)
            out.push(entry.link.href)
          }
        }
      }
    }
    return out
  }

  it('zero token-like strings (token/bearer/jwt/apikey)', () => {
    const hits = allStrings().filter((s) => /\b(token|bearer|jwt|api[_-]?key)\b/i.test(s))
    expect(hits).toEqual([])
  })

  it('zero host-like strings (hostname, IP literal, localhost, protocol+host URL)', () => {
    const hits = allStrings().filter(
      (s) => /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(s) || /localhost/i.test(s) || /https?:\/\//i.test(s),
    )
    expect(hits).toEqual([])
  })

  it('zero internal-log-path-like strings (/var/, /etc/, /tmp/, .log)', () => {
    const hits = allStrings().filter((s) => /\/(var|etc|tmp)\//.test(s) || /\.log\b/.test(s))
    expect(hits).toEqual([])
  })

  it('zero env-secret-like strings (secret/env var SCREAMING_SNAKE/process.env)', () => {
    const hits = allStrings().filter((s) => /secret/i.test(s) || /process\.env/.test(s) || /\b[A-Z][A-Z0-9]*(_[A-Z0-9]+){2,}\b/.test(s))
    expect(hits).toEqual([])
  })

  it('zero real-user-identifier-like strings (UUID literal, email-like customer identifier)', () => {
    const hits = allStrings().filter(
      (s) => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s) || /[\w.+-]+@[\w-]+\.[\w.-]+/.test(s),
    )
    expect(hits).toEqual([])
  })

  it('zero customer-identifier-like strings (org id / user id literal, e.g. "org-" or "user-" followed by digits)', () => {
    const hits = allStrings().filter((s) => /\b(org|user|corp|tenant)[-_][0-9a-z]{2,}\b/i.test(s))
    expect(hits).toEqual([])
  })

  // Positive control: the values-free regexes above are not vacuous — each one DOES fire on an
  // adversarial string shaped like the thing it targets (guards against a tautological "always []"
  // assertion silently passing because the regex never matches anything).
  it('positive control: each L225 regex actually fires on a deliberately-planted adversarial string', () => {
    expect(/\b(token|bearer|jwt|api[_-]?key)\b/i.test('Bearer abc123')).toBe(true)
    expect(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test('reach 10.0.0.5 directly')).toBe(true)
    expect(/localhost/i.test('http://localhost:8080')).toBe(true)
    expect(/\/(var|etc|tmp)\//.test('see /var/log/app.log')).toBe(true)
    expect(/\.log\b/.test('see /var/log/app.log')).toBe(true)
    expect(/secret/i.test('JWT_SECRET is missing')).toBe(true)
    expect(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test('id=11111111-2222-3333-4444-555555555555')).toBe(true)
    expect(/[\w.+-]+@[\w-]+\.[\w.-]+/.test('contact ops@example.com')).toBe(true)
    expect(/\b(org|user|corp|tenant)[-_][0-9a-z]{2,}\b/i.test('org-abc123 flagged')).toBe(true)
  })
})

// -------------------------------------------------------------------------------------------------
// R1 (owner freeze ⑦ 零配置写入口) at the data-shape level: no entry, in any context/locale, ever
// carries anything resembling a write affordance. The TS shape already has no such field (structural
// impossibility for a well-typed caller), but this scan defends against a future field addition
// smuggling a write payload/URL into a `body` line.
// -------------------------------------------------------------------------------------------------
describe('attendanceContextHelp — R1 zero write affordance (data-shape scan)', () => {
  it('zero write-verb / write-endpoint-shaped substrings across every context/locale', () => {
    for (const contextId of ATTENDANCE_CONTEXT_HELP_CONTEXTS) {
      for (const tr of [trZh, trEn]) {
        const entries = getAttendanceContextHelpEntries(contextId, tr)
        const serialized = JSON.stringify(entries)
        expect(/\bPOST\b|\bPUT\b|\bPATCH\b|\bDELETE\b|fetch\(|apiFetch\(/i.test(serialized)).toBe(false)
      }
    }
  })

  it('only category "evidence_link" ever carries a `link` field, and only ever a read-target href (never a write endpoint)', () => {
    for (const contextId of ATTENDANCE_CONTEXT_HELP_CONTEXTS) {
      const entries = getAttendanceContextHelpEntries(contextId, trZh)
      for (const entry of entries) {
        if (entry.category === 'evidence_link') {
          expect(entry.link).toBeDefined()
          expect(entry.link!.href.startsWith('/attendance?')).toBe(true)
        } else {
          expect(entry.link).toBeUndefined()
        }
      }
    }
  })
})
