import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import ts from 'typescript'

/**
 * Lock-1 OD-L1-7(a) — a STATIC census of every `ApprovalGraphExecutor` construction site, pinning
 * the `groupMemberIds` wiring the cc 'group' arm depends on.
 *
 * `ApprovalGraphExecutor.collectCcEvents` expands a `targetType:'group'` cc node from
 * `options.groupMemberIds` (the create-frozen snapshot) and THROWS when that option was not
 * supplied — the wiring guard (fail loud, never a silent cc drop). The guard is only as good as the
 * sites that pass the option: the real-DB suite (approval-user-group.db.test.ts) exercises the
 * create site and the `dispatchAction` site; `adminJump` and `applyNodeTimeoutEffect` reach the same
 * arm on rarer walks that no real-DB case drives. Gate r1 (P2-1) proved the hazard: with the
 * `dispatchAction` wiring removed every unit test stayed green while a cc-after-approval approve
 * 500-ed. This file makes each wiring a TESTED property.
 *
 * CALIBER (so nobody reads more into a green run): the population is DISCOVERED, not listed —
 * every `new ApprovalGraphExecutor(...)` expression in the two files that construct executors is
 * parsed with the TypeScript compiler API and classified by its enclosing function. A new site reds
 * the population check and must be classified here as wired or exempt. "Wired" means the third
 * argument is an inline object literal with a `groupMemberIds` property whose initializer is a
 * `readGroupMemberIdsSnapshot(...)` call (the dispatch-side snapshot reader) — a spread, a
 * variable-held options object, or any other initializer is reported as NOT wired, so an
 * `?? {}`-style bypass lands in the executor (and is covered by the executor unit test), not here.
 * Each EXEMPT site is pinned by the mechanical fact that makes it unable to reach a cc arm, not by
 * a comment: the cancel-round seed graph carries no cc node; the return-target walk calls only
 * `listVisitedApprovalNodeKeysUntil`, whose body never calls `collectCcEvents` (positive control:
 * the two walkers that DO call it). Comments are not nodes — a docblock mentioning the option
 * never counts.
 */

const backendRoot = path.resolve(__dirname, '..', '..')
const srcRoot = path.join(backendRoot, 'src')
const SERVICE_FILE = path.join(srcRoot, 'services', 'ApprovalProductService.ts')
const RETURN_TARGETS_FILE = path.join(srcRoot, 'services', 'approval-return-targets.ts')
const EXECUTOR_FILE = path.join(srcRoot, 'services', 'ApprovalGraphExecutor.ts')
const CANCEL_ROUND_SEED_FILE = path.join(srcRoot, 'db', 'seeds', 'approval-cancel-round-published-definition.ts')

/** Sites that MUST pass the frozen snapshot (they can reach a cc arm through a walk). */
const WIRED_SITES = ['assembleCreationContext', 'adminJump', 'applyNodeTimeoutEffect', 'dispatchAction'] as const
/** Sites that cannot reach a cc 'group' arm — each pinned below by its mechanical reason. */
const EXEMPT_SERVICE_SITES = ['createCancelRoundInstance'] as const
const EXEMPT_RETURN_TARGET_SITE = 'computeReturnableNodeKeys'

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function enclosingFunctionName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if ((ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) && current.name) {
      return current.name.getText()
    }
    if (
      ts.isVariableDeclaration(current)
      && current.initializer
      && (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
    ) {
      return current.name.getText()
    }
    current = current.parent
  }
  return '<module>'
}

interface ConstructionSite {
  enclosing: string
  line: number
  /** Name of the `const x = new ApprovalGraphExecutor(...)` binding, when the site is one. */
  bindingName: string | null
  /** Initializer text of an inline `groupMemberIds:` property in the third argument; null when absent. */
  groupMemberIdsInitializer: string | null
  /** True when the third argument is an inline object literal (the only shape this census resolves). */
  inlineOptions: boolean
}

function censusConstructionSites(file: string): ConstructionSite[] {
  const sourceFile = parse(file)
  const sites: ConstructionSite[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'ApprovalGraphExecutor') {
      const optionsArg = node.arguments?.[2]
      const inlineOptions = Boolean(optionsArg && ts.isObjectLiteralExpression(optionsArg))
      let groupMemberIdsInitializer: string | null = null
      if (optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
        for (const property of optionsArg.properties) {
          const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
            ? property.name.text
            : null
          if (name !== 'groupMemberIds') continue
          if (ts.isPropertyAssignment(property)) groupMemberIdsInitializer = property.initializer.getText()
          else if (ts.isShorthandPropertyAssignment(property)) groupMemberIdsInitializer = property.name.text
          else groupMemberIdsInitializer = '<non-assignment member>'
        }
      }
      const bindingName = ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)
        ? node.parent.name.text
        : null
      sites.push({
        enclosing: enclosingFunctionName(node),
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        bindingName,
        groupMemberIdsInitializer,
        inlineOptions,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return sites
}

/** Body text of a named method of the (single) class in the executor file. */
function executorMethodBodyText(methodName: string): string {
  const sourceFile = parse(EXECUTOR_FILE)
  let body: string | null = null
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && node.name.getText() === methodName && node.body) {
      body = node.body.getText()
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (body === null) throw new Error(`executor method ${methodName} not found`)
  return body
}

/** Every `x.<member>(...)` call on the identifier `bindingName` inside `file`. */
function memberCallsOn(file: string, bindingName: string): string[] {
  const sourceFile = parse(file)
  const calls: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === bindingName
    ) {
      calls.push(node.expression.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return calls
}

/** Every string-literal `type: '...'` property value in `file` (object literals only; comments are not nodes). */
function typeLiteralValues(file: string): string[] {
  const sourceFile = parse(file)
  const values: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node)
      && ts.isIdentifier(node.name)
      && node.name.text === 'type'
      && ts.isStringLiteral(node.initializer)
    ) {
      values.push(node.initializer.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return values
}

const serviceSites = censusConstructionSites(SERVICE_FILE)
const returnTargetSites = censusConstructionSites(RETURN_TARGETS_FILE)

describe('OD-L1-7(a) — ApprovalGraphExecutor construction-site census (groupMemberIds wiring)', () => {
  it('population self-check: the discovered sites are exactly the wired + exempt sets (a new site reds here and must be classified)', () => {
    const discovered = serviceSites.map((site) => site.enclosing).sort()
    expect(discovered, serviceSites.map((site) => `${site.enclosing}@${site.line}`).join(', '))
      .toEqual([...WIRED_SITES, ...EXEMPT_SERVICE_SITES].sort())
    // One site per enclosing function (a second construction inside one of them would hide behind the name).
    expect(new Set(discovered).size).toBe(discovered.length)
    expect(returnTargetSites.map((site) => site.enclosing)).toEqual([EXEMPT_RETURN_TARGET_SITE])
  })

  it('every WIRED site passes groupMemberIds through the dispatch-side snapshot reader, inline (never a spread or a held options object)', () => {
    for (const name of WIRED_SITES) {
      const site = serviceSites.find((candidate) => candidate.enclosing === name)
      expect(site, name).toBeDefined()
      expect(site!.inlineOptions, `${name}@${site!.line}: options must be an inline object literal`).toBe(true)
      expect(site!.groupMemberIdsInitializer, `${name}@${site!.line}: groupMemberIds must be wired`)
        .toMatch(/^readGroupMemberIdsSnapshot\(/)
    }
  })

  it('the wiring guard the sites feed still exists: collectCcEvents reads options.groupMemberIds and throws without it (positive control for the property name)', () => {
    const body = executorMethodBodyText('collectCcEvents')
    expect(body).toContain('this.options.groupMemberIds')
    expect(body).toContain('no group member snapshot was supplied')
  })

  it('EXEMPT createCancelRoundInstance: the cancel-round seed graph carries no cc node (start / approval / end only), so its executor can never reach a cc arm', () => {
    const site = serviceSites.find((candidate) => candidate.enclosing === 'createCancelRoundInstance')
    expect(site).toBeDefined()
    expect(site!.groupMemberIdsInitializer).toBeNull()
    const nodeTypes = typeLiteralValues(CANCEL_ROUND_SEED_FILE)
    // Positive control: the graph literal was actually parsed (its three node types are present).
    for (const required of ['start', 'approval', 'end']) expect(nodeTypes).toContain(required)
    expect(nodeTypes).not.toContain('cc')
  })

  it('EXEMPT computeReturnableNodeKeys: its executor is only ever asked for the visited-key walk, and that walk never collects cc events (positive control: the two resolving walkers do)', () => {
    const site = returnTargetSites[0]
    expect(site.bindingName).toBe('executor')
    expect(site.groupMemberIdsInitializer).toBeNull()
    expect(memberCallsOn(RETURN_TARGETS_FILE, 'executor')).toEqual(['listVisitedApprovalNodeKeysUntil'])
    expect(executorMethodBodyText('listVisitedApprovalNodeKeysUntil')).not.toContain('collectCcEvents')
    expect(executorMethodBodyText('resolveFromNode')).toContain('this.collectCcEvents(')
    expect(executorMethodBodyText('resolveBranchAdvance')).toContain('this.collectCcEvents(')
  })

  it('DECOY: the census is discriminating — a synthetic site with a spread / held options object is reported as NOT wired, an inline readGroupMemberIdsSnapshot call as wired', () => {
    const fixture = path.join(backendRoot, 'tests', 'unit', '__decoy_cc_sites__.ts')
    const synthetic = [
      'declare const ApprovalGraphExecutor: any; declare const readGroupMemberIdsSnapshot: any; declare const snap: any; declare const held: any;',
      'function wiredSite() { const e = new ApprovalGraphExecutor({}, {}, { groupMemberIds: readGroupMemberIdsSnapshot(snap) }); return e }',
      'function spreadSite() { const e = new ApprovalGraphExecutor({}, {}, { ...held }); return e }',
      'function heldSite() { const e = new ApprovalGraphExecutor({}, {}, held); return e }',
      'function bypassSite() { const e = new ApprovalGraphExecutor({}, {}, { groupMemberIds: snap ?? {} }); return e }',
    ].join('\n')
    const sourceFile = ts.createSourceFile(fixture, synthetic, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const sites: Array<{ enclosing: string; wired: boolean }> = []
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'ApprovalGraphExecutor') {
        const optionsArg = node.arguments?.[2]
        let wired = false
        if (optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
          for (const property of optionsArg.properties) {
            if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'groupMemberIds') {
              wired = /^readGroupMemberIdsSnapshot\(/.test(property.initializer.getText())
            }
          }
        }
        sites.push({ enclosing: enclosingFunctionName(node), wired })
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    expect(sites).toEqual([
      { enclosing: 'wiredSite', wired: true },
      { enclosing: 'spreadSite', wired: false },
      { enclosing: 'heldSite', wired: false },
      { enclosing: 'bypassSite', wired: false },
    ])
  })
})
