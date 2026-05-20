// Attachment list chrome string table (T3C3).
//
// Scope: MetaAttachmentList.vue static UI only. Attachment filenames, URLs,
// and caller-provided empty labels pass through unchanged.

export type MetaAttachmentLabelKey =
  | 'attachment.openOriginal'
  | 'attachment.closePreview'

const META_ATTACHMENT_LABELS: Record<MetaAttachmentLabelKey, { en: string; zh: string }> = {
  'attachment.openOriginal': { en: 'Open original', zh: '打开原文件' },
  'attachment.closePreview': { en: 'Close attachment preview', zh: '关闭附件预览' },
}

export function attachmentLabel(key: MetaAttachmentLabelKey, isZh: boolean): string {
  const entry = META_ATTACHMENT_LABELS[key]
  return isZh ? entry.zh : entry.en
}

export function previewAttachmentTitle(filename: string, isZh: boolean): string {
  return isZh ? `预览 ${filename}` : `Preview ${filename}`
}

export function removeAttachmentTitle(filename: string, isZh: boolean): string {
  return isZh ? `移除 ${filename}` : `Remove ${filename}`
}
