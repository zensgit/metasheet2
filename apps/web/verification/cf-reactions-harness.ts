// Browser-verification harness (dev/CI only — NOT part of the app build/typecheck;
// lives outside src/ so vue-tsc + vite build ignore it). Mounts the real
// MetaGridTable (data-bar / color-scale / icon-set) + MetaCommentReactions with
// fixtures so a real browser (Playwright in CI) can confirm the visual/interaction
// render that jsdom can't. Reactions are reactive so click → chip change is observable.
import { createApp, h, ref } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import MetaCommentReactions from '../src/multitable/components/MetaCommentReactions.vue'
import { buildFieldScaleMap, sanitizeScaleRule } from '../src/multitable/utils/conditional-formatting'
import type { MultitableCommentReaction } from '../src/multitable/types'

const FIELDS = [
  { id: 'bar', name: 'Data bar', type: 'number' },
  { id: 'scale', name: 'Color scale', type: 'number' },
  { id: 'icon', name: 'Icon set', type: 'number' },
  { id: 'label', name: 'Label', type: 'string' },
]
const ROWS = [0, 25, 50, 75, 100].map((n, i) => ({
  id: `r${i}`, version: 1, data: { bar: n, scale: n, icon: n, label: `row ${i}` },
}))
const scaleMap = buildFieldScaleMap([
  sanitizeScaleRule({ id: 'b', fieldId: 'bar', kind: 'dataBar', order: 0, range: { mode: 'auto' }, dataBar: { color: '#2196f3' } })!,
  sanitizeScaleRule({ id: 'c', fieldId: 'scale', kind: 'colorScale', order: 1, range: { mode: 'auto' }, colorScale: { stops: [{ at: 'min', color: '#ff5252' }, { at: 'mid', color: '#ffeb3b' }, { at: 'max', color: '#4caf50' }] } })!,
  sanitizeScaleRule({ id: 'i', fieldId: 'icon', kind: 'iconSet', order: 2, range: { mode: 'auto' }, iconSet: { set: 'arrows3', thresholds: [33, 66] } })!,
], ROWS)

const reactions = ref<MultitableCommentReaction[]>([
  { emoji: '👍', count: 3, reactedByMe: true },
  { emoji: '❤️', count: 1, reactedByMe: false },
  { emoji: '🎉', count: 5, reactedByMe: false },
])
function applyReaction(emoji: string, mode: 'add' | 'remove') {
  const cur = reactions.value
  const ex = cur.find((r) => r.emoji === emoji)
  if (mode === 'add') {
    if (!ex) reactions.value = [...cur, { emoji, count: 1, reactedByMe: true }]
    else if (!ex.reactedByMe) reactions.value = cur.map((r) => (r.emoji === emoji ? { ...r, count: r.count + 1, reactedByMe: true } : r))
  } else if (ex?.reactedByMe) {
    const count = Math.max(0, ex.count - 1)
    reactions.value = count === 0
      ? cur.filter((r) => r.emoji !== emoji)
      : cur.map((r) => (r.emoji === emoji ? { ...r, count, reactedByMe: false } : r))
  }
}

createApp({
  setup() {
    return () => h('div', [
      h('div', { style: 'border:1px solid #ddd;margin-bottom:24px' }, [
        h(MetaGridTable, {
          rows: ROWS, visibleFields: FIELDS, sortRules: [], loading: false,
          currentPage: 1, totalPages: 1, startIndex: 0, canEdit: true,
          searchText: '', rowDensity: 'normal', conditionalFormattingScale: scaleMap,
        }),
      ]),
      h('div', { style: 'padding:12px;border:1px solid #ddd;max-width:360px' }, [
        h('div', { style: 'margin-bottom:8px;color:#333' }, 'Reaction chips + picker:'),
        h(MetaCommentReactions, {
          commentId: 'c1', canReact: true,
          reactions: reactions.value,
          onReact: (_id: string, emoji: string) => applyReaction(emoji, 'add'),
          onUnreact: (_id: string, emoji: string) => applyReaction(emoji, 'remove'),
        }),
      ]),
    ])
  },
}).mount('#app')
