'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  createErpFeedbackWriter,
  createMultitableFeedbackWriter,
  ErpFeedbackError,
  normalizeFeedbackItems,
} = require(path.join(__dirname, '..', 'lib', 'erp-feedback.cjs'))

const cleanRecords = [
  {
    sourceRecord: { id: 'src_1', code: 'MAT-001' },
    targetRecord: {
      _integration_idempotency_key: 'idem_1',
      FNumber: 'MAT-001',
      FName: 'Bolt',
    },
  },
  {
    sourceRecord: { id: 'src_2', code: 'MAT-002' },
    targetRecord: {
      _integration_idempotency_key: 'idem_2',
      FNumber: 'MAT-002',
      FName: 'Nut',
    },
  },
]

function fixedClock() {
  return '2026-04-24T12:00:00.000Z'
}

async function testNormalizeFeedbackItems() {
  const items = normalizeFeedbackItems({
    cleanRecords,
    clock: fixedClock,
    pipeline: {
      id: 'pipe_1',
      targetObject: 'BD_MATERIAL',
      options: {},
    },
    writeResult: {
      results: [
        {
          key: 'idem_2',
          externalId: 'k3_item_2',
          billNo: 'K3-BILL-002',
          responseCode: '0',
          responseMessage: 'saved',
        },
        {
          key: 'idem_1',
          materialId: 'k3_item_1',
          number: 'K3-BILL-001',
        },
      ],
      errors: [
        {
          key: 'idem_missing',
          code: 'K3_FAIL',
          message: 'not matched',
        },
      ],
    },
  })

  assert.equal(items.length, 2, 'unmatched target errors are not written to staging')
  assert.equal(items[0].key, 'idem_2', 'matches by explicit key before result order')
  assert.equal(items[0].fields.erpSyncStatus, 'synced')
  assert.equal(items[0].fields.erpExternalId, 'k3_item_2')
  assert.equal(items[0].fields.erpBillNo, 'K3-BILL-002')
  assert.equal(items[0].fields.erpResponseCode, '0')
  assert.equal(items[0].fields.erpResponseMessage, 'saved')
  assert.equal(items[0].fields.lastSyncedAt, '2026-04-24T12:00:00.000Z')
  assert.equal(items[1].fields.erpExternalId, 'k3_item_1')
  assert.equal(items[1].fields.erpBillNo, 'K3-BILL-001')

  const failures = normalizeFeedbackItems({
    cleanRecords,
    clock: fixedClock,
    pipeline: {},
    writeResult: {
      results: [],
      errors: [
        {
          index: 1,
          code: 'K3_VALIDATION_FAILED',
          message: 'unit missing',
        },
      ],
    },
  })
  assert.equal(failures.length, 1)
  assert.equal(failures[0].key, 'idem_2')
  assert.equal(failures[0].fields.erpSyncStatus, 'failed')
  assert.equal(failures[0].fields.erpExternalId, null)
  assert.equal(failures[0].fields.erpResponseCode, 'K3_VALIDATION_FAILED')
  assert.equal(failures[0].fields.erpResponseMessage, 'unit missing')

  const aggregateFailure = normalizeFeedbackItems({
    cleanRecords,
    clock: fixedClock,
    pipeline: {},
    writeResult: {
      written: 0,
      failed: 1,
      results: [],
      errors: [],
    },
  })
  assert.equal(aggregateFailure.length, 0, 'aggregate target failures are not bound to an arbitrary staging row')

  const snakeCase = normalizeFeedbackItems({
    cleanRecords,
    clock: fixedClock,
    pipeline: {
      options: {
        erpFeedback: {
          fieldMap: {
            status: 'erp_sync_status',
            externalId: 'erp_material_id',
            billNo: 'erp_bill_no',
            responseCode: 'erp_response_code',
            responseMessage: 'erp_response_message',
            syncedAt: 'last_synced_at',
          },
        },
      },
    },
    writeResult: {
      results: [{ key: 'idem_1', externalId: 'mat_1', billNo: 'bill_1' }],
    },
  })
  assert.equal(snakeCase[0].fields.erp_sync_status, 'synced')
  assert.equal(snakeCase[0].fields.erp_material_id, 'mat_1')
  assert.equal(snakeCase[0].fields.erp_bill_no, 'bill_1')
  assert.equal(snakeCase[0].fields.last_synced_at, '2026-04-24T12:00:00.000Z')

  const customKeyField = normalizeFeedbackItems({
    cleanRecords,
    clock: fixedClock,
    pipeline: {
      options: {
        erpFeedback: {
          keyField: 'FNumber',
        },
      },
    },
    writeResult: {
      results: [{ key: 'idem_2', externalId: 'mat_2', billNo: 'bill_2' }],
    },
  })
  assert.equal(customKeyField.length, 1)
  assert.equal(customKeyField[0].key, 'MAT-002', 'configured keyField wins over adapter idempotency key')

  const k3RawEntity = normalizeFeedbackItems({
    cleanRecords,
    clock: fixedClock,
    pipeline: {},
    writeResult: {
      results: [
        {
          key: 'idem_1',
          raw: {
            Result: {
              ResponseStatus: {
                SuccessEntitys: [{ Id: '5001', Number: 'MAT-001' }],
              },
            },
          },
        },
      ],
    },
  })
  assert.equal(k3RawEntity[0].fields.erpExternalId, '5001')
  assert.equal(k3RawEntity[0].fields.erpBillNo, 'MAT-001')

  const k3RawNumberOnly = normalizeFeedbackItems({
    cleanRecords,
    clock: fixedClock,
    pipeline: {},
    writeResult: {
      results: [
        {
          key: 'idem_1',
          raw: {
            Result: {
              ResponseStatus: {
                SuccessEntitys: [{ Number: 'MAT-001' }],
              },
            },
          },
        },
      ],
    },
  })
  assert.equal(k3RawNumberOnly[0].fields.erpExternalId, null, 'K3 Number is not reused as external id')
  assert.equal(k3RawNumberOnly[0].fields.erpBillNo, 'MAT-001')

  for (const enabled of ['false', '否', 0]) {
    const disabledItems = normalizeFeedbackItems({
      cleanRecords,
      clock: fixedClock,
      pipeline: {
        options: {
          erpFeedback: {
            enabled,
          },
        },
      },
      writeResult: {
        results: [{ key: 'idem_1', externalId: 'mat_1' }],
      },
    })
    assert.deepEqual(disabledItems, [], `erpFeedback.enabled=${JSON.stringify(enabled)} disables feedback items`)
  }

  assert.throws(() => normalizeFeedbackItems({
    cleanRecords,
    pipeline: {
      options: {
        erpFeedback: {
          enabled: 'maybe',
        },
      },
    },
    writeResult: {
      results: [{ key: 'idem_1', externalId: 'mat_1' }],
    },
  }), ErpFeedbackError)
}

async function testWriterBoundary() {
  const calls = []
  const writer = createErpFeedbackWriter({
    clock: fixedClock,
    stagingWriter: {
      async updateRecords(input) {
        calls.push(input)
        return { ok: true, written: input.updates.length, patched: input.updates.length, created: 0 }
      },
    },
  })

  const result = await writer.writeBack({
    tenantId: 'tenant_1',
    workspaceId: null,
    runId: 'run_1',
    pipeline: {
      id: 'pipe_1',
      projectId: 'project_1',
      targetObject: 'BD_MATERIAL',
      options: {
        erpFeedback: {
          keyField: '_integration_idempotency_key',
        },
      },
    },
    cleanRecords,
    writeResult: {
      results: [{ key: 'idem_1', externalId: 'mat_1', billNo: 'bill_1' }],
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, false)
  assert.equal(result.objectId, 'standard_materials')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].projectId, 'project_1')
  assert.equal(calls[0].objectId, 'standard_materials')
  assert.equal(calls[0].keyField, '_integration_idempotency_key')
  assert.equal(calls[0].updates[0].key, 'idem_1')
  assert.equal(calls[0].updates[0].fields.erpSyncStatus, 'synced')

  const disabled = await writer.writeBack({
    pipeline: {
      options: {
        erpFeedback: {
          enabled: false,
        },
      },
    },
    cleanRecords,
    writeResult: {
      results: [{ key: 'idem_1' }],
    },
  })
  assert.equal(disabled.skipped, true)
  assert.equal(disabled.reason, 'ERP_FEEDBACK_DISABLED')

  const disabledByString = await writer.writeBack({
    pipeline: {
      options: {
        erpFeedback: {
          enabled: '否',
        },
      },
    },
    cleanRecords,
    writeResult: {
      results: [{ key: 'idem_1' }],
    },
  })
  assert.equal(disabledByString.skipped, true)
  assert.equal(disabledByString.reason, 'ERP_FEEDBACK_DISABLED')

  const missingTarget = await writer.writeBack({
    pipeline: {
      targetObject: 'unknown',
    },
    cleanRecords,
    writeResult: {
      results: [{ key: 'idem_1' }],
    },
  })
  assert.equal(missingTarget.skipped, true)
  assert.equal(missingTarget.reason, 'ERP_FEEDBACK_TARGET_MISSING')

  const failingWriter = createErpFeedbackWriter({
    clock: fixedClock,
    stagingWriter: {
      async updateRecords() {
        throw new Error('staging writer failed')
      },
    },
  })

  const nonThrowingFailure = await failingWriter.writeBack({
    pipeline: {
      projectId: 'project_1',
      targetObject: 'BD_MATERIAL',
      options: {
        erpFeedback: {
          failOnError: 'false',
        },
      },
    },
    cleanRecords,
    writeResult: {
      results: [{ key: 'idem_1', externalId: 'mat_1' }],
    },
  })
  assert.equal(nonThrowingFailure.ok, false)
  assert.equal(nonThrowingFailure.reason, 'ERP_FEEDBACK_WRITE_FAILED')

  for (const failOnError of ['true', '是', 1]) {
    await assert.rejects(() => failingWriter.writeBack({
      pipeline: {
        projectId: 'project_1',
        targetObject: 'BD_MATERIAL',
        options: {
          erpFeedback: {
            failOnError,
          },
        },
      },
      cleanRecords,
      writeResult: {
        results: [{ key: 'idem_1', externalId: 'mat_1' }],
      },
    }), /staging writer failed/)
  }
}

async function testMultitableWriter() {
  const patched = []
  const created = []
  const context = {
    api: {
      multitable: {
        provisioning: {
          async findObjectSheet(input) {
            assert.deepEqual(input, { projectId: 'project_1', objectId: 'standard_materials' })
            return { id: 'sheet_materials', baseId: null, name: 'Materials' }
          },
          async resolveFieldIds(input) {
            assert.equal(input.projectId, 'project_1')
            assert.equal(input.objectId, 'standard_materials')
            return Object.fromEntries(input.fieldIds.map((fieldId) => [`${fieldId}`, `fld_${fieldId}`]))
          },
        },
        records: {
          async queryRecords(input) {
            assert.equal(input.sheetId, 'sheet_materials')
            if (input.filters.fld__integration_idempotency_key === 'idem_existing') {
              return [{ id: 'rec_existing', sheetId: 'sheet_materials', version: 1, data: {} }]
            }
            return []
          },
          async patchRecord(input) {
            patched.push(input)
            return { id: input.recordId, sheetId: input.sheetId, version: 2, data: input.changes }
          },
          async createRecord(input) {
            created.push(input)
            return { id: `rec_${created.length}`, sheetId: input.sheetId, version: 1, data: input.data }
          },
        },
      },
    },
  }
  const writer = createMultitableFeedbackWriter({ context })
  const result = await writer.updateRecords({
    projectId: 'project_1',
    objectId: 'standard_materials',
    keyField: '_integration_idempotency_key',
    updates: [
      {
        key: 'idem_existing',
        fields: {
          erpSyncStatus: 'synced',
          erpBillNo: 'bill_1',
        },
      },
      {
        key: 'idem_new',
        fields: {
          erpSyncStatus: 'failed',
          erpResponseMessage: 'bad unit',
        },
      },
    ],
  })
  assert.equal(result.written, 2)
  assert.equal(result.patched, 1)
  assert.equal(result.created, 1)
  assert.equal(patched[0].recordId, 'rec_existing')
  assert.equal(patched[0].changes.fld_erpSyncStatus, 'synced')
  assert.equal(created[0].data.fld__integration_idempotency_key, 'idem_new')
  assert.equal(created[0].data.fld_erpResponseMessage, 'bad unit')

  const scanOnlyWriter = createMultitableFeedbackWriter({
    context: {
      api: {
        multitable: {
          provisioning: context.api.multitable.provisioning,
          records: {
            async listRecords() {
              throw new Error('listRecords must not be used for feedback lookup')
            },
            async patchRecord() {},
            async createRecord() {},
          },
        },
      },
    },
  })
  assert.equal(scanOnlyWriter, null, 'feedback writer requires reliable queryRecords lookup')
}

async function main() {
  await testNormalizeFeedbackItems()
  await testWriterBoundary()
  await testMultitableWriter()
  console.log('✓ erp-feedback: normalize + writer tests passed')
}

main().catch((err) => {
  console.error('✗ erp-feedback FAILED')
  console.error(err)
  process.exit(1)
})
