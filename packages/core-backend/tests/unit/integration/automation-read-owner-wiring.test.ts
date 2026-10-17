import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Structural evidence only: parse the real host without importing/booting it.
// JWT/DB/HTTP execution is covered separately by the authority acceptance suite;
// this suite pins the production assembly that the small HTTP fixture cannot run.
const source = ts.createSourceFile('index.ts', readFileSync(
  new URL('../../../src/index.ts', import.meta.url), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const prefix = '/api/integration/automation-read'

function one<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1)
  return items[0]!
}

function collect<T extends ts.Node>(node: ts.Node, is: (item: ts.Node) => item is T): T[] {
  const found: T[] = []
  function visit(item: ts.Node): void {
    if (is(item)) found.push(item)
    ts.forEachChild(item, visit)
  }
  visit(node)
  return found
}

function name(node: ts.Node | undefined): string | undefined {
  return node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : undefined
}

function chain(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this'
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) {
    const owner = chain(node.expression)
    return owner === undefined ? undefined : `${owner}.${node.name.text}`
  }
  return undefined
}

function call(node: ts.Node | undefined, target: string): ts.CallExpression {
  expect(node && ts.isCallExpression(node)).toBe(true)
  const result = node as ts.CallExpression
  expect(chain(result.expression)).toBe(target)
  return result
}

function object(node: ts.Node | undefined): ts.ObjectLiteralExpression {
  expect(node && ts.isObjectLiteralExpression(node)).toBe(true)
  return node as ts.ObjectLiteralExpression
}

function assignment(node: ts.Node): ts.PropertyAssignment {
  expect(ts.isPropertyAssignment(node)).toBe(true)
  return node as ts.PropertyAssignment
}

const server = one(source.statements.filter(ts.isClassDeclaration)
  .filter(item => name(item.name) === 'MetaSheetServer'))

function method(methodName: string): ts.MethodDeclaration {
  return one(server.members.filter(ts.isMethodDeclaration).filter(item => name(item.name) === methodName))
}

const setup = method('setupMiddleware')
const mounts = setup.body!.statements.filter(ts.isExpressionStatement)
  .map(item => item.expression).filter(ts.isCallExpression)
  .filter(item => chain(item.expression) === 'this.app.use')
const ownerMounts = mounts.filter(item => name(item.arguments[0]) === prefix)
const routerMount = one(ownerMounts.filter(item => ts.isCallExpression(item.arguments[1])
  && chain(item.arguments[1].expression) === 'createIntegrationAutomationReadRouter'))
const routerFactory = call(routerMount.arguments[1], 'createIntegrationAutomationReadRouter')

function imported(localName: string, modulePath: string): void {
  const matches = source.statements.filter(ts.isImportDeclaration).filter(declaration => {
    if (name(declaration.moduleSpecifier) !== modulePath) return false
    const bindings = declaration.importClause?.namedBindings
    return bindings && ts.isNamedImports(bindings)
      && bindings.elements.some(item => item.name.text === localName
        && (item.propertyName?.text ?? item.name.text) === localName && !item.isTypeOnly)
      && declaration.importClause?.isTypeOnly === false
  })
  expect(matches).toHaveLength(1)
}

describe('Automation Read owner host AST wiring (not full boot or authorization evidence)', () => {
  it('wires the private record producer into the actual durable boot with original delivery and signal', () => {
    const factory = one(collect(server, ts.isCallExpression).filter(item => chain(item.expression) === 'buildDurableConsumerHandlers'))
    const bindings = object(factory.arguments[0]).properties.map(assignment)
    const record = one(bindings.filter(item => name(item.name) === 'automationReadRecord'))
    const producer = one(object(record.initializer).properties.map(assignment))
    expect(name(producer.name)).toBe('produce')
    expect(ts.isArrowFunction(producer.initializer)).toBe(true)
    const forward = producer.initializer as ts.ArrowFunction
    expect(forward.parameters.map(item => name(item.name))).toEqual(['delivery', 'signal'])
    expect(call(forward.body, 'this.automationReadRuntime.produceRecord').arguments.map(chain)).toEqual(['delivery', 'signal'])
  })

  it('wires the eighth actual AutomationService constructor argument to the host-private schedule producer', () => {
    const constructor = one(collect(server, ts.isNewExpression).filter(item => chain(item.expression) === 'AutomationService'))
    expect(constructor.arguments).toHaveLength(8)
    const producer = one(object(constructor.arguments![7]).properties.map(assignment))
    expect(name(producer.name)).toBe('produce')
    expect(ts.isArrowFunction(producer.initializer)).toBe(true)
    const forward = producer.initializer as ts.ArrowFunction
    expect(forward.parameters.map(item => name(item.name))).toEqual(['occurrence', 'signal'])
    expect(call(forward.body, 'this.automationReadRuntime.produceSchedule').arguments.map(chain)).toEqual(['occurrence', 'signal'])
  })

  it.each(['Record', 'Schedule'])('separately closes and drains metadata %s admission before pool shutdown', kind => {
    const stop = method('stopOnce')
    const variables = stop.body!.statements.filter(ts.isVariableStatement).flatMap(item => [...item.declarationList.declarations])
    const drainName = `automationRead${kind}Drain`
    const drain = one(variables.filter(item => name(item.name) === drainName))
    const observed = call(drain.initializer, 'this.observeShutdownTask')
    expect(call(observed.arguments[0], `this.automationReadRuntime.stop${kind}Admissions`).arguments).toHaveLength(0)
    expect(drain.end).toBeLessThan(Math.min(...collect(stop, ts.isAwaitExpression).map(item => item.pos)))
    const tasks = one(variables.filter(item => name(item.name) === 'shutdownTasks'))
    expect((tasks.initializer as ts.ArrayLiteralExpression).elements.map(chain).filter(item => item === drainName)).toHaveLength(1)
    const barrier = one(collect(stop, ts.isCallExpression).filter(item => chain(item.expression) === 'this.waitForShutdownBarrier'
      && name(item.arguments[0]) === 'shutdownTasks'))
    const end = one(collect(stop, ts.isCallExpression).filter(item => chain(item.expression) === 'pool.end'))
    expect(barrier.end).toBeLessThan(end.pos)
  })

  it('constructs the private management service with the real host transaction and manifest', () => {
    imported('createAutomationReadManagement', './integration/automation-read-management')
    imported('createIntegrationAutomationReadRouter', './routes/integration-automation-read')
    const field = one(server.members.filter(ts.isPropertyDeclaration)
      .filter(item => name(item.name) === 'automationReadManagement'))
    expect(field.modifiers?.some(item => item.kind === ts.SyntaxKind.PrivateKeyword)).toBe(true)
    const factory = call(field.initializer, 'createAutomationReadManagement')
    expect(factory.arguments).toHaveLength(1)
    expect(object(factory.arguments[0]).properties.map(item => {
      const property = assignment(item)
      return [name(property.name), chain(property.initializer)]
    })).toEqual([
      ['transaction', 'automationReadTransaction'], ['manifest', 'CURRENT_ROUTING_MANIFEST'],
    ])
  })

  it('calls middleware assembly directly from the real constructor', () => {
    const constructor = one(server.members.filter(ts.isConstructorDeclaration))
    const assemblyCalls = constructor.body!.statements.filter(ts.isExpressionStatement)
      .map(item => item.expression).filter(ts.isCallExpression)
      .filter(item => chain(item.expression) === 'this.setupMiddleware')
    expect(one(assemblyCalls).arguments).toHaveLength(0)
  })

  const mapping = [
    ['options', 'automationReadRuntime', 'input'],
    ['grant', 'automationReadRuntime', 'input'],
    ['activateRecord', 'automationReadRuntime', 'input'],
    ['activateSchedule', 'automationReadRuntime', 'input'],
    ['submit', 'automationReadRuntime', 'input'],
    ['retry', 'automationReadRuntime', ['id', 'input']],
    ['retryContext', 'automationReadManagement', 'id'],
    ['grantDetail', 'automationReadManagement', 'id'],
    ['listGrants', 'automationReadManagement', 'input'],
    ['listRequests', 'automationReadManagement', 'input'],
    ['observe', 'automationReadManagement', 'id'],
    ['cancel', 'automationReadManagement', 'id'],
    ['revoke', 'automationReadManagement', 'id'],
  ] as const

  it.each(mapping)('forwards %s only to %s with the original actor and %s', (operation, service, input) => {
    expect(routerFactory.arguments).toHaveLength(1)
    const bindings = object(routerFactory.arguments[0]).properties.map(assignment)
    expect(bindings.map(item => name(item.name))).toEqual(mapping.map(item => item[0]))
    const binding = one(bindings.filter(item => name(item.name) === operation))
    expect(ts.isArrowFunction(binding.initializer)).toBe(true)
    const forward = binding.initializer as ts.ArrowFunction
    const args = ['actor', ...(typeof input === 'string' ? [input] : input)]
    expect(forward.parameters.map(item => name(item.name))).toEqual(args)
    const invocation = call(forward.body, `this.${service}.${operation}`)
    expect(invocation.arguments.map(chain)).toEqual(args)
  })

  it('mounts no-store before global parsing/JWT and mounts the owner router after the JWT gate', () => {
    imported('automationReadNoStoreMiddleware', './routes/integration-automation-read')
    const noStore = one(ownerMounts.filter(item => chain(item.arguments[1]) === 'automationReadNoStoreMiddleware'))
    const parsers = mounts.filter(item => item.arguments.length === 1
      && ts.isCallExpression(item.arguments[0])
      && ['express.json', 'express.urlencoded'].includes(chain(item.arguments[0].expression) ?? ''))
    expect(parsers).toHaveLength(2)
    const jwtMount = one(mounts.filter(item => item.arguments.length === 1
      && ts.isArrowFunction(item.arguments[0])
      && collect(item.arguments[0].body, ts.isCallExpression)
        .some(invocation => chain(invocation.expression) === 'jwtAuthMiddleware')))
    const jwt = jwtMount.arguments[0] as ts.ArrowFunction
    expect(ts.isBlock(jwt.body)).toBe(true)
    const gate = one((jwt.body as ts.Block).statements.filter(ts.isIfStatement)
      .filter(item => ts.isCallExpression(item.expression) && chain(item.expression.expression) === 'isApiPath'))
    expect(call(gate.expression, 'isApiPath').arguments.map(chain)).toEqual(['req.path'])
    expect(ts.isReturnStatement(gate.thenStatement)).toBe(true)
    expect(call((gate.thenStatement as ts.ReturnStatement).expression, 'jwtAuthMiddleware')
      .arguments.map(chain)).toEqual(['req', 'res', 'next'])
    for (const parser of parsers) {
      expect(noStore.pos).toBeLessThan(parser.pos)
      expect(parser.pos).toBeLessThan(jwtMount.pos)
    }
    expect(jwtMount.pos).toBeLessThan(routerMount.pos)
  })

  it('mounts the terminal error handler on exactly the owner prefix immediately after the router', () => {
    imported('automationReadParseErrorHandler', './routes/integration-automation-read')
    const error = one(ownerMounts.filter(item => chain(item.arguments[1]) === 'automationReadParseErrorHandler'))
    expect(ownerMounts).toHaveLength(3)
    // No hidden conditional/nested duplicate mount may bypass this ordered direct assembly.
    const allOwnerMounts = collect(setup, ts.isCallExpression).filter(item =>
      chain(item.expression) === 'this.app.use' && name(item.arguments[0]) === prefix)
    expect(allOwnerMounts).toEqual(ownerMounts)
    expect(error.arguments).toHaveLength(2)
    expect(routerMount.arguments).toHaveLength(2)
    const statements = [...setup.body!.statements]
    expect(statements.indexOf(error.parent as ts.Statement))
      .toBe(statements.indexOf(routerMount.parent as ts.Statement) + 1)
  })

  it('closes management admission before the first await and awaits its drain before pool closure', () => {
    const stop = method('stopOnce')
    const statements = [...stop.body!.statements]
    const directVariables = statements.filter(ts.isVariableStatement)
      .flatMap(item => [...item.declarationList.declarations])
    const drain = one(directVariables.filter(item => name(item.name) === 'automationReadManagementDrain'))
    const observe = call(drain.initializer, 'this.observeShutdownTask')
    expect(observe.arguments).toHaveLength(1)
    expect(call(observe.arguments[0], 'this.automationReadManagement.stop').arguments).toHaveLength(0)
    const firstAwait = Math.min(...collect(stop.body!, ts.isAwaitExpression).map(item => item.pos))
    expect(drain.end).toBeLessThan(firstAwait)
    const tasks = one(directVariables.filter(item => name(item.name) === 'shutdownTasks'))
    expect(tasks.initializer && ts.isArrayLiteralExpression(tasks.initializer)).toBe(true)
    expect((tasks.initializer as ts.ArrayLiteralExpression).elements.map(chain)
      .filter(item => item === 'automationReadManagementDrain')).toHaveLength(1)
    const barrier = one(statements.filter(ts.isExpressionStatement)
      .map(item => item.expression).filter(ts.isAwaitExpression)
      .filter(item => ts.isCallExpression(item.expression)
        && chain(item.expression.expression) === 'this.waitForShutdownBarrier'
        && name(item.expression.arguments[0]) === 'shutdownTasks'))
    expect(tasks.end).toBeLessThan(barrier.pos)
    const poolEnd = one(collect(stop, ts.isCallExpression).filter(item => chain(item.expression) === 'pool.end'))
    expect(ts.isAwaitExpression(poolEnd.parent)).toBe(true)
    expect(barrier.end).toBeLessThan(poolEnd.pos)
    // The awaited host barrier actually includes allSettled(tasks), not an unrelated promise.
    const barrierMethod = method('waitForShutdownBarrier')
    const settled = one(collect(barrierMethod, ts.isVariableDeclaration)
      .filter(item => name(item.name) === 'settled'))
    expect(settled.initializer && ts.isCallExpression(settled.initializer)).toBe(true)
    const then = settled.initializer as ts.CallExpression
    expect(ts.isPropertyAccessExpression(then.expression) && then.expression.name.text).toBe('then')
    expect(call((then.expression as ts.PropertyAccessExpression).expression, 'Promise.allSettled')
      .arguments.map(chain)).toEqual(['tasks'])
    const race = one(collect(barrierMethod, ts.isAwaitExpression)
      .filter(item => ts.isCallExpression(item.expression) && chain(item.expression.expression) === 'Promise.race'))
    const raceArray = call(race.expression, 'Promise.race').arguments[0]
    expect(ts.isArrayLiteralExpression(raceArray)).toBe(true)
    expect(name((raceArray as ts.ArrayLiteralExpression).elements[0])).toBe('settled')
  })
})
