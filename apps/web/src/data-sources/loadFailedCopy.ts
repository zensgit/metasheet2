// Operator-facing copy for sources the server could not load (#6079). Pure functions, so the
// wording and — more importantly — WHICH states get a re-seal action are testable without a mount.
import type { DataSourceLoadState } from './types'

/** Badge text per load state. Every state but a credential failure means "ask an administrator". */
export function loadFailedBadgeText(state: DataSourceLoadState): string {
  return state === 'credentials_unreadable'
    ? '凭据无法解密，请重新输入'
    : '无法装载，请联系管理员'
}

/**
 * Only a credential problem can be fixed by re-entering credentials; every other state is an
 * administrator's job and gets no action at all.
 */
export function canResealLoadFailed(state: DataSourceLoadState): boolean {
  return state === 'credentials_unreadable'
}

/** Shown after a rotation/re-seal whose credentials were saved but only take effect after a restart. */
export const RESEAL_RESTART_REQUIRED_NOTICE =
  '凭据已保存，但该数据源需要重启服务后才会生效。'
