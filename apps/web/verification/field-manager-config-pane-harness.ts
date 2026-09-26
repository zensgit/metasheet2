// Browser-verification harness (dev/CI only -- NOT part of the app build/typecheck; lives outside src/
// so vue-tsc + vite build ignore it). Mounts the REAL MetaFieldManager dialog (「管理字段」; its only
// app mount point is MultitableWorkbench.vue, as a full-viewport fixed overlay) with:
//   - enough synthetic fields that the field list overflows any window, and
//   - one single-select field whose option list makes its config pane taller than any window,
//   - one dateTime field whose config pane is SHORT (it must keep hugging its content),
//   - one single-select field ('Mid config', always the LAST field) whose config pane is taller than
//     the default split but shorter than the ceiling at 1280x800 (#7a round 3, SF1).
// That is the case the customer hit (客户反馈 2026-09-24 #7a): both halves want more height than the
// 84vh frame has, which is exactly when the old shrinkable pane was drawn below its ceiling.
// `?fields=N` (N >= 3) mounts only the first N fields: a sheet with few fields (#7a round 3, SF2).
// Values-free: every field name / id / option below is synthetic.
import { createApp, h } from 'vue'
import 'element-plus/dist/index.css'
import '../src/styles/tokens.css'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import type { MetaField } from '../src/multitable/types'

const requestedFieldCount = Number(new URLSearchParams(window.location.search).get('fields'))
const FIELD_COUNT = Number.isInteger(requestedFieldCount) && requestedFieldCount >= 3 ? requestedFieldCount : 48
const OPTION_COUNT = 48

const fields = Array.from({ length: FIELD_COUNT }, (_, index): MetaField => {
  if (index === 0) {
    return {
      id: 'fld_select',
      name: 'Select field',
      type: 'select',
      property: {
        options: Array.from({ length: OPTION_COUNT }, (_, option) => ({
          value: `Option ${String(option + 1).padStart(2, '0')}`,
        })),
      },
    }
  }
  if (index === 1) {
    // dateTime has no configurable options, so its pane is the shortest one there is.
    return { id: 'fld_short', name: 'Short config', type: 'dateTime', property: {} }
  }
  if (index === FIELD_COUNT - 1) {
    // One option: 348px of content in Chromium, between 1280x800's default (267) and ceiling (439).
    return { id: 'fld_mid', name: 'Mid config', type: 'select', property: { options: [{ value: 'Mid option' }] } }
  }
  return {
    id: `fld_${index}`,
    name: `Field ${String(index).padStart(2, '0')}`,
    type: index % 3 === 0 ? 'number' : 'string',
    property: {},
  }
})

createApp({
  render() {
    return h(MetaFieldManager, { visible: true, sheetId: 'sheet_config_pane_harness', sheets: [], fields })
  },
}).mount('#app')
