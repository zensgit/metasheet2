/**
 * PG 报错守卫的 locale 契约。
 *
 * 背景:PostgreSQL 的报错散文受 `lc_messages` 影响。222 测试机是
 * `Chinese (Simplified)_China.936`,`column "x" does not exist` 在那台机器上是
 * 「字段 x 不存在」,`relation "x" does not exist` 是「关系 "x" 不存在」。
 * 凡是把英文整句当判定条件(尤其是与 SQLSTATE 做 AND)的守卫,在中文 locale 下恒为 false,
 * 本该降级的路径会直接抛出 → 500。
 *
 * 契约(三条):
 *   1. 有 code 时,SQLSTATE 是唯一的种类判据(42P01 缺表 / 42703 缺列),与语言无关;
 *   2. message 只用来核对标识符(表名/列名),标识符对不上就不许降级;
 *   3. 英文散文只在完全没有 code 时兜底(手工构造的错误),并同时认中文译文。
 *
 * 夹具形态沿用 tests/unit/audit-repository-partition.test.ts:75-91(222 实测的中文报错)。
 */
import { describe, expect, test } from 'vitest'

import { isUndefinedColumnError, isUndefinedTableError } from '../../src/utils/database-errors'
import {
  sweepMetaRevisionRetention,
  type MetaRevisionRetentionConfig,
} from '../../src/multitable/meta-revision-retention'
import { loadRecordCreatorMap } from '../../src/multitable/permission-service'

/** 中文 locale 下 PG 的缺表报错。 */
function zhUndefinedTable(tableName: string) {
  return Object.assign(new Error(`关系 "${tableName}" 不存在`), { code: '42P01' })
}

/** 中文 locale 下 PG 的缺列报错。 */
function zhUndefinedColumn(columnName: string) {
  return Object.assign(new Error(`字段 ${columnName} 不存在`), { code: '42703' })
}

function enUndefinedTable(tableName: string) {
  return Object.assign(new Error(`relation "${tableName}" does not exist`), { code: '42P01' })
}

function enUndefinedColumn(columnName: string) {
  return Object.assign(new Error(`column ${columnName} does not exist`), { code: '42703' })
}

describe('utils/database-errors — SQLSTATE 主判的缺表/缺列守卫', () => {
  test('中文 locale:42P01 + 表名 → 命中', () => {
    expect(isUndefinedTableError(zhUndefinedTable('meta_records'), 'meta_records')).toBe(true)
    expect(isUndefinedTableError(zhUndefinedTable('platform_member_groups'), 'platform_member_groups')).toBe(true)
  })

  test('中文 locale:42703 + 列名 → 命中(含限定名)', () => {
    expect(isUndefinedColumnError(zhUndefinedColumn('r.description'), 'r.description')).toBe(true)
    expect(isUndefinedColumnError(zhUndefinedColumn('g.description'), 'g.description')).toBe(true)
    expect(isUndefinedColumnError(zhUndefinedColumn('created_by'), 'created_by')).toBe(true)
    expect(isUndefinedColumnError(zhUndefinedColumn('operation_id'), 'operation_id')).toBe(true)
  })

  test('英文有 code:不回归', () => {
    expect(isUndefinedTableError(enUndefinedTable('meta_links'), 'meta_links')).toBe(true)
    expect(isUndefinedColumnError(enUndefinedColumn('g.name'), 'g.name')).toBe(true)
    // 加引号的限定名(pg 常见形态)
    expect(
      isUndefinedColumnError(Object.assign(new Error('column "g"."name" does not exist'), { code: '42703' }), 'g.name'),
    ).toBe(true)
  })

  test('英文无 code:散文兜底仍然有效(手工构造的错误)', () => {
    expect(isUndefinedTableError(new Error('relation "record_permissions" does not exist'), 'record_permissions')).toBe(true)
    expect(isUndefinedColumnError(new Error('column "created_by" does not exist'), 'created_by')).toBe(true)
  })

  test('中文无 code:散文兜底也认中文译文', () => {
    expect(isUndefinedTableError(new Error('关系 "record_permissions" 不存在'), 'record_permissions')).toBe(true)
    expect(isUndefinedColumnError(new Error('字段 created_by 不存在'), 'created_by')).toBe(true)
  })

  test('标识符对不上 → 不误触发(降级作用域不许扩大)', () => {
    expect(isUndefinedColumnError(zhUndefinedColumn('other_col'), 'r.description')).toBe(false)
    expect(isUndefinedColumnError(enUndefinedColumn('other_col'), 'created_by')).toBe(false)
    expect(isUndefinedTableError(zhUndefinedTable('other_table'), 'platform_member_groups')).toBe(false)
    expect(isUndefinedTableError(new Error('relation "other_table" does not exist'), 'meta_links')).toBe(false)
  })

  test('SQLSTATE 不匹配 → 不误触发(code 存在时不与散文 OR)', () => {
    // 缺列的 code 配缺表的问法,或反过来,都不许互相冒充
    expect(isUndefinedTableError(zhUndefinedColumn('created_by'), 'created_by')).toBe(false)
    expect(isUndefinedColumnError(zhUndefinedTable('meta_records'), 'meta_records')).toBe(false)
    // 唯一约束冲突带着「不存在」字样也不许命中
    expect(
      isUndefinedTableError(Object.assign(new Error('没有为关系"audit_logs"找到分区'), { code: '23514' }), 'audit_logs'),
    ).toBe(false)
    expect(isUndefinedColumnError(Object.assign(new Error('字段 created_by 不存在'), { code: '23505' }), 'created_by')).toBe(false)
  })

  test('毫无关系的错误 → false', () => {
    expect(isUndefinedTableError(new Error('boom'), 'meta_records')).toBe(false)
    expect(isUndefinedColumnError(new Error('boom'), 'created_by')).toBe(false)
    expect(isUndefinedTableError(null, 'meta_records')).toBe(false)
    expect(isUndefinedColumnError(undefined, 'created_by')).toBe(false)
  })
})

describe('meta-revision-retention 清理任务:中文 locale 下仍能降级', () => {
  const config: MetaRevisionRetentionConfig = {
    enabled: true,
    policy: 'keep-last-n',
    keepN: 200,
    retentionDays: 365,
    batchSize: 5000,
  }

  test('pre-migration 缺 operation_id 列(中文报错)→ 降级返回 0,而不是抛错', async () => {
    // 变异探针:把守卫改回 `code === '42703' && message.startsWith('column ')`,
    // 中文 message 不以 'column ' 开头,这条会变成 rejects。
    const query = (async () => {
      throw zhUndefinedColumn('operation_id')
    }) as never
    await expect(sweepMetaRevisionRetention(query, config)).resolves.toBe(0)
  })

  test('缺的是别的列 → 照样抛出(不许把无关错误吞成 0)', async () => {
    const query = (async () => {
      throw zhUndefinedColumn('sheet_id')
    }) as never
    await expect(sweepMetaRevisionRetention(query, config)).rejects.toThrow('字段 sheet_id 不存在')
  })
})

describe('permission-service loadRecordCreatorMap:中文 locale 下仍能降级', () => {
  function failingQuery(err: unknown) {
    return (async () => {
      throw err
    }) as never
  }

  test('pre-migration 缺 created_by 列(中文报错)→ 空 Map', async () => {
    await expect(loadRecordCreatorMap(failingQuery(zhUndefinedColumn('created_by')), 'sheet_1', ['rec_1'])).resolves.toEqual(
      new Map(),
    )
  })

  test('英文无 code 的老夹具不回归', async () => {
    await expect(
      loadRecordCreatorMap(failingQuery(new Error('column "created_by" does not exist')), 'sheet_1', ['rec_1']),
    ).resolves.toEqual(new Map())
  })

  test('缺的是别的列 → 照样抛出', async () => {
    await expect(
      loadRecordCreatorMap(failingQuery(zhUndefinedColumn('data')), 'sheet_1', ['rec_1']),
    ).rejects.toThrow('字段 data 不存在')
  })
})
