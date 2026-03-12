<template>
  <div class="team-preset-block">
    <div class="team-preset-header">
      <span class="team-preset-title">团队视图</span>
      <button class="btn ghost mini" :disabled="loading.value" @click="refresh">
        {{ loading.value ? '刷新中...' : '刷新' }}
      </button>
    </div>
    <div class="field-inline">
      <select :id="selectId" v-model="teamViewKey.value" :name="selectName">
        <option value="">选择团队视图</option>
        <option v-for="view in teamViews.value" :key="view.id" :value="view.id">
          {{ view.name }} · {{ view.ownerUserId }}{{ view.isDefault ? ' · 默认' : '' }}{{ view.isArchived ? ' · 已归档' : '' }}
        </option>
      </select>
      <button class="btn ghost mini" :disabled="!(canApply?.value ?? Boolean(teamViewKey.value))" @click="apply">
        应用
      </button>
      <button
        v-if="duplicate"
        class="btn ghost mini"
        :disabled="!(canDuplicate?.value ?? false) || loading.value"
        @click="duplicate"
      >
        复制副本
      </button>
      <button
        v-if="share && (showManageActions?.value ?? true)"
        class="btn ghost mini"
        :disabled="!(canShare?.value ?? false) || loading.value"
        @click="share"
      >
        分享
      </button>
      <button v-if="showManageActions?.value ?? true" class="btn ghost mini" :disabled="!canSetDefault.value" @click="setDefault">
        设为默认
      </button>
      <button v-if="showManageActions?.value ?? true" class="btn ghost mini" :disabled="!canClearDefault.value" @click="clearDefault">
        取消默认
      </button>
      <button v-if="showManageActions?.value ?? true" class="btn ghost mini danger" :disabled="!canDelete.value" @click="remove">
        删除
      </button>
      <button
        v-if="archive && (showManageActions?.value ?? true)"
        class="btn ghost mini"
        :disabled="!(canArchive?.value ?? false) || loading.value"
        @click="archive"
      >
        归档
      </button>
      <button
        v-if="restore && (showManageActions?.value ?? true)"
        class="btn ghost mini"
        :disabled="!(canRestore?.value ?? false) || loading.value"
        @click="restore"
      >
        恢复
      </button>
    </div>
    <p v-if="defaultLabel.value" class="status">当前默认：{{ defaultLabel.value }}</p>
    <div class="field-inline">
      <input
        :id="inputId"
        v-model.trim="teamViewName.value"
        :name="inputName"
        :placeholder="`${label}团队视图名称`"
      />
      <button class="btn ghost mini" :disabled="!canSave.value || loading.value" @click="save">
        保存到团队
      </button>
      <button
        v-if="rename && (showManageActions?.value ?? true)"
        class="btn ghost mini"
        :disabled="!(canRename?.value ?? false) || loading.value"
        @click="rename"
      >
        重命名
      </button>
    </div>
    <div v-if="transfer && teamViewOwnerUserId && (showManageActions?.value ?? true)" class="field-inline">
      <input
        :id="ownerInputId"
        v-model.trim="teamViewOwnerUserId.value"
        :name="ownerInputName"
        :placeholder="`${label}目标用户 ID`"
      />
      <button
        class="btn ghost mini"
        :disabled="!(canTransfer?.value ?? false) || loading.value"
        @click="transfer"
      >
        转移所有者
      </button>
    </div>
    <button
      v-if="showBatchManager && hasManageableTeamViews?.value"
      class="btn ghost mini"
      :disabled="loading.value"
      @click="showBatchManager.value = !showBatchManager.value"
    >
      {{ showBatchManager.value ? '收起批量管理' : '批量管理' }}
    </button>
    <div v-if="showBatchManager?.value" class="preset-manager">
      <div class="field-inline field-actions">
        <button class="btn ghost mini" :disabled="!hasManageableTeamViews?.value" @click="selectAllTeamViews?.()">
          全选可管理
        </button>
        <button class="btn ghost mini" :disabled="!teamViewSelectionCount?.value" @click="clearTeamViewSelection?.()">
          清空选择
        </button>
        <span class="muted">已选 {{ teamViewSelectionCount?.value || 0 }}/{{ teamViews.value.length }}</span>
      </div>
      <div class="field-inline field-actions">
        <button class="btn ghost mini" :disabled="!(selectedBatchArchivableTeamViewIds?.value?.length)" @click="archiveTeamViewSelection?.()">
          批量归档
        </button>
        <button class="btn ghost mini" :disabled="!(selectedBatchRestorableTeamViewIds?.value?.length)" @click="restoreTeamViewSelection?.()">
          批量恢复
        </button>
        <button class="btn ghost mini danger" :disabled="!(selectedBatchDeletableTeamViewIds?.value?.length)" @click="deleteTeamViewSelection?.()">
          批量删除
        </button>
      </div>
      <div v-if="teamViewSelection" class="preset-list">
        <label v-for="view in teamViews.value" :key="view.id" class="preset-item">
          <input
            type="checkbox"
            :value="view.id"
            v-model="teamViewSelection.value"
            :disabled="!(view.permissions?.canManage ?? view.canManage)"
          />
          <span>
            {{ view.name }} · {{ view.ownerUserId }}{{ view.isDefault ? ' · 默认' : '' }}{{ view.isArchived ? ' · 已归档' : '' }}{{ !(view.permissions?.canManage ?? view.canManage) ? ' · 只读' : '' }}
          </span>
        </label>
      </div>
    </div>
    <p v-if="error.value" class="status error">{{ error.value }}</p>
  </div>
</template>

<script setup lang="ts">
import type { ComputedRef, Ref } from 'vue'

type TeamViewOption = {
  id: string
  name: string
  ownerUserId: string
  canManage?: boolean
  permissions?: {
    canManage?: boolean
  }
  isDefault: boolean
  isArchived?: boolean
}

defineProps<{
  label: string
  selectId: string
  selectName: string
  inputId: string
  inputName: string
  ownerInputId?: string
  ownerInputName?: string
  teamViewKey: Ref<string>
  teamViewName: Ref<string>
  teamViewOwnerUserId?: Ref<string>
  teamViews: Ref<ReadonlyArray<TeamViewOption>>
  loading: Ref<boolean>
  error: Ref<string>
  canSave: ComputedRef<boolean>
  canApply?: ComputedRef<boolean>
  showManageActions?: ComputedRef<boolean>
  canDuplicate?: ComputedRef<boolean>
  canShare?: ComputedRef<boolean>
  canDelete: ComputedRef<boolean>
  canArchive?: ComputedRef<boolean>
  canRestore?: ComputedRef<boolean>
  canRename?: ComputedRef<boolean>
  canTransfer?: ComputedRef<boolean>
  canSetDefault: ComputedRef<boolean>
  canClearDefault: ComputedRef<boolean>
  defaultLabel: ComputedRef<string>
  hasManageableTeamViews?: ComputedRef<boolean>
  showBatchManager?: Ref<boolean>
  teamViewSelection?: Ref<string[]>
  teamViewSelectionCount?: ComputedRef<number>
  selectedBatchArchivableTeamViewIds?: ComputedRef<string[]>
  selectedBatchRestorableTeamViewIds?: ComputedRef<string[]>
  selectedBatchDeletableTeamViewIds?: ComputedRef<string[]>
  refresh: () => void | Promise<void>
  apply: () => void | Promise<void>
  save: () => void | Promise<void>
  duplicate?: () => void | Promise<void>
  share?: () => void | Promise<void>
  remove: () => void | Promise<void>
  archive?: () => void | Promise<void>
  restore?: () => void | Promise<void>
  rename?: () => void | Promise<void>
  transfer?: () => void | Promise<void>
  setDefault: () => void | Promise<void>
  clearDefault: () => void | Promise<void>
  selectAllTeamViews?: () => void
  clearTeamViewSelection?: () => void
  archiveTeamViewSelection?: () => void | Promise<void>
  restoreTeamViewSelection?: () => void | Promise<void>
  deleteTeamViewSelection?: () => void | Promise<void>
}>()
</script>

<style scoped src="./PlmPanelShared.css"></style>
