// Browser-verification harness (dev/CI only — NOT part of the app build/typecheck;
// lives outside src/ so vue-tsc + vite build ignore it). E1 isolated approval-flow
// renderer spike: constrained vertical tree, no free-form graph, no persisted
// coordinates, no production route wiring.
//
// E1-b: mutations go through the real production approvalCanvasCommands history API
// (create / apply / undo / redo). The renderer never re-implements topology validation.
import { computed, createApp, h, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import '../src/styles/tokens.css'
import {
  applyApprovalCanvasCommand,
  createApprovalCanvasHistory,
  redoApprovalCanvasCommand,
  undoApprovalCanvasCommand,
  type ApprovalCanvasCommand,
  type ApprovalCanvasCommandErrorCode,
  type ApprovalCanvasHistory,
  type ApprovalCanvasSelection,
} from '../src/approvals/approvalCanvasCommands'
import type { ApprovalGraph, ConditionNodeConfig } from '../src/types/approval'
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
/** Input channel for the single command adapter (pointer/HTML5 and keyboard share it). */
type CommandChannel = 'pointer' | 'keyboard' | 'toolbar'

interface InsertMenuState {
  edgeFocusId: string
  edgeKey: string
  x: number
  y: number
}

interface CommandDispatchResult {
  ok: boolean
  code: ApprovalCanvasCommandErrorCode | null
  channel: CommandChannel
  liveText: string
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
  /** Sole persisted model snapshot (no coordinates). Verification only. */
  graphJson: string
  canUndo: boolean
  canRedo: boolean
  undoDepth: number
  lastCommandOk: boolean | null
  lastCommandCode: string | null
  lastCommandChannel: CommandChannel | null
  /** Opaque focusId → graph key maps (window metrics only; never DOM text). */
  cardKeyByFocusId: Record<string, string>
  edgeKeyByFocusId: Record<string, string>
}

declare global {
  interface Window {
    __E1_CANVAS__?: E1PublicMetrics
    __E1_SELECT_FIXTURE__?: (id: E1FixtureId) => void
    /** Real reorder-condition-branches via history API (no fixture swap). */
    __E1_SWAP_CONDITION_PRIORITY__?: () => CommandDispatchResult | void
    __E1_UNDO__?: () => CommandDispatchResult | void
    __E1_REDO__?: () => CommandDispatchResult | void
    /**
     * Canonical move adapter entry (same function keyboard + pointer/HTML5 use).
     * Channel defaults to 'keyboard' for programmatic harness hooks.
     */
    __E1_MOVE_NODE_INTO_EDGE__?: (
      nodeKey: string,
      intoEdgeKey: string,
      channel?: CommandChannel,
    ) => CommandDispatchResult
    __E1_APPLY_COMMAND__?: (
      command: ApprovalCanvasCommand,
      channel?: CommandChannel,
    ) => CommandDispatchResult
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

function cloneGraph(graph: ApprovalGraph): ApprovalGraph {
  return JSON.parse(JSON.stringify(graph)) as ApprovalGraph
}

function cloneFixture(id: E1FixtureId): E1Fixture {
  const base = getFixture(id)
  return JSON.parse(JSON.stringify(base)) as E1Fixture
}

/**
 * Values-free business copy for command rejections.
 * Never interpolates node keys, edge keys, field IDs, or raw internal messages.
 */
function businessCopyForError(code: ApprovalCanvasCommandErrorCode): string {
  switch (code) {
    case 'self-slot':
    case 'adjacent-slot':
    case 'ambiguous-slot':
    case 'cycle':
    case 'nested-parallel-invalid':
    case 'empty-parallel-branch':
    case 'edge-not-found':
    case 'not-linear':
      return '该位置不能放置此节点'
    case 'unsupported-node-type':
      return '此节点类型不支持此操作'
    case 'node-not-found':
      return '未找到可操作的节点'
    case 'invalid-branch-order':
    case 'default-edge-immutable':
      return '无法调整该分支顺序'
    case 'empty-history':
      return '没有可撤销的操作'
    case 'unknown-command':
      return '操作无法完成'
    default: {
      const _exhaustive: never = code
      void _exhaustive
      return '操作无法完成'
    }
  }
}

function successCopyForCommand(
  command: ApprovalCanvasCommand,
  fixture: E1Fixture,
  graph: ApprovalGraph,
): string {
  if (command.type === 'move-node-into-edge') {
    const node = graph.nodes.find((item) => item.key === command.nodeKey)
    const name = node?.name?.trim() || '节点'
    return `已移动「${name}」`
  }
  if (command.type === 'reorder-condition-branches') {
    const firstKey = command.orderedEdgeKeys[0]
    const raised =
      (firstKey && fixture.branchDisplayLabels?.[firstKey]) ||
      graph.nodes.find((item) => item.key === command.conditionNodeKey)?.name ||
      '分支'
    return `已提高「${raised}」的优先级`
  }
  if (command.type === 'reorder-parallel-branches') {
    return '已调整并行分支顺序'
  }
  return '操作已完成'
}

createApp({
  setup() {
    const fixtureId = ref<E1FixtureId>('linear')
    const fixture = ref<E1Fixture>(cloneFixture('linear'))
    const history = ref<ApprovalCanvasHistory>(
      createApprovalCanvasHistory(cloneGraph(fixture.value.graph)),
    )
    // Keep fixture.graph as the history graph reference surface for layout.
    fixture.value = { ...fixture.value, graph: history.value.graph }

    const selectedFocusId = ref<string | null>(null)
    const liveText = ref('')
    const viewportW = ref(window.innerWidth)
    const sheetDetent = ref<SheetDetent>('half')
    const insertMenu = ref<InsertMenuState | null>(null)
    const measuredHeights = ref<Map<string, number>>(new Map())
    const surfaceEl = ref<HTMLElement | null>(null)
    const reducedMotion = ref(prefersReducedMotion())
    const lastResult = ref<CommandDispatchResult | null>(null)
    const draggingNodeKey = ref<string | null>(null)
    const dragOverEdgeFocusId = ref<string | null>(null)

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

    function syncFixtureFromHistory() {
      fixture.value = {
        ...fixture.value,
        graph: history.value.graph,
      }
    }

    /**
     * Map history.selection (stable graph keys) onto the current layout's render-only
     * focusId. Never stores focusIds or coordinates in history — only remaps after render.
     */
    function focusIdForHistorySelection(
      selection: ApprovalCanvasSelection,
      model: E1LayoutModel,
    ): string | null {
      if (selection.kind === 'none') return null
      if (selection.kind === 'node') {
        return model.cards.find((card) => card.nodeKey === selection.nodeKey)?.focusId ?? null
      }
      if (selection.kind === 'edge') {
        return model.edges.find((edge) => edge.edgeKey === selection.edgeKey)?.focusId ?? null
      }
      if (selection.kind === 'condition-branch') {
        // Prefer the gateway card so the inspector stays on the business node; fall back to branch edge.
        return (
          model.cards.find((card) => card.nodeKey === selection.conditionNodeKey)?.focusId ??
          model.edges.find((edge) => edge.edgeKey === selection.edgeKey)?.focusId ??
          null
        )
      }
      if (selection.kind === 'parallel-branch') {
        return (
          model.cards.find((card) => card.nodeKey === selection.parallelNodeKey)?.focusId ??
          model.edges.find((edge) => edge.edgeKey === selection.edgeKey)?.focusId ??
          null
        )
      }
      const _exhaustive: never = selection
      void _exhaustive
      return null
    }

    /**
     * After apply/undo/redo, rebind selectedFocusId from history.selection using the
     * newly computed layout. Layer-order focus IDs can change after a move; keys do not.
     */
    function restoreSelectionFromHistory() {
      const focusId = focusIdForHistorySelection(history.value.selection, layout.value)
      selectedFocusId.value = focusId
      if (focusId) {
        void nextTick(() => {
          document.querySelector<HTMLElement>(`[data-focus-id="${focusId}"]`)?.focus()
        })
      }
    }

    function afterHistoryMutation() {
      measuredHeights.value = new Map()
      // Layout recomputes synchronously from the new graph; remap before paint/metrics.
      restoreSelectionFromHistory()
      void nextTick(() => {
        measureAndReflow()
        // Heights can reflow geometry but not focusId identity; remap again in case layout rebuilt.
        restoreSelectionFromHistory()
        publishMetrics()
      })
    }

    /**
     * Single command adapter for toolbar, keyboard, and pointer/HTML5 drag.
     * Topology validity is decided only by the production command layer — never here.
     */
    function runCanvasCommand(
      command: ApprovalCanvasCommand,
      channel: CommandChannel,
      selectionBefore?: ApprovalCanvasSelection,
    ): CommandDispatchResult {
      if (fixture.value.readOnly) {
        const result: CommandDispatchResult = {
          ok: false,
          code: 'unsupported-node-type',
          channel,
          liveText: '当前为只读夹具，无法编辑',
        }
        lastResult.value = result
        announce(result.liveText)
        publishMetrics()
        return result
      }

      const selection =
        selectionBefore ??
        (selectedCard.value
          ? ({ kind: 'node', nodeKey: selectedCard.value.nodeKey } satisfies ApprovalCanvasSelection)
          : ({ kind: 'none' } satisfies ApprovalCanvasSelection))

      const applied = applyApprovalCanvasCommand(history.value, command, selection)
      if (!applied.ok) {
        const copy = businessCopyForError(applied.error.code)
        const result: CommandDispatchResult = {
          ok: false,
          code: applied.error.code,
          channel,
          liveText: copy,
        }
        lastResult.value = result
        // Failure returns the same history reference — graph stays byte-identical.
        announce(copy)
        publishMetrics()
        return result
      }

      history.value = applied.history
      syncFixtureFromHistory()
      const copy = successCopyForCommand(command, fixture.value, history.value.graph)
      const result: CommandDispatchResult = {
        ok: true,
        code: null,
        channel,
        liveText: copy,
      }
      lastResult.value = result
      announce(copy)
      afterHistoryMutation()
      return result
    }

    function selectFixture(id: E1FixtureId) {
      fixtureId.value = id
      const next = cloneFixture(id)
      history.value = createApprovalCanvasHistory(cloneGraph(next.graph))
      fixture.value = { ...next, graph: history.value.graph }
      selectedFocusId.value = null
      insertMenu.value = null
      measuredHeights.value = new Map()
      draggingNodeKey.value = null
      dragOverEdgeFocusId.value = null
      lastResult.value = null
      announce(`已加载夹具：${fixture.value.title}`)
      void nextTick(() => {
        measureAndReflow()
        publishMetrics()
      })
    }

    /**
     * Raise the second rule branch to highest priority via reorder-condition-branches.
     * Replaces the demo-only fixture swap; default branch is never included.
     */
    function swapConditionPriority(): CommandDispatchResult | void {
      if (fixture.value.readOnly) {
        const result: CommandDispatchResult = {
          ok: false,
          code: 'unsupported-node-type',
          channel: 'toolbar',
          liveText: '当前为只读夹具，无法调整优先级',
        }
        lastResult.value = result
        announce(result.liveText)
        publishMetrics()
        return result
      }
      const condition = history.value.graph.nodes.find((node) => node.type === 'condition')
      if (!condition) {
        announce('请先加载条件分支夹具')
        return
      }
      const config = condition.config as ConditionNodeConfig
      const keys = (config.branches ?? []).map((branch) => branch.edgeKey)
      if (keys.length < 2) {
        announce('当前条件没有可对调的规则分支')
        return
      }
      const orderedEdgeKeys = [keys[1]!, keys[0]!, ...keys.slice(2)]
      return runCanvasCommand(
        {
          type: 'reorder-condition-branches',
          conditionNodeKey: condition.key,
          orderedEdgeKeys,
        },
        'toolbar',
        { kind: 'node', nodeKey: condition.key },
      )
    }

    function undoLast(): CommandDispatchResult {
      const undone = undoApprovalCanvasCommand(history.value)
      if (!undone.ok) {
        const copy = businessCopyForError(undone.error.code)
        const result: CommandDispatchResult = {
          ok: false,
          code: undone.error.code,
          channel: 'toolbar',
          liveText: copy,
        }
        lastResult.value = result
        announce(copy)
        publishMetrics()
        return result
      }
      history.value = undone.history
      syncFixtureFromHistory()
      const result: CommandDispatchResult = {
        ok: true,
        code: null,
        channel: 'toolbar',
        liveText: '已撤销上一步操作',
      }
      lastResult.value = result
      announce(result.liveText)
      // selectionBefore is restored on history.selection — remap to post-undo focusIds.
      afterHistoryMutation()
      return result
    }

    function redoLast(): CommandDispatchResult {
      const redone = redoApprovalCanvasCommand(history.value)
      if (!redone.ok) {
        const copy = businessCopyForError(redone.error.code)
        const result: CommandDispatchResult = {
          ok: false,
          code: redone.error.code,
          channel: 'toolbar',
          liveText: copy,
        }
        lastResult.value = result
        announce(copy)
        publishMetrics()
        return result
      }
      history.value = redone.history
      syncFixtureFromHistory()
      const result: CommandDispatchResult = {
        ok: true,
        code: null,
        channel: 'toolbar',
        liveText: '已重做上一步操作',
      }
      lastResult.value = result
      announce(result.liveText)
      // selectionAfter is restored on history.selection — remap to post-redo focusIds.
      afterHistoryMutation()
      return result
    }

    /** Canonical move used by pointer/HTML5 drag and keyboard activation alike. */
    function moveNodeIntoEdge(
      nodeKey: string,
      intoEdgeKey: string,
      channel: CommandChannel,
    ): CommandDispatchResult {
      return runCanvasCommand(
        { type: 'move-node-into-edge', nodeKey, intoEdgeKey },
        channel,
        { kind: 'node', nodeKey },
      )
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
      insertMenu.value = {
        edgeFocusId: edge.focusId,
        edgeKey: edge.edgeKey,
        x: edge.midX,
        y: edge.midY,
      }
      announce(`已打开插入菜单：${edge.ariaLabel}`)
      void nextTick(() => {
        const first = document.querySelector<HTMLElement>('[data-test="insert-menu"] button')
        first?.focus()
      })
    }

    function activateInsert(kind: 'approval' | 'cc') {
      const label = kind === 'approval' ? '审批' : '抄送'
      insertMenu.value = null
      // Spike: announce activation only — insert mutations stay out of E1-b scope.
      announce(`已选择插入「${label}」节点（spike 演示，未写入业务模型）`)
      publishMetrics()
    }

    function activateMoveSelectedToEdge(edgeKey: string, channel: CommandChannel) {
      const card = selectedCard.value
      if (!card || (card.type !== 'approval' && card.type !== 'cc')) {
        announce('请先选中可移动的审批或抄送节点')
        return
      }
      insertMenu.value = null
      moveNodeIntoEdge(card.nodeKey, edgeKey, channel)
    }

    function isCardDraggable(card: E1CardModel): boolean {
      if (fixture.value.readOnly) return false
      return card.type === 'approval' || card.type === 'cc'
    }

    function onCardDragStart(card: E1CardModel, event: DragEvent) {
      if (!isCardDraggable(card)) {
        event.preventDefault()
        return
      }
      draggingNodeKey.value = card.nodeKey
      selectedFocusId.value = card.focusId
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move'
        // Opaque token only — never surface graph keys in accessible DOM text.
        event.dataTransfer.setData('text/plain', card.focusId)
      }
    }

    function onCardDragEnd() {
      draggingNodeKey.value = null
      dragOverEdgeFocusId.value = null
    }

    function onEdgeDragOver(edge: E1EdgeModel, event: DragEvent) {
      if (!draggingNodeKey.value || !edge.insertable || fixture.value.readOnly) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      dragOverEdgeFocusId.value = edge.focusId
    }

    function onEdgeDragLeave(edge: E1EdgeModel) {
      if (dragOverEdgeFocusId.value === edge.focusId) dragOverEdgeFocusId.value = null
    }

    function onEdgeDrop(edge: E1EdgeModel, event: DragEvent) {
      event.preventDefault()
      const nodeKey = draggingNodeKey.value
      dragOverEdgeFocusId.value = null
      draggingNodeKey.value = null
      if (!nodeKey || !edge.insertable) return
      // Pointer/HTML5 path — same adapter as keyboard.
      moveNodeIntoEdge(nodeKey, edge.edgeKey, 'pointer')
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

      // Undo / redo (toolbar channel for chrome-equivalent keyboard shortcuts).
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redoLast()
        else undoLast()
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

      // Keyboard semantic move: with a movable node selected, `m` on an edge insert
      // uses the same adapter as pointer/HTML5 drop.
      if (event.key === 'm' || event.key === 'M') {
        const edge = layout.value.edges.find((item) => item.focusId === focusId)
        if (edge?.insertable) {
          event.preventDefault()
          activateMoveSelectedToEdge(edge.edgeKey, 'keyboard')
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
        const measured = el.getBoundingClientRect().height
        if (measured > 0) next.set(card.nodeKey, Math.ceil(measured))
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
      const cardKeyByFocusId: Record<string, string> = {}
      const edgeKeyByFocusId: Record<string, string> = {}
      for (const card of model.cards) cardKeyByFocusId[card.focusId] = card.nodeKey
      for (const edge of model.edges) edgeKeyByFocusId[edge.focusId] = edge.edgeKey

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
        graphJson: JSON.stringify(history.value.graph),
        canUndo: history.value.undoStack.length > 0,
        canRedo: history.value.redoStack.length > 0,
        undoDepth: history.value.undoStack.length,
        lastCommandOk: lastResult.value?.ok ?? null,
        lastCommandCode: lastResult.value?.code ?? null,
        lastCommandChannel: lastResult.value?.channel ?? null,
        cardKeyByFocusId,
        edgeKeyByFocusId,
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
      window.__E1_UNDO__ = undoLast
      window.__E1_REDO__ = redoLast
      window.__E1_MOVE_NODE_INTO_EDGE__ = (nodeKey, intoEdgeKey, channel = 'keyboard') =>
        moveNodeIntoEdge(nodeKey, intoEdgeKey, channel)
      window.__E1_APPLY_COMMAND__ = (command, channel = 'keyboard') =>
        runCanvasCommand(command, channel)
      void nextTick(() => {
        measureAndReflow()
        publishMetrics()
      })
    })

    onUnmounted(() => {
      window.removeEventListener('resize', onResize)
      delete window.__E1_SELECT_FIXTURE__
      delete window.__E1_SWAP_CONDITION_PRIORITY__
      delete window.__E1_UNDO__
      delete window.__E1_REDO__
      delete window.__E1_MOVE_NODE_INTO_EDGE__
      delete window.__E1_APPLY_COMMAND__
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
      const movableSelected =
        card != null && (card.type === 'approval' || card.type === 'cc') && !readOnly

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
            onClick: () => {
              swapConditionPriority()
            },
          }, '调整条件优先级'),
          h('button', {
            type: 'button',
            'data-test': 'undo',
            disabled: history.value.undoStack.length === 0,
            onClick: () => {
              undoLast()
            },
          }, '撤销'),
          h('button', {
            type: 'button',
            'data-test': 'redo',
            disabled: history.value.redoStack.length === 0,
            onClick: () => {
              redoLast()
            },
          }, '重做'),
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
                const draggable = isCardDraggable(item)
                return h('div', {
                  class: [
                    'e1-card',
                    selected ? 'is-selected' : null,
                    paired ? 'is-paired' : null,
                    readOnly ? 'is-readonly' : null,
                    draggable ? 'is-draggable' : null,
                    draggingNodeKey.value === item.nodeKey ? 'is-dragging' : null,
                  ],
                  'data-test': 'flow-node',
                  'data-node-type': item.type,
                  'data-focus-id': item.focusId,
                  'data-draggable': draggable ? 'true' : 'false',
                  role: 'button',
                  tabindex: 0,
                  draggable,
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
                  onDragstart: (event: DragEvent) => onCardDragStart(item, event),
                  onDragend: onCardDragEnd,
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
                class: [
                  'e1-insert',
                  dragOverEdgeFocusId.value === edge.focusId ? 'is-drop-target' : null,
                ],
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
                onDragover: (event: DragEvent) => onEdgeDragOver(edge, event),
                onDragleave: () => onEdgeDragLeave(edge),
                onDrop: (event: DragEvent) => onEdgeDrop(edge, event),
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
                  movableSelected
                    ? h('button', {
                      type: 'button',
                      role: 'menuitem',
                      'data-test': 'move-selected-here',
                      onClick: () => {
                        const edgeKey = insertMenu.value?.edgeKey
                        if (edgeKey) activateMoveSelectedToEdge(edgeKey, 'keyboard')
                      },
                    }, '移动已选节点到此处')
                    : null,
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
