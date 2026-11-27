import { expect } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { whilePaused } from './stock-preparation-project-delete-concurrency-realdb.cases'
import type { ProjectDeleteTestStack } from './stock-preparation-project-delete-realdb.cases'

type Scope = { tenantId: string; projectNo: string; actor: string }
function latch() {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  return { wait, release }
}

export function createRegistryPause(registry: ProjectDeleteTestStack['registry'], scope: Scope) {
  const held = latch(), resume = latch()
  let sheetId = ''
  return {
    held, resume, provisioned: () => sheetId,
    registry: {
      ...registry,
      async create(input: Scope & { sheetId: string }) {
        if (scope.tenantId === input.tenantId && scope.projectNo === input.projectNo) {
          sheetId = input.sheetId
          held.release()
          await resume.wait
        }
        return registry.create(input)
      },
    },
  }
}

export async function exerciseCreateDeleteOrdering(fixture: ProjectDeleteTestStack, scope: Scope,
  pause: ReturnType<typeof createRegistryPause>, create: () => PromiseLike<{ status: number; body: { error?: { code: string } } }>) {
  await fixture.shared(scope)
  const before = await fixture.service.preview(scope)
  const pending = Promise.resolve(create())
  const physical = () => poolManager.get().query('SELECT id FROM meta_sheets WHERE id=$1', [pause.provisioned()])
  const mappings = () => poolManager.get().query('SELECT sheet_id FROM plugin_multitable_object_registry WHERE sheet_id=$1', [pause.provisioned()])
  const blocked = { status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_BUSY' }
  try {
    await Promise.race([pause.held.wait, pending.then(r => { throw Error('create exited before registration: ' + JSON.stringify(r.body)) })])
    expect((await physical()).rowCount).toBe(1)
    expect(await fixture.registry.get(scope)).toBeFalsy()
    await expect(fixture.service.preview(scope)).rejects.toMatchObject(blocked)
    await expect(fixture.service.confirm({ ...scope, ...before })).rejects.toMatchObject(blocked)
  } finally { pause.resume.release(); await pending }
  expect((await pending).status).toBe(201)
  expect((await fixture.registry.get(scope)).sheetId).toBe(pause.provisioned())
  expect((await mappings()).rowCount).toBe(1)
  const preview = await fixture.service.preview(scope)
  await whilePaused(fixture, 'SELECT id FROM meta_records WHERE id = ANY', s => s.confirm({ ...scope, ...preview }), async () => {
    const refused = await create()
    expect([refused.status, refused.body.error?.code]).toEqual([409, blocked.code])
    expect((await physical()).rowCount).toBe(1)
  })
  expect(await fixture.registry.get(scope)).toBeFalsy()
  expect((await physical()).rowCount).toBe(0)
  expect((await mappings()).rowCount).toBe(0)
}
