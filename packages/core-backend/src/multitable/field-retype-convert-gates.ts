/**
 * 字段类型转换 —— 门 ③ ④ ⑤ 的**唯一**判定（预览 / 执行 / 撤销三个端点共用）。
 * 设计锁：docs/development/multitable-field-retype-first-batch-adr-20260926.md §2「门」与文末「增补 B」。
 *
 * ── 为什么要收成一个函数 ───────────────────────────────────────────────────────────────────────────────
 * 三个端点各抄一份门，抄的时候最容易丢的就是 ⑤ 里的 `canRead`。`canManageFields` 单凭 `multitable:manage-schema`
 * 即可为真，与 `canRead` 无关；少了 `canRead`，一个只有改结构权、读不了本表的主体会过全部五门：预览把每条记录的 id
 * 交给他，执行让他改写一整列他读不了的数据。⑤ 的完整定义是 **`canRead` 且全表读**，写在这里，只写一次。
 *
 * 这一条是**纵深防御，不是唯一防线**：回调通常是路由的 `hasFullTableReadAccess`，它自 #6147 起自己也先查 `canRead`
 * （此前只看行级拒读、字段遮罩、公式遮罩三个轴）。本函数**不依赖**回调里的那次检查——回调是调用方给的，换一个实现、
 * 或者那边的检查被重构掉，这里的判定都不该变。单测用恒真的回调钉住这一行：路由级测试钉不住它，因为真回调会替它拒。
 *
 * ── 顺序锁定 ───────────────────────────────────────────────────────────────────────────────────────────
 * ③ 先于 ④：没有改结构权的人不该从「404 还是 403」里得知这张表是否还在。④ 先于 ⑤：全表读判定要读本表的字段与
 * 权限行，死表上不读。`hasFullTableReadAccess` 以惰性回调传入，前两门不过时**不会**被调用。
 *
 * 本模块是纯判定：不碰 req / res、不发 SQL（SQL 在回调里），调用方决定怎么应答。事务外（凭请求里的能力）与事务内
 * （栅栏之后、从数据库重新解析的能力）用的是同一个函数——两处不可能各有各的口径。
 */
import type { SheetLiveness } from './sheet-liveness'

/** 判定只读这两个能力位；传整个 capabilities 对象即可。 */
export interface FieldRetypeConvertGateCapabilities {
  canManageFields: boolean
  canRead: boolean
}

export type FieldRetypeConvertGateRefusal =
  | { gate: 3; kind: 'forbidden' }
  | { gate: 4; kind: 'not_live'; sheetLiveness: Exclude<SheetLiveness, 'live'> }
  | { gate: 5; kind: 'full_table_read_required' }

export const FIELD_RETYPE_FULL_TABLE_READ_REQUIRED_CODE = 'FULL_TABLE_READ_REQUIRED'
export const FIELD_RETYPE_FULL_TABLE_READ_REQUIRED_MESSAGE =
  'A field type conversion requires unrestricted read access to every record and field of this sheet.'

export async function judgeFieldRetypeConvertGates(input: {
  capabilities: FieldRetypeConvertGateCapabilities
  sheetLiveness: SheetLiveness
  /**
   * The caller's full-table read check (the route's `hasFullTableReadAccess`: read on the sheet, then row-level
   * deny, field mask, formula taint). Called only after ③ and ④ pass AND `canRead` is true — this function does
   * not rely on the callback looking at `canRead` itself.
   */
  hasFullTableReadAccess: () => Promise<boolean>
}): Promise<FieldRetypeConvertGateRefusal | null> {
  // ③ schema authority — the PATCH /fields/:fieldId gate.
  if (input.capabilities.canManageFields !== true) return { gate: 3, kind: 'forbidden' }
  // ④ liveness — a dead sheet keeps its capabilities; the caller must answer 404.
  if (input.sheetLiveness !== 'live') return { gate: 4, kind: 'not_live', sheetLiveness: input.sheetLiveness }
  // ⑤ canRead AND full-table read — whole-surface refusal, no scoped mode, no undisclosed marker.
  if (input.capabilities.canRead !== true) return { gate: 5, kind: 'full_table_read_required' }
  if (!(await input.hasFullTableReadAccess())) return { gate: 5, kind: 'full_table_read_required' }
  return null
}
