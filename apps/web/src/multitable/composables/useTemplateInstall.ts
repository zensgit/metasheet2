// useTemplateInstall — shared install + redirect composable.
//
// Consumed only by MultitableHomeView and MultitableTemplateCenterView.
// Workbench template install is intentionally NOT routed through here because
// its lifecycle (confirmDiscardContextChanges -> workbench.client.installTemplate
// -> workbench.syncExternalContext -> showSuccess) depends on the current
// workbench context, not on router.push to a freshly created base.
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { multitableClient } from '../api/client'
import type { MetaSheet, MetaTemplate, MetaView } from '../types'
import { AppRouteNames } from '../../router/types'

export interface TemplateInstallSuccess {
  baseId: string
  sheet: MetaSheet
  view: MetaView
}

export type TemplateInstallOutcome =
  | { status: 'installed-and-opened'; success: TemplateInstallSuccess }
  | { status: 'installed-no-view'; baseId: string }
  | { status: 'failed'; error: string }

export function useTemplateInstall() {
  const router = useRouter()
  const installingTemplateId = ref<string | null>(null)
  const errorMessage = ref('')

  async function installAndOpen(
    template: MetaTemplate,
    opts?: { baseName?: string },
  ): Promise<TemplateInstallOutcome | null> {
    if (installingTemplateId.value) return null
    installingTemplateId.value = template.id
    errorMessage.value = ''
    try {
      const result = await multitableClient.installTemplate(template.id, {
        baseName: opts?.baseName ?? `${template.name} Base`,
      })
      const sheet = result.sheets[0]
      const view = sheet ? result.views.find((v) => v.sheetId === sheet.id) ?? result.views[0] : null
      if (!sheet || !view) {
        errorMessage.value = '模板已创建，但默认视图尚未就绪。请刷新后重试。'
        return { status: 'installed-no-view', baseId: result.base.id }
      }
      await router.push({
        name: AppRouteNames.MULTITABLE,
        params: { sheetId: sheet.id, viewId: view.id },
        query: { baseId: result.base.id },
      })
      return {
        status: 'installed-and-opened',
        success: { baseId: result.base.id, sheet, view },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '模板创建失败'
      errorMessage.value = message
      return { status: 'failed', error: message }
    } finally {
      installingTemplateId.value = null
    }
  }

  return { installingTemplateId, errorMessage, installAndOpen }
}
