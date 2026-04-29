<template>
  <div class="meta-hierarchy" role="tree" aria-label="Hierarchy view">
    <div class="meta-hierarchy__toolbar">
      <label class="meta-hierarchy__control">
        <span>Parent field</span>
        <select :value="hierarchyDraft.parentFieldId ?? ''" @change="onPickParentField">
          <option value="">(auto link field)</option>
          <option v-for="field in linkFields" :key="field.id" :value="field.id">{{ field.name }}</option>
        </select>
      </label>
      <label class="meta-hierarchy__control">
        <span>Title field</span>
        <select :value="hierarchyDraft.titleFieldId ?? ''" @change="onPickTitleField">
          <option value="">(auto)</option>
          <option v-for="field in fields" :key="field.id" :value="field.id">{{ field.name }}</option>
        </select>
      </label>
      <label class="meta-hierarchy__control">
        <span>Expand depth</span>
        <input
          :value="hierarchyDraft.defaultExpandDepth"
          type="number"
          min="0"
          max="8"
          @change="onPickExpandDepth"
        />
      </label>
      <label class="meta-hierarchy__control">
        <span>Orphans</span>
        <select :value="hierarchyDraft.orphanMode" @change="onPickOrphanMode">
          <option value="root">show at root</option>
          <option value="hidden">hide</option>
        </select>
      </label>
      <button v-if="canCreate" class="meta-hierarchy__create" @click="emit('create-record', {})">+ Add root</button>
    </div>

    <div v-if="!parentField" class="meta-hierarchy__placeholder">
      <strong>No parent link field configured.</strong>
      <span>Add or choose a link field to render parent-child relationships.</span>
    </div>

    <div v-else class="meta-hierarchy__body">
      <div v-if="treeDiagnostics.length" class="meta-hierarchy__notice" role="status">
        {{ treeDiagnostics.join(' ') }}
      </div>
      <ul v-if="visibleRoots.length" class="meta-hierarchy__list meta-hierarchy__list--root">
        <HierarchyNode
          v-for="node in visibleRoots"
          :key="node.record.id"
          :node="node"
          :expanded-ids="expandedIds"
          :title-for-row="titleForRow"
          :can-create="canCreate"
          :can-comment="canComment"
          :comment-presence="commentPresence"
          @toggle="toggleNode"
          @select-record="emitSelectRecord"
          @open-comments="emitOpenComments"
          @create-child="createChild"
        />
      </ul>
      <div v-else class="meta-hierarchy__empty">No records match this hierarchy view.</div>
    </div>

    <div v-if="loading" class="meta-hierarchy__loading">Loading...</div>
  </div>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, reactive, ref, watch, type PropType, type VNode } from 'vue'
import type { MetaField, MetaHierarchyViewConfig, MetaRecord, MultitableCommentPresenceSummary } from '../types'
import { formatFieldDisplay } from '../utils/field-display'
import { resolveHierarchyViewConfig } from '../utils/view-config'
import MetaCommentActionChip from './MetaCommentActionChip.vue'
import {
  handleCommentAffordanceKeydown,
  resolveCommentAffordanceStateClass,
  resolveRecordCommentAffordance,
} from '../utils/comment-affordance'

type HierarchyNodeModel = {
  record: MetaRecord
  children: HierarchyNodeModel[]
  depth: number
}

type TreeResult = {
  roots: HierarchyNodeModel[]
  diagnostics: string[]
}

const props = defineProps<{
  rows: MetaRecord[]
  fields: MetaField[]
  loading: boolean
  canCreate?: boolean
  canComment?: boolean
  viewConfig?: Record<string, unknown> | null
  commentPresence?: Record<string, MultitableCommentPresenceSummary | undefined>
}>()

const emit = defineEmits<{
  (e: 'select-record', recordId: string): void
  (e: 'open-comments', recordId: string): void
  (e: 'create-record', data: Record<string, unknown>): void
  (e: 'update-view-config', input: { config: Record<string, unknown> }): void
}>()

const hierarchyDraft = reactive<Required<MetaHierarchyViewConfig>>({
  parentFieldId: null,
  titleFieldId: null,
  defaultExpandDepth: 2,
  orphanMode: 'root',
})
const pendingConfigKey = ref<string | null>(null)
const expandedIds = ref<Set<string>>(new Set())

const hierarchyConfig = computed<Required<MetaHierarchyViewConfig>>(() =>
  resolveHierarchyViewConfig(props.fields, props.viewConfig),
)

watch(
  hierarchyConfig,
  (config) => {
    const normalized = normalizeHierarchyConfig(config)
    const configKey = JSON.stringify(normalized)
    if (pendingConfigKey.value && pendingConfigKey.value !== configKey) return
    Object.assign(hierarchyDraft, normalized)
    if (pendingConfigKey.value === configKey) pendingConfigKey.value = null
  },
  { immediate: true },
)

const linkFields = computed(() => props.fields.filter((field) => field.type === 'link'))
const parentField = computed(() =>
  hierarchyDraft.parentFieldId
    ? props.fields.find((field) => field.id === hierarchyDraft.parentFieldId && field.type === 'link') ?? null
    : null,
)
const titleField = computed(() =>
  hierarchyDraft.titleFieldId
    ? props.fields.find((field) => field.id === hierarchyDraft.titleFieldId) ?? null
    : props.fields.find((field) => field.type === 'string') ?? props.fields[0] ?? null,
)
const treeResult = computed<TreeResult>(() =>
  buildHierarchyTree(props.rows, hierarchyDraft.parentFieldId, hierarchyDraft.orphanMode),
)
const visibleRoots = computed(() => treeResult.value.roots)
const treeDiagnostics = computed(() => treeResult.value.diagnostics)

watch(
  [() => props.rows, () => hierarchyDraft.defaultExpandDepth, () => hierarchyDraft.parentFieldId],
  () => {
    expandedIds.value = defaultExpandedIds(treeResult.value.roots, hierarchyDraft.defaultExpandDepth)
  },
  { immediate: true },
)

function normalizeHierarchyConfig(config?: Partial<Required<MetaHierarchyViewConfig>>): Required<MetaHierarchyViewConfig> {
  return {
    parentFieldId: config?.parentFieldId ?? null,
    titleFieldId: config?.titleFieldId ?? null,
    defaultExpandDepth: config?.defaultExpandDepth ?? 2,
    orphanMode: config?.orphanMode === 'hidden' ? 'hidden' : 'root',
  }
}

function emitConfigUpdate(next: Partial<Required<MetaHierarchyViewConfig>>) {
  const normalized = normalizeHierarchyConfig({
    parentFieldId: hierarchyDraft.parentFieldId,
    titleFieldId: hierarchyDraft.titleFieldId,
    defaultExpandDepth: hierarchyDraft.defaultExpandDepth,
    orphanMode: hierarchyDraft.orphanMode,
    ...next,
  })
  Object.assign(hierarchyDraft, normalized)
  pendingConfigKey.value = JSON.stringify(normalized)
  emit('update-view-config', { config: normalized })
}

function onPickParentField(event: Event) {
  emitConfigUpdate({ parentFieldId: (event.target as HTMLSelectElement).value || null })
}

function onPickTitleField(event: Event) {
  emitConfigUpdate({ titleFieldId: (event.target as HTMLSelectElement).value || null })
}

function onPickExpandDepth(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  emitConfigUpdate({ defaultExpandDepth: Math.max(0, Math.min(8, Number.isFinite(value) ? Math.round(value) : 2)) })
}

function onPickOrphanMode(event: Event) {
  emitConfigUpdate({ orphanMode: (event.target as HTMLSelectElement).value === 'hidden' ? 'hidden' : 'root' })
}

function titleForRow(row: MetaRecord): string {
  if (!titleField.value) return row.id
  const display = formatFieldDisplay({ field: titleField.value, value: row.data[titleField.value.id] })
  return display === '-' || display === '—' ? row.id : display
}

function toggleNode(recordId: string) {
  const next = new Set(expandedIds.value)
  if (next.has(recordId)) next.delete(recordId)
  else next.add(recordId)
  expandedIds.value = next
}

function createChild(recordId: string) {
  const fieldId = hierarchyDraft.parentFieldId
  emit('create-record', fieldId ? { [fieldId]: [recordId] } : {})
}

function emitSelectRecord(recordId: string): void {
  emit('select-record', recordId)
}

function emitOpenComments(recordId: string): void {
  emit('open-comments', recordId)
}

function firstParentId(value: unknown): string | null {
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string' && item.trim().length > 0)
    return first ?? null
  }
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function hasCycle(recordId: string, parentById: Map<string, string | null>): boolean {
  const seen = new Set<string>()
  let current: string | null = recordId
  while (current) {
    if (seen.has(current)) return true
    seen.add(current)
    current = parentById.get(current) ?? null
  }
  return false
}

function buildHierarchyTree(rows: MetaRecord[], parentFieldId: string | null, orphanMode: 'root' | 'hidden'): TreeResult {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const parentById = new Map<string, string | null>()
  const cyclicIds = new Set<string>()
  let orphanCount = 0

  for (const row of rows) {
    const parentId = parentFieldId ? firstParentId(row.data[parentFieldId]) : null
    parentById.set(row.id, parentId && byId.has(parentId) ? parentId : null)
    if (parentId && !byId.has(parentId)) orphanCount += 1
  }

  for (const row of rows) {
    if (hasCycle(row.id, parentById)) cyclicIds.add(row.id)
  }
  for (const rowId of cyclicIds) parentById.set(rowId, null)

  const nodeById = new Map<string, HierarchyNodeModel>()
  for (const row of rows) nodeById.set(row.id, { record: row, children: [], depth: 0 })

  const roots: HierarchyNodeModel[] = []
  for (const row of rows) {
    const node = nodeById.get(row.id)!
    const parentId = parentById.get(row.id)
    if (parentId && !cyclicIds.has(row.id)) {
      nodeById.get(parentId)?.children.push(node)
    } else if (orphanMode === 'root' || !firstParentId(parentFieldId ? row.data[parentFieldId] : null) || cyclicIds.has(row.id)) {
      roots.push(node)
    }
  }

  function assignDepth(nodes: HierarchyNodeModel[], depth: number): void {
    for (const node of nodes) {
      node.depth = depth
      assignDepth(node.children, depth + 1)
    }
  }
  assignDepth(roots, 0)

  const diagnostics: string[] = []
  if (orphanCount > 0 && orphanMode === 'root') diagnostics.push(`${orphanCount} orphan record${orphanCount === 1 ? '' : 's'} shown at root.`)
  if (orphanCount > 0 && orphanMode === 'hidden') diagnostics.push(`${orphanCount} orphan record${orphanCount === 1 ? '' : 's'} hidden.`)
  if (cyclicIds.size > 0) diagnostics.push(`${cyclicIds.size} cyclic record${cyclicIds.size === 1 ? '' : 's'} detached to root.`)
  return { roots, diagnostics }
}

function defaultExpandedIds(nodes: HierarchyNodeModel[], depth: number): Set<string> {
  const ids = new Set<string>()
  function visit(node: HierarchyNodeModel): void {
    if (node.depth < depth && node.children.length > 0) ids.add(node.record.id)
    node.children.forEach(visit)
  }
  nodes.forEach(visit)
  return ids
}

const HierarchyNode: ReturnType<typeof defineComponent> = defineComponent({
  name: 'HierarchyNode',
  props: {
    node: { type: Object as PropType<HierarchyNodeModel>, required: true },
    expandedIds: { type: Object as PropType<Set<string>>, required: true },
    titleForRow: { type: Function as PropType<(row: MetaRecord) => string>, required: true },
    canCreate: { type: Boolean, default: false },
    canComment: { type: Boolean, default: false },
    commentPresence: { type: Object as PropType<Record<string, MultitableCommentPresenceSummary | undefined> | undefined>, default: undefined },
  },
  emits: ['toggle', 'select-record', 'open-comments', 'create-child'],
  setup(nodeProps, { emit: nodeEmit }) {
    function rowCommentAffordance(recordId: string) {
      return resolveRecordCommentAffordance(nodeProps.commentPresence?.[recordId])
    }
    function rowCommentButtonClass(recordId: string): string {
      return resolveCommentAffordanceStateClass('meta-hierarchy__comment-btn', rowCommentAffordance(recordId))
    }
    return (): VNode => {
      const node = nodeProps.node
      const title = nodeProps.titleForRow(node.record)
      const expanded = nodeProps.expandedIds.has(node.record.id)
      const hasChildren = node.children.length > 0
      return h('li', { class: 'meta-hierarchy__item' }, [
        h('div', {
          class: 'meta-hierarchy__row',
          role: 'treeitem',
          'aria-expanded': hasChildren ? String(expanded) : undefined,
          style: { paddingLeft: `${node.depth * 18 + 8}px` },
        }, [
          h('button', {
            class: ['meta-hierarchy__toggle', { 'meta-hierarchy__toggle--empty': !hasChildren }],
            type: 'button',
            disabled: !hasChildren,
            onClick: () => nodeEmit('toggle', node.record.id),
          }, hasChildren ? (expanded ? '▾' : '▸') : '•'),
          h('button', {
            class: 'meta-hierarchy__title',
            type: 'button',
            onClick: () => nodeEmit('select-record', node.record.id),
          }, title),
          nodeProps.canComment
            ? h('button', {
              class: rowCommentButtonClass(node.record.id),
              type: 'button',
              'aria-label': `Open comments for ${title}`,
              onClick: () => nodeEmit('open-comments', node.record.id),
              onKeydown: (event: KeyboardEvent) => handleCommentAffordanceKeydown(event, () => nodeEmit('open-comments', node.record.id)),
            }, [h(MetaCommentActionChip, { label: 'Comments', state: rowCommentAffordance(node.record.id) })])
            : null,
          nodeProps.canCreate
            ? h('button', {
              class: 'meta-hierarchy__child-btn',
              type: 'button',
              onClick: () => nodeEmit('create-child', node.record.id),
            }, '+ Child')
            : null,
        ]),
        hasChildren && expanded
          ? h('ul', { class: 'meta-hierarchy__list', role: 'group' }, node.children.map((child: HierarchyNodeModel): VNode =>
            h(HierarchyNode, {
              key: child.record.id,
              node: child,
              expandedIds: nodeProps.expandedIds,
              titleForRow: nodeProps.titleForRow,
              canCreate: nodeProps.canCreate,
              canComment: nodeProps.canComment,
              commentPresence: nodeProps.commentPresence,
              onToggle: (recordId: string) => nodeEmit('toggle', recordId),
              onSelectRecord: (recordId: string) => nodeEmit('select-record', recordId),
              onOpenComments: (recordId: string) => nodeEmit('open-comments', recordId),
              onCreateChild: (recordId: string) => nodeEmit('create-child', recordId),
            }),
          ))
          : null,
      ])
    }
  },
})
</script>

<style scoped>
.meta-hierarchy { position: relative; display: flex; flex-direction: column; flex: 1; min-height: 0; background: #f8fafc; color: #334155; }
.meta-hierarchy__toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; padding: 12px 16px; border-bottom: 1px solid #e2e8f0; background: #fff; }
.meta-hierarchy__control { display: flex; flex-direction: column; gap: 4px; min-width: 130px; font-size: 11px; color: #64748b; }
.meta-hierarchy__control select, .meta-hierarchy__control input { padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; color: #334155; }
.meta-hierarchy__create { padding: 7px 12px; border: 1px solid #2563eb; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; }
.meta-hierarchy__placeholder, .meta-hierarchy__empty { margin: 24px; padding: 28px; border: 1px dashed #cbd5e1; border-radius: 10px; background: #fff; color: #64748b; text-align: center; display: flex; flex-direction: column; gap: 6px; }
.meta-hierarchy__body { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px 24px; }
.meta-hierarchy__notice { margin-bottom: 10px; padding: 8px 10px; border: 1px solid #fde68a; border-radius: 8px; background: #fffbeb; color: #92400e; font-size: 12px; }
.meta-hierarchy__list { margin: 0; padding: 0; list-style: none; }
.meta-hierarchy__list--root { border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; background: #fff; }
.meta-hierarchy__row { display: flex; align-items: center; gap: 8px; min-height: 40px; border-bottom: 1px solid #edf2f7; }
.meta-hierarchy__item:last-child > .meta-hierarchy__row { border-bottom: 0; }
.meta-hierarchy__toggle { width: 24px; height: 24px; border: 0; border-radius: 6px; background: #eef2ff; color: #3730a3; cursor: pointer; }
.meta-hierarchy__toggle--empty { background: transparent; color: #94a3b8; cursor: default; }
.meta-hierarchy__title { min-width: 0; flex: 1; border: 0; background: transparent; color: #1e293b; font-weight: 600; text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-hierarchy__title:hover { color: #2563eb; }
.meta-hierarchy__comment-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 28px; padding: 2px 8px; border: 1px solid #d8e1ee; border-radius: 999px; background: #fff; cursor: pointer; color: #64748b; }
.meta-hierarchy__comment-btn:hover { border-color: #93c5fd; background: #eff6ff; color: #2563eb; }
.meta-hierarchy__comment-btn--active { border-color: #f59e0b; background: #fff7ed; color: #b45309; }
.meta-hierarchy__comment-btn--idle { border-color: #d8e1ee; background: #fff; color: #64748b; }
.meta-hierarchy__child-btn { margin-right: 10px; padding: 4px 8px; border: 1px dashed #cbd5e1; border-radius: 6px; background: #fff; color: #475569; cursor: pointer; font-size: 12px; }
.meta-hierarchy__child-btn:hover { border-color: #2563eb; color: #2563eb; }
.meta-hierarchy__loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.7); font-size: 14px; color: #666; z-index: 10; }
</style>
