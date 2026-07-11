// G-B2-27: create_record's "target sheet" picker used to be a bare text box — a non-developer
// had to know (and correctly paste) a raw sheet ID. This module is the pure mapping from
// listSheets() results to dropdown options; the component wires it into an el-select with an
// allow-create manual fallback (listSheets may omit cross-base/future sheets, and the client may
// be unavailable in some hosts) — see MetaAutomationRuleEditor.vue's targetSheetOptions computed.

export interface AutomationTargetSheetOption {
  value: string
  label: string
}

interface AutomationTargetSheetLike {
  id: string
  name?: string | null
}

/**
 * Map raw sheets (as returned by listSheets()) into select options.
 * Honest about partial/malformed input: entries missing a usable string id are dropped
 * (an id-less option can't round-trip through save), and a missing/blank name falls back
 * to the id so the option always has a readable label.
 */
export function automationTargetSheetOptions(
  sheets: readonly AutomationTargetSheetLike[] | null | undefined,
): AutomationTargetSheetOption[] {
  if (!Array.isArray(sheets)) return []
  return sheets
    .filter((sheet): sheet is AutomationTargetSheetLike => !!sheet && typeof sheet.id === 'string' && sheet.id.length > 0)
    .map((sheet) => ({
      value: sheet.id,
      label: typeof sheet.name === 'string' && sheet.name.trim() ? sheet.name : sheet.id,
    }))
}
