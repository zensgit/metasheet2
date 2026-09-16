/**
 * Admin retry / resume refusal codes: the web runs view must know every one the service can return
 * (#5803 review).
 *
 * `retryExecution()` / `resumeExecution()` return `{ status, code, message }` refusals, and the route sends
 * them as `{ ok:false, error:{ code, message } }`. apps/web/src/views/AutomationExecutionsView.vue maps each
 * code to a localized inline message (`RERUN_ERROR_LABELS` / `RESUME_ERROR_LABELS`). An unmapped code falls
 * back to the raw English server message, so a zh session sees English. The view also carries a comment
 * that claims to be the COMPLETE list of retry refusals. #5803 added `SHEET_DELETED` to both methods and
 * the view knew neither.
 *
 * The codes are read from the service with the TypeScript parser, never retyped here:
 *   - every `return` in the method body (nested functions excluded) must be an object literal that is
 *     either a refusal with a `code` property or the success shape `{ execution }`. Anything else (for
 *     example a refusal returned by a helper) fails the test, because its codes could not be listed;
 *   - a `code` is a string literal or an identifier this file resolves from its real export
 *     (`SHEET_DELETED_CODE`). An unknown identifier fails the test.
 * The view's maps and the COMPLETE comment are read from the .vue text.
 *
 * Pinned:
 *   retry:  service (status, code) pairs == the COMPLETE comment's numbered items, and service codes ==
 *           RERUN_ERROR_LABELS keys minus the two route-level admin keys.
 *   resume: service codes == RESUME_ERROR_LABELS keys plus KNOWN_UNMAPPED_RESUME_CODES. That list holds the
 *           two codes that already had no label before #5803. It must stay exact: mapping one of them means
 *           removing it here too.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { SHEET_DELETED_CODE } from '../../src/multitable/sheet-liveness'

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')
const SERVICE_FILE = 'packages/core-backend/src/multitable/automation-service.ts'
const VIEW_FILE = 'apps/web/src/views/AutomationExecutionsView.vue'

/** Identifiers the service may use as a `code`, resolved from their real exports. */
const CODE_IDENTIFIERS: Readonly<Record<string, string>> = { SHEET_DELETED_CODE }

/**
 * `RERUN_ERROR_LABELS` keys that are not service refusals: the route's requireAdminRole() 403. The client
 * throws it as `AccessDenied`, and the backend documents the code as `ADMIN_REQUIRED` (see the view).
 */
const ROUTE_LEVEL_RERUN_KEYS: readonly string[] = ['AccessDenied', 'ADMIN_REQUIRED']

/**
 * Resume refusals that had no web label before #5803. They still fall back to the raw server message. This
 * is a known gap for a later web slice, recorded here so it cannot grow unnoticed.
 */
const KNOWN_UNMAPPED_RESUME_CODES: readonly string[] = ['EXECUTION_GONE', 'SUSPENSION_CURSOR_INVALID']

/** Repo file as text, line endings normalized (the Windows checkout is CRLF, CI is LF). */
function readRepoText(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

type Refusal = { status: number; code: string }

function serviceRefusals(methodName: 'retryExecution' | 'resumeExecution'): Refusal[] {
  const source = ts.createSourceFile(SERVICE_FILE, readRepoText(SERVICE_FILE), ts.ScriptTarget.Latest, true)
  let method: ts.MethodDeclaration | undefined
  const findMethod = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === 'AutomationService') {
      method = node.members.find(
        (m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === methodName,
      )
      return
    }
    ts.forEachChild(node, findMethod)
  }
  findMethod(source)
  if (!method?.body) throw new Error(`AutomationService.${methodName} not found`)

  const refusals: Refusal[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return // a nested function's returns are not the method's
    if (ts.isReturnStatement(node)) {
      const text = node.getText(source)
      const expr = node.expression
      if (!expr || !ts.isObjectLiteralExpression(expr)) {
        throw new Error(`${methodName}: cannot enumerate a non-literal return: ${text}`)
      }
      const props = new Map<string, ts.ObjectLiteralElementLike>()
      for (const p of expr.properties) {
        if (!p.name || !ts.isIdentifier(p.name)) throw new Error(`${methodName}: unreadable return: ${text}`)
        props.set(p.name.text, p)
      }
      if (props.size === 1 && props.has('execution')) return
      const code = props.get('code')
      const status = props.get('status')
      if (!code || !status || !ts.isPropertyAssignment(code) || !ts.isPropertyAssignment(status)) {
        throw new Error(`${methodName}: return is neither a refusal nor { execution }: ${text}`)
      }
      if (!ts.isNumericLiteral(status.initializer)) throw new Error(`${methodName}: non-literal status: ${text}`)
      let codeValue: string
      if (ts.isStringLiteral(code.initializer)) codeValue = code.initializer.text
      else if (ts.isIdentifier(code.initializer) && code.initializer.text in CODE_IDENTIFIERS) {
        codeValue = CODE_IDENTIFIERS[code.initializer.text]
      } else throw new Error(`${methodName}: unresolvable code expression: ${text}`)
      refusals.push({ status: Number(status.initializer.text), code: codeValue })
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(method.body, visit)
  return refusals
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

/** `code -> label key` entries of a view label map (comment lines inside the map are skipped). */
function viewLabelMap(view: string, constName: string): [string, string][] {
  const start = view.indexOf(`const ${constName}: Record<string, AutomationLabelKey> = {`)
  if (start < 0) throw new Error(`${constName} not found in the view`)
  const body = view.slice(view.indexOf('{', start) + 1, view.indexOf('\n}', start))
  const entries = [...body.matchAll(/^\s+([A-Za-z_]+):\s*'([^']+)',?\s*$/gm)].map((m): [string, string] => [m[1], m[2]])
  const codeLines = body.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('//'))
  if (codeLines.length !== entries.length) throw new Error(`${constName}: ${codeLines.length} lines but ${entries.length} readable entries`)
  return entries
}

function viewLabelMapKeys(view: string, constName: string): string[] {
  return viewLabelMap(view, constName).map(([code]) => code)
}

function viewCompleteEnumeration(view: string): { item: number; status: number; code: string }[] {
  const start = view.indexOf('COMPLETE enumeration of the refusals `retryExecution()` can return')
  if (start < 0) throw new Error('the COMPLETE enumeration comment is gone from the view')
  const block = view.slice(start, view.indexOf('*/', start))
  return [...block.matchAll(/^\s*\*\s+(\d+)\.\s+(\d{3})\s+([A-Z_]+)\b/gm)].map((m) => ({
    item: Number(m[1]),
    status: Number(m[2]),
    code: m[3],
  }))
}

describe('service refusal codes are read from the source', () => {
  it('retryExecution: the parse finds the known refusals', () => {
    const codes = serviceRefusals('retryExecution').map((r) => r.code)
    expect(codes).toContain('NOT_FOUND')
    expect(codes).toContain('RETRY_LEDGER_EVIDENCE_MISSING')
    expect(codes).toContain('SHEET_DELETED')
  })

  it('resumeExecution: the parse finds the known refusals', () => {
    const codes = serviceRefusals('resumeExecution').map((r) => r.code)
    expect(codes).toContain('NOT_FOUND')
    expect(codes).toContain('RECORD_GONE')
    expect(codes).toContain('SHEET_DELETED')
  })
})

describe('AutomationExecutionsView knows every retry / resume refusal', () => {
  const view = readRepoText(VIEW_FILE)

  it('retry: every service code has a RERUN_ERROR_LABELS entry, and the map has nothing else', () => {
    const service = uniqueSorted(serviceRefusals('retryExecution').map((r) => r.code))
    const mapped = viewLabelMapKeys(view, 'RERUN_ERROR_LABELS')
    expect(new Set(mapped).size).toBe(mapped.length)
    for (const key of ROUTE_LEVEL_RERUN_KEYS) expect(mapped, key).toContain(key)
    expect(uniqueSorted(mapped.filter((k) => !ROUTE_LEVEL_RERUN_KEYS.includes(k)))).toEqual(service)
  })

  it('retry: the COMPLETE enumeration comment lists exactly the service (status, code) pairs, numbered 1..n', () => {
    const service = uniqueSorted(serviceRefusals('retryExecution').map((r) => `${r.status} ${r.code}`))
    const items = viewCompleteEnumeration(view)
    expect(items.map((i) => i.item)).toEqual(items.map((_, n) => n + 1))
    expect(uniqueSorted(items.map((i) => `${i.status} ${i.code}`))).toEqual(service)
    expect(items.length).toBe(service.length)
  })

  it('resume: every service code has a RESUME_ERROR_LABELS entry, except the recorded pre-#5803 gaps', () => {
    const service = uniqueSorted(serviceRefusals('resumeExecution').map((r) => r.code))
    const mapped = viewLabelMapKeys(view, 'RESUME_ERROR_LABELS')
    expect(new Set(mapped).size).toBe(mapped.length)
    for (const gap of KNOWN_UNMAPPED_RESUME_CODES) {
      expect(service, `${gap} is no longer a resume refusal: drop it from KNOWN_UNMAPPED_RESUME_CODES`).toContain(gap)
      expect(mapped, `${gap} is mapped now: drop it from KNOWN_UNMAPPED_RESUME_CODES`).not.toContain(gap)
    }
    expect(uniqueSorted([...mapped, ...KNOWN_UNMAPPED_RESUME_CODES])).toEqual(service)
  })

  it('SHEET_DELETED is mapped on both lanes to its own sheet-deleted label', () => {
    expect(new Map(viewLabelMap(view, 'RERUN_ERROR_LABELS')).get(SHEET_DELETED_CODE)).toBe('runs.rerunError.sheetDeleted')
    expect(new Map(viewLabelMap(view, 'RESUME_ERROR_LABELS')).get(SHEET_DELETED_CODE)).toBe('runs.resumeError.sheetDeleted')
  })
})
