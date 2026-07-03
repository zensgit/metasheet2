// MP-5 makeup-punch request-side UX: pure error-copy resolver.
//
// `tr` (bilingual picker) and `classifyStatusError` both live inside
// AttendanceView.vue's `<script setup>`, so a testable helper cannot be exported
// from the SFC. This module holds the pure request-context copy for the seven
// `MAKEUP_PUNCH_*` server codes so it can be unit-tested in isolation (inject a
// stub `tr`) and reused by any future request-update UI instead of re-wording.
//
// It maps the codes documented in
// docs/development/attendance-makeup-punch-request-ux-design-lock-20260703.md §3.
// It performs NO client-side policy decision — the backend
// (`enforceMakeupPunchPolicy`) remains the sole authority; this only explains a
// rejection the server already emitted.

export type MakeupPunchRequestStatusAction = 'retry-submit-request' | 'reload-requests'

export interface MakeupPunchRequestStatusCopy {
  message: string
  hint?: string
  action?: MakeupPunchRequestStatusAction
}

/**
 * Resolve human-actionable copy for a `MAKEUP_PUNCH_*` server rejection code.
 *
 * Returns `null` for any non-makeup code so the caller falls through to its
 * existing generic status handling. Bilingual output is produced through the
 * injected `tr` (English default, Chinese when the app locale is zh).
 */
export function resolveMakeupPunchRequestStatusCopy(
  code: string,
  tr: (en: string, zh: string) => string,
): MakeupPunchRequestStatusCopy | null {
  switch (code) {
    case 'MAKEUP_PUNCH_QUOTA_EXCEEDED':
      return {
        message: tr(
          'Makeup-punch quota for this cycle has been used.',
          '本周期的补卡次数已用完。',
        ),
        hint: tr(
          'Review pending/approved makeup requests before retrying.',
          '请先查看待处理/已通过的补卡申请，再重试。',
        ),
        action: 'reload-requests',
      }
    case 'MAKEUP_PUNCH_WINDOW_EXPIRED':
      return {
        message: tr(
          'This work date is outside the allowed makeup-punch window.',
          '该工作日期不在允许的补卡时间窗口内。',
        ),
        hint: tr(
          'Choose an allowed work date or ask an attendance admin to adjust the policy.',
          '请选择允许的工作日期，或联系考勤管理员调整策略。',
        ),
      }
    case 'MAKEUP_PUNCH_FUTURE_DATE_UNSUPPORTED':
      return {
        message: tr(
          'Future work dates cannot be submitted for makeup punch.',
          '未来的工作日期无法提交补卡。',
        ),
        hint: tr(
          'Choose today or an earlier work date.',
          '请选择今天或更早的工作日期。',
        ),
      }
    case 'MAKEUP_PUNCH_TYPE_NOT_ALLOWED':
      // Wording must NOT imply an anomaly definitely does not exist — the server
      // rejected the current date/type combination under policy, not the anomaly.
      return {
        message: tr(
          'The selected date/type is not eligible under the current makeup-punch policy.',
          '所选日期/类型不符合当前补卡策略。',
        ),
        hint: tr(
          'Use the anomaly quick action if available, or choose a different request type/date.',
          '如有异常快捷入口可优先使用，或改选其他申请类型/日期。',
        ),
      }
    case 'MAKEUP_PUNCH_REASON_REQUIRED':
      return {
        message: tr(
          'A reason is required by the makeup-punch policy.',
          '补卡策略要求填写原因。',
        ),
        hint: tr(
          'Fill the reason field and retry.',
          '请填写原因后重试。',
        ),
        action: 'retry-submit-request',
      }
    case 'MAKEUP_PUNCH_ATTACHMENT_REQUIRED':
      return {
        message: tr(
          'An attachment is required by the makeup-punch policy.',
          '补卡策略要求上传附件。',
        ),
        hint: tr(
          'Add an attachment URL in the Request Center and retry.',
          '请在申请中心填写附件链接后重试。',
        ),
        action: 'retry-submit-request',
      }
    case 'MAKEUP_PUNCH_CROSS_USER_FORBIDDEN':
      // PUT-only backend code (pending-request update path). Surfaced here only so
      // a future request-update UI reuses this wording; there is no POST UI for it.
      return {
        message: tr(
          'This makeup-punch request cannot be edited for another user in v1.',
          'v1 不支持为他人编辑补卡申请。',
        ),
        hint: tr(
          'Ask the employee to submit their own request.',
          '请让该员工自行提交申请。',
        ),
      }
    default:
      return null
  }
}
