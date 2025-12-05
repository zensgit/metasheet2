import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SchemaSnapshotService } from '../../src/services/SchemaSnapshotService'

// Mock dependencies
vi.mock('../../src/db/db', () => ({
  db: {
    insertInto: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returningAll: vi.fn().mockReturnThis(),
    executeTakeFirstOrThrow: vi.fn(),
    executeTakeFirst: vi.fn(),
    selectFrom: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    selectAll: vi.fn().mockReturnThis(),
  }
}))

vi.mock('../../src/metrics/metrics', () => ({
  metrics: {
    schemaSnapshotsCreatedTotal: { inc: vi.fn() }
  }
}))

describe('SchemaSnapshotService', () => {
  let service: SchemaSnapshotService
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbMock: any

  beforeEach(async () => {
    vi.clearAllMocks()
    service = new SchemaSnapshotService()
    const { db } = await import('../../src/db/db')
    dbMock = db
  })

  it('should create a schema snapshot', async () => {
    dbMock.executeTakeFirstOrThrow.mockResolvedValue({
      id: 'ss-1',
      schema_version: 'v123'
    })

    const result = await service.createSchemaSnapshot('view-1', 'user-1')

    expect(result.id).toBe('ss-1')
    expect(dbMock.insertInto).toHaveBeenCalledWith('schema_snapshots')
  })

  it('should detect breaking changes in schema diff', async () => {
    const schema1 = {
      fields: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: true }
      ],
      indexes: [],
      relations: []
    }
    const schema2 = {
      fields: [
        { name: 'id', type: 'string', nullable: false }
        // 'title' removed -> breaking change
      ],
      indexes: [],
      relations: []
    }

    // The service casts to SchemaDefinition directly, so return the object not JSON string
    dbMock.executeTakeFirst
      .mockResolvedValueOnce({ id: 'ss-1', schema_definition: schema1 })
      .mockResolvedValueOnce({ id: 'ss-2', schema_definition: schema2 })

    const diff = await service.diffSchemas('ss-1', 'ss-2')

    expect(diff.removedFields).toHaveLength(1)
    expect(diff.removedFields[0].name).toBe('title')
    expect(diff.isBreakingChange).toBe(true)
  })

  it('should detect non-breaking changes', async () => {
    const schema1 = {
      fields: [
        { name: 'id', type: 'string', nullable: false }
      ],
      indexes: [],
      relations: []
    }
    const schema2 = {
      fields: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'new_field', type: 'string', nullable: true }
      ],
      indexes: [],
      relations: []
    }

    // The service casts to SchemaDefinition directly, so return the object not JSON string
    dbMock.executeTakeFirst
      .mockResolvedValueOnce({ id: 'ss-1', schema_definition: schema1 })
      .mockResolvedValueOnce({ id: 'ss-2', schema_definition: schema2 })

    const diff = await service.diffSchemas('ss-1', 'ss-2')

    expect(diff.addedFields).toHaveLength(1)
    expect(diff.isBreakingChange).toBe(false)
  })
})
