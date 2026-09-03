<template>
  <div class="meta-notif-bell" data-test="notification-bell">
    <button
      type="button"
      class="meta-notif-bell__btn"
      :class="{ 'meta-notif-bell__btn--attention': hasUnread }"
      :title="l('notification.bell')"
      :aria-label="l('notification.bell')"
      data-test="notification-bell-btn"
      @click="toggle"
    >
      <el-icon class="meta-notif-bell__icon" aria-hidden="true"><Bell /></el-icon>
      <span v-if="hasUnread" class="meta-notif-bell__badge" data-test="notification-bell-badge">{{ unreadCount }}</span>
    </button>
    <div v-if="open" class="meta-notif-bell__panel" data-test="notification-panel">
      <div class="meta-notif-bell__head">
        <span class="meta-notif-bell__title">{{ l('notification.title') }}</span>
        <MtLink
          v-if="hasUnread"
          data-test="notification-mark-all"
          @click="markAllRead"
        >{{ l('notification.markAllRead') }}</MtLink>
      </div>
      <div v-if="loading" class="meta-notif-bell__state">…</div>
      <div v-else-if="error" class="meta-notif-bell__state meta-notif-bell__state--error">{{ error }}</div>
      <div v-else-if="notifications.length === 0" class="meta-notif-bell__state" data-test="notification-empty">{{ l('notification.empty') }}</div>
      <!-- list renders independently of `error`: a transient mark-read/mark-all failure shows the error
           banner above WITHOUT replacing the still-loaded list (the dead-state the review caught). -->
      <ul v-if="!loading && notifications.length" class="meta-notif-bell__list">
        <li
          v-for="n in notifications"
          :key="n.id"
          class="meta-notif-bell__item"
          :class="{ 'meta-notif-bell__item--unread': !n.readAt }"
          data-test="notification-item"
          @click="onItemClick(n)"
        >
          <span v-if="!n.readAt" class="meta-notif-bell__dot" data-test="notification-unread-dot" aria-hidden="true"></span>
          <span class="meta-notif-bell__body">
            <span class="meta-notif-bell__event">{{ eventLabel(n.eventType) }}</span>
            <!-- B1-S1 D0-A: a notification.sent row carries a custom message body. -->
            <span
              v-if="n.eventType === 'notification.sent' && n.message"
              class="meta-notif-bell__message"
              data-test="notification-message"
            >{{ n.message }}</span>
          </span>
          <span class="meta-notif-bell__time">{{ formatTime(n.createdAt) }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { ElIcon } from 'element-plus'
import { Bell } from '@element-plus/icons-vue'
import { useLocale } from '../../composables/useLocale'
import { scheduleIdle } from '../../utils/scheduleIdle'
import { recordLabel, type MetaRecordLabelKey } from '../utils/meta-record-labels'
import { useNotificationInbox } from '../composables/useNotificationInbox'
import type { MetaRecordSubscriptionNotification } from '../types'
import type { MultitableApiClient } from '../api/client'
import { MtLink } from '../ui'

const props = defineProps<{ apiClient?: MultitableApiClient }>()
const emit = defineEmits<{ (e: 'navigate', payload: { sheetId: string; recordId: string }): void }>()

const { isZh } = useLocale()
const l = (key: MetaRecordLabelKey) => recordLabel(key, isZh.value)

const { notifications, unreadCount, loading, error, hasUnread, eventLabel, loadInbox, refreshUnreadCount, markRead, markAllRead } =
  useNotificationInbox(props.apiClient)

const open = ref(false)

function formatTime(value: string): string {
  if (!value) return ''
  const ts = Date.parse(value)
  return Number.isNaN(ts) ? value : new Date(ts).toLocaleString()
}

async function toggle(): Promise<void> {
  open.value = !open.value
  if (open.value) await loadInbox({ limit: 50 })
}

async function onItemClick(n: MetaRecordSubscriptionNotification): Promise<void> {
  if (!n.readAt) void markRead([n.id])
  emit('navigate', { sheetId: n.sheetId, recordId: n.recordId })
  open.value = false
}

// Ambient badge: surface the unread count without requiring the panel to be
// opened — idle-deferred so it never competes with the sheet-open critical
// path, and voided on unmount so a late idle callback cannot fetch into a
// torn-down component.
let bellAlive = true
onBeforeUnmount(() => {
  bellAlive = false
})
scheduleIdle(() => {
  if (bellAlive) void refreshUnreadCount()
})
</script>

<style scoped>
.meta-notif-bell { position: relative; display: inline-block; }
.meta-notif-bell__btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--ms-control-height, 32px);
  height: var(--ms-control-height, 32px);
  padding: 0;
  border: none;
  border-radius: var(--ms-radius-sm, 6px);
  background: transparent;
  color: var(--ms-color-info, #6b7280);
  cursor: pointer;
}
.meta-notif-bell__btn:hover { color: var(--ms-color-primary); background: var(--ms-bg-page, #f5f6f8); }
.meta-notif-bell__icon { font-size: var(--ms-sheet-icon-size, 16px); color: currentColor; }
.meta-notif-bell__badge {
  position: absolute; top: 2px; right: 2px;
  display: inline-block; min-width: 16px; padding: 0 4px; border-radius: 8px;
  background: var(--ms-color-danger, #dc2626); color: #fff; font-size: 10px; line-height: 14px; text-align: center;
}
.meta-notif-bell__panel { position: absolute; right: 0; top: calc(100% + 6px); z-index: 20; width: 320px; max-height: 420px; overflow-y: auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12); }
.meta-notif-bell__head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid #f1f5f9; }
.meta-notif-bell__title { font-weight: 600; color: #0f172a; }
/* .meta-notif-bell__mark-all: its only sharer is now <MtLink> (UI-P2-1c T3); the bespoke #2563eb text
   is normalized to --ms-color-primary. Bespoke CSS removed (no double-styling). */
.meta-notif-bell__state { padding: 16px 12px; color: #64748b; font-size: 13px; }
.meta-notif-bell__state--error { color: #b91c1c; }
.meta-notif-bell__list { list-style: none; margin: 0; padding: 4px 0; }
.meta-notif-bell__item { display: flex; align-items: baseline; gap: 8px; padding: 8px 12px; cursor: pointer; }
.meta-notif-bell__item:hover { background: #f8fafc; }
.meta-notif-bell__item--unread { background: #eff6ff; }
.meta-notif-bell__dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: #2563eb; align-self: center; }
.meta-notif-bell__body { flex: 1 1 auto; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.meta-notif-bell__event { color: #0f172a; font-size: 13px; }
.meta-notif-bell__message { color: #475569; font-size: 12px; white-space: normal; word-break: break-word; }
.meta-notif-bell__time { flex: 0 0 auto; color: #94a3b8; font-size: 11px; }
</style>
