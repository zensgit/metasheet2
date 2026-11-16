/**
 * Rollout gate for persisting an exact department scope (`includeChildren: false`).
 *
 * Default OFF. Only the byte-exact env string `true` enables a new false write.
 * Readers are not gated: a stored false stays an exact department after the flag
 * is turned off. This module does not lock rows or compare `updated_at`.
 */

export const DELEGATED_SCOPE_EXACT_DEPARTMENT_DISABLED = 'DELEGATED_SCOPE_EXACT_DEPARTMENT_DISABLED'

export type IncludeChildrenSemantics = 'include-descendants' | 'exact-department' | 'unassigned'

export type IncludeChildrenIntent =
  | { kind: 'invalid' }
  | { kind: 'omitted' }
  | { kind: 'explicit'; value: boolean }

export function isDelegatedScopeExactDepartmentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED === 'true'
}

/** An absent field is omitted. A present non-boolean, including null, is invalid. */
export function readIncludeChildrenIntent(body: unknown): IncludeChildrenIntent {
  if (!body || typeof body !== 'object') return { kind: 'omitted' }
  if (!Object.prototype.hasOwnProperty.call(body, 'includeChildren')) return { kind: 'omitted' }
  const value = (body as { includeChildren?: unknown }).includeChildren
  if (typeof value === 'boolean') return { kind: 'explicit', value }
  return { kind: 'invalid' }
}

export function describeIncludeChildren(stored: boolean | null): IncludeChildrenSemantics {
  if (stored === true) return 'include-descendants'
  if (stored === false) return 'exact-department'
  return 'unassigned'
}

/**
 * Decide the boolean to store for an assign.
 * Explicit false is refused while the rollout is off.
 * An omitted value keeps the historical true default, except a stored false is
 * preserved while the rollout is off so the row is not widened.
 */
export function resolveDelegatedIncludeChildrenWrite(input: {
  intent: Exclude<IncludeChildrenIntent, { kind: 'invalid' }>
  existingIncludeChildren: boolean | null
  exactDepartmentEnabled: boolean
}): { outcome: 'refuse' } | { outcome: 'persist'; includeChildren: boolean } {
  if (input.intent.kind === 'explicit') {
    if (input.intent.value === false && !input.exactDepartmentEnabled) return { outcome: 'refuse' }
    return { outcome: 'persist', includeChildren: input.intent.value }
  }
  if (!input.exactDepartmentEnabled && input.existingIncludeChildren === false) {
    return { outcome: 'persist', includeChildren: false }
  }
  return { outcome: 'persist', includeChildren: true }
}
