// Browser-verification harness (dev/CI only — NOT part of the app build/typecheck; lives outside src/
// so vue-tsc + vite build ignore it). Real UF token load (../src/styles/tokens.css — the exact statement
// apps/web/src/main.ts uses) + the copied CSS in rail-drawer-harness.html's <style> block let a real
// browser resolve the UI-P2-2c drawer rule's computed values (position/z-index/width/background-color/
// box-shadow) — see design docs/development/multitable-ui-p2-2c-responsive-design-20260714.md §7.
// This harness intentionally does NOT reproduce MultitableWorkbench.vue's viewport/resize STATE machine
// (that's already proven in jsdom, see the 'UI-P2-2c' describe in
// apps/web/tests/multitable-workbench-view.spec.ts) — the three buttons below just apply the class
// combinations directly so the spec can assert each state's resolved CSS in isolation.
import { createApp, h, ref } from 'vue'
import '../src/styles/tokens.css'

type Mode = 'default' | 'collapsed' | 'drawer'

createApp({
  setup() {
    const mode = ref<Mode>('default')
    const railClass = () => ({
      'mt-workbench__rail': true,
      'mt-workbench__rail--collapsed': mode.value === 'collapsed',
      'mt-workbench__rail--drawer': mode.value === 'drawer',
    })
    return () => h('div', [
      h('div', { style: 'margin-bottom:12px;display:flex;gap:8px' }, [
        h('button', { 'data-test': 'mode-default', onClick: () => { mode.value = 'default' } }, 'default'),
        h('button', { 'data-test': 'mode-collapsed', onClick: () => { mode.value = 'collapsed' } }, 'collapsed'),
        h('button', { 'data-test': 'mode-drawer', onClick: () => { mode.value = 'drawer' } }, 'drawer'),
      ]),
      h('div', { 'data-test': 'current-mode', style: 'margin-bottom:12px;color:#333' }, `mode: ${mode.value}`),
      h('div', { class: 'mt-workbench__content', 'data-test': 'content' }, [
        h('aside', { class: railClass(), 'data-test': 'rail' }, 'rail content'),
        h('div', { class: 'mt-workbench__main', 'data-test': 'main' }, 'main content'),
      ]),
    ])
  },
}).mount('#app')
