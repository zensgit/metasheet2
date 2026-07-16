// Browser-verification harness (dev/CI only — NOT part of the app build/typecheck; lives outside src/
// so vue-tsc + vite build ignore it). Real UF token load (../src/styles/tokens.css — the exact statement
// apps/web/src/main.ts uses) + the copied CSS in inspector-overlay-harness.html's <style> block let a
// real browser resolve the W2 S7 `.meta-record-drawer--overlay` rule's computed values (position/
// z-index/width/background-color/box-shadow) — see design docs/development/multitable-w2-unified-
// record-inspector-design-lock-20260714.md §3.4/§6bis/§8.3. Modeled directly on rail-drawer-harness.ts
// (same idiom, same three buttons pattern) — this harness intentionally does NOT reproduce
// MultitableWorkbench.vue's viewport/resize/mutual-exclusion STATE machine (that's already proven in
// jsdom, see the 'W2 S7' describe in apps/web/tests/multitable-workbench-view.spec.ts) — the buttons
// below just apply the class combinations directly so the spec can assert each state's resolved CSS in
// isolation, side by side with the rail (so the layout this component actually sits in is reproduced).
import { createApp, h, ref } from 'vue'
import '../src/styles/tokens.css'

type Mode = 'push' | 'overlay' | 'rail-drawer'

createApp({
  setup() {
    const mode = ref<Mode>('push')
    const railClass = () => ({
      'mt-workbench__rail': true,
      'mt-workbench__rail--collapsed': mode.value !== 'rail-drawer',
    })
    const drawerClass = () => ({
      'meta-record-drawer': true,
      'meta-record-drawer--overlay': mode.value === 'overlay',
    })
    return () => h('div', [
      // flex-wrap:wrap — this harness-chrome header row (unrelated to the product CSS under test)
      // must NOT itself cause horizontal overflow at narrow viewport widths (down to 320px), or the
      // spec's "no body horizontal scroll" assertion would be polluted by the harness's own UI rather
      // than proving anything about `.meta-record-drawer--overlay`. Confirmed via a throwaway debug
      // probe: at 320px, an un-wrapped button row is what overflowed — not the drawer.
      h('div', { style: 'margin:16px 16px 12px;display:flex;flex-wrap:wrap;gap:8px;max-width:100%;box-sizing:border-box' }, [
        h('h3', { style: 'margin:0 16px 0 0' }, 'W2 S7 — inspector overlay CSS'),
        h('button', { 'data-test': 'mode-push', onClick: () => { mode.value = 'push' } }, 'push (desktop)'),
        h('button', { 'data-test': 'mode-overlay', onClick: () => { mode.value = 'overlay' } }, 'overlay (narrow)'),
        h('button', { 'data-test': 'mode-rail-drawer', onClick: () => { mode.value = 'rail-drawer' } }, 'rail-drawer (mutex)'),
      ]),
      h('div', { 'data-test': 'current-mode', style: 'margin:0 16px 12px;color:#333' }, `mode: ${mode.value}`),
      h('div', { class: 'mt-workbench__content', 'data-test': 'content' }, [
        h('aside', { class: railClass(), 'data-test': 'rail' }, 'rail content'),
        h('div', { class: 'mt-workbench__main', 'data-test': 'main' }, 'main (grid) content'),
        // mode !== 'rail-drawer': the inspector is "open" (mirrors selectedRecordId truthy).
        // mode === 'rail-drawer': the inspector is "closed" (mirrors S7's mutual-exclusion — the rail
        // drawer being open means selectedRecordId got force-nulled), so nothing is rendered here, same
        // as MetaRecordInspector.vue's own `v-if="visible"` root.
        mode.value === 'rail-drawer' ? null : h('div', { class: drawerClass(), 'data-test': 'inspector' }, 'inspector content'),
      ]),
    ])
  },
}).mount('#app')
