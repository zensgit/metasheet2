import { describe, expect, it } from 'vitest'
import {
  attendanceApprovalOptionCopy,
  attendanceApprovalOptionSaveNotice,
  withApprovalOptionSaveNotice,
  type AttendanceApprovalOptionKind,
  type TranslateFn,
} from '../src/views/attendance/attendanceApprovalOptionHint'

// A1 「提示与实际状态」 - the leave-type / overtime-rule 「需要审批」 option is stored but NOT enforced
// (plugins/plugin-attendance/index.cjs: the column is written by the create/update routes and copied into the
// request metadata snapshot, never read to branch; every request-creating insert writes status 'pending').
// These specs pin the copy that says so, in both languages.

const enTr: TranslateFn = (en) => en
const zhTr: TranslateFn = (_en, zh) => zh
const CJK = /[㐀-鿿]/
const kinds: AttendanceApprovalOptionKind[] = ['leave', 'overtime']

describe('attendanceApprovalOptionCopy', () => {
  it('labels the option 暂不生效 in zh and "Not in effect yet" in en', () => {
    for (const kind of kinds) {
      expect(attendanceApprovalOptionCopy(zhTr, kind).badge).toBe('暂不生效')
      expect(attendanceApprovalOptionCopy(enTr, kind).badge).toBe('Not in effect yet')
    }
  })

  it('explains that unticking does not skip approval and that the request still waits for an approver', () => {
    for (const kind of kinds) {
      const zh = attendanceApprovalOptionCopy(zhTr, kind).hint
      const en = attendanceApprovalOptionCopy(enTr, kind).hint
      expect(zh).toContain('不改变申请的提交与审批')
      expect(zh).toContain('待审批')
      expect(zh).toContain('取消勾选不会免除审批')
      expect(en).toContain('does not change how requests are submitted or approved')
      expect(en).toContain('submitted as pending')
      expect(en).toContain('unticking it does not skip approval')
    }
  })

  it('names the right subject per kind', () => {
    expect(attendanceApprovalOptionCopy(zhTr, 'leave').hint).toContain('该请假类型')
    expect(attendanceApprovalOptionCopy(zhTr, 'overtime').hint).toContain('该加班规则')
    expect(attendanceApprovalOptionCopy(enTr, 'leave').hint).toContain('this leave type')
    expect(attendanceApprovalOptionCopy(enTr, 'overtime').hint).toContain('this overtime rule')
  })

  it('marks the stored Yes/No column as not in effect without renaming it away', () => {
    expect(attendanceApprovalOptionCopy(zhTr, 'leave').columnHeader).toBe('审批(暂不生效)')
    expect(attendanceApprovalOptionCopy(enTr, 'leave').columnHeader).toBe('Approval (not in effect)')
  })

  it('has both languages for every string, and the English side carries no CJK', () => {
    for (const kind of kinds) {
      const zh = attendanceApprovalOptionCopy(zhTr, kind)
      const en = attendanceApprovalOptionCopy(enTr, kind)
      for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
        expect(zh[key].trim().length).toBeGreaterThan(0)
        expect(en[key].trim().length).toBeGreaterThan(0)
        expect(CJK.test(zh[key])).toBe(true)
        expect(CJK.test(en[key])).toBe(false)
      }
    }
  })

  it('never claims the option took effect', () => {
    for (const kind of kinds) {
      for (const tr of [enTr, zhTr]) {
        const copy = attendanceApprovalOptionCopy(tr, kind)
        const text = `${copy.badge} ${copy.hint} ${copy.columnHeader}`
        expect(text).not.toContain('已生效')
        expect(text).not.toMatch(/\btakes? effect\b/i)
        expect(text).not.toMatch(/\bis (now )?in effect\b/i)
      }
    }
  })
})

describe('attendanceApprovalOptionSaveNotice / withApprovalOptionSaveNotice', () => {
  it('adds nothing when the option was saved ticked (the stored value then matches what happens)', () => {
    for (const kind of kinds) {
      expect(attendanceApprovalOptionSaveNotice(enTr, kind, true)).toBe('')
      expect(withApprovalOptionSaveNotice(enTr, kind, true, 'Leave type created.')).toBe('Leave type created.')
    }
  })

  it('appends a not-in-effect note when the option was saved UNTICKED, so saving never reads as "approval skipped"', () => {
    const leaveEn = withApprovalOptionSaveNotice(enTr, 'leave', false, 'Leave type created.')
    expect(leaveEn.startsWith('Leave type created. ')).toBe(true)
    expect(leaveEn).toContain('not in effect yet')
    expect(leaveEn).toContain('still need approval')
    const overtimeZh = withApprovalOptionSaveNotice(zhTr, 'overtime', false, '加班规则已更新。')
    expect(overtimeZh.startsWith('加班规则已更新。 ')).toBe(true)
    expect(overtimeZh).toContain('暂不生效')
    expect(overtimeZh).toContain('仍需审批')
  })
})
