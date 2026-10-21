import { describe, expect, it } from 'vitest'

import { approvalCcTabConditionSql, approvalCcTargetMatchSql } from '../../src/services/approval-cc-predicate'

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim()

describe('抄送我的 predicate builder (approval-cc-predicate.ts)', () => {
  it('user + role arms bind exactly the two placeholders handed in', () => {
    const sql = normalize(approvalCcTargetMatchSql({ actorParam: 3, rolesParam: 7 }))
    expect(sql).toBe(
      "( (metadata->>'targetType' = 'user' AND metadata->>'targetId' = $3) "
      + "OR (metadata->>'targetType' = 'role' AND metadata->>'targetId' = ANY($7)) )",
    )
  })

  it('rolesParam null is the user-only shape the PLM-source tab has always used (no role arm at all)', () => {
    const sql = normalize(approvalCcTargetMatchSql({ actorParam: 2, rolesParam: null }))
    expect(sql).toBe("(metadata->>'targetType' = 'user' AND metadata->>'targetId' = $2)")
    expect(sql).not.toContain("'role'")
  })

  it('an alias qualifies every metadata reference (correlated use)', () => {
    const sql = normalize(approvalCcTargetMatchSql({ actorParam: 1, rolesParam: 2 }, 'cc_rec'))
    expect(sql).toContain("cc_rec.metadata->>'targetType' = 'user' AND cc_rec.metadata->>'targetId' = $1")
    expect(sql).toContain("cc_rec.metadata->>'targetType' = 'role' AND cc_rec.metadata->>'targetId' = ANY($2)")
    expect(sql.replace(/cc_rec\.metadata/g, '')).not.toContain('metadata')
  })

  it('the tab condition is an approval_instances id-membership over CC rows', () => {
    const sql = normalize(approvalCcTabConditionSql({ actorParam: 4, rolesParam: 5 }))
    expect(sql).toBe(
      "id IN ( SELECT instance_id FROM approval_records WHERE action = 'cc' AND "
      + "( (metadata->>'targetType' = 'user' AND metadata->>'targetId' = $4) "
      + "OR (metadata->>'targetType' = 'role' AND metadata->>'targetId' = ANY($5)) ) )",
    )
  })
})
