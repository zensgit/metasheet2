<template>
  <section
    ref="dialogRef"
    class="delegation-confirmation"
    data-testid="delegation-confirmation"
    role="dialog"
    aria-modal="true"
    aria-labelledby="delegation-confirmation-title"
    tabindex="-1"
  >
    <h3 id="delegation-confirmation-title">{{ title }}</h3>
    <p data-testid="delegation-confirmation-target">{{ confirmation.targetLabel }}</p>
    <p data-testid="delegation-confirmation-role">{{ confirmation.roleTitle || confirmation.roleId || '无角色' }}</p>
    <p v-if="confirmation.namespace" data-testid="delegation-confirmation-namespace">{{ confirmation.namespace }}</p>
    <template v-if="confirmation.kind !== 'admission-enable'">
      <ul v-if="confirmation.permissionListing === 'listed'" data-testid="delegation-confirmation-permissions">
        <li v-for="code in confirmation.permissions" :key="code">{{ code }}</li>
      </ul>
      <p v-else-if="confirmation.permissionListing === 'empty'" data-testid="delegation-confirmation-permissions-empty">目录中该角色没有权限码</p>
      <p v-else data-testid="delegation-confirmation-permissions-empty">目录未提供权限码</p>
      <p v-if="confirmation.roleId === PLATFORM_ADMIN_ROLE_ID" data-testid="delegation-confirmation-platform-admin">
        平台管理员是一项特殊权限，权限码列表不能代表它的全部权限。
      </p>
    </template>
    <p data-testid="delegation-confirmation-effect">{{ effect }}</p>
    <label v-if="requiresAdminPhrase" class="delegation-confirmation__typed">
      输入“取消平台管理员”以确认撤销
      <input
        v-model="typedText"
        data-testid="delegation-confirmation-typed"
        type="text"
        aria-label="输入取消平台管理员以确认撤销"
      />
    </label>
    <div class="delegation-confirmation__actions">
      <button
        class="delegation-confirmation__button"
        type="button"
        data-testid="delegation-confirmation-cancel"
        @click="emit('cancel')"
      >
        取消
      </button>
      <button
        class="delegation-confirmation__button"
        type="button"
        data-testid="delegation-confirmation-confirm"
        :disabled="confirmDisabled"
        @click="emit('confirm', typedText)"
      >
        确认
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  PLATFORM_ADMIN_REVOKE_PHRASE,
  PLATFORM_ADMIN_ROLE_ID,
  type DelegationConfirmation,
} from './delegationConfirmation'

const props = defineProps<{ confirmation: DelegationConfirmation }>()
const emit = defineEmits<{ confirm: [typedText: string]; cancel: [] }>()
const typedText = ref('')
const dialogRef = ref<HTMLElement | null>(null)
let previousFocus: HTMLElement | null = null

watch(() => props.confirmation.token, () => {
  typedText.value = ''
})

const title = computed(() => {
  if (props.confirmation.kind === 'grant') return '确认分配角色'
  if (props.confirmation.kind === 'revoke') return '确认撤销角色'
  return '确认开通插件使用'
})

const requiresAdminPhrase = computed(() => (
  props.confirmation.kind === 'revoke' && props.confirmation.roleId === PLATFORM_ADMIN_ROLE_ID
))

const effect = computed(() => {
  if (requiresAdminPhrase.value) {
    return '此角色是平台管理员权限。撤销后该成员不再是平台管理员。这可能同时关闭该角色带来的命名空间准入。目录权限码和单独授予的直接权限码来源不同，撤销角色不会改写直接权限码。请输入“取消平台管理员”后再确认。'
  }
  if (props.confirmation.kind === 'revoke') {
    return '撤销后，该成员失去此角色。这可能同时关闭该角色带来的命名空间准入。目录权限码和单独授予的直接权限码来源不同，撤销角色不会改写直接权限码。'
  }
  if (props.confirmation.kind === 'admission-enable') {
    return '将为该成员开通此命名空间的插件使用准入。开通后，角色和准入同时满足时插件才可用。'
  }
  return '将为该成员分配此角色。分配角色不会开通插件使用准入，也不会写入直接权限码。'
})

const confirmDisabled = computed(() => (
  requiresAdminPhrase.value && typedText.value.trim() !== PLATFORM_ADMIN_REVOKE_PHRASE
))

function focusableNodes(): HTMLElement[] {
  const root = dialogRef.value
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>('button, input, a[href], [tabindex]'))
    .filter((node) => !node.hasAttribute('disabled') && node.tabIndex !== -1)
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('cancel')
    return
  }
  if (event.key !== 'Tab') return
  const nodes = focusableNodes()
  if (nodes.length === 0) return
  const first = nodes[0]
  const last = nodes[nodes.length - 1]
  const active = document.activeElement
  if (event.shiftKey && (active === first || !dialogRef.value?.contains(active))) {
    event.preventDefault()
    last?.focus()
    return
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault()
    first?.focus()
  }
}

onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  document.addEventListener('keydown', onDocumentKeydown)
  const preferred = requiresAdminPhrase.value
    ? dialogRef.value?.querySelector<HTMLElement>('[data-testid="delegation-confirmation-typed"]')
    : dialogRef.value?.querySelector<HTMLElement>('[data-testid="delegation-confirmation-cancel"]')
  preferred?.focus()
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onDocumentKeydown)
  previousFocus?.focus()
})
</script>

<style scoped>
.delegation-confirmation {
  display: grid;
  gap: 8px;
  padding: 16px;
  border: 1px solid #f59e0b;
  border-radius: 12px;
  background: #fffbeb;
}

.delegation-confirmation h3,
.delegation-confirmation p {
  margin: 0;
}

.delegation-confirmation__typed {
  display: grid;
  gap: 4px;
}

.delegation-confirmation__typed input {
  min-width: 240px;
  height: 38px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 0 12px;
}

.delegation-confirmation__actions {
  display: flex;
  gap: 8px;
}

.delegation-confirmation__button {
  height: 38px;
  border: 0;
  border-radius: 8px;
  background: #2563eb;
  color: #fff;
  padding: 0 14px;
  cursor: pointer;
}

.delegation-confirmation__button:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}
</style>
