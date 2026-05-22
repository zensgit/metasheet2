import type { MetaView } from '../types'

export type DingTalkNotificationPreset = 'form_request' | 'internal_process' | 'form_and_process'

export interface DingTalkNotificationPresetConfig {
  titleTemplate?: string
  bodyTemplate?: string
  publicFormViewId?: string
  internalViewId?: string
}

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function pickDefaultFormViewId(views: MetaView[], currentViewId?: string): string {
  const current = normalizeId(currentViewId)
  if (current && views.some((view) => view.id === current && view.type === 'form')) return current
  return views.find((view) => view.type === 'form')?.id ?? ''
}

function pickDefaultInternalViewId(views: MetaView[], currentViewId?: string): string {
  const current = normalizeId(currentViewId)
  if (current && views.some((view) => view.id === current)) return current
  return views.find((view) => view.type !== 'form')?.id ?? views[0]?.id ?? ''
}

export function applyDingTalkNotificationPreset(
  config: DingTalkNotificationPresetConfig,
  preset: DingTalkNotificationPreset,
  views: MetaView[],
  isZh = false,
): DingTalkNotificationPresetConfig {
  const formViewId = pickDefaultFormViewId(views, config.publicFormViewId)
  const internalViewId = pickDefaultInternalViewId(views, config.internalViewId)

  if (preset === 'form_request') {
    return {
      ...config,
      titleTemplate: isZh ? '{{recordId}} 待填写' : '{{recordId}} needs input',
      bodyTemplate: isZh
        ? '请完成本次表单填写。\n记录编号：{{recordId}}\n触发人：{{actorId}}'
        : 'Please complete this form request.\nRecord ID: {{recordId}}\nActor: {{actorId}}',
      publicFormViewId: formViewId,
      internalViewId: '',
    }
  }

  if (preset === 'internal_process') {
    return {
      ...config,
      titleTemplate: isZh ? '{{recordId}} 待处理' : '{{recordId}} needs processing',
      bodyTemplate: isZh
        ? '请查看并处理该记录。\n记录编号：{{recordId}}\n触发人：{{actorId}}'
        : 'Please review and process this record.\nRecord ID: {{recordId}}\nActor: {{actorId}}',
      publicFormViewId: '',
      internalViewId,
    }
  }

  return {
    ...config,
    titleTemplate: isZh ? '{{recordId}} 待填写并处理' : '{{recordId}} needs input and processing',
    bodyTemplate: isZh
      ? '请先填写所需信息，并由有权限成员继续处理该记录。\n记录编号：{{recordId}}\n触发人：{{actorId}}'
      : 'Please complete the required form input, then continue processing this record.\nRecord ID: {{recordId}}\nActor: {{actorId}}',
    publicFormViewId: formViewId,
    internalViewId,
  }
}
