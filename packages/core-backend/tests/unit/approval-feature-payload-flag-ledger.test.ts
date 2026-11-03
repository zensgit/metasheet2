import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * F2-M2: every key of the session feature payload is registered in the approval flag ledger.
 *
 * POPULATION: the keys of the one object literal returned by `buildFeaturePayload` in
 * `src/routes/auth.ts`, read from the TypeScript AST of that file. There is no hand-written key list
 * and no prefix filter, so a new key of any name joins the population as soon as it is added to the
 * literal.
 *
 * REGISTRY: the `Payload key` column of the table under `## 7. Flag and environment ledger` in
 * `docs/development/approval-parity-execution-ledger-20260817.md`. A cell there is either one
 * backticked key or text that starts with `—` (capability not surfaced in the payload).
 *
 * DIRECTION: payload ⊆ ledger. The ledger may hold more rows than the payload has keys (env-only flags
 * such as durable delivery or the Class A/B ledgers, and placeholder rows). The reverse direction is not
 * asserted: a key removed from the payload leaves its ledger row behind until the ledger is edited.
 *
 * FAIL CLOSED: a missing or repeated function, anything other than exactly one `return` of an object
 * literal, a spread or computed member, a missing heading / table / `Payload key` column, a row with the
 * wrong cell count, or a malformed `Payload key` cell each throws, so a restructured source file or
 * ledger cannot pass by reading an empty population.
 *
 * HOME: `tests/unit/*.test.ts` is collected by the default Vitest include of
 * `pnpm --filter @metasheet/core-backend test`, which the required `test` job runs; no workflow edit.
 */

const REPO_ROOT = join(__dirname, '../../../..')
const AUTH_ROUTE_PATH = 'packages/core-backend/src/routes/auth.ts'
const LEDGER_PATH = 'docs/development/approval-parity-execution-ledger-20260817.md'
const PAYLOAD_FUNCTION = 'buildFeaturePayload'
const LEDGER_HEADING = '## 7. Flag and environment ledger'
const PAYLOAD_KEY_COLUMN = 'Payload key'
const NO_KEY_MARKER = '—'
const KEY_CELL = /^`([A-Za-z_$][A-Za-z0-9_$]*)`$/

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function findPayloadLiteral(sourceText: string): ts.ObjectLiteralExpression {
  const sourceFile = ts.createSourceFile(AUTH_ROUTE_PATH, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declarations = sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === PAYLOAD_FUNCTION,
  )
  if (declarations.length !== 1 || !declarations[0].body) {
    throw new Error(
      `expected exactly one top-level function ${PAYLOAD_FUNCTION} with a body in ${AUTH_ROUTE_PATH}, found ${declarations.length}`,
    )
  }
  const returns: ts.ReturnStatement[] = []
  const visit = (node: ts.Node): void => {
    // A nested callback's `return` is not the payload.
    if (ts.isFunctionLike(node)) return
    if (ts.isReturnStatement(node)) returns.push(node)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(declarations[0].body, visit)
  if (returns.length !== 1 || !returns[0].expression) {
    throw new Error(`expected exactly one return statement, returning a value, in ${PAYLOAD_FUNCTION}; found ${returns.length} return statement(s)`)
  }
  const returned = unwrapExpression(returns[0].expression)
  if (!ts.isObjectLiteralExpression(returned)) {
    throw new Error(`${PAYLOAD_FUNCTION} must return an object literal; found ${ts.SyntaxKind[returned.kind]}`)
  }
  return returned
}

function memberKey(member: ts.ObjectLiteralElementLike): string {
  if (ts.isShorthandPropertyAssignment(member)) return member.name.text
  if (
    ts.isPropertyAssignment(member)
    || ts.isMethodDeclaration(member)
    || ts.isGetAccessorDeclaration(member)
    || ts.isSetAccessorDeclaration(member)
  ) {
    const name = member.name
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
    throw new Error(`computed member name in the ${PAYLOAD_FUNCTION} literal cannot be enumerated: ${name.getText()}`)
  }
  throw new Error(`member kind ${ts.SyntaxKind[member.kind]} in the ${PAYLOAD_FUNCTION} literal cannot be enumerated: ${member.getText()}`)
}

function extractFeaturePayloadKeys(sourceText: string): string[] {
  return findPayloadLiteral(sourceText).properties.map(memberKey)
}

function splitRow(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) throw new Error(`malformed table row: ${line}`)
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim())
}

function extractLedgerPayloadKeys(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/)
  const headings = lines.flatMap((line, index) => (line.trim() === LEDGER_HEADING ? [index] : []))
  if (headings.length !== 1) throw new Error(`expected exactly one "${LEDGER_HEADING}" heading, found ${headings.length}`)
  const start = headings[0] + 1
  const next = lines.findIndex((line, index) => index >= start && /^## /.test(line))
  const section = lines.slice(start, next === -1 ? lines.length : next)

  const first = section.findIndex((line) => line.trim().startsWith('|'))
  if (first === -1) throw new Error(`no table under "${LEDGER_HEADING}"`)
  let end = first
  while (end < section.length && section[end].trim().startsWith('|')) end += 1
  if (section.slice(end).some((line) => line.trim().startsWith('|'))) {
    throw new Error(`"${LEDGER_HEADING}" must hold exactly one table`)
  }
  const table = section.slice(first, end)

  const header = splitRow(table[0])
  const column = header.indexOf(PAYLOAD_KEY_COLUMN)
  if (column === -1 || header.lastIndexOf(PAYLOAD_KEY_COLUMN) !== column) {
    throw new Error(`expected exactly one "${PAYLOAD_KEY_COLUMN}" column in the ledger header`)
  }
  if (table.length < 2 || !splitRow(table[1]).every((cell) => /^:?-{3,}:?$/.test(cell))) {
    throw new Error('ledger table has no separator row')
  }
  const rows = table.slice(2)
  if (rows.length === 0) throw new Error('ledger table has no rows')

  const keys: string[] = []
  for (const row of rows) {
    const cells = splitRow(row)
    if (cells.length !== header.length) {
      throw new Error(`ledger row has ${cells.length} cells, header has ${header.length}: ${row}`)
    }
    const cell = cells[column]
    const match = KEY_CELL.exec(cell)
    if (match) keys.push(match[1])
    else if (!cell.startsWith(NO_KEY_MARKER)) {
      throw new Error(`"${PAYLOAD_KEY_COLUMN}" cell must be one backticked key or start with ${NO_KEY_MARKER}: "${cell}"`)
    }
  }
  return keys
}

function unregisteredKeys(payloadKeys: readonly string[], ledgerKeys: readonly string[]): string[] {
  const registered = new Set(ledgerKeys)
  return payloadKeys.filter((key) => !registered.has(key))
}

function spliceIntoPayloadLiteral(sourceText: string, member: string): string {
  const openBrace = findPayloadLiteral(sourceText).getStart() + 1
  return `${sourceText.slice(0, openBrace)}\n    ${member}${sourceText.slice(openBrace)}`
}

describe('session feature payload keys are registered in the approval flag ledger (F2-M2)', () => {
  const authSource = readRepoFile(AUTH_ROUTE_PATH)
  const ledger = readRepoFile(LEDGER_PATH)

  it('reads a non-empty, duplicate-free population from the buildFeaturePayload return literal', () => {
    const payloadKeys = extractFeaturePayloadKeys(authSource)
    expect(payloadKeys.length).toBeGreaterThan(0)
    expect(new Set(payloadKeys).size).toBe(payloadKeys.length)
  })

  it('registers each key at most once in the ledger Payload key column', () => {
    const ledgerKeys = extractLedgerPayloadKeys(ledger)
    expect(ledgerKeys.length).toBeGreaterThan(0)
    expect(ledgerKeys.filter((key, index) => ledgerKeys.indexOf(key) !== index)).toEqual([])
  })

  it('every payload key appears in the ledger Payload key column (payload ⊆ ledger)', () => {
    expect(unregisteredKeys(extractFeaturePayloadKeys(authSource), extractLedgerPayloadKeys(ledger))).toEqual([])
  })

  describe('negative controls on in-memory copies of the real files', () => {
    it('reports a key added to the return literal without a ledger row', () => {
      const mutated = spliceIntoPayloadLiteral(authSource, 'ledgerProbeUnregisteredKey: false,')
      const mutatedKeys = extractFeaturePayloadKeys(mutated)
      expect(mutatedKeys).toContain('ledgerProbeUnregisteredKey')
      expect(unregisteredKeys(mutatedKeys, extractLedgerPayloadKeys(ledger))).toEqual(['ledgerProbeUnregisteredKey'])
    })

    it('reports the key whose ledger row is deleted, for every registered payload key', () => {
      const payloadKeys = extractFeaturePayloadKeys(authSource)
      const lines = ledger.split('\n')
      for (const key of payloadKeys) {
        const rowIndexes = lines.flatMap((line, index) => (line.includes(`| \`${key}\` |`) ? [index] : []))
        expect(rowIndexes, key).toHaveLength(1)
        const withoutRow = lines.filter((_, index) => index !== rowIndexes[0]).join('\n')
        expect(unregisteredKeys(payloadKeys, extractLedgerPayloadKeys(withoutRow)), key).toEqual([key])
      }
    })

    it('fails closed on a spread or computed member in the return literal', () => {
      expect(() => extractFeaturePayloadKeys(spliceIntoPayloadLiteral(authSource, '...extraFeatures,'))).toThrow(
        /cannot be enumerated/,
      )
      expect(() => extractFeaturePayloadKeys(spliceIntoPayloadLiteral(authSource, '[dynamicKey]: true,'))).toThrow(
        /cannot be enumerated/,
      )
    })

    it('fails closed when the function is missing or has more than one return', () => {
      expect(() => extractFeaturePayloadKeys(authSource.replace(`function ${PAYLOAD_FUNCTION}(`, 'function renamedPayload('))).toThrow(
        /expected exactly one top-level function/,
      )
      const earlyReturn = authSource.replace(
        'const permissions = Array.isArray(authUser.permissions)',
        'if (!authUser) return {}\n  const permissions = Array.isArray(authUser.permissions)',
      )
      expect(earlyReturn).not.toBe(authSource)
      expect(() => extractFeaturePayloadKeys(earlyReturn)).toThrow(/exactly one return statement/)
    })

    it('fails closed when the ledger heading, column or a Payload key cell is malformed', () => {
      expect(() => extractLedgerPayloadKeys(ledger.replace(LEDGER_HEADING, '## 7. Flags'))).toThrow(/heading/)
      expect(() => extractLedgerPayloadKeys(ledger.replace(`| ${PAYLOAD_KEY_COLUMN} |`, '| Key |'))).toThrow(
        /Payload key" column/,
      )
      expect(() => extractLedgerPayloadKeys(ledger.replace('| — (env only) |', '| env only |'))).toThrow(
        /must be one backticked key/,
      )
    })
  })
})
