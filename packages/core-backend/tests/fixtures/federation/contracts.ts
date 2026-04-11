export const plmContractFixtures = {
  products: [
    {
      id: 'prod-1001',
      name: 'Servo Motor',
      code: 'PN-1001',
      partNumber: 'PN-1001',
      revision: 'B',
      status: 'released',
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-02T00:00:00.000Z',
      itemType: 'Part',
    },
  ],
  bom: [
    {
      id: 'line-1',
      parent_item_id: 'prod-1001',
      component_id: 'comp-1',
      component_code: 'CMP-1',
      component_name: 'Rotor',
      quantity: 2,
      unit: 'EA',
      level: 1,
    },
  ],
  productDetail: {
    id: 'prod-1001',
    name: 'Servo Motor',
    code: 'PN-1001',
    partNumber: 'PN-1001',
    revision: 'B',
    status: 'released',
    created_at: '2026-03-01T00:00:00.000Z',
    updated_at: '2026-03-02T00:00:00.000Z',
    itemType: 'Part',
  },
  productMetadata: {
    id: 'Part',
    label: 'Part',
    is_relationship: false,
    properties: [
      {
        name: 'item_number',
        label: '料号',
        type: 'string',
        required: true,
        length: 64,
        default: null,
      },
      {
        name: 'name',
        label: '名称',
        type: 'string',
        required: false,
        length: 255,
        default: null,
      },
    ],
  },
  releaseReadiness: {
    item_id: 'prod-1001',
    generated_at: '2026-03-05T00:00:00.000Z',
    ruleset_id: 'readiness',
    summary: {
      ok: false,
      resources: 3,
      ok_resources: 2,
      error_count: 1,
      warning_count: 1,
      by_kind: {
        mbom: {
          resources: 1,
          ok_resources: 0,
          error_count: 1,
          warning_count: 0,
        },
      },
    },
    resources: [
      {
        kind: 'mbom',
        name: 'MBOM Alignment',
        state: 'warning',
        diagnostics: {
          ok: false,
          resource_type: 'mbom',
          resource_id: 'mbom-1',
          ruleset_id: 'readiness',
          errors: [{ code: 'MBOM_MISSING', message: 'MBOM baseline missing', severity: 'error' }],
          warnings: [{ code: 'ALT_ROUTE', message: 'Alternate route incomplete', severity: 'warning' }],
        },
      },
    ],
    links: {
      summary: '/api/v1/release-readiness/items/prod-1001?ruleset_id=readiness',
      export: '/api/v1/release-readiness/items/prod-1001/export?export_format=zip&ruleset_id=readiness',
    },
  },
  approvals: [
    {
      id: 'eco-1',
      title: 'ECO-1',
      status: 'pending',
      product_id: 'prod-1001',
      product_number: 'PN-1001',
      requester_id: 'u-1',
      created_at: '2026-03-03T00:00:00.000Z',
    },
  ],
  approvalHistory: [
    {
      id: 'record-1',
      status: 'approved',
      stage: 'review',
      type: 'manual',
      role: 'qa',
      user: 'user-1',
      comment: 'looks good',
      approved_at: '2026-03-04T00:00:00.000Z',
      created_at: '2026-03-03T00:00:00.000Z',
    },
  ],
  whereUsed: {
    item_id: 'comp-1',
    count: 1,
    parents: [
      {
        id: 'rel-1',
        level: 1,
        parent: {
          id: 'prod-parent',
          item_number: 'PARENT-1',
          name: 'Parent Assembly',
        },
        relationship: {
          id: 'rel-1',
          quantity: 2,
          uom: 'EA',
        },
      },
    ],
  },
  bomCompare: {
    summary: {
      added: 1,
      removed: 0,
      changed: 1,
      changed_major: 0,
      changed_minor: 1,
      changed_info: 0,
    },
    added: [{ child_id: 'comp-2' }],
    removed: [],
    changed: [{ child_id: 'comp-1', after: { quantity: 3 } }],
  },
  substituteAdded: {
    ok: true,
    substitute_id: 'sub-1',
    bom_line_id: 'line-1',
    substitute_item_id: 'part-2',
  },
}

export const athenaContractFixtures = {
  documents: [
    {
      id: 'doc-1',
      name: 'Servo Spec.pdf',
      mime_type: 'application/pdf',
      size: 4096,
      version: 'A',
      created_at: '2026-03-01T00:00:00.000Z',
      modified_at: '2026-03-02T00:00:00.000Z',
      locked: false,
    },
  ],
  documentDetail: {
    id: 'doc-1',
    name: 'Servo Spec.pdf',
    mime_type: 'application/pdf',
    size: 4096,
    version: 'A',
    created_at: '2026-03-01T00:00:00.000Z',
    modified_at: '2026-03-02T00:00:00.000Z',
    locked: false,
  },
}
