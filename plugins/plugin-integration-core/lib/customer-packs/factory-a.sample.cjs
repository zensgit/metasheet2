'use strict'

// SAMPLE customer config pack — tests / local development ONLY.
//
// A real deployment's pack is DEPLOY-TIME DATA: it is loaded at install time
// from an uncommitted local file on the tenant's own machine, because the full
// dictionaries (material grades, blank standards, supplier-facing status
// vocabularies) are the customer's data, not ours. Nothing customer-identifying
// belongs in this repository.
//
// What lives here instead is a SHAPE EXEMPLAR: the column names a real
// stock-preparation landing sheet actually carries (旧系统ID / PLM对象ID /
// 父级旧ID / 组件系统版本 / 名称及规格 / 标准 / 毛胚尺寸 / 创建来源), a
// deliberately short material-grade dictionary of the ordinary published
// "牌号 - 材质" form, and the two role bands every 备料 sheet ends up growing
// (生产 vs 采购). It exists so the validator and the installer have something
// realistic to be tested against — not so anyone ships it.
//
// Ownership follows the frozen template's own rule:
//   plm_system      — ids and attributes that a PLM refresh re-derives; a
//                     refresh OVERWRITES these, so a human must never own one
//   human_preserved — what a person fills in on the sheet; preserved across
//                     every PLM refresh (preserveOnRefresh is derived, not
//                     authored)
//
// Every field id carries the reserved `ext_` prefix and is validated against
// the frozen template catalog at normalize time, so none of these can collide
// with a template column — today's or a future one's.

const FACTORY_A_SAMPLE_PACK = {
  packId: 'factory-a',
  packVersion: 1,
  label: 'Factory A stock preparation pack (sample)',

  // ADDITIVE columns on plm_stock_preparation_main. Nothing here redefines,
  // retypes or removes a canonical column.
  extensionFields: [
    // --- legacy / PLM identity: re-derived by every refresh -----------------
    { id: 'ext_legacyRowId', label: '旧系统ID', type: 'string', ownership: 'plm_system' },
    { id: 'ext_plmObjectId', label: 'PLM对象ID', type: 'string', ownership: 'plm_system' },
    { id: 'ext_parentLegacyId', label: '父级旧ID', type: 'string', ownership: 'plm_system' },
    { id: 'ext_componentSystemVersion', label: '组件系统版本', type: 'string', ownership: 'plm_system' },
    { id: 'ext_nameAndSpec', label: '名称及规格', type: 'string', ownership: 'plm_system' },
    { id: 'ext_createdSource', label: '创建来源', type: 'string', ownership: 'plm_system' },
    // Options are NOT authored on the field — they arrive through optionSets.
    { id: 'ext_standard', label: '标准', type: 'select', ownership: 'plm_system' },

    // --- filled on the sheet by 备料/采购: must survive a PLM refresh -------
    { id: 'ext_blankLength', label: '毛胚长度', type: 'number', ownership: 'human_preserved' },
    { id: 'ext_blankWidth', label: '毛胚宽度', type: 'number', ownership: 'human_preserved' },
    { id: 'ext_blankQuantity', label: '毛胚数量', type: 'number', ownership: 'human_preserved' },
  ],

  // Dictionary literals. A production pack's version of this list is long and
  // customer-specific; this one is a dozen ordinary published grades, enough to
  // exercise the normalizer's cap, dedupe and key whitelist.
  optionSets: [
    {
      fieldId: 'ext_standard',
      options: [
        { value: '10 - Q235B' },
        { value: '20 - Q245R' },
        { value: '30 - Q345R' },
        { value: '40 - S30408' },
        { value: '50 - S31603' },
        { value: '60 - S32168' },
        { value: '70 - 16MnDR' },
        { value: '80 - 09MnNiDR' },
        { value: '90 - 20G' },
        { value: '100 - 15CrMoR' },
        { value: '110 - 12Cr1MoVG' },
        { value: '120 - 06Cr19Ni10' },
      ],
    },
  ],

  // Role bands. Column hiding only — a view never filters rows out of a
  // person's reach here, and never changes what anyone is allowed to write.
  roleViews: [
    {
      viewId: 'production',
      label: '生产备料视图',
      // The whole human/procurement band is noise on the shop floor.
      hideOwnerships: ['human_preserved'],
      hideFieldIds: ['lastPlmConflictSummary'],
    },
    {
      viewId: 'procurement',
      label: '采购视图',
      // Procurement works in the human band; the system id columns are the
      // noise here, so they are hidden by name rather than by ownership.
      hideOwnerships: [],
      hideFieldIds: [
        'idempotencyKey',
        'componentSourceId',
        'parentSourceId',
        'path',
        'ext_legacyRowId',
        'ext_plmObjectId',
        'ext_parentLegacyId',
      ],
    },
  ],
}

module.exports = {
  FACTORY_A_SAMPLE_PACK,
}
