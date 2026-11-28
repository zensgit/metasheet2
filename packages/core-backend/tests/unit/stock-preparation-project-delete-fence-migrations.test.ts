import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely'
import { expect, it } from 'vitest'
import { up as scopedFences } from '../../src/db/migrations/zzzz20261128090000_stock_prep_project_delete_scoped_fences'
import { up as businessFences } from '../../src/db/migrations/zzzz20261128090100_stock_prep_project_delete_business_fences'
import { up as runtimeFences } from '../../src/db/migrations/zzzz20261128090200_stock_prep_project_delete_runtime_fences'

it.each([
  { name: 'scoped', up: scopedFences, functionCount: 18 },
  { name: 'business', up: businessFences, functionCount: 18 },
  { name: 'runtime', up: runtimeFences, functionCount: 1 },
])('$name fence migration resolves catalog types before temporary types', async ({ up, functionCount }) => {
  const declarations: string[] = []
  const db = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: database => new PostgresIntrospector(database),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log(event) {
      if (event.level === 'query' && event.query.sql.startsWith('CREATE FUNCTION ')) {
        declarations.push(event.query.sql.split('AS $fn$')[0].replace(/\s+/g, ' ').trim())
      }
    },
  })
  try {
    await up(db)
    expect(declarations).toHaveLength(functionCount)
    for (const declaration of declarations) {
      const paths = [...declaration.matchAll(/\bSET search_path = (.*?)(?= SET |$)/g)].map(match => match[1])
      expect(paths, declaration).toEqual(['pg_catalog, pg_temp'])
    }
  } finally {
    await db.destroy()
  }
})
