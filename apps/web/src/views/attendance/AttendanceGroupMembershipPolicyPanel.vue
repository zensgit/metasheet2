<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { apiFetch } from '../../utils/api'
import { useAttendanceSessionGuard } from '../../composables/useAttendanceSessionGuard'

defineProps<{ tr: (en: string, zh: string) => string }>()

const guard = useAttendanceSessionGuard()
const fetcher = guard.wrapFetch(apiFetch)

type PanelStatus = 'idle' | 'loading' | 'ready' | 'saving' | 'error'
type ErrorKind = '' | 'forbidden' | 'conflict' | 'unknown'

interface PolicyData {
  orgId: string
  allowMultipleGroups: boolean
  version: number
}

const status = ref<PanelStatus>('idle')
const errorKind = ref<ErrorKind>('')
const draft = ref(false)
const current = ref(false)
const version = ref<number | null>(null)
const notice = ref('')

let generation = 0
let disposed = false

onScopeDispose(() => {
  disposed = true
})

watch(guard.stale, (isStale) => {
  if (isStale) reset()
})

watch(draft, () => {
  notice.value = ''
})

function reset(): void {
  generation += 1
  status.value = 'idle'
  errorKind.value = ''
  draft.value = false
  current.value = false
  version.value = null
  notice.value = ''
}

function alive(gen: number, org: string): boolean {
  return !disposed && gen === generation && !guard.stale.value && guard.orgId === org && guard.isCurrent()
}

function policyUrl(): string {
  return '/api/attendance/group-membership-policy?orgId=' + encodeURIComponent(guard.orgId)
}

function parsePolicy(body: unknown): PolicyData | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || (body as { ok?: unknown }).ok !== true) return null
  const data = (body as { data?: unknown }).data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  if (typeof d.orgId !== 'string' || typeof d.allowMultipleGroups !== 'boolean') return null
  if (typeof d.version !== 'number' || !Number.isSafeInteger(d.version) || d.version < 0) return null
  return { orgId: d.orgId, allowMultipleGroups: d.allowMultipleGroups, version: d.version }
}

function classify(code: number): ErrorKind {
  if (code === 401 || code === 403 || code === 404) return 'forbidden'
  if (code === 400 || code === 409) return 'conflict'
  return 'unknown'
}

function fail(kind: ErrorKind): void {
  status.value = 'error'
  errorKind.value = kind
  version.value = null
  notice.value = ''
}

async function runGet(): Promise<boolean> {
  if (disposed || guard.stale.value || !guard.isCurrent()) return false
  const gen = ++generation
  const org = guard.orgId
  status.value = 'loading'
  errorKind.value = ''
  notice.value = ''
  try {
    const res = await fetcher(policyUrl(), { method: 'GET' })
    if (!alive(gen, org)) return false
    if (!res.ok) {
      fail(classify(res.status))
      return false
    }
    const parsed = parsePolicy(await res.json())
    if (!alive(gen, org)) return false
    if (!parsed || parsed.orgId !== org) {
      fail('unknown')
      return false
    }
    current.value = parsed.allowMultipleGroups
    draft.value = parsed.allowMultipleGroups
    version.value = parsed.version
    status.value = 'ready'
    return true
  } catch {
    if (alive(gen, org)) fail('unknown')
    return false
  }
}

async function refresh(): Promise<void> {
  if (status.value === 'loading' || status.value === 'saving') return
  await runGet()
}

const canSave = computed(
  () => status.value === 'ready' && version.value !== null && !guard.stale.value && draft.value !== current.value,
)

async function save(): Promise<void> {
  if (!canSave.value || version.value === null) return
  const gen = ++generation
  const org = guard.orgId
  const expectedVersion = version.value
  const proposed = draft.value
  status.value = 'saving'
  errorKind.value = ''
  notice.value = ''
  try {
    const res = await fetcher(policyUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowMultipleGroups: proposed, expectedVersion }),
    })
    if (!alive(gen, org)) return
    if (!res.ok) {
      fail(classify(res.status))
      return
    }
    const parsed = parsePolicy(await res.json())
    if (!alive(gen, org)) return
    if (!parsed || parsed.orgId !== org || parsed.allowMultipleGroups !== proposed
      || parsed.version !== expectedVersion + 1) {
      fail('unknown')
      return
    }
    const confirmed = await runGet()
    if (confirmed) notice.value = 'saved'
  } catch {
    if (alive(gen, org)) fail('unknown')
  }
}
</script>

<template>
  <section class="membership-policy" data-group-membership-policy>
    <h3>{{ tr('Attendance group membership policy', '考勤组归属策略') }}</h3>
    <p class="hint">{{ tr('Allow one person to join multiple attendance groups (not allowed by default).', '允许一人加入多个考勤组（默认不允许）。') }}</p>
    <p class="hint">{{ tr('Turning this off only blocks adding a second group link; existing members are kept and history is not recomputed.', '关闭只限制新增第二组关联，保留已有成员，不重新计算历史。') }}</p>
    <p class="hint">{{ tr('The calculation attribution constraint still applies; enabling this does not allow multiple calculation attributions on the same day.', '计算归属约束仍保持，不因开启而允许同日多计算归属。') }}</p>
    <div v-if="status === 'error'" role="alert" data-membership-error>
      <span v-if="errorKind === 'forbidden'">{{ tr('You do not have permission to access this policy.', '当前没有权限查看或修改该策略。') }}</span>
      <span v-else-if="errorKind === 'conflict'">{{ tr('The request was rejected or the policy changed. Refresh and try again.', '请求被拒绝或策略已变更，请刷新后重试。') }}</span>
      <span v-else>{{ tr('The result is unknown. Refresh before trying again.', '结果未知，请刷新后再试。') }}</span>
    </div>
    <div v-else role="status" data-membership-status>
      <span v-if="status === 'idle'">{{ tr('Not loaded yet.', '尚未加载。') }}</span>
      <span v-else-if="status === 'loading'">{{ tr('Loading…', '加载中…') }}</span>
      <span v-else-if="status === 'saving'">{{ tr('Saving…', '保存中…') }}</span>
      <span v-else-if="notice === 'saved'" data-membership-saved>{{ tr('Saved.', '已保存。') }}</span>
      <span v-else>{{ tr('Loaded.', '已加载。') }}</span>
    </div>
    <label class="field">
      <input v-model="draft" type="checkbox" data-membership-allow-multiple :disabled="status !== 'ready'" />
      <span>{{ tr('Allow multiple attendance groups per person', '允许一人加入多个考勤组') }}</span>
    </label>
    <p v-if="status === 'ready'" data-membership-current>{{ current ? tr('Current policy: multiple groups allowed.', '当前策略：允许一人多组。') : tr('Current policy: one group per person; existing multiple memberships are kept.', '当前策略：一人一组，保留存量多组关联。') }}</p>
    <div class="actions">
      <button type="button" data-membership-refresh :disabled="status === 'loading' || status === 'saving'" @click="refresh">{{ tr('View / refresh', '查看 / 刷新') }}</button>
      <button type="button" data-membership-save :disabled="!canSave" @click="save">{{ tr('Save', '保存') }}</button>
    </div>
  </section>
</template>

<style scoped>
.membership-policy {
  display: grid;
  gap: 8px;
  max-width: 560px;
}

.membership-policy .field {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px;
  align-items: center;
}

.membership-policy .actions {
  display: grid;
  grid-auto-flow: column;
  gap: 8px;
  justify-content: start;
}
</style>
