import { computed, type Ref } from 'vue'
import type { MetaCapabilities } from '../types'

export type MultitableRole = 'owner' | 'editor' | 'commenter' | 'viewer'

export interface MultitableCapabilities {
  canRead: Ref<boolean>
  canCreateRecord: Ref<boolean>
  canEditRecord: Ref<boolean>
  canDeleteRecord: Ref<boolean>
  canManageFields: Ref<boolean>
  canManageSheetAccess: Ref<boolean>
  canManageViews: Ref<boolean>
  canComment: Ref<boolean>
  canManageAutomation: Ref<boolean>
  canExport: Ref<boolean>
}

const ROLE_CAPS: Record<MultitableRole, Record<string, boolean>> = {
  owner: {
    canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true,
    canManageFields: true, canManageSheetAccess: true, canManageViews: true, canComment: true, canManageAutomation: true, canExport: true,
  },
  editor: {
    canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true,
    canManageFields: false, canManageSheetAccess: false, canManageViews: false, canComment: true, canManageAutomation: false, canExport: true,
  },
  commenter: {
    canRead: true, canCreateRecord: false, canEditRecord: false, canDeleteRecord: false,
    canManageFields: false, canManageSheetAccess: false, canManageViews: false, canComment: true, canManageAutomation: false, canExport: true,
  },
  viewer: {
    canRead: true, canCreateRecord: false, canEditRecord: false, canDeleteRecord: false,
    canManageFields: false, canManageSheetAccess: false, canManageViews: false, canComment: false, canManageAutomation: false, canExport: true,
  },
}

function isMetaCapabilities(value: unknown): value is MetaCapabilities {
  return !!value && typeof value === 'object' && 'canRead' in value
}

export function useMultitableCapabilities(
  source: Ref<MultitableRole | MetaCapabilities | null | undefined>,
): MultitableCapabilities {
  const caps = (key: keyof MetaCapabilities) =>
    computed(() => {
      const current = source.value
      if (isMetaCapabilities(current)) return current[key]
      return ROLE_CAPS[current ?? 'viewer']?.[key] ?? false
    })

  return {
    canRead: caps('canRead'),
    canCreateRecord: caps('canCreateRecord'),
    canEditRecord: caps('canEditRecord'),
    canDeleteRecord: caps('canDeleteRecord'),
    canManageFields: caps('canManageFields'),
    canManageSheetAccess: caps('canManageSheetAccess'),
    canManageViews: caps('canManageViews'),
    canComment: caps('canComment'),
    canManageAutomation: caps('canManageAutomation'),
    canExport: caps('canExport'),
  }
}
