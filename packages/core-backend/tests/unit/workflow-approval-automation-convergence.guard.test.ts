/**
 * Engine Convergence Doctrine — DURABLE STRUCTURAL GUARD.
 *
 * Enforces the runtime boundaries decided in
 * `docs/development/workflow-approval-automation-engine-convergence-doctrine-20260616.md`
 * (#2738, sharpened in #2740). The doctrine is convergence-BY-CONTRACT, not
 * fusion-by-refactor: approval owns approval state, automation owns side
 * effects + WorkflowJob, the legacy BPMN live runtime is fenced, and all
 * cross-runtime behavior goes through explicit bridge contracts.
 *
 * A doctrine that is only prose decays at the first deadline. This guard turns
 * its two most concrete, mechanically-checkable rules into fail-closed CI:
 *
 *   §5  Legacy BPMN fence — `BPMNWorkflowEngine` may only be imported by a
 *       FROZEN allowlist (the legacy route + the preview surface). A NEW
 *       importer — especially from approval or automation runtime code — fails
 *       RED. This is how "do not expand the legacy live BPMN runtime" stays
 *       true rather than aspirational.
 *
 *   §3  Cross-runtime table-write boundary — approval runtime code must not
 *       write automation tables, and automation runtime code must not write
 *       approval tables. Cross-runtime effect goes through the bridge
 *       (`start_approval` create-via-API + the completion-event durable claim),
 *       never a direct write into the other runtime's tables.
 *
 * Runs in the standard vitest unit job (default glob, not excluded), so it
 * gates every PR. If it fails, you almost certainly crossed a runtime boundary
 * the doctrine draws — re-route through a bridge contract, or (for the BPMN
 * allowlist) classify the new importer with an explicit disposition + reason.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

const SRC = join(__dirname, '../../src')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

function walkTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTsFiles(full))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/** A file "depends on" the BPMN engine when it imports from the engine module path. */
function importsBpmnEngine(src: string): boolean {
  return /(?:from|import)\s+['"][^'"]*\/BPMNWorkflowEngine['"]/.test(src)
}

/** SQL write statements (skipping comment lines) against tables matching `pattern`. */
function tableWriteSites(src: string, pattern: RegExp): string[] {
  const hits: string[] = []
  for (const raw of src.split('\n')) {
    const trimmed = raw.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
    if (pattern.test(raw)) hits.push(raw.trim())
  }
  return hits
}

/**
 * §5 — FROZEN allowlist of every file allowed to import `BPMNWorkflowEngine`.
 * Disposition:
 *   LEGACY-RUNTIME — the fenced live `/api/workflow` surface. Must not grow new
 *                    product dependencies (doctrine §5).
 *   PREVIEW        — Workflow Designer compile-preview / gap-report. Read-only,
 *                    no live execution (doctrine §3.3).
 *
 * Adding a file here is a deliberate, reviewable act. Approval and automation
 * runtime code must NEVER appear in this list (see the dedicated test below).
 */
const BPMN_IMPORT_ALLOWLIST: Array<{ file: string; disposition: 'LEGACY-RUNTIME' | 'PREVIEW'; reason: string }> = [
  {
    file: 'routes/workflow.ts',
    disposition: 'LEGACY-RUNTIME',
    reason: 'Fenced legacy /api/workflow live runtime (doctrine §5). Do not add new product features that depend on it.',
  },
  {
    file: 'routes/workflow-designer.ts',
    disposition: 'PREVIEW',
    reason: 'Workflow Designer compile-preview / gap-report only — no live execution (doctrine §3.3).',
  },
]

/**
 * §5 sharpening — runtime authorities that the doctrine names explicitly and
 * which must NEVER import the legacy BPMN engine, even if mistakenly added to
 * the allowlist above. These are the approval + automation source-of-truth
 * files from the doctrine §1 runtime map.
 */
const RUNTIME_FILES_FORBIDDEN_BPMN = [
  'multitable/automation-executor.ts',
  'multitable/automation-service.ts',
  'multitable/automation-job-service.ts',
  'multitable/automation-approval-bridge-service.ts',
  'services/ApprovalProductService.ts',
  'services/ApprovalGraphExecutor.ts',
  'routes/approvals.ts',
]

/**
 * §3 — the automation source-of-truth files. They must not write approval
 * tables; they reach approval only through the bridge (create-via-API +
 * completion event). NOTE: `automation-approval-bridge-service.ts` is the
 * sanctioned bridge — it writes its OWN `automation_approval_bridges` table and
 * calls `ApprovalProductService` (no direct approval-table writes) — so it is
 * deliberately excluded from this list.
 */
const AUTOMATION_RUNTIME_FILES = [
  'multitable/automation-executor.ts',
  'multitable/automation-service.ts',
  'multitable/automation-job-service.ts',
]

/** §3 — the approval source-of-truth files. They must not write automation tables. */
const APPROVAL_RUNTIME_FILES = [
  'services/ApprovalProductService.ts',
  'services/ApprovalGraphExecutor.ts',
  'routes/approvals.ts',
]

const APPROVAL_TABLE_WRITE = /(INSERT INTO|UPDATE|DELETE FROM)\s+approval_/
const AUTOMATION_TABLE_WRITE = /(INSERT INTO|UPDATE|DELETE FROM)\s+(automation_|multitable_automation_jobs)/

describe('engine convergence doctrine — durable structural guard', () => {
  test('§5: only the frozen allowlist imports BPMNWorkflowEngine (legacy fence)', () => {
    const importers = walkTsFiles(SRC)
      .filter((full) => importsBpmnEngine(readFileSync(full, 'utf8')))
      .map((full) => full.slice(SRC.length + 1))

    // A new importer that is not classified fails RED.
    const unaudited = importers.filter((f) => !BPMN_IMPORT_ALLOWLIST.some((a) => a.file === f))
    expect(
      unaudited,
      'CONVERGENCE GUARD §5: a new file imports BPMNWorkflowEngine. The legacy live BPMN runtime must not ' +
        'be expanded. Route the behavior through a bridge contract / the automation runtime, or — if this is ' +
        'a deliberate legacy/preview surface — add it to BPMN_IMPORT_ALLOWLIST with a disposition + reason. ' +
        'Approval and automation runtime code may NEVER import it.',
    ).toEqual([])

    // A stale allowlist entry (file no longer imports it) must be pruned.
    const stale = BPMN_IMPORT_ALLOWLIST.filter((a) => !importers.includes(a.file))
    expect(
      stale.map((a) => a.file),
      'CONVERGENCE GUARD §5: an allowlisted file no longer imports BPMNWorkflowEngine — prune it from ' +
        'BPMN_IMPORT_ALLOWLIST so the fence keeps reflecting reality.',
    ).toEqual([])
  })

  test('§5: approval/automation runtime authorities never import BPMNWorkflowEngine', () => {
    const offenders = RUNTIME_FILES_FORBIDDEN_BPMN.filter((f) => importsBpmnEngine(read(f)))
    expect(
      offenders,
      'CONVERGENCE GUARD §5: an approval/automation runtime authority imports BPMNWorkflowEngine. ' +
        'The legacy BPMN runtime is a separate fenced surface; runtime code must not depend on it.',
    ).toEqual([])
  })

  test('§3: automation runtime code does not write approval tables', () => {
    const offenders = AUTOMATION_RUNTIME_FILES.flatMap((f) =>
      tableWriteSites(read(f), APPROVAL_TABLE_WRITE).map((sql) => `${f} → ${sql.slice(0, 90)}`))
    expect(
      offenders,
      'CONVERGENCE GUARD §3: automation runtime code writes an approval_* table directly. Automation must ' +
        'reach approval through the bridge (start_approval create-via-API + completion-event claim), not by ' +
        'writing approval tables. (The sanctioned bridge automation-approval-bridge-service.ts is exempt.)',
    ).toEqual([])
  })

  test('§3: approval runtime code does not write automation tables', () => {
    const offenders = APPROVAL_RUNTIME_FILES.flatMap((f) =>
      tableWriteSites(read(f), AUTOMATION_TABLE_WRITE).map((sql) => `${f} → ${sql.slice(0, 90)}`))
    expect(
      offenders,
      'CONVERGENCE GUARD §3: approval runtime code writes an automation_*/multitable_automation_jobs table ' +
        'directly. Approval must not settle automation jobs except through the completion-event bridge path.',
    ).toEqual([])
  })
})
