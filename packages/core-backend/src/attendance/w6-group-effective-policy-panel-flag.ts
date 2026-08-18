/**
 * W6-3 (#4556) — OD-W6-7(a): UI gate for the group effective-policy panel
 * (`apps/web/src/views/attendance/AttendanceGroupEffectivePolicyPanel.vue`).
 *
 * Governing document:
 *   docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md
 *   §5 item 2, §6/§9 (OD-W6-7 resolved (a): "org opt-in setting + env gate, default OFF").
 *
 * Two independent, additive layers — both default OFF (unset env => disabled for every org):
 *
 *  1. a master capability switch (`ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ENABLED`), mirroring
 *     the existing single-boolean env-gate idiom already used for other default-OFF UI rollouts
 *     (`isApprovalCanvasV2Enabled` in `../services/approval-canvas-flag.ts`,
 *     `isFwbWritebackEnabled` in `../multitable/approval-fwb-activation.ts`) — never inferred from
 *     role, product mode, or plugin state;
 *  2. a per-org EXACT allowlist (`ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ORGS`), mirroring the
 *     exact-org-only outer-allowlist idiom this same design-lock lineage already uses for the W4
 *     segment-calculation rollout gate (`isOrgExactlyAllowlisted` /
 *     `ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED` in `./w4c0-identity.ts`) — a dedicated env
 *     var scoped to THIS capability (never shared with segment-calculation's own allowlist, which
 *     gates an unrelated posture). Wildcard `*` never counts as a match, matching that precedent.
 *
 * Both layers must hold for a given org. This module owns no persistence (no new table/column)
 * and performs zero writes — it is a pure env-config predicate, computed fresh per call.
 */

const MASTER_ENV_VAR = 'ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ENABLED'
const ORG_ALLOWLIST_ENV_VAR = 'ATTENDANCE_GROUP_EFFECTIVE_POLICY_PANEL_ORGS'

/** Layer 1 — master capability switch. Default OFF. */
export function isAttendanceGroupEffectivePolicyPanelMasterEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return String(env[MASTER_ENV_VAR] ?? '').trim().toLowerCase() === 'true'
}

/** Layer 2 — exact org-only allowlist. `*` never counts (same rule as the W4 precedent). */
function isOrgExactlyAllowlisted(orgId: string, env: NodeJS.ProcessEnv): boolean {
  const raw = typeof env[ORG_ALLOWLIST_ENV_VAR] === 'string' ? (env[ORG_ALLOWLIST_ENV_VAR] as string) : ''
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return entries.includes(orgId)
}

/**
 * The single boolean this capability surfaces to the web client (session `features` payload —
 * see `buildFeaturePayload` in `../routes/auth.ts`). An org with the master switch off, OR with
 * no allowlist entry, gets `false` — byte-identical to runtime behavior before this slice existed.
 */
export function isAttendanceGroupEffectivePolicyPanelEnabledForOrgV1(
  orgId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isAttendanceGroupEffectivePolicyPanelMasterEnabled(env)) return false
  if (typeof orgId !== 'string' || !orgId.trim()) return false
  return isOrgExactlyAllowlisted(orgId.trim(), env)
}
