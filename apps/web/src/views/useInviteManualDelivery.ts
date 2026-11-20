import { inject, onBeforeUnmount, ref, watch } from 'vue'
import { routerKey } from 'vue-router'
import { apiFetch } from '../utils/api'

type Target = { id: string; userName: string | null; email: string; status: string }

export function useInviteManualDelivery(onDelivered: (id: string) => void) {
  const target = ref<Target | null>(null)
  const credentials = ref<{ loginIdentifier: string; temporaryPassword: string } | null>(null)
  const sending = ref(false)
  const needsRefresh = ref(false)
  const conflicts = ref(new Set<string>())
  const router = inject(routerKey, null)
  let mounted = true

  watch(sending, (pending, _, onCleanup) => {
    if (!pending) return
    const removeNavigationGuard = router?.beforeEach(() => false)
    function warnBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    onCleanup(() => {
      removeNavigationGuard?.()
      window.removeEventListener('beforeunload', warnBeforeUnload)
    })
  }, { flush: 'sync' })

  function clear() {
    target.value = null
    credentials.value = null
  }

  function close() {
    if (!sending.value) clear()
  }

  function open(record: Target) {
    if (target.value || sending.value || needsRefresh.value || conflicts.value.has(record.id) ||
        record.status !== 'pending' || !record.id || !record.email) return
    target.value = { id: record.id, userName: record.userName, email: record.email, status: record.status }
  }

  async function confirm() {
    const current = target.value
    if (!current || sending.value || needsRefresh.value || credentials.value) return
    sending.value = true
    try {
      const response = await apiFetch(`/api/admin/invites/${encodeURIComponent(current.id)}/manual-delivery`, {
        method: 'POST', body: '{}', cache: 'no-store',
      })
      if (response.status === 409) {
        if (mounted) {
          conflicts.value.add(current.id)
          clear()
        }
        return
      }
      if (!response.ok) throw new Error()
      const payload = await response.json()
      const { loginIdentifier, temporaryPassword } = payload?.data ?? {}
      if (payload?.ok !== true || typeof loginIdentifier !== 'string' || !loginIdentifier.trim() ||
          typeof temporaryPassword !== 'string' || !temporaryPassword.trim()) throw new Error()
      if (!mounted) return
      onDelivered(current.id)
      credentials.value = { loginIdentifier, temporaryPassword }
    } catch {
      if (mounted) {
        clear()
        needsRefresh.value = true
      }
    } finally {
      sending.value = false
    }
  }

  onBeforeUnmount(() => {
    mounted = false
    clear()
  })
  return { target, credentials, sending, needsRefresh, conflicts, open, confirm, close }
}
