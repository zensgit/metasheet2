import type { FormField, FormSchema } from '../types/approval'
import { getVisibleFormFields, describeFieldVisibilityRule } from './fieldVisibility'

/**
 * G-B2-21 (模板编辑器发起人视角预览): split a template's form fields into what a REQUESTER would
 * actually see for a given sample submission, versus what is currently hidden and why.
 *
 * The whole point is fidelity: the authoring 试运行 panel must render the SAME visible set a
 * requester sees on the submit page, and it must be the SAME set the backend routes on. So this
 * reuses `getVisibleFormFields` — the exact predicate ApprovalNewView renders from, whose sibling
 * `pruneHiddenFormData` mirrors the backend's own pre-walk pruning — rather than re-evaluating
 * visibility here. A parallel evaluator would be a place for the author's preview to silently
 * disagree with reality; there is deliberately only one.
 *
 * Hidden fields are returned WITH a human reason (not just dropped) so the author can verify their
 * visibilityRule is written correctly — a field vanishing with no explanation is exactly the
 * confusion this feature removes.
 */
export interface HiddenPreviewField {
  field: FormField
  /** Human description of the visibilityRule keeping it hidden, or a generic fallback. */
  reason: string
}

export interface RequesterPreviewFields {
  visible: FormField[]
  hidden: HiddenPreviewField[]
}

export function computeRequesterPreviewFields(
  formSchema: FormSchema | null | undefined,
  sampleFormData: Record<string, unknown>,
): RequesterPreviewFields {
  if (!formSchema || !Array.isArray(formSchema.fields) || formSchema.fields.length === 0) {
    return { visible: [], hidden: [] }
  }
  const visible = getVisibleFormFields(formSchema, sampleFormData)
  const visibleIds = new Set(visible.map((field) => field.id))
  const labelOf = (fieldId: string): string =>
    formSchema.fields.find((f) => f.id === fieldId)?.label || fieldId
  const hidden: HiddenPreviewField[] = formSchema.fields
    .filter((field) => !visibleIds.has(field.id))
    .map((field) => {
      const rule = field.visibilityRule
      // A field is hidden for one of two reasons, and they need DIFFERENT explanations:
      //  - its own rule evaluated false → describe that rule (it's what the author must fix);
      //  - its own rule would pass, but the field it DEPENDS ON is itself hidden → the chain hid
      //    it. Describing its own rule here would mislead: the rule's condition may well be met.
      const dependencyHidden = !!rule && !visibleIds.has(rule.fieldId)
      const reason = dependencyHidden
        ? `其依赖的字段「${labelOf(rule!.fieldId)}」当前被隐藏，故此字段一并隐藏`
        : describeFieldVisibilityRule(field, formSchema) ?? '当前样例下不显示'
      return { field, reason }
    })
  return { visible, hidden }
}
