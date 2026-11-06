// Chrome of the shared quick-phrase bar (ApprovalQuickPhraseBar.vue). The phrases themselves are not
// here: a phrase is written into the stored opinion as-is, so it is not localized (quickPhrases.ts).
import { MAX_PERSONAL_PHRASES, MAX_PHRASE_LENGTH } from '../quickPhrases'

export const QUICK_PHRASE_BAR_ZH = {
  groupLabel: '快捷短语',
  save: '存为常用语',
  saveHint: '把意见框里的文字存为你的常用语',
  remove: '删除这条常用语',
  saved: '已存为常用语',
  duplicate: '这条已在你的常用语里',
  tooLong: `常用语最多 ${MAX_PHRASE_LENGTH} 个字`,
  full: `常用语最多 ${MAX_PERSONAL_PHRASES} 条，请先删除不用的`,
  failed: '保存失败，请重试',
}

export const QUICK_PHRASE_BAR_EN: Record<keyof typeof QUICK_PHRASE_BAR_ZH, string> = {
  groupLabel: 'Quick phrases',
  save: 'Save as phrase',
  saveHint: 'Save the text in the opinion box as one of your phrases',
  remove: 'Remove this saved phrase',
  saved: 'Saved to your phrases',
  duplicate: 'This is already one of your phrases',
  tooLong: `A phrase can be at most ${MAX_PHRASE_LENGTH} characters`,
  full: `You can keep at most ${MAX_PERSONAL_PHRASES} phrases; remove one first`,
  failed: 'Could not save, please try again',
}
