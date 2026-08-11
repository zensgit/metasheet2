import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const WRITER_NAME = 'recordAttendanceScheduledRunTargetOutcomeV1'
const OUTCOME_TABLE = 'attendance_scheduled_run_target_outcomes'

interface WriterScanResult {
  readonly completed: string[]
  readonly unsafe: string[]
  readonly outcomeTableWrites: string[]
}

function listProductionFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && ['__tests__', 'test', 'tests'].includes(entry.name)) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...listProductionFiles(path))
    else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.cjs'))) files.push(path)
  }
  return files
}

function location(sourceFile: ts.SourceFile, node: ts.Node): string {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return `${sourceFile.fileName}:${start.line + 1}`
}

function isWriterExpression(expression: ts.Expression, localWriterNames: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(expression)) return localWriterNames.has(expression.text)
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === WRITER_NAME
  return (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteral(expression.argumentExpression) &&
    expression.argumentExpression.text === WRITER_NAME
  )
}

function scanSource(file: string, source: string): WriterScanResult {
  const scriptKind = file.endsWith('.cjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind)
  const localWriterNames = new Set<string>()
  const completed: string[] = []
  const unsafe: string[] = []
  const outcomeTableWrites: string[] = []

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue
    if (!ts.isNamedImports(statement.importClause.namedBindings)) continue
    for (const specifier of statement.importClause.namedBindings.elements) {
      if ((specifier.propertyName ?? specifier.name).text === WRITER_NAME) {
        localWriterNames.add(specifier.name.text)
      }
    }
  }

  const directWriterExpressions = new Set<ts.Node>()
  const visitCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isWriterExpression(node.expression, localWriterNames)) {
      directWriterExpressions.add(node.expression)
      const outcome = node.arguments[2]
      const terminalOutcome =
        outcome && ts.isObjectLiteralExpression(outcome)
          ? outcome.properties.find(
              (property): property is ts.PropertyAssignment =>
                ts.isPropertyAssignment(property) &&
                ((ts.isIdentifier(property.name) && property.name.text === 'terminalOutcome') ||
                  (ts.isStringLiteral(property.name) && property.name.text === 'terminalOutcome')),
            )
          : undefined
      const callsite = location(sourceFile, node)
      if (
        terminalOutcome &&
        ts.isStringLiteral(terminalOutcome.initializer) &&
        terminalOutcome.initializer.text === 'completed'
      ) {
        completed.push(callsite)
      } else {
        unsafe.push(callsite)
      }
    }
    ts.forEachChild(node, visitCalls)
  }
  visitCalls(sourceFile)

  const visitReferences = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      localWriterNames.has(node.text) &&
      !ts.isImportSpecifier(node.parent) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !directWriterExpressions.has(node)
    ) {
      unsafe.push(`${location(sourceFile, node)}:indirect-writer-reference`)
    }
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === WRITER_NAME) ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === WRITER_NAME)
    ) {
      if (!directWriterExpressions.has(node)) {
        unsafe.push(`${location(sourceFile, node)}:indirect-writer-reference`)
      }
    }
    ts.forEachChild(node, visitReferences)
  }
  visitReferences(sourceFile)

  const tableWritePattern = new RegExp(
    String.raw`(?:\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:(?:public)\.)?${OUTCOME_TABLE}\b|\b(?:insertInto|updateTable|deleteFrom)\s*\(\s*['"]${OUTCOME_TABLE}['"])`,
    'gi',
  )
  for (const match of source.matchAll(tableWritePattern)) {
    const start = sourceFile.getLineAndCharacterOfPosition(match.index)
    outcomeTableWrites.push(`${file}:${start.line + 1}`)
  }

  return { completed, unsafe, outcomeTableWrites }
}

function scanProductionSources(): WriterScanResult {
  const coreSrc = fileURLToPath(new URL('../../', import.meta.url))
  const pluginSrc = fileURLToPath(new URL('../../../../../plugins/plugin-attendance', import.meta.url))
  const result: WriterScanResult = { completed: [], unsafe: [], outcomeTableWrites: [] }
  for (const file of [...listProductionFiles(coreSrc), ...listProductionFiles(pluginSrc)]) {
    const scanned = scanSource(file, readFileSync(file, 'utf8'))
    result.completed.push(...scanned.completed)
    result.unsafe.push(...scanned.unsafe)
    result.outcomeTableWrites.push(...scanned.outcomeTableWrites)
  }
  return result
}

describe('W4C-2 OD-W4C-54=(a) production outcome allowlist', () => {
  it('keeps both production outcome calls literal-completed and the canonical writer as the only table writer', () => {
    const result = scanProductionSources()
    expect(result.completed).toHaveLength(2)
    expect(result.unsafe).toEqual([])
    expect(result.outcomeTableWrites).toHaveLength(1)
    expect(result.outcomeTableWrites[0]).toMatch(/w4c2-scheduled-run\.ts:\d+$/)
  })

  it('fails closed on dynamic outcomes and indirect aliases', () => {
    const dynamic = scanSource(
      'dynamic.ts',
      `import { ${WRITER_NAME} as writer } from './w4c2-scheduled-run'
       const outcome = Math.random() > 0.5 ? 'completed' : 'failed'
       writer(trx, identity, { terminalOutcome: outcome })`,
    )
    expect(dynamic.completed).toEqual([])
    expect(dynamic.unsafe).toHaveLength(1)

    const aliased = scanSource(
      'aliased.ts',
      `import { ${WRITER_NAME} as writer } from './w4c2-scheduled-run'
       const indirect = writer
       indirect(trx, identity, { terminalOutcome: 'failed', failureReasonCode: 'x' })`,
    )
    expect(aliased.completed).toEqual([])
    expect(aliased.unsafe).toHaveLength(1)

    const queryBuilderWrite = scanSource(
      'query-builder.ts',
      `db.insertInto('${OUTCOME_TABLE}').values({ terminal_outcome: 'failed' }).execute()`,
    )
    expect(queryBuilderWrite.outcomeTableWrites).toHaveLength(1)
  })
})
