import { LocaleType, mergeLocales } from '@univerjs/core'

import enUSDesign from '@univerjs/design/locale/en-US'
import zhCNDesign from '@univerjs/design/locale/zh-CN'
import enUSUI from '@univerjs/ui/locale/en-US'
import zhCNUI from '@univerjs/ui/locale/zh-CN'
import enUSSheets from '@univerjs/sheets/locale/en-US'
import zhCNSheets from '@univerjs/sheets/locale/zh-CN'
import enUSSheetsUI from '@univerjs/sheets-ui/locale/en-US'
import zhCNSheetsUI from '@univerjs/sheets-ui/locale/zh-CN'

import { enUSSheetsNumfmtUI, zhCNSheetsNumfmtUI } from './univerNumfmtLocale'

type LocaleAddon = Record<string, unknown>

type BuildLocalesOptions = {
  enUS?: LocaleAddon[]
  zhCN?: LocaleAddon[]
}

export function buildUniverSheetsLocales(options: BuildLocalesOptions = {}) {
  const enExtras = options.enUS ?? []
  const zhExtras = options.zhCN ?? []

  return {
    [LocaleType.EN_US]: mergeLocales(
      enUSDesign,
      enUSUI,
      enUSSheets,
      enUSSheetsUI,
      enUSSheetsNumfmtUI,
      ...enExtras,
    ),
    [LocaleType.ZH_CN]: mergeLocales(
      zhCNDesign,
      zhCNUI,
      zhCNSheets,
      zhCNSheetsUI,
      zhCNSheetsNumfmtUI,
      ...zhExtras,
    ),
  }
}

export function buildUniverSheetsLocalesMinimal(options: BuildLocalesOptions = {}) {
  const enExtras = options.enUS ?? []
  const zhExtras = options.zhCN ?? []

  return {
    [LocaleType.EN_US]: mergeLocales(
      enUSDesign,
      enUSUI,
      enUSSheets,
      enUSSheetsUI,
      ...enExtras,
    ),
    [LocaleType.ZH_CN]: mergeLocales(
      zhCNDesign,
      zhCNUI,
      zhCNSheets,
      zhCNSheetsUI,
      ...zhExtras,
    ),
  }
}

