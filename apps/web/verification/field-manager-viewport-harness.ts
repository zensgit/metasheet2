// Browser-verification harness (dev/CI only -- NOT part of the app build/typecheck; lives outside src/
// so vue-tsc + vite build ignore it). Mounts the REAL MetaFieldManager dialog -- the only place the
// multitable「管理字段」field list and its field-config pane render (MultitableWorkbench.vue mounts it
// as a full-viewport overlay) -- with enough synthetic fields that the list overflows any window,
// plus one single-select field with enough options that its config pane is taller than any window
// (a 1080px window included). That is the worst case for #5864 ②: both halves want more height than
// there is, so the assertions in field-manager-viewport.spec.ts can observe how the dialog shares
// the window out. Values-free: every field name / id / option below is synthetic.
import { createApp, h } from 'vue'
import 'element-plus/dist/index.css'
import '../src/styles/tokens.css'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import type { MetaField } from '../src/multitable/types'

const FIELD_COUNT = 48
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
  return {
    id: `fld_${index}`,
    name: `Field ${String(index).padStart(2, '0')}`,
    type: index % 3 === 0 ? 'number' : 'string',
    property: {},
  }
})

createApp({
  render() {
    return h(MetaFieldManager, { visible: true, sheetId: 'sheet_viewport_harness', sheets: [], fields })
  },
}).mount('#app')
