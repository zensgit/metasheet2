// Link picker modal chrome string table (T3B3).
//
// Scope: MetaLinkPicker.vue static UI only. Field names and linked-record
// display values are user data and pass through unchanged.

export type MetaLinkPickerLabelKey =
  | 'linkPicker.selected'
  | 'linkPicker.clear'
  | 'linkPicker.loading'
  | 'linkPicker.empty'
  | 'linkPicker.loadMore'
  | 'linkPicker.cancel'
  | 'linkPicker.confirm'
  | 'linkPicker.close'
  | 'linkPicker.errorLoad'
  // 关联字段没有目标表时的人话（2026-09-10）。后端过去把 `Link field is missing foreignSheetId: fld_...`
  // 原样甩到这个弹窗里，用户只能看到一句英文报错 + 一个 id。
  | 'linkPicker.errorMissingForeignSheet'

const META_LINK_PICKER_LABELS: Record<MetaLinkPickerLabelKey, { en: string; zh: string }> = {
  'linkPicker.selected': { en: 'Selected', zh: '已选择' },
  'linkPicker.clear': { en: 'Clear', zh: '清除' },
  'linkPicker.loading': { en: 'Loading...', zh: '正在加载...' },
  'linkPicker.empty': { en: 'No records found', zh: '未找到记录' },
  'linkPicker.loadMore': { en: 'Load more', zh: '加载更多' },
  'linkPicker.cancel': { en: 'Cancel', zh: '取消' },
  'linkPicker.confirm': { en: 'Confirm', zh: '确认' },
  'linkPicker.close': { en: 'Close link picker', zh: '关闭关联记录选择器' },
  'linkPicker.errorLoad': { en: 'Failed to load records', zh: '加载记录失败' },
  'linkPicker.errorMissingForeignSheet': {
    en: 'This link field has no target sheet yet. Open "Manage fields", edit it, pick the sheet to link to, and then come back to choose records.',
    zh: '这个关联字段还没有设置要关联哪张表。请在「管理字段」里编辑它，选好目标表后再来选记录。',
  },
}

/**
 * 后端稳定错误码 → 人话。读取侧 `GET /fields/:fieldId/link-options` 的
 * `LINK_FIELD_FOREIGN_SHEET_MISSING`（已有坏字段）与写入侧的 `LINK_FIELD_FOREIGN_SHEET_REQUIRED`
 * （创建/更新被 fail-closed 挡住）指向同一件事：这个关联字段没有目标表。按 CODE 翻译而不是按 message
 * 文本匹配 —— 后端的 message 已经是 values-free 的兜底文案，不参与判定。
 */
const LINK_PICKER_ERROR_CODE_LABELS: Record<string, MetaLinkPickerLabelKey> = {
  LINK_FIELD_FOREIGN_SHEET_MISSING: 'linkPicker.errorMissingForeignSheet',
  LINK_FIELD_FOREIGN_SHEET_REQUIRED: 'linkPicker.errorMissingForeignSheet',
}

export function linkPickerLabel(key: MetaLinkPickerLabelKey, isZh: boolean): string {
  const entry = META_LINK_PICKER_LABELS[key]
  return isZh ? entry.zh : entry.en
}

/**
 * 关联记录选择器的失败文案：有已知稳定码就翻人话，否则退回后端 message，再退回通用「加载记录失败」。
 * 兜底顺序保持不变，所以别的错误（403 / 503 / 网络）呈现与之前一致。
 */
export function linkPickerErrorMessage(error: unknown, isZh: boolean): string {
  const candidate = (error ?? {}) as { code?: unknown; message?: unknown }
  const code = typeof candidate.code === 'string' ? candidate.code : ''
  const mappedKey = LINK_PICKER_ERROR_CODE_LABELS[code]
  if (mappedKey) return linkPickerLabel(mappedKey, isZh)
  const message = typeof candidate.message === 'string' ? candidate.message.trim() : ''
  return message || linkPickerLabel('linkPicker.errorLoad', isZh)
}

export function selectedCount(count: number, isZh: boolean): string {
  return isZh ? `已选择 ${count} 条` : `${count} selected`
}
