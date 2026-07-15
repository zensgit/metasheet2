// Base picker chrome string table (T3C2).
//
// Scope: MetaBasePicker.vue static UI only. Base names and icons are user data
// and pass through unchanged.

export type MetaBasePickerLabelKey =
  | 'basePicker.selectBase'
  | 'basePicker.searchPlaceholder'
  | 'basePicker.favoriteBadge'
  | 'basePicker.recentBadge'
  | 'basePicker.empty'
  | 'basePicker.newBasePlaceholder'

const META_BASE_PICKER_LABELS: Record<MetaBasePickerLabelKey, { en: string; zh: string }> = {
  // W1 G-10 (docs/development/… terminology dictionary, ratified 2026-07-13): Base = 工作区.
  // Was '多维表' (the product name) — conflated the product with the Base/workspace entity.
  'basePicker.selectBase': { en: 'Select Base', zh: '选择工作区' },
  'basePicker.searchPlaceholder': { en: 'Search bases...', zh: '搜索工作区...' },
  'basePicker.favoriteBadge': { en: 'Favorite', zh: '收藏' },
  'basePicker.recentBadge': { en: 'Recent', zh: '最近打开' },
  'basePicker.empty': { en: 'No bases found', zh: '未找到工作区' },
  'basePicker.newBasePlaceholder': { en: 'New base name...', zh: '新工作区名称...' },
}

export function basePickerLabel(key: MetaBasePickerLabelKey, isZh: boolean): string {
  const entry = META_BASE_PICKER_LABELS[key]
  return isZh ? entry.zh : entry.en
}

export function favoriteAriaLabel(baseName: string, isFavorite: boolean, isZh: boolean): string {
  if (isZh) return isFavorite ? `取消收藏 ${baseName}` : `收藏 ${baseName}`
  return isFavorite ? `Remove ${baseName} from favorites` : `Add ${baseName} to favorites`
}
