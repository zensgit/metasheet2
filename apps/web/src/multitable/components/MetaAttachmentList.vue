<template>
  <div class="meta-attachment-list" :class="[`meta-attachment-list--${variant}`]">
    <span v-if="!attachments.length" class="meta-attachment-list__empty">{{ emptyLabel }}</span>
    <div v-else class="meta-attachment-list__items">
      <div v-for="attachment in attachments" :key="attachment.id" class="meta-attachment-list__item">
        <button
          v-if="isPreviewableImage(attachment)"
          type="button"
          class="meta-attachment-list__card meta-attachment-list__card--preview"
          :title="`Preview ${attachment.filename}`"
          @click="previewAttachment = attachment"
        >
          <img
            class="meta-attachment-list__thumb"
            :src="attachment.thumbnailUrl || attachment.url || ''"
            :alt="attachment.filename"
          />
          <span class="meta-attachment-list__name">{{ attachment.filename }}</span>
        </button>
        <a
          v-else-if="attachment.url"
          class="meta-attachment-list__card"
          :href="attachment.url"
          :title="attachment.filename"
          target="_blank"
          rel="noopener noreferrer"
        >
          <span class="meta-attachment-list__icon">{{ mimeIcon(attachment.mimeType) }}</span>
          <span class="meta-attachment-list__name">{{ attachment.filename }}</span>
        </a>
        <span v-else class="meta-attachment-list__card" :title="attachment.filename">
          <span class="meta-attachment-list__icon">{{ mimeIcon(attachment.mimeType) }}</span>
          <span class="meta-attachment-list__name">{{ attachment.filename }}</span>
        </span>
        <button
          v-if="removable"
          type="button"
          class="meta-attachment-list__remove"
          :title="`Remove ${attachment.filename}`"
          @click="emit('remove', attachment.id)"
        >&times;</button>
      </div>
    </div>
    <Teleport to="body">
      <div
        v-if="previewAttachment"
        class="meta-attachment-list__lightbox"
        @click.self="previewAttachment = null"
      >
        <div class="meta-attachment-list__lightbox-card">
          <div class="meta-attachment-list__lightbox-header">
            <strong class="meta-attachment-list__lightbox-title">{{ previewAttachment.filename }}</strong>
            <div class="meta-attachment-list__lightbox-actions">
              <a
                v-if="previewAttachment.url"
                class="meta-attachment-list__lightbox-link"
                :href="previewAttachment.url"
                target="_blank"
                rel="noopener noreferrer"
              >Open original</a>
              <button
                type="button"
                class="meta-attachment-list__lightbox-close"
                aria-label="Close attachment preview"
                @click="previewAttachment = null"
              >&times;</button>
            </div>
          </div>
          <img
            class="meta-attachment-list__lightbox-image"
            :src="previewAttachment.url || previewAttachment.thumbnailUrl || ''"
            :alt="previewAttachment.filename"
          />
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { MetaAttachment } from '../types'

const props = withDefaults(defineProps<{
  attachments: MetaAttachment[]
  variant?: 'compact' | 'comfortable'
  removable?: boolean
  emptyLabel?: string
}>(), {
  variant: 'comfortable',
  removable: false,
  emptyLabel: '—',
})

const emit = defineEmits<{
  (e: 'remove', attachmentId: string): void
}>()

const previewAttachment = ref<MetaAttachment | null>(null)

function isPreviewableImage(attachment: MetaAttachment): boolean {
  return attachment.mimeType.startsWith('image/') && !!(attachment.thumbnailUrl || attachment.url)
}

function mimeIcon(mimeType: string): string {
  if (mimeType.startsWith('image/')) return '\uD83D\uDDBC'
  if (mimeType.includes('pdf')) return '\uD83D\uDCC4'
  if (mimeType.includes('sheet') || mimeType.includes('csv') || mimeType.includes('excel')) return '\uD83D\uDCCA'
  return '\uD83D\uDCCE'
}
</script>

<style scoped>
.meta-attachment-list { display: flex; flex-direction: column; gap: 6px; }
.meta-attachment-list__empty { color: #999; font-size: 12px; }
.meta-attachment-list__items { display: flex; flex-wrap: wrap; gap: 6px; }
.meta-attachment-list__item { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.meta-attachment-list__card {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 220px;
  padding: 4px 8px;
  border: 1px solid #dde4ee;
  border-radius: 8px;
  background: #f8fafc;
  color: #334155;
  text-decoration: none;
}
.meta-attachment-list__card--preview { cursor: zoom-in; }
.meta-attachment-list__thumb {
  width: 40px;
  height: 40px;
  border-radius: 6px;
  object-fit: cover;
  background: #e5e7eb;
  flex-shrink: 0;
}
.meta-attachment-list__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  font-size: 13px;
  flex-shrink: 0;
}
.meta-attachment-list__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  font-size: 12px;
}
.meta-attachment-list__remove {
  border: none;
  background: none;
  color: #94a3b8;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 0 2px;
}
.meta-attachment-list__remove:hover { color: #f56c6c; }
.meta-attachment-list--compact .meta-attachment-list__card {
  max-width: 150px;
  padding: 2px 6px;
  gap: 6px;
  border-radius: 6px;
}
.meta-attachment-list--compact .meta-attachment-list__thumb {
  width: 24px;
  height: 24px;
  border-radius: 5px;
}
.meta-attachment-list--compact .meta-attachment-list__name { font-size: 11px; }
.meta-attachment-list__lightbox {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(15, 23, 42, 0.75);
}
.meta-attachment-list__lightbox-card {
  width: min(960px, 100%);
  max-height: min(90vh, 860px);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.35);
}
.meta-attachment-list__lightbox-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.meta-attachment-list__lightbox-title {
  font-size: 14px;
  color: #0f172a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta-attachment-list__lightbox-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.meta-attachment-list__lightbox-link {
  color: #2563eb;
  font-size: 12px;
  text-decoration: none;
}
.meta-attachment-list__lightbox-close {
  border: none;
  background: none;
  font-size: 24px;
  line-height: 1;
  cursor: pointer;
  color: #64748b;
}
.meta-attachment-list__lightbox-image {
  width: 100%;
  max-height: calc(90vh - 110px);
  object-fit: contain;
  border-radius: 12px;
  background: #f8fafc;
}
</style>
