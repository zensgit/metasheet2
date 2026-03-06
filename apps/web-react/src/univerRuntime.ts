import {
  LocaleType,
  LogLevel,
  Univer,
  UniverInstanceType,
  type IWorkbookData,
} from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { UniverDocsPlugin } from '@univerjs/docs'
import { UniverDocsUIPlugin } from '@univerjs/docs-ui'
import '@univerjs/docs-ui/facade'
import docsUiEnUS from '@univerjs/docs-ui/lib/locale/en-US'
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import '@univerjs/engine-formula/facade'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import '@univerjs/sheets/facade'
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula'
import '@univerjs/sheets-formula/facade'
import { UniverSheetsUIPlugin } from '@univerjs/sheets-ui'
import '@univerjs/sheets-ui/facade'
import sheetsUiEnUS from '@univerjs/sheets-ui/lib/locale/en-US'
import { UniverUIPlugin } from '@univerjs/ui'
import '@univerjs/ui/facade'
import uiEnUS from '@univerjs/ui/lib/locale/en-US'

export interface UniverRuntime {
  activeUnitId: string | null
  api: FUniver
  univer: Univer
}

export function createUniverRuntime(container: HTMLElement): UniverRuntime {
  const univer = new Univer({
    locale: LocaleType.EN_US,
    locales: {
      [LocaleType.EN_US]: {
        ...uiEnUS,
        ...sheetsUiEnUS,
        ...docsUiEnUS,
      },
    },
    logLevel: LogLevel.ERROR,
  })

  univer.registerPlugin(UniverDocsPlugin)
  univer.registerPlugin(UniverRenderEnginePlugin)
  univer.registerPlugin(UniverUIPlugin, { container })
  univer.registerPlugin(UniverDocsUIPlugin)
  univer.registerPlugin(UniverSheetsPlugin)
  univer.registerPlugin(UniverSheetsUIPlugin)
  univer.registerPlugin(UniverFormulaEnginePlugin)
  univer.registerPlugin(UniverSheetsFormulaPlugin)

  return {
    activeUnitId: null,
    api: FUniver.newAPI(univer),
    univer,
  }
}

export function renderWorkbook(runtime: UniverRuntime, workbookData: IWorkbookData) {
  if (runtime.activeUnitId) {
    runtime.api.disposeUnit(runtime.activeUnitId)
    runtime.activeUnitId = null
  }

  const workbook = runtime.univer.createUnit(UniverInstanceType.UNIVER_SHEET, workbookData)
  if (typeof workbook?.getUnitId === 'function') {
    runtime.activeUnitId = workbook.getUnitId()
  }
}

export function disposeUniverRuntime(runtime: UniverRuntime) {
  runtime.activeUnitId = null
  runtime.api.dispose()
  runtime.univer.dispose()
}
