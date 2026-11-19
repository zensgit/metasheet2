import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { listFiles, SOURCE_EXTENSIONS } from '../helpers/authorization-input-scan'
import { AUTHORIZATION_SCHEMA_MUTATION_CALLERS, runAuthorizationSchemaMutation } from '../../src/rbac/authorization-input-lock'

describe('authorization schema mutation entry', () => {
  it('registers exactly the core migration provider', () => {
    expect(AUTHORIZATION_SCHEMA_MUTATION_CALLERS).toEqual({ core_migration_provider: 'packages/core-backend/src/db/migration-provider.ts' })
  })
  it('refuses a regular Kysely executor before invoking work or acquiring a connection', async () => {
    const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new Pool({ connectionTimeoutMillis: 100 }) }) })
    let called = false
    try {
      await expect(runAuthorizationSchemaMutation(db as never, async () => { called = true }, { caller: 'core_migration_provider' })).rejects.toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID' })
      expect(called).toBe(false)
    } finally { await db.destroy() }
  })
  it('rejects missing, unknown, and non-closed callers before SQL or work', async () => {
    for (const options of [null, {}, { caller: 'other' }, { caller: 'core_migration_provider', extra: true }]) {
      let called = false
      const tx = { isTransaction: true } as never
      await expect(runAuthorizationSchemaMutation(tx, async () => { called = true }, options as never)).rejects.toMatchObject({ code: 'AUTHORIZATION_INPUT_PLAN_INVALID' })
      expect(called).toBe(false)
    }
  })
  it('keeps every production schema-gate call inside the registered provider', () => {
    const root=path.resolve(__dirname,'..','..','..','..')
    const files=listFiles(root,{roots:['packages/core-backend/src','plugins'],exclude:[]}).filter(file=>SOURCE_EXTENSIONS.has(path.extname(file)))
    const calls:Array<{file:string; caller:string}> = []
    for(const file of files) {
      const text=fs.readFileSync(path.join(root,file),'utf8')
      if(!text.includes('runAuthorizationSchemaMutation')) continue
      const tree=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true)
      const names=new Set(['runAuthorizationSchemaMutation'])
      for(const statement of tree.statements) if(ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
        for(const element of statement.importClause.namedBindings.elements) if((element.propertyName ?? element.name).text==='runAuthorizationSchemaMutation') names.add(element.name.text)
      }
      const visit=(node:ts.Node) => {
        if(ts.isCallExpression(node) && ((ts.isIdentifier(node.expression) && names.has(node.expression.text)) || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text==='runAuthorizationSchemaMutation'))) {
          const options=node.arguments[2]
          const caller=options && ts.isObjectLiteralExpression(options) ? options.properties.find(property=>ts.isPropertyAssignment(property) && property.name.getText(tree)==='caller') : undefined
          calls.push({file,caller:caller && ts.isPropertyAssignment(caller) && ts.isStringLiteral(caller.initializer) ? caller.initializer.text : ''})
        }
        ts.forEachChild(node,visit)
      }
      visit(tree)
    }
    expect(calls).toEqual([
      {file:AUTHORIZATION_SCHEMA_MUTATION_CALLERS.core_migration_provider,caller:'core_migration_provider'},
      {file:AUTHORIZATION_SCHEMA_MUTATION_CALLERS.core_migration_provider,caller:'core_migration_provider'},
    ])
  })

})
