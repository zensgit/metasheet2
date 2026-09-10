<template>
  <div class="meta-base-picker">
    <div class="meta-base-picker__current" @click="open = !open">
      <span class="meta-base-picker__icon" :style="activeBase ? { background: activeBase.color ?? '#409eff' } : {}">
        {{ activeBase?.icon ?? '📋' }}
      </span>
      <span class="meta-base-picker__name">{{ activeBase?.name ?? l('basePicker.selectBase') }}</span>
      <span class="meta-base-picker__arrow">{{ open ? '▲' : '▼' }}</span>
    </div>

    <div v-if="open" class="meta-base-picker__dropdown">
      <div class="meta-base-picker__search">
        <input
          v-model="search"
          class="meta-base-picker__search-input"
          :placeholder="l('basePicker.searchPlaceholder')"
          @keydown.escape="open = false"
        />
      </div>
      <div class="meta-base-picker__list">
        <div
          v-for="base in filteredBases"
          :key="base.id"
          class="meta-base-picker__item"
          :class="{ 'meta-base-picker__item--active': base.id === activeBaseId }"
          @click="onSelect(base.id)"
        >
          <span class="meta-base-picker__item-icon" :style="{ background: base.color ?? '#409eff' }">{{ base.icon ?? '📋' }}</span>
          <!--
            Rename affordance (feat/multitable-rename). Hiding is UX only — the server is the real
            enforcement (PATCH /api/multitable/bases/:id gates on canManageFields, see
            MultitableWorkbench.vue's onRenameBase). Same inline-edit shape as
            MetaFieldManager.vue's field rename. @click.stop mirrors the favorite button below —
            without it, clicking into the input (or the confirm/cancel buttons) would also select
            this base via the row's own @click.
          -->
          <template v-if="renamingBaseId === base.id">
            <input
              class="meta-base-picker__rename-input"
              data-testid="base-picker-rename-input"
              :value="renamingBaseName"
              @click.stop
              @input="renamingBaseName = ($event.target as HTMLInputElement).value"
              @keydown.enter.stop="confirmRenameBase(base.id)"
              @keydown.escape.stop="cancelRenameBase"
            />
            <button
              type="button"
              class="meta-base-picker__rename-ok"
              data-testid="base-picker-rename-confirm"
              :disabled="!renamingBaseName.trim()"
              :title="l('basePicker.confirmRename')"
              @click.stop="confirmRenameBase(base.id)"
            >&#x2713;</button>
            <button
              type="button"
              class="meta-base-picker__rename-cancel"
              data-testid="base-picker-rename-cancel"
              :title="l('basePicker.cancelRename')"
              @click.stop="cancelRenameBase"
            >&#x2717;</button>
          </template>
          <template v-else>
            <span class="meta-base-picker__item-copy">
              <span class="meta-base-picker__item-name">{{ base.name }}</span>
              <span v-if="base.isFavorite || base.lastOpenedAt" class="meta-base-picker__badges">
                <span v-if="base.isFavorite">{{ l('basePicker.favoriteBadge') }}</span>
                <span v-if="base.lastOpenedAt">{{ l('basePicker.recentBadge') }}</span>
              </span>
            </span>
            <button
              v-if="canManageFields"
              type="button"
              class="meta-base-picker__rename"
              data-testid="base-picker-rename"
              :aria-label="renameAriaLabel(base.name, isZh)"
              @click.stop="startRenameBase(base)"
            >&#x270E;</button>
          </template>
          <button
            type="button"
            class="meta-base-picker__favorite"
            :aria-pressed="base.isFavorite"
            :aria-label="favoriteAriaLabel(base.name, base.isFavorite === true, isZh)"
            @click.stop="onToggleFavorite(base.id)"
          >
            {{ base.isFavorite ? '★' : '☆' }}
          </button>
        </div>
        <div v-if="!filteredBases.length" class="meta-base-picker__empty">{{ l('basePicker.empty') }}</div>
      </div>
      <div v-if="canCreate" class="meta-base-picker__create">
        <input
          v-model="newBaseName"
          class="meta-base-picker__create-input"
          :placeholder="l('basePicker.newBasePlaceholder')"
          @keydown.enter="onCreate"
        />
        <MtIconButton
          class="meta-base-picker__create-btn"
          variant="primary"
          :disabled="!newBaseName.trim()"
          @click="onCreate"
        >+</MtIconButton>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { DecoratedBase } from '../utils/base-local-state'
import { basePickerLabel, favoriteAriaLabel, renameAriaLabel } from '../utils/meta-base-picker-labels'
import { MtIconButton } from '../ui'

const props = defineProps<{
  bases: DecoratedBase[]
  activeBaseId: string
  canCreate?: boolean
  // Rename affordance (feat/multitable-rename): mirrors the server's canManageFields gate (admin
  // role or multitable:manage-schema). Hiding the pencil button when false is UX only — the
  // server re-checks on PATCH /api/multitable/bases/:id and 403s regardless.
  canManageFields?: boolean
}>()

const emit = defineEmits<{
  (e: 'select', baseId: string): void
  (e: 'create', name: string): void
  (e: 'toggle-favorite', baseId: string): void
  (e: 'rename', baseId: string, name: string): void
}>()

const open = ref(false)
const search = ref('')
const newBaseName = ref('')
const { isZh } = useLocale()
const l = (key: Parameters<typeof basePickerLabel>[0]) => basePickerLabel(key, isZh.value)

const activeBase = computed(() => props.bases.find((b) => b.id === props.activeBaseId) ?? null)

const filteredBases = computed(() => {
  const q = search.value.toLowerCase().trim()
  if (!q) return props.bases
  return props.bases.filter((b) => b.name.toLowerCase().includes(q))
})

function onSelect(baseId: string) {
  emit('select', baseId)
  open.value = false
  search.value = ''
}

function onCreate() {
  const name = newBaseName.value.trim()
  if (!name) return
  emit('create', name)
  newBaseName.value = ''
}

function onToggleFavorite(baseId: string) {
  emit('toggle-favorite', baseId)
}

// --- Rename affordance (feat/multitable-rename) --------------------------------------------
// Same inline-edit shape as MetaFieldManager.vue's field rename: pencil swaps the row into an
// input + confirm/cancel, Enter confirms, Escape cancels. This component only emits — the parent
// (MultitableWorkbench.vue) owns the HTTP call and error surfacing.
const renamingBaseId = ref<string | null>(null)
const renamingBaseName = ref('')

function startRenameBase(base: DecoratedBase) {
  renamingBaseId.value = base.id
  renamingBaseName.value = base.name
}

function confirmRenameBase(baseId: string) {
  const name = renamingBaseName.value.trim()
  const current = props.bases.find((base) => base.id === baseId)
  if (name && name !== current?.name) {
    emit('rename', baseId, name)
  }
  cancelRenameBase()
}

function cancelRenameBase() {
  renamingBaseId.value = null
  renamingBaseName.value = ''
}
</script>

<style scoped>
.meta-base-picker { position: relative; }
.meta-base-picker__current { display: flex; align-items: center; gap: 8px; padding: 6px 12px; cursor: pointer; border-radius: 6px; }
.meta-base-picker__current:hover { background: #f5f7fa; }
.meta-base-picker__icon { width: 24px; height: 24px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 14px; color: #fff; }
.meta-base-picker__name { font-size: 14px; font-weight: 600; color: #333; }
.meta-base-picker__arrow { font-size: 10px; color: #999; }
.meta-base-picker__dropdown { position: absolute; top: 100%; left: 0; min-width: 260px; background: #fff; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.15); z-index: 50; overflow: hidden; }
.meta-base-picker__search { padding: 8px; border-bottom: 1px solid #eee; }
.meta-base-picker__search-input { width: 100%; padding: 5px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
.meta-base-picker__list { max-height: 200px; overflow-y: auto; }
.meta-base-picker__item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; }
.meta-base-picker__item:hover { background: #f5f7fa; }
.meta-base-picker__item--active { background: #ecf5ff; }
.meta-base-picker__item-icon { width: 20px; height: 20px; border-radius: 3px; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #fff; flex-shrink: 0; }
.meta-base-picker__item-copy { min-width: 0; flex: 1; display: grid; gap: 4px; }
.meta-base-picker__item-name { font-size: 13px; color: #333; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-base-picker__badges { display: flex; flex-wrap: wrap; gap: 4px; }
.meta-base-picker__badges span { border-radius: 999px; padding: 2px 6px; background: #eff6ff; color: #1d4ed8; font-size: 10px; font-weight: 700; }
.meta-base-picker__favorite { flex-shrink: 0; width: 28px; height: 28px; border: 1px solid #dbeafe; border-radius: 999px; background: #f8fbff; color: #2563eb; cursor: pointer; font-size: 14px; line-height: 1; }
.meta-base-picker__favorite[aria-pressed='true'] { border-color: #f59e0b; background: #fffbeb; color: #92400e; }
.meta-base-picker__rename { flex-shrink: 0; width: 24px; height: 24px; border: none; border-radius: 4px; background: transparent; color: #94a3b8; cursor: pointer; font-size: 12px; line-height: 1; }
.meta-base-picker__rename:hover { background: #eff6ff; color: #2563eb; }
.meta-base-picker__rename-input { flex: 1; min-width: 0; padding: 4px 8px; border: 1px solid #2563eb; border-radius: 4px; font-size: 13px; }
.meta-base-picker__rename-ok, .meta-base-picker__rename-cancel { flex-shrink: 0; width: 24px; height: 24px; border: none; border-radius: 4px; background: transparent; color: #94a3b8; cursor: pointer; font-size: 12px; line-height: 1; }
.meta-base-picker__rename-ok:hover:not(:disabled) { background: #f0fdf4; color: #16a34a; }
.meta-base-picker__rename-ok:disabled { opacity: 0.5; cursor: not-allowed; }
.meta-base-picker__rename-cancel:hover { background: #fef2f2; color: #dc2626; }
.meta-base-picker__empty { padding: 16px; text-align: center; color: #999; font-size: 12px; }
.meta-base-picker__create { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #eee; }
.meta-base-picker__create-input { flex: 1; padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; }
/* UI-P2-1c batch-3: .meta-base-picker__create-btn (its only sharer, glyph-only "+") is now
   <MtIconButton variant="primary">; the bespoke #409eff fill is normalized to --ms-color-primary
   (sanctioned token convergence). Bespoke CSS removed to avoid double-styling the MtButton root; class
   kept as additive for selector stability. */
</style>
