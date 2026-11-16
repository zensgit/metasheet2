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
      <div data-testid="admin-authorization-admissions">
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
      <label v-if="draft.requiresTypedPhrase" class="admin-authorization__phrase">
        <span>请输入「{{ draft.requiresTypedPhrase }}」以确认</span>
        <input
          data-testid="admin-authorization-phrase"
          type="text"
          :value="phrase"
          :disabled="busy"
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
          class="admin-authorization__cancel"
          type="button"
          data-testid="admin-authorization-cancel"
          :disabled="busy"
          @click="emit('cancel')"
        >
          取消
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  describeAdmissionChange,
  type AdminAuthorizationDraft,
} from './AdminAuthorizationConfirm'

const props = defineProps<{
  draft: AdminAuthorizationDraft
  phrase: string
  busy: boolean
}>()

const emit = defineEmits<{
  confirm: []
  cancel: []
  'update:phrase': [value: string]
}>()

const dialogRoot = ref<HTMLElement | null>(null)
let restoreFocus: HTMLElement | null = null

const confirmDisabled = computed(() => {
  if (props.busy) return true
  if (!props.draft.requiresTypedPhrase) return false
  return props.phrase !== props.draft.requiresTypedPhrase
})

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
    if (props.busy) return
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

onMounted(() => {
  const active = document.activeElement
  restoreFocus = active instanceof HTMLElement ? active : null
  document.addEventListener('keydown', onDialogKeydown)
  dialogRoot.value?.focus()
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
