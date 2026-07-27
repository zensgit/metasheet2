// Browser-verification harness (dev/CI only — NOT part of the app build/typecheck;
// lives outside src/ so vue-tsc + vite build ignore it). E1 isolated approval-flow
// renderer spike: constrained vertical tree, no free-form graph, no persisted
// coordinates, no production route wiring.
import { computed, createApp, h, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import '../src/styles/tokens.css'
import {
  ALL_FIXTURES,
  collectInternalTokens,
  getFixture,
  type E1Fixture,
  type E1FixtureId,
} from './approval-flow-canvas-e1-fixtures'
import {
  computeE1Layout,
  type E1CardModel,
  type E1EdgeModel,
  type E1LayoutModel,
} from './approval-flow-canvas-e1-layout'

type InspectorPresentation = 'dock' | 'overlay' | 'sheet'
type SheetDetent = 'half' | 'full'

interface InsertMenuState {
  edgeFocusId: string
  x: number
  y: number
}

interface E1PublicMetrics {
  ready: true
  fixtureId: E1FixtureId
  nodeCount: number
  edgeCount: number
  inspectorPresentation: InspectorPresentation
  sheetDetent: SheetDetent | null
  inspectorOpen: boolean
  readOnly: boolean
  cards: Array<{
    focusId: string
    name: string
    type: string
    x: number
    y: number
    width: number
    height: number
  }>
  edges: Array<{
    focusId: string
    path: string
    midX: number
    midY: number
    sourceFocusId: string
    targetFocusId: string
  }>
  branchLabels: Array<{
    order: number
    label: string
    priority?: number
    isDefault: boolean
    x: number
  }>
  layoutWidth: number
  layoutHeight: number
  selectedName: string | null
  liveText: string
  reducedMotion: boolean
  internalTokens: string[]
}

declare global {
  interface Window {
    __E1_CANVAS__?: E1PublicMetrics
    __E1_SELECT_FIXTURE__?: (id: E1FixtureId) => void
    __E1_SWAP_CONDITION_PRIORITY__?: () => void
  }
}

function presentationForWidth(width: number): InspectorPresentation {
  if (width <= 480) return 'sheet'
  if (width <= 1100) return 'overlay'
  return 'dock'
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

createApp({
  setup() {
    const fixtureId = ref<E1FixtureId>('linear')
    const fixture = ref<E1Fixture>(getFixture('linear'))
    const selectedFocusId = ref<string | null>(null)
    const liveText = ref('')
    const viewportW = ref(window.innerWidth)
    const sheetDetent = ref<SheetDetent>('half')
    const insertMenu = ref<InsertMenuState | null>(null)
    const measuredHeights = ref<Map<string, number>>(new Map())
    const surfaceEl = ref<HTMLElement | null>(null)
    const reducedMotion = ref(prefersReducedMotion())

    const layout = computed<E1LayoutModel>(() =>
      computeE1Layout(fixture.value, measuredHeights.value.size ? measuredHeights.value : undefined),
    )

    const presentation = computed(() => presentationForWidth(viewportW.value))
    const inspectorOpen = computed(() => selectedFocusId.value != null)
    const selectedCard = computed(() =>
      layout.value.cards.find((card) => card.focusId === selectedFocusId.value) ?? null,
    )

    const focusables = computed(() => {
      const nodeIds = layout.value.focusOrder
      const insertIds = layout.value.edges.filter((edge) => edge.insertable).map((edge) => edge.focusId)
      return [...nodeIds, ...insertIds]
    })

    function announce(message: string) {
      // Re-assign to force polite live region update even for identical strings.
      liveText.value = ''
      void nextTick(() => {
        liveText.value = message
      })
    }

    function selectFixture(id: E1FixtureId) {
      fixtureId.value = id
      fixture.value = getFixture(id)
      selectedFocusId.value = null
      insertMenu.value = null
      measuredHeights.value = new Map()
      announce(`已加载夹具：${fixture.value.title}`)
      void nextTick(() => {
        measureAndReflow()
        publishMetrics()
      })
    }

    /** Demo-only: swap condition branch priority via config.branches only (nodes/edges untouched). */
    function swapConditionPriority() {
      if (fixture.value.readOnly) {
        announce('当前为只读夹具，无法调整优先级')
        return
      }
      if (fixtureId.value === 'condition') {
        selectFixture('condition-priority-swapped')
        announce('已提高「金额大于等于一千」的优先级')
        return
      }
      if (fixtureId.value === 'condition-priority-swapped') {
        selectFixture('condition')
        announce('已恢复「金额大于等于一百」为最高优先级')
        return
      }
      announce('请先加载条件分支夹具')
    }

    function selectCard(card: E1CardModel) {
      selectedFocusId.value = card.focusId
      insertMenu.value = null
      announce(`已选中「${card.name}」`)
      void nextTick(() => {
        const el = document.querySelector<HTMLElement>(`[data-focus-id="${card.focusId}"]`)
        el?.focus()
        publishMetrics()
      })
    }

    function closeInspector() {
      const name = selectedCard.value?.name
      selectedFocusId.value = null
      if (name) announce(`已关闭「${name}」的属性面板`)
      publishMetrics()
    }

    function openInsertMenu(edge: E1EdgeModel) {
      if (!edge.insertable || fixture.value.readOnly) {
        announce('当前连线不可插入')
        return
      }
      insertMenu.value = { edgeFocusId: edge.focusId, x: edge.midX, y: edge.midY }
      announce(`已打开插入菜单：${edge.ariaLabel}`)
      void nextTick(() => {
        const first = document.querySelector<HTMLElement>('[data-test="insert-menu"] button')
        first?.focus()
      })
    }

    function activateInsert(kind: 'approval' | 'cc') {
      const label = kind === 'approval' ? '审批' : '抄送'
      insertMenu.value = null
      // Spike: announce activation only — mutations stay out of production graph save paths.
      announce(`已选择插入「${label}」节点（spike 演示，未写入业务模型）`)
      publishMetrics()
    }

    function onCanvasKeydown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (!target) return
      const focusId = target.getAttribute('data-focus-id')
      if (!focusId) return

      if (insertMenu.value && event.key === 'Escape') {
        event.preventDefault()
        const edgeFocus = insertMenu.value.edgeFocusId
        insertMenu.value = null
        announce('已关闭插入菜单')
        document.querySelector<HTMLElement>(`[data-focus-id="${edgeFocus}"]`)?.focus()
        return
      }

      if (event.key === 'Enter' || event.key === ' ') {
        const edge = layout.value.edges.find((item) => item.focusId === focusId)
        if (edge) {
          event.preventDefault()
          openInsertMenu(edge)
          return
        }
        const card = layout.value.cards.find((item) => item.focusId === focusId)
        if (card) {
          event.preventDefault()
          selectCard(card)
          return
        }
      }

      if (event.key === 'Escape' && selectedFocusId.value) {
        event.preventDefault()
        closeInspector()
        return
      }

      const order = focusables.value
      const index = order.indexOf(focusId)
      if (index < 0) return

      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        event.preventDefault()
        const next = order[Math.min(order.length - 1, index + 1)]
        if (next) focusById(next)
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        event.preventDefault()
        const prev = order[Math.max(0, index - 1)]
        if (prev) focusById(prev)
      }
    }

    function focusById(focusId: string) {
      const el = document.querySelector<HTMLElement>(`[data-focus-id="${focusId}"]`)
      el?.focus()
      const card = layout.value.cards.find((item) => item.focusId === focusId)
      if (card) {
        selectedFocusId.value = card.focusId
        announce(`已聚焦「${card.name}」`)
      }
    }

    function measureAndReflow() {
      const root = surfaceEl.value
      if (!root) return
      const next = new Map<string, number>()
      for (const card of layout.value.cards) {
        const el = root.querySelector<HTMLElement>(`[data-focus-id="${card.focusId}"]`)
        if (!el) continue
        const h = el.getBoundingClientRect().height
        if (h > 0) next.set(card.nodeKey, Math.ceil(h))
      }
      // Only update when heights actually differ to avoid loops.
      let changed = next.size !== measuredHeights.value.size
      if (!changed) {
        for (const [key, value] of next) {
          if (measuredHeights.value.get(key) !== value) {
            changed = true
            break
          }
        }
      }
      if (changed) measuredHeights.value = next
    }

    function publishMetrics() {
      const model = layout.value
      window.__E1_CANVAS__ = {
        ready: true,
        fixtureId: fixtureId.value,
        nodeCount: fixture.value.graph.nodes.length,
        edgeCount: fixture.value.graph.edges.length,
        inspectorPresentation: presentation.value,
        sheetDetent: presentation.value === 'sheet' ? sheetDetent.value : null,
        inspectorOpen: inspectorOpen.value,
        readOnly: Boolean(fixture.value.readOnly),
        cards: model.cards.map((card) => ({
          focusId: card.focusId,
          name: card.name,
          type: card.type,
          x: card.x,
          y: card.y,
          width: card.width,
          height: card.height,
        })),
        edges: model.edges.map((edge) => ({
          focusId: edge.focusId,
          path: edge.path,
          midX: edge.midX,
          midY: edge.midY,
          sourceFocusId: edge.sourceFocusId,
          targetFocusId: edge.targetFocusId,
        })),
        branchLabels: model.branchLabels
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((label) => ({
            order: label.order,
            label: label.label,
            priority: label.priority,
            isDefault: label.isDefault,
            x: label.x,
          })),
        layoutWidth: model.width,
        layoutHeight: model.height,
        selectedName: selectedCard.value?.name ?? null,
        liveText: liveText.value,
        reducedMotion: reducedMotion.value,
        internalTokens: collectInternalTokens(fixture.value.graph),
      }
    }

    function onResize() {
      viewportW.value = window.innerWidth
      publishMetrics()
    }

    function onMotionChange(event: MediaQueryListEvent) {
      reducedMotion.value = event.matches
      publishMetrics()
    }

    onMounted(() => {
      window.addEventListener('resize', onResize)
      const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)')
      motionQuery?.addEventListener?.('change', onMotionChange)
      window.__E1_SELECT_FIXTURE__ = selectFixture
      window.__E1_SWAP_CONDITION_PRIORITY__ = swapConditionPriority
      void nextTick(() => {
        measureAndReflow()
        publishMetrics()
      })
    })

    onUnmounted(() => {
      window.removeEventListener('resize', onResize)
      delete window.__E1_SELECT_FIXTURE__
      delete window.__E1_SWAP_CONDITION_PRIORITY__
      delete window.__E1_CANVAS__
    })

    watch(layout, () => {
      void nextTick(() => {
        measureAndReflow()
        publishMetrics()
      })
    })

    watch(presentation, () => publishMetrics())
    watch(selectedFocusId, () => publishMetrics())

    return () => {
      const model = layout.value
      const mode = presentation.value
      const card = selectedCard.value
      const readOnly = Boolean(fixture.value.readOnly)

      const inspectorClass = [
        'e1-inspector',
        mode === 'dock' ? 'e1-inspector--dock' : null,
        mode === 'overlay' ? 'e1-inspector--overlay' : null,
        mode === 'sheet' ? 'e1-inspector--sheet' : null,
        mode === 'sheet' ? (sheetDetent.value === 'full' ? 'is-full' : 'is-half') : null,
      ].filter(Boolean)

      const inspector = inspectorOpen.value
        ? h('aside', {
          class: inspectorClass,
          'data-test': 'e1-inspector',
          'data-presentation': mode,
          'data-sheet-detent': mode === 'sheet' ? sheetDetent.value : undefined,
          'aria-label': '属性面板',
        }, [
          mode === 'sheet'
            ? h('div', { class: 'e1-sheet-handle', 'data-test': 'sheet-handle', 'aria-hidden': 'true' })
            : null,
          mode === 'sheet'
            ? h('div', { class: 'e1-sheet-actions' }, [
              h('button', {
                type: 'button',
                'data-test': 'sheet-half',
                onClick: () => {
                  sheetDetent.value = 'half'
                  announce('属性面板已收起为半屏')
                  publishMetrics()
                },
              }, '收起'),
              h('button', {
                type: 'button',
                'data-test': 'sheet-full',
                onClick: () => {
                  sheetDetent.value = 'full'
                  announce('属性面板已展开为全屏')
                  publishMetrics()
                },
              }, '展开'),
            ])
            : null,
          h('div', { class: 'e1-inspector__header' }, [
            h('h2', {
              class: 'e1-inspector__title',
              id: 'e1-inspector-heading',
              tabindex: -1,
            }, card ? `${card.typeLabel} · ${card.name}` : '属性'),
            h('button', {
              type: 'button',
              class: 'e1-inspector__close',
              'data-test': 'inspector-close',
              onClick: closeInspector,
            }, '关闭'),
          ]),
          h('div', { class: 'e1-inspector__body' }, [
            card
              ? h('div', [
                h('div', { class: 'e1-inspector__section' }, [
                  h('h3', '名称'),
                  h('div', { 'data-test': 'inspector-name' }, card.name),
                ]),
                h('div', { class: 'e1-inspector__section' }, [
                  h('h3', '类型'),
                  h('div', { 'data-test': 'inspector-type' }, card.typeLabel),
                ]),
                card.summaryLines.length
                  ? h('div', { class: 'e1-inspector__section' }, [
                    h('h3', '摘要'),
                    h('ul', { 'data-test': 'inspector-summary' },
                      card.summaryLines.map((line) => h('li', line))),
                  ])
                  : null,
                card.joinModeLabel
                  ? h('div', { class: 'e1-inspector__section' }, [
                    h('h3', '合并方式'),
                    h('div', { 'data-test': 'inspector-join-mode' }, card.joinModeLabel),
                  ])
                  : null,
                readOnly
                  ? h('div', {
                    class: 'e1-inspector__section',
                    'data-test': 'inspector-readonly',
                  }, fixture.value.readOnlyReason ?? '只读')
                  : h('div', {
                    class: 'e1-inspector__section e1-empty-inspector',
                  }, '配置项在生产检查器中编辑；本 spike 仅验证展示与几何。'),
              ])
              : h('div', { class: 'e1-empty-inspector' }, '选择一个节点以查看属性'),
          ]),
        ])
        : null

      return h('div', { class: 'e1-shell', 'data-test': 'e1-shell' }, [
        h('header', { class: 'e1-header', 'data-test': 'e1-header' }, [
          h('h1', '审批流程画布 E1 spike'),
          h('label', { style: 'display:flex;align-items:center;gap:6px;font-size:13px' }, [
            h('span', '夹具'),
            h('select', {
              'data-test': 'fixture-select',
              value: fixtureId.value,
              onChange: (event: Event) => {
                const value = (event.target as HTMLSelectElement).value as E1FixtureId
                selectFixture(value)
              },
            }, ALL_FIXTURES.map((item) => h('option', { value: item.id }, item.title))),
          ]),
          h('button', {
            type: 'button',
            'data-test': 'swap-priority',
            onClick: swapConditionPriority,
          }, '调整条件优先级'),
          h('span', {
            'data-test': 'fixture-title',
            style: 'font-size:13px;color:#4b5563',
          }, fixture.value.title),
          h('span', {
            'data-test': 'node-count',
            style: 'font-size:13px;color:#6b7280',
          }, `${fixture.value.graph.nodes.length} 个节点`),
        ]),
        readOnly
          ? h('div', {
            class: 'e1-banner',
            'data-test': 'readonly-banner',
            role: 'status',
          }, fixture.value.readOnlyReason)
          : null,
        // Single polite live region for command results (errors would be assertive in production).
        h('div', {
          class: 'e1-live',
          'data-test': 'e1-live',
          role: 'status',
          'aria-live': 'polite',
          'aria-atomic': 'true',
        }, liveText.value),
        h('div', { class: 'e1-body', 'data-test': 'e1-body' }, [
          h('div', {
            class: 'e1-canvas-region',
            'data-test': 'e1-canvas-region',
            onKeydown: onCanvasKeydown,
          }, [
            h('div', {
              class: 'e1-canvas-surface',
              'data-test': 'e1-canvas-surface',
              ref: (el: unknown) => {
                surfaceEl.value = (el as HTMLElement | null) ?? null
              },
              style: {
                width: `${model.width}px`,
                height: `${model.height}px`,
              },
            }, [
              h('svg', {
                class: 'e1-edges',
                width: model.width,
                height: model.height,
                'data-test': 'e1-edges',
              }, [
                h('defs', [
                  h('marker', {
                    id: 'e1-arrow',
                    viewBox: '0 0 10 10',
                    refX: 8,
                    refY: 5,
                    markerWidth: 6,
                    markerHeight: 6,
                    orient: 'auto-start-reverse',
                  }, [
                    h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#64748b' }),
                  ]),
                ]),
                ...model.edges.map((edge) => h('path', {
                  class: 'e1-edge-path',
                  d: edge.path,
                  'data-test': 'e1-edge',
                  'data-edge-focus': edge.focusId,
                })),
              ]),
              ...model.branchLabels.map((label) => h('div', {
                class: ['e1-branch-label', label.isDefault ? 'is-default' : null],
                'data-test': 'branch-label',
                'data-order': String(label.order),
                'data-default': label.isDefault ? 'true' : 'false',
                style: {
                  left: `${label.x}px`,
                  top: `${label.y}px`,
                },
                title: label.label,
              }, [
                label.priority != null
                  ? h('span', { class: 'e1-priority', 'data-test': 'branch-priority' }, `优先级${label.priority}`)
                  : null,
                h('span', label.label),
              ])),
              ...model.cards.map((item) => {
                const selected = item.focusId === selectedFocusId.value
                const paired =
                  selectedCard.value?.pairedFocusId === item.focusId ||
                  (selected && Boolean(item.pairedFocusId))
                return h('div', {
                  class: [
                    'e1-card',
                    selected ? 'is-selected' : null,
                    paired ? 'is-paired' : null,
                    readOnly ? 'is-readonly' : null,
                  ],
                  'data-test': 'flow-node',
                  'data-node-type': item.type,
                  'data-focus-id': item.focusId,
                  role: 'button',
                  tabindex: 0,
                  // Business language only — never node keys / edge keys / IDs.
                  'aria-label': `${item.typeLabel}：${item.name}`,
                  title: item.name,
                  style: {
                    left: `${item.x}px`,
                    top: `${item.y}px`,
                    width: `${item.width}px`,
                    // Height is content-driven (auto); layout uses measured/estimated height for edges.
                    minHeight: `${Math.max(48, item.height - 8)}px`,
                  },
                  onClick: () => selectCard(item),
                }, [
                  h('div', { class: 'e1-card__type' }, item.typeLabel),
                  h('div', { class: 'e1-card__name', 'data-test': 'node-name' }, item.name),
                  item.summaryLines.length
                    ? h('ul', { class: 'e1-card__summary', 'data-test': 'node-summary' },
                      item.summaryLines.map((line) => h('li', { title: line }, line)))
                    : null,
                  item.badges.length
                    ? h('div', { class: 'e1-card__badges' },
                      item.badges.map((badge) => h('span', { class: 'e1-card__badge' }, badge)))
                    : null,
                ])
              }),
              ...model.edges.filter((edge) => edge.insertable).map((edge) => h('button', {
                type: 'button',
                class: 'e1-insert',
                'data-test': 'edge-insert',
                'data-focus-id': edge.focusId,
                'aria-label': edge.ariaLabel,
                style: {
                  left: `${edge.midX}px`,
                  top: `${edge.midY}px`,
                },
                onClick: (event: MouseEvent) => {
                  event.stopPropagation()
                  openInsertMenu(edge)
                },
              }, '+')),
              insertMenu.value
                ? h('div', {
                  class: 'e1-insert-menu',
                  'data-test': 'insert-menu',
                  role: 'menu',
                  style: {
                    left: `${insertMenu.value.x + 24}px`,
                    top: `${insertMenu.value.y + 8}px`,
                  },
                }, [
                  h('button', {
                    type: 'button',
                    role: 'menuitem',
                    'data-test': 'insert-approval',
                    onClick: () => activateInsert('approval'),
                  }, '审批节点'),
                  h('button', {
                    type: 'button',
                    role: 'menuitem',
                    'data-test': 'insert-cc',
                    onClick: () => activateInsert('cc'),
                  }, '抄送节点'),
                ])
                : null,
            ]),
          ]),
          inspector,
        ]),
      ])
    }
  },
}).mount('#app')
