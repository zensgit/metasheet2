export function shareSnapshot() {
  const line = {
    bom_line_id: 'RC',
    part_id: 'C',
    item_number: 'C-001',
    name: 'Child',
    state: 'Draft',
    generation: 1,
    quantity: 2,
    uom: 'EA',
    find_num: null,
    refdes: null,
    level: 2,
    path: ['P', 'A'],
    path_labels: ['P', 'A'],
    source_version: 1,
    source_updated_at: null,
    sync_status: 'snapshot',
  }
  return {
    projection_contract: 'bom_review_share.v1',
    feature_key: 'bom_multitable',
    entitled: true,
    upgrade: { available: false },
    source: {
      tenant_id: 't',
      org_id: 'o',
      auth_user_id: '9007199254740999',
      part_id: 'P',
    },
    snapshot_at: '2026-10-01T01:00:00.000000Z',
    context: {
      part: {
        part_id: 'P',
        item_number: 'P',
        name: 'Root',
        state: 'Draft',
        generation: 1,
      },
      lines: ['RA1', 'RA2'].flatMap((id) => [
        {
          ...line,
          bom_line_id: id,
          part_id: 'A',
          level: 1,
          path: ['P'],
          path_labels: ['P'],
        },
        { ...line },
      ]),
      source_version: 1,
      source_updated_at: null,
      sync_status: 'snapshot',
      template_key: 'bom_review',
    },
  }
}
