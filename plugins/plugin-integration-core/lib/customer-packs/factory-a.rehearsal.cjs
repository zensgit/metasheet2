'use strict'

// REHEARSAL customer config pack — tests / install rehearsal ONLY.
//
// factory-a.sample.cjs is a ten-column SHAPE EXEMPLAR: enough to exercise the
// normalizer and the installer, not enough to answer the question the customer
// pack was built to answer — "does ONE config object regenerate the WHOLE
// landing sheet a factory actually works in, and does a PLM refresh over that
// regenerated sheet still leave human work alone?".
//
// This pack is the FULL-SHAPE input to that rehearsal. It is structurally real
// (21 extension columns, the same ownership split, the same two select
// dictionaries a real 备料 sheet carries) and synthetically valued: the column
// set is derived from the real customer sheet's SHAPE, but nothing tenant-
// identifying is committed here. A real deployment still loads its pack as
// deploy-time data from an uncommitted local file.
//
// TOTAL SHAPE the rehearsal proves out:
//   25 frozen canonical columns (stock-preparation-templates.cjs, untouched)
// + 21 pack extension columns (below)
// = 46 logical columns on plm_stock_preparation_main.
//
// Ownership follows the frozen template's own rule and nothing else:
//   plm_system      — re-derived by every PLM refresh; a refresh OVERWRITES
//                     these, so a human must never own one (13 columns here)
//   human_preserved — filled by a person on the sheet; survives every PLM
//                     refresh, because `preserveOnRefresh` is DERIVED from
//                     ownership, never authored (8 columns here)
//
// Every id carries the reserved `ext_` prefix and is validated against the
// frozen template catalog at normalize time, so none of these can collide with
// a canonical column — today's or a future one's.

// The system-id plumbing. Present on the sheet because a refresh needs it to
// find the row again; noise to every human role, so all three role views below
// band it out by name. Kept in ONE list so the three views cannot drift from
// each other, and so "what counts as id noise" is a single reviewable edit.
const ID_NOISE_FIELD_IDS = Object.freeze([
  // canonical plumbing
  'idempotencyKey',
  'componentSourceId',
  'parentSourceId',
  'path',
  'lastPlmRefreshRunId',
  'lastPlmConflictSummary',
  // legacy-system plumbing carried by the pack
  'ext_legacyRowId',
  'ext_parentLegacyId',
  'ext_supplementId',
])

const FACTORY_A_REHEARSAL_PACK = {
  packId: 'factory-a-rehearsal',
  packVersion: 1,
  label: 'Factory A stock preparation pack (full-shape rehearsal)',

  extensionFields: [
    // --- PLM-derived attributes: a refresh re-writes every one of these ------
    { id: 'ext_parentDrawingNo', label: '父组件图号', type: 'string', ownership: 'plm_system' },
    { id: 'ext_parentName', label: '父组件名称', type: 'string', ownership: 'plm_system' },
    { id: 'ext_spec', label: '规格', type: 'string', ownership: 'plm_system' },
    { id: 'ext_nameAndSpec', label: '名称及规格', type: 'string', ownership: 'plm_system' },
    { id: 'ext_standard', label: '标准', type: 'string', ownership: 'plm_system' },
    { id: 'ext_designer', label: '设计者', type: 'string', ownership: 'plm_system' },
    { id: 'ext_createdSource', label: '创建来源', type: 'string', ownership: 'plm_system' },

    // --- legacy-system identity: re-derived, never hand-edited ---------------
    { id: 'ext_legacyRowId', label: '旧系统ID', type: 'string', ownership: 'plm_system' },
    { id: 'ext_parentLegacyId', label: '父级旧ID', type: 'string', ownership: 'plm_system' },
    { id: 'ext_supplementId', label: '补充信息ID', type: 'string', ownership: 'plm_system' },

    // --- BOM ordering: numeric, PLM-owned; the sheet's natural sort ----------
    { id: 'ext_parentSortNo', label: '父组件排序号', type: 'number', ownership: 'plm_system' },
    { id: 'ext_componentSortNo', label: '当前组件排序号', type: 'number', ownership: 'plm_system' },

    // 物料ID. STRING for v1, deliberately NOT `select`.
    //
    // The real dictionary behind this column is 203 entries, and the option-set
    // normalizer caps a select at 200 (MAX_OPTIONS_PER_FIELD,
    // stock-preparation-option-sync.cjs) — so this column CANNOT be carried as
    // an inline dictionary at all, at any pack version. The cap is not the
    // problem to work around; it is the signal that a 203-entry vocabulary is
    // reference data, not field metadata.
    //
    // CARRIER DECISION (open, tracked separately — see the rehearsal report):
    // a dedicated material dictionary SHEET plus a link field, so the
    // vocabulary is a table a customer can maintain, diff and search, instead
    // of 203 option literals re-patched onto a field property on every install.
    // v1 ships the string so the rehearsal is honest about today's shape; the
    // link migration is additive over it.
    { id: 'ext_materialCode', label: '物料ID', type: 'string', ownership: 'plm_system' },

    // --- filled on the sheet by 备料/生产: must survive a PLM refresh --------
    { id: 'ext_stockPrepDate', label: '备料日期', type: 'date', ownership: 'human_preserved' },
    // Options are NOT authored on the field — they arrive through optionSets.
    { id: 'ext_pickingNode', label: '领料节点', type: 'select', ownership: 'human_preserved' },
    { id: 'ext_handoverSection', label: '交接工段', type: 'select', ownership: 'human_preserved' },
    { id: 'ext_blankLength', label: '毛胚长度', type: 'number', ownership: 'human_preserved' },
    { id: 'ext_blankWidth', label: '毛胚宽度', type: 'number', ownership: 'human_preserved' },
    { id: 'ext_blankThickness', label: '毛胚厚度', type: 'number', ownership: 'human_preserved' },
    { id: 'ext_blankQuantity', label: '毛胚数量', type: 'number', ownership: 'human_preserved' },
    { id: 'ext_blankMass', label: '毛胚质量', type: 'number', ownership: 'human_preserved' },
  ],

  // Dictionary literals for every select on the sheet — the pack's own two AND
  // the three frozen canonical selects.
  //
  // The canonical three are here because `normalizeCustomerPack` resolves an
  // optionSet against the FULL catalog (template fields + pack fields) and only
  // requires `type === 'select'`, and the installer keeps the TEMPLATE's own
  // declared `optionSource` for them (resolveOptionSource) rather than
  // re-labelling the column's dictionary origin. Leaving them out would have
  // regenerated a landing sheet whose 材质 / 毛胚类型 / 备料状态 dropdowns are
  // empty — which is not the full shape.
  optionSets: [
    {
      // 领料节点 — the production node that draws the material. Real vocabulary
      // shape: the published "编号 - 名称" form the shop floor already reads.
      fieldId: 'ext_pickingNode',
      options: [
        { value: '48 - 主体焊接' },
        { value: '124 - 接管' },
        { value: '125 - 监检' },
        { value: '126 - 包皮' },
        { value: '127 - 装配' },
        { value: '128 - 发货' },
      ],
    },
    {
      // 交接工段 — the section the part is handed over to. Includes the
      // 历史值 bucket the real sheet carries for rows migrated from the old
      // system; dropping it would strand those rows on an invalid option.
      fieldId: 'ext_handoverSection',
      options: [
        { value: '53 - 主体' },
        { value: '54 - 非标' },
        { value: '55 - 总装' },
        { value: '56 - 零部件' },
        { value: '57 - 机加工' },
        { value: '59 - 钣金' },
        { value: '60 - 电工' },
        { value: '61 - 抛光' },
        { value: '158 - MVR' },
        { value: '163 - 外协' },
        { value: '206 - 售后' },
        { value: '257 - 制管' },
        { value: '290 - 下罐体' },
        { value: '304 - 大机加' },
        { value: '58 - 历史值' },
      ],
    },
    {
      // Canonical select — ordinary published pressure-vessel grades.
      fieldId: 'materialType',
      options: [
        { value: '10 - Q235B' },
        { value: '20 - Q245R' },
        { value: '30 - Q345R' },
        { value: '40 - S30408' },
        { value: '50 - S31603' },
        { value: '60 - 16MnDR' },
      ],
    },
    {
      // Canonical select — the blank forms a 备料 sheet actually orders in.
      fieldId: 'blankType',
      options: [
        { value: '10 - 板材' },
        { value: '20 - 管材' },
        { value: '30 - 棒材' },
        { value: '40 - 锻件' },
        { value: '50 - 型材' },
        { value: '60 - 外购件' },
      ],
    },
    {
      // Canonical select — the status band 生产/采购/仓库 all read.
      fieldId: 'stockPreparationStatus',
      options: [
        { value: '10 - 待备料' },
        { value: '20 - 已下单' },
        { value: '30 - 已到货' },
        { value: '40 - 已领用' },
        { value: '50 - 暂缓' },
      ],
    },
  ],

  // Role bands. Column hiding ONLY — a view never filters rows out of anyone's
  // reach and never changes what anyone is allowed to write.
  //
  // All three use `hideOwnerships: []` and hide by NAME. Banding a whole
  // ownership out would be the wrong tool on this sheet: every role here both
  // reads PLM columns and writes human ones, so an ownership band would always
  // hide either the row's identity or the role's own work surface. Ownership is
  // the REFRESH boundary; it is not the visibility boundary.
  roleViews: [
    {
      viewId: 'production',
      label: '生产备料视图',
      // Production FILLS 备料日期 / 领料节点 / 交接工段 / 毛胚*, so the human
      // band must stay visible. Only the id plumbing is noise here.
      hideOwnerships: [],
      hideFieldIds: [...ID_NOISE_FIELD_IDS],
    },
    {
      viewId: 'procurement',
      label: '采购跟进视图',
      // Procurement works the demand/lead-time/reply columns and needs the
      // material identity to place an order. Shop-floor geometry (毛胚 sizing,
      // 领料节点, 交接工段) and BOM ordering are somebody else's columns —
      // hidden so the follow-up view stays narrow enough to scan.
      hideOwnerships: [],
      hideFieldIds: [
        ...ID_NOISE_FIELD_IDS,
        'depth',
        'rawQuantity',
        'warehouseConfirmation',
        'ext_parentSortNo',
        'ext_componentSortNo',
        'ext_pickingNode',
        'ext_handoverSection',
        'ext_blankLength',
        'ext_blankWidth',
        'ext_blankThickness',
        'ext_blankMass',
      ],
    },
    {
      viewId: 'warehouse',
      label: '仓库跟进视图',
      // The warehouse confirms receipt and issues material: it needs identity,
      // quantity, status, dates and the handover/picking nodes. Design metadata
      // and the procurement conversation are not its columns.
      hideOwnerships: [],
      hideFieldIds: [
        ...ID_NOISE_FIELD_IDS,
        'depth',
        'rawQuantity',
        'leadTimeDays',
        'procurementReply',
        'ext_designer',
        'ext_createdSource',
        'ext_standard',
        'ext_parentDrawingNo',
        'ext_parentName',
        'ext_parentSortNo',
        'ext_componentSortNo',
      ],
    },
  ],
}

module.exports = {
  ID_NOISE_FIELD_IDS,
  FACTORY_A_REHEARSAL_PACK,
}
