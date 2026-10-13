import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildTaskFieldByIdCondition } from '../../src/tasks/task-field-access'

// M5 PR-4a slice 3 (design task-m5-pr4a-backend-design-20261010.md §4.7; ASSUMPTION(task-m5a):
// [a-40]): the field-definition org clause is written once, in the module's private generator.
describe('task-field-access (M5 PR-4a slice 3)', () => {
  it('by id: pinned text and params, the org clause once, only $1 / $2 bound', () => {
    const cond = buildTaskFieldByIdCondition({ fieldIdParam: 'tfld_a', orgParam: 'org1' })
    expect(cond.sql).toBe('(task_fields.org_id = $2) AND task_fields.id = $1')
    expect(cond.params).toEqual(['tfld_a', 'org1'])
    expect(cond.sql.split('task_fields.org_id = $2').length - 1).toBe(1)
    expect(new Set(cond.sql.match(/\$\d+/g))).toEqual(new Set(['$1', '$2']))
  })

  it('the source writes the org column once, in the private generator\'s template literal', () => {
    const source = readFileSync(new URL('../../src/tasks/task-field-access.ts', import.meta.url), 'utf8')
    const lines = source.split('\n').filter((line) => line.includes('task_fields.org_id') && !line.trim().startsWith('*'))
    expect(lines).toHaveLength(1)
    expect(lines[0].trim().startsWith('return `')).toBe(true)
  })
})
