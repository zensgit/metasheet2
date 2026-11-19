<template>
  <div class="admin-authorization__shield" data-testid="admin-authorization-shield">
    <div
      ref="dialogRoot"
      class="admin-authorization"
      role="dialog"
      aria-modal="true"
      aria-labelledby="admin-authorization-title"
      data-testid="admin-authorization-dialog"
      tabindex="-1"
    >
      <h2 id="admin-authorization-title">确认这次授权变更</h2>
      <p data-testid="admin-authorization-target">
        对象：{{ draft.targetName }}<template v-if="draft.targetUserId">（{{ draft.targetUserId }}）</template>
      </p>
      <p data-testid="admin-authorization-role">角色：{{ draft.roleName }}<template v-if="draft.roleId && draft.roleId !== draft.roleName">（{{ draft.roleId }}）</template></p>
      <div data-testid="admin-authorization-direct-permissions">
        <strong>直接权限码</strong>
        <ul v-if="draft.directPermissionCodes.length > 0">
          <li v-for="code in draft.directPermissionCodes" :key="`direct-${code}`">{{ code }}</li>
        </ul>
        <p v-else>无</p>
      </div>
      <div data-testid="admin-authorization-inherited-permissions">
        <strong>角色继承权限码</strong>
        <ul v-if="draft.inheritedKnown && draft.inheritedPermissionCodes.length > 0">
          <li v-for="code in draft.inheritedPermissionCodes" :key="`inherited-${code}`">{{ code }}</li>
        </ul>
        <p v-else-if="draft.inheritedKnown">无</p>
        <p v-else>角色目录没有这份角色，不能把缺失列表当作没有继承权限。</p>
        <p v-if="draft.platformAdminAuthority" data-testid="admin-authorization-platform-admin">
          平台管理员拥有平台管理权限。权限码列表即使为空，也不表示没有管理权限。
        </p>
      </div>
      <div v-if="serverImpact" data-testid="admin-authorization-server-impact">
        <strong>服务器预览</strong>
        <p data-testid="admin-authorization-role-sources">角色来源：{{ joined(serverImpact.roleSources) }}</p>
        <p data-testid="admin-authorization-explicit-admissions">显式准入：{{ joined(serverImpact.explicitAdmissions) }}</p>
        <p data-testid="admin-authorization-derived-admissions">派生准入：{{ joined(serverImpact.derivedAdmissions) }}</p>
        <p data-testid="admin-authorization-scope-cleanup">范围清理：{{ serverImpact.scopeCleanupCount }}</p>
        <p data-testid="admin-authorization-retained-sources">
          提交时回执记录的其他来源：{{ joined(serverImpact.retainedSources) }}<template v-if="serverImpact.retainedSources.length > 0">。当前的角色和准入读取不能确认这些来源是否仍在。</template>
        </p>
      </div>
      <div v-else data-testid="admin-authorization-admissions">
        <strong>准入变化</strong>
        <p v-if="!draft.admissionKnown" data-testid="admin-authorization-admissions-unknown">
          目前看不出这次会不会改变插件使用。
        </p>
        <ul v-else-if="draft.admissionChanges.length > 0">
          <li v-for="change in draft.admissionChanges" :key="`${change.effect}-${change.namespace}`">
            {{ describeAdmissionChange(change) }}
          </li>
        </ul>
        <p v-else>不会改变插件使用。</p>
      </div>
      <ul class="admin-authorization__notes">
        <li v-for="note in draft.notes" :key="note">{{ note }}</li>
      </ul>
      <p v-if="outcomeText" data-testid="admin-authorization-outcome">{{ outcomeText }}</p>
      <label v-if="draft.requiresTypedPhrase" class="admin-authorization__phrase">
        <span>请输入「{{ draft.requiresTypedPhrase }}」以确认</span>
        <input
          data-testid="admin-authorization-phrase"
          type="text"
          :value="phrase"
          :disabled="phraseLocked"
          @input="onPhraseInput"
        />
      </label>
      <div class="admin-authorization__actions">
        <button
          class="admin-authorization__confirm"
          type="button"
          data-testid="admin-authorization-confirm"
          :disabled="confirmDisabled"
          @click="emit('confirm')"
        >
          确认执行
        </button>
        <button
          v-if="showReadAgain"
          class="admin-authorization__cancel"
          type="button"
          data-testid="admin-authorization-read-again"
          :disabled="!allowReadAgain"
          @click="emit('readAgain')"
        >
          重新读取
        </button>
        <button
          v-if="showClose"
          ref="closeButton"
          class="admin-authorization__cancel"
          type="button"
          data-testid="admin-authorization-close"
          :disabled="closeDisabled"
          @click="emit('close')"
        >
          关闭
        </button>
        <button
          class="admin-authorization__cancel"
          type="button"
          data-testid="admin-authorization-cancel"
          :disabled="cancelDisabled"
          @click="emit('cancel')"
        >
          取消
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, onUpdated, ref, watch } from 'vue'
import type { AdminAuthorizationOperationPhase } from '../composables/useAdminAuthorizationOperation'
import {
  describeAdmissionChange,
  describeServerAuthorizationImpact,
  type AdminAuthorizationDraft,
  type ReadableAuthorizationImpact,
} from './AdminAuthorizationConfirm'

const props = withDefaults(defineProps<{
  draft: AdminAuthorizationDraft
  phrase: string
  busy: boolean
  phase?: AdminAuthorizationOperationPhase | null
  impact?: ReadableAuthorizationImpact | null
  outcomeText?: string
  allowReadAgain?: boolean
}>(), {
  phase: null,
  impact: null,
  outcomeText: '',
  allowReadAgain: true,
})

const emit = defineEmits<{
  confirm: []
  cancel: []
  close: []
  readAgain: []
  'update:phrase': [value: string]
}>()

const dialogRoot = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
let restoreFocus: HTMLElement | null = null

const lockedPhases = new Set<AdminAuthorizationOperationPhase>([
  'committing',
  'pending',
  'committed',
  'verified',
  'unverified_no_read',
])

const terminalPhases = new Set<AdminAuthorizationOperationPhase>(['forbidden', 'validation_failed'])

const completed = computed(() => (
  props.phase === 'committed' || props.phase === 'verified' || props.phase === 'unverified_no_read'
))

const serverImpact = computed(() => (
  props.phase == null ? null : describeServerAuthorizationImpact(props.impact)
))

const confirmDisabled = computed(() => {
  if (props.phase == null) {
    if (props.busy) return true
    if (!props.draft.requiresTypedPhrase) return false
    return props.phrase !== props.draft.requiresTypedPhrase
  }
  if (props.busy || props.phase !== 'awaiting_confirmation') return true
  if (!props.draft.requiresTypedPhrase) return false
  return props.phrase !== props.draft.requiresTypedPhrase
})

const cancelDisabled = computed(() => {
  if (props.phase == null) return props.busy
  if (props.busy) return true
  return lockedPhases.has(props.phase) || terminalPhases.has(props.phase) || completed.value
})

const phraseLocked = computed(() => {
  if (props.busy) return true
  return props.phase != null && props.phase !== 'awaiting_confirmation'
})

const showReadAgain = computed(() => (
  props.phase === 'pending' || props.phase === 'unverified_no_read' || props.phase === 'committed'
))

const showClose = computed(() => {
  if (props.phase == null) return false
  return lockedPhases.has(props.phase) || terminalPhases.has(props.phase)
})

const closeDisabled = computed(() => props.phase === 'committing' || props.busy)

const escapeLocked = computed(() => {
  if (props.phase == null) return props.busy
  if (props.busy) return true
  return lockedPhases.has(props.phase) || terminalPhases.has(props.phase)
})

function joined(values: readonly string[]): string {
  return values.length > 0 ? values.join('、') : '无'
}

function onPhraseInput(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  emit('update:phrase', target.value)
}

function focusableElements(): HTMLElement[] {
  const root = dialogRoot.value
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>('button, input, a[href], select, textarea')).filter((element) => {
    if (element.hasAttribute('disabled')) return false
    return element.tabIndex !== -1
  })
}

function onDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (escapeLocked.value) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (props.phase == null && props.busy) return
    event.preventDefault()
    event.stopPropagation()
    emit('cancel')
    return
  }
  if (event.key !== 'Tab') return
  const root = dialogRoot.value
  if (!root) return
  const items = focusableElements()
  if (items.length === 0) {
    event.preventDefault()
    root.focus()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (event.shiftKey && (active === first || active === root || !root.contains(active))) {
    event.preventDefault()
    last?.focus()
    return
  }
  if (!event.shiftKey && (active === last || active === root || !root.contains(active))) {
    event.preventDefault()
    first?.focus()
  }
}

function focusCloseNow(): void {
  if (!completed.value || closeDisabled.value) return
  const button = closeButton.value
  if (!button || document.activeElement === button) return
  const active = document.activeElement
  const root = dialogRoot.value
  const inside = Boolean(root && active && root.contains(active))
  const disabledControl = active instanceof HTMLButtonElement && active.disabled
  // A later render can drop the focused control. Focus then lands on the dialog root.
  if (active === root || !inside || disabledControl) button.focus()
}

watch(() => [props.phase, props.outcomeText, props.busy] as const, () => {
  focusCloseNow()
}, { flush: 'post' })

onMounted(() => {
  const active = document.activeElement
  restoreFocus = active instanceof HTMLElement ? active : null
  document.addEventListener('keydown', onDialogKeydown)
  if (completed.value) {
    focusCloseNow()
    return
  }
  dialogRoot.value?.focus()
})

onUpdated(() => {
  focusCloseNow()
})

onUnmounted(() => {
  document.removeEventListener('keydown', onDialogKeydown)
  restoreFocus?.focus()
  restoreFocus = null
})
</script>

<style scoped>
.admin-authorization__shield {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(15, 23, 42, 0.45);
  box-sizing: border-box;
}

.admin-authorization {
  width: min(560px, 100%);
  max-height: min(80vh, 720px);
  overflow: auto;
  box-sizing: border-box;
  background: #fff;
  border-radius: 14px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.admin-authorization h2,
.admin-authorization p,
.admin-authorization ul {
  margin: 0;
}

.admin-authorization ul {
  padding-left: 18px;
}

.admin-authorization__notes {
  color: #334155;
}

.admin-authorization__phrase {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.admin-authorization__phrase input {
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  padding: 8px 10px;
  font: inherit;
}

.admin-authorization__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.admin-authorization__confirm,
.admin-authorization__cancel {
  border: none;
  border-radius: 10px;
  padding: 10px 14px;
  font: inherit;
  cursor: pointer;
}

.admin-authorization__confirm {
  background: #2563eb;
  color: #fff;
}

.admin-authorization__cancel {
  background: #e2e8f0;
  color: #0f172a;
}

.admin-authorization__confirm:disabled,
.admin-authorization__cancel:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
</style>
