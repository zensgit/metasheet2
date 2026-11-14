/**
 * Consumer registry guard: every call of a privilege-class read outside the classifier module is a
 * registered consumer, a `LOCKED_DECISION` consumer's function takes the branded transaction typed
 * as the contract token or asserts it (or the call sits inside an entry-point work closure), and
 * every registered consumer still exists. The scanned call-site keys equal a literal list, and the
 * set of decision points still outside a contract transaction is pinned and may only shrink by
 * becoming locked decisions. A call is recognised by the imported name it resolves to:
 * a renamed import (`import { classifyPrivilege as cp }`) and a namespace import
 * (`import * as p`, then `p.classifyPrivilege(…)`) are call sites of the original function.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  AUTHORIZATION_INPUT_CLASSIFIER_MODULE,
  AUTHORIZATION_INPUT_CONSUMER_FUNCTIONS,
  AUTHORIZATION_INPUT_CONSUMERS,
  hasPendingConsumers,
} from '../../src/rbac/authorization-input-consumers'
import type { AuthorizationInputConsumerEntry } from '../../src/rbac/authorization-input-consumers'
import { enclosingFunctionAt, listFiles, SOURCE_EXTENSIONS } from '../helpers/authorization-input-scan'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const SRC = 'packages/core-backend/src'
const read = (file: string) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')

type CallSite = { file: string; line: number; position: number; call: string; insideWorkClosure: boolean }

const CONSUMER_FUNCTIONS = AUTHORIZATION_INPUT_CONSUMER_FUNCTIONS as readonly string[]

const PROOF_MODULE = `${SRC}/auth/security-action-proof.ts`
/** Every production call site outside the classifier, as `file|function|call`, one item per site. */
const CALL_SITE_KEYS: readonly string[] = [
  `${PROOF_MODULE}|consume|assessSecurityActionPrivilege`,
  `${PROOF_MODULE}|readIssueInputs|assessSecurityActionPrivilege`,
]
/** Decision points not yet inside a contract transaction. An item leaves this list only by becoming a locked decision; none may be added. */
const PENDING_CONSUMER_KEYS: readonly string[] = [`${PROOF_MODULE}|consume|assessSecurityActionPrivilege`]

const keyOfEntry = (entry: AuthorizationInputConsumerEntry) => `${entry.file}|${entry.symbol}|${entry.call}`

/** Problems with the pending set: a pending entry outside the pin, or a pinned item that left the pending set without becoming a locked decision. */
function pendingProblems(registry: readonly AuthorizationInputConsumerEntry[], pinned: readonly string[]): string[] {
  const problems: string[] = []
  for (const entry of registry) {
    if (entry.mode === 'PENDING_LOCKED' && !pinned.includes(keyOfEntry(entry))) problems.push(`${keyOfEntry(entry)}: pending consumer outside the pinned set`)
  }
  for (const key of pinned) {
    const entry = registry.find((e) => keyOfEntry(e) === key)
    if (!entry) problems.push(`${key}: pinned pending consumer is not registered`)
    else if (entry.mode !== 'PENDING_LOCKED' && entry.mode !== 'LOCKED_DECISION') problems.push(`${key}: pinned pending consumer became ${entry.mode}`)
  }
  return problems
}

/** Local names bound by the file's imports: renamed imports map to the original name, namespace imports to `*`. */
function importBindings(tree: ts.SourceFile): Map<string, string> {
  const bindings = new Map<string, string>()
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue
    const named = statement.importClause.namedBindings
    if (ts.isNamespaceImport(named)) bindings.set(named.name.text, '*')
    else for (const element of named.elements) bindings.set(element.name.text, (element.propertyName ?? element.name).text)
  }
  return bindings
}

/** The consumer function a callee expression resolves to, or null: a bare name, a renamed import, or a member of a namespace import. */
function resolveCallee(callee: ts.Expression, bindings: Map<string, string>): string | null {
  if (ts.isIdentifier(callee)) {
    const original = bindings.get(callee.text) ?? callee.text
    return CONSUMER_FUNCTIONS.includes(original) ? original : null
  }
  if (ts.isPropertyAccessExpression(callee)) {
    const member = callee.name.text
    if (!CONSUMER_FUNCTIONS.includes(member)) return null
    return member
  }
  return null
}

function callSites(file: string, source: string): CallSite[] {
  const sites: CallSite[] = []
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS)
  const bindings = importBindings(tree)
  const visit = (node: ts.Node, insideWorkClosure: boolean) => {
    let inside = insideWorkClosure
    if (ts.isCallExpression(node)) {
      const name = resolveCallee(node.expression, bindings)
      if (name !== null) {
        sites.push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, position: node.getStart(tree), call: name, insideWorkClosure })
      }
      if (/^(?:with|enter)AuthorizationInputTransaction$/.test(node.expression.getText(tree))) inside = true
    }
    ts.forEachChild(node, (child) => visit(child, inside))
  }
  visit(tree, false)
  return sites
}

function registryProblems(sites: readonly CallSite[], registry: readonly AuthorizationInputConsumerEntry[], sourceOf: (file: string) => string): string[] {
  const problems: string[] = []
  const expected = new Map<string, number>()
  for (const entry of registry) expected.set(`${entry.file}|${entry.symbol}|${entry.call}`, (expected.get(`${entry.file}|${entry.symbol}|${entry.call}`) ?? 0) + entry.count)
  const found = new Map<string, number>()
  for (const site of sites) {
    const fn = enclosingFunctionAt(site.file, sourceOf(site.file), site.position)
    const key = `${site.file}|${fn?.name ?? '<module>'}|${site.call}`
    found.set(key, (found.get(key) ?? 0) + 1)
    const entry = registry.find((e) => `${e.file}|${e.symbol}|${e.call}` === key)
    if (!entry) {
      problems.push(`unregistered consumer ${key} at line ${site.line}`)
      continue
    }
    const holdsToken = fn !== null && (fn.brandedParameters.length > 0 || fn.assertsToken)
    if (entry.mode === 'LOCKED_DECISION' && !(holdsToken || site.insideWorkClosure)) problems.push(`${key}: locked decision without the token`)
    if (entry.mode === 'ADVISORY' && !entry.reason) problems.push(`${key}: advisory consumer without a reason`)
    if (entry.mode === 'PENDING_LOCKED' && !entry.slice) problems.push(`${key}: pending consumer without a slice`)
  }
  for (const [key, count] of expected) if (found.get(key) !== count) problems.push(`registered consumer ${key} expected ${count} site(s), found ${found.get(key) ?? 0}`)
  return problems
}

describe('consumer registry', () => {
  const files = listFiles(REPO_ROOT, { roots: [SRC, 'plugins'], exclude: [] }).filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)) && file !== AUTHORIZATION_INPUT_CLASSIFIER_MODULE)

  it('every privilege-class read outside the classifier is a registered consumer, and every registered consumer exists', () => {
    expect(files.length).toBeGreaterThan(900)
    expect(fs.existsSync(path.join(REPO_ROOT, AUTHORIZATION_INPUT_CLASSIFIER_MODULE))).toBe(true)
    // A renamed import still spells the original name in its import clause, and a namespace member
    // spells it at the call, so the text pre-filter loses no site.
    const pattern = new RegExp(AUTHORIZATION_INPUT_CONSUMER_FUNCTIONS.join('|'))
    const sites = files.flatMap((file) => {
      const source = read(file)
      return pattern.test(source) ? callSites(file, source) : []
    })
    expect(registryProblems(sites, AUTHORIZATION_INPUT_CONSUMERS, read)).toEqual([])
    const keys = sites.map((site) => `${site.file}|${enclosingFunctionAt(site.file, read(site.file), site.position)?.name ?? '<module>'}|${site.call}`).sort()
    expect(keys).toEqual([...CALL_SITE_KEYS].sort())
  })

  it('the decision points still outside a contract transaction are the pinned set, each names its slice, and the pending flag follows them', () => {
    expect(pendingProblems(AUTHORIZATION_INPUT_CONSUMERS, PENDING_CONSUMER_KEYS)).toEqual([])
    const pending = AUTHORIZATION_INPUT_CONSUMERS.filter((entry) => entry.mode === 'PENDING_LOCKED')
    expect(pending.map(keyOfEntry)).toEqual([...PENDING_CONSUMER_KEYS])
    for (const entry of pending) expect(entry.slice, entry.id).toBe('AIS-3b')
    expect(hasPendingConsumers()).toBe(pending.length > 0)
    expect(hasPendingConsumers()).toBe(true)
    expect(new Set(AUTHORIZATION_INPUT_CONSUMERS.map((entry) => entry.id)).size).toBe(AUTHORIZATION_INPUT_CONSUMERS.length)
    for (const key of PENDING_CONSUMER_KEYS) expect(CALL_SITE_KEYS).toContain(key)
  })

  it('the classifier module itself calls its own functions, and the scan finds that call shape', () => {
    const sites = callSites(AUTHORIZATION_INPUT_CLASSIFIER_MODULE, read(AUTHORIZATION_INPUT_CLASSIFIER_MODULE))
    expect(sites.map((site) => site.call)).toContain('readPrivilegeInputs')
  })

  it('POSITIVE CONTROL — an unregistered call, a locked decision without the token, and a vanished registered site are each a problem', () => {
    const file = `${SRC}/x.ts`
    const unregistered = "async function decide(tx: AuthorizationInputTx) { return assessSecurityActionPrivilege(tx, 'u') }"
    expect(registryProblems(callSites(file, unregistered), [], () => unregistered)).toHaveLength(1)
    const locked: AuthorizationInputConsumerEntry = { id: 'C-X', file, symbol: 'decide', call: 'assessSecurityActionPrivilege', count: 1, mode: 'LOCKED_DECISION' }
    expect(registryProblems(callSites(file, unregistered), [locked], () => unregistered)).toEqual([])
    const noToken = unregistered.replace('decide(tx: AuthorizationInputTx)', 'decide(client: PoolClient)').replace('(tx,', '(client,')
    expect(registryProblems(callSites(file, noToken), [locked], () => noToken)).toHaveLength(1)
    const renamedOnly = unregistered.replace('decide(tx: AuthorizationInputTx)', 'decide(tx)')
    expect(registryProblems(callSites(file, renamedOnly), [locked], () => renamedOnly)).toHaveLength(1)
    const asserted = "async function decide(client: PoolClient, tx: unknown) { assertAuthorizationInputTx(tx, { client, userId: 'u' }); return assessSecurityActionPrivilege(client, 'u') }"
    expect(registryProblems(callSites(file, asserted), [locked], () => asserted)).toEqual([])
    const inClosure = "async function decide(client) { return withAuthorizationInputTransaction(plan, async (tx) => assessSecurityActionPrivilege(tx, 'u')) }"
    const closureEntry: AuthorizationInputConsumerEntry = { ...locked, symbol: 'callback:withAuthorizationInputTransaction' }
    expect(registryProblems(callSites(file, inClosure), [closureEntry], () => inClosure)).toEqual([])
    expect(registryProblems([], [locked], () => '')).toHaveLength(1)
    const advisory: AuthorizationInputConsumerEntry = { ...locked, mode: 'ADVISORY' }
    expect(registryProblems(callSites(file, noToken), [advisory], () => noToken)).toHaveLength(1)
    expect(registryProblems(callSites(file, noToken), [{ ...advisory, reason: 'issue-time pre-read; consume re-reads under the lock' }], () => noToken)).toEqual([])
  })

  it('POSITIVE CONTROL — a pending consumer needs a slice and no token; outside the pinned set it is a problem, and a pinned one may only become a locked decision', () => {
    const file = `${SRC}/x.ts`
    const noToken = "async function decide(client: PoolClient) { return assessSecurityActionPrivilege(client, 'u') }"
    const pending: AuthorizationInputConsumerEntry = { id: 'K-X', file, symbol: 'decide', call: 'assessSecurityActionPrivilege', count: 1, mode: 'PENDING_LOCKED', slice: 'AIS-3b' }
    expect(registryProblems(callSites(file, noToken), [pending], () => noToken)).toEqual([])
    const { slice: _slice, ...withoutSlice } = pending
    expect(registryProblems(callSites(file, noToken), [withoutSlice], () => noToken)).toEqual([`${keyOfEntry(pending)}: pending consumer without a slice`])
    expect(pendingProblems([pending], [keyOfEntry(pending)])).toEqual([])
    expect(pendingProblems([pending], [])).toEqual([`${keyOfEntry(pending)}: pending consumer outside the pinned set`])
    expect(pendingProblems([{ ...pending, mode: 'LOCKED_DECISION' }], [keyOfEntry(pending)])).toEqual([])
    expect(pendingProblems([{ ...pending, mode: 'ADVISORY', reason: 'r' }], [keyOfEntry(pending)])).toEqual([`${keyOfEntry(pending)}: pinned pending consumer became ADVISORY`])
    expect(pendingProblems([], [keyOfEntry(pending)])).toEqual([`${keyOfEntry(pending)}: pinned pending consumer is not registered`])
  })

  it('POSITIVE CONTROL — a renamed import, a namespace import and a member call are call sites of the original function; an unrelated name is not', () => {
    const file = `${SRC}/x.ts`
    const renamed = "import { classifyPrivilege as cp } from '../auth/security-action-privilege'\nexport function f(i) { return cp(i) }"
    expect(callSites(file, renamed).map((site) => site.call)).toEqual(['classifyPrivilege'])
    const namespace = "import * as privilege from '../auth/security-action-privilege'\nexport function f(i) { return privilege.classifyPrivilege(i) }"
    expect(callSites(file, namespace).map((site) => site.call)).toEqual(['classifyPrivilege'])
    const member = 'export function f(s, i) { return s.readPrivilegeInputs(i) }'
    expect(callSites(file, member).map((site) => site.call)).toEqual(['readPrivilegeInputs'])
    const unrelated = "import { classifyPrivilege as cp } from '../auth/security-action-privilege'\nexport function f(i) { return cpx(i) + classify(i) }"
    expect(callSites(file, unrelated)).toEqual([])
    expect(registryProblems(callSites(file, renamed), [], () => renamed)).toHaveLength(1)
  })
})
