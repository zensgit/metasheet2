/**
 * The public health endpoint keeps its status and its fields.
 *
 * Realtime admission notices are shown to administrators only (routes/admin-realtime-diagnostics.ts).
 * This guard reads the health handler in src/index.ts and pins:
 *   - the exact field set of its JSON body;
 *   - that both public paths are served by that one handler;
 *   - that the handler reads nothing from the realtime admission modules.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const INDEX = join(here, '../../src/index.ts')

const EXPECTED_FIELDS = ['status', 'ok', 'success', 'timestamp', 'plugins', 'pluginsSummary', 'dbPool', 'build']

function findHealthHandler(text: string): { node: ts.VariableDeclaration; source: ts.SourceFile } {
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true)
  const found: ts.VariableDeclaration[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'healthHandler') found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (found.length !== 1) throw new Error(`expected exactly one healthHandler, found ${found.length}`)
  return { node: found[0], source }
}

function jsonBodies(handler: ts.Node): string[][] {
  const bodies: string[][] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'json'
      && node.arguments.length === 1
      && ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      bodies.push(node.arguments[0].properties.map((property) => {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) throw new Error('health body has a computed or spread member')
        return property.name.text
      }))
    }
    ts.forEachChild(node, visit)
  }
  visit(handler)
  return bodies
}

function analyse(text: string) {
  const { node, source } = findHealthHandler(text)
  const handlerText = node.getText(source)
  return {
    bodies: jsonBodies(node),
    statusCalls: [...handlerText.matchAll(/\.status\(([^)]*)\)/g)].map((match) => match[1]),
    mentionsAdmission: /realtime|diagnostic|admission|revalidation/i.test(handlerText),
    mounts: [...text.matchAll(/this\.app\.get\('([^']+)', healthHandler\)/g)].map((match) => match[1]),
  }
}

describe('public health endpoint contract', () => {
  const real = analyse(readFileSync(INDEX, 'utf8'))

  it('answers one JSON body with exactly the established fields, in order', () => {
    expect(real.bodies).toEqual([EXPECTED_FIELDS])
  })

  it('sets no explicit status, so a served request answers 200', () => {
    expect(real.statusCalls).toEqual([])
  })

  it('serves both public paths from the one handler', () => {
    expect(real.mounts).toEqual(['/health', '/api/health'])
  })

  it('reads nothing from realtime admission state', () => {
    expect(real.mentionsAdmission).toBe(false)
  })

  it('the analysis sees an added field, an added status and an admission read (controls)', () => {
    const text = readFileSync(INDEX, 'utf8')
    const withField = analyse(text.replace('          build: getBuildInfo(),\n        })\n        endTimer?.({ route: \'/health\'', '          build: getBuildInfo(),\n          realtime: realtimeDiagnostics.snapshot(),\n        })\n        endTimer?.({ route: \'/health\''))
    expect(withField.bodies).toEqual([[...EXPECTED_FIELDS, 'realtime']])
    expect(withField.mentionsAdmission).toBe(true)
    const withStatus = analyse(text.replace("        res.json({\n          status: 'ok',\n          ok: true,", "        res.status(503).json({\n          status: 'ok',\n          ok: true,"))
    expect(withStatus.statusCalls).toEqual(['503'])
  })
})
