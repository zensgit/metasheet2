import { computed, watch, type Ref } from 'vue'
import type { ApprovalTemplateDetailDTO } from '../types/approval'
import { autoSumTotalFromMapping } from './amountAutoSum'

// Detail-row auto-sum wiring (design-lock #3189, Gate B). Extracted from ApprovalNewView so the watch is
// unit-testable in isolation. When the active template declares `amountConsistencyCheck`, the total field
// is DERIVED from the detail rows (read-only in the UI) — auto-fill (UX) closing the loop with the backend
// total-check (tamper-proof). FE-only: this never calls the backend; it only maintains formData[total].
export function useAutoSumTotal(
  template: Ref<ApprovalTemplateDetailDTO | null>,
  formData: Record<string, unknown>,
) {
  const amountConsistency = computed(() => template.value?.formSchema.amountConsistencyCheck ?? null)

  /** True for the field that is auto-summed (→ rendered read-only). */
  function isAutoSummedTotal(fieldId: string): boolean {
    return amountConsistency.value?.totalFieldId === fieldId
  }

  // Watch BOTH the mapping itself AND (deep) the detail rows, recomputing the total via the
  // backend-identical mirror so the auto-filled value always clears the backstop. Watching the mapping
  // matters because `template` resolves async: this seeds the total to 0 the instant a mapped template
  // loads — even if the detail field isn't array-initialized yet at that tick — rather than relying on
  // watch-ordering vs the view's detail seeding. immediate: also seed on a synchronously-present mapping.
  watch(
    [amountConsistency, () => (amountConsistency.value ? formData[amountConsistency.value.detailFieldId] : undefined)],
    () => {
      const mapping = amountConsistency.value
      if (!mapping || !template.value) return
      formData[mapping.totalFieldId] = autoSumTotalFromMapping(template.value.formSchema, formData, mapping)
    },
    { deep: true, immediate: true },
  )

  return { isAutoSummedTotal }
}
