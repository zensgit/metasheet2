import assert from 'node:assert/strict'
import test from 'node:test'

import {
  sanitizeReportJson,
  sanitizeMarkdown,
  valueIsProvablySafe,
} from './sanitize-smoke-report.mjs'

const REDACTION = '[REDACTED]'

function sanitize(report) {
  const { output, ...rest } = sanitizeReportJson(JSON.stringify(report))
  return { json: JSON.parse(output), ...rest }
}

test('redacts business values stored under dynamic field-ID keys (the v1 leak)', () => {
  const { json } = sanitize({
    checks: [{
      name: 'ui.import.people-repair',
      ok: false,
      fieldId: 'fld_pilot_owner',
      fld_pilot_owner: 'Alice Customer',
      fld_title: 'ACME order 123',
      fld_amount: 50000,
    }],
  })
  const c = json.checks[0]
  assert.equal(c.fld_pilot_owner, REDACTION, 'string cell value under fld_ key')
  assert.equal(c.fld_title, REDACTION)
  assert.equal(c.fld_amount, REDACTION, 'numeric cell value under fld_ key must also be redacted')
  assert.equal(c.fieldId, 'fld_pilot_owner', 'fieldId metadata key keeps its opaque-ID value')
})

test('redacts future busy-save diagnostic fields by default-deny', () => {
  const { json } = sanitize({
    checks: [{
      name: 'api.embed-host.persisted-busy-form-save',
      ok: false,
      recordId: 'rec_001',
      expectedTitle: 'ACME order 123 busy-save',
      persistedTitle: 'ACME order 123',
      inputValueBeforeClick: 'ACME order 123 busy-save',
      requestBody: { data: { fld_title: 'ACME order 123 busy-save' } },
      responseBody: { record: { data: { fld_title: 'ACME order 123' } } },
      recordVersionBefore: 7,
      recordVersionAfter: 8,
    }],
  })
  const c = json.checks[0]
  assert.equal(c.expectedTitle, REDACTION)
  assert.equal(c.persistedTitle, REDACTION)
  assert.equal(c.inputValueBeforeClick, REDACTION)
  assert.ok(c.requestBody && c.requestBody[REDACTION] === true, 'requestBody object subtree dropped')
  assert.ok(c.responseBody && c.responseBody[REDACTION] === true, 'responseBody object subtree dropped')
  // numeric version counters are not customer data and stay useful for triage
  assert.equal(c.recordVersionBefore, 7)
  assert.equal(c.recordVersionAfter, 8)
})

test('drops nested record/data/payload subtrees including CJK content', () => {
  const { json } = sanitize({
    checks: [{
      name: 'x',
      ok: false,
      record: { data: { fld_x: '客户张三' } },
      createRecordPayload: { data: { title: 'ACME' } },
    }],
  })
  const c = json.checks[0]
  assert.ok(c.record[REDACTION] === true)
  assert.ok(c.createRecordPayload[REDACTION] === true)
})

test('keeps triage signals: check name/ok, opaque IDs, enums, status codes', () => {
  const { json } = sanitize({
    checks: [{
      name: 'ui.timeline.config-replay',
      ok: false,
      baseId: 'bas_pilot01',
      viewId: 'viw_tl01',
      labelValue: 'fld_pilot_owner',
      zoomValue: 'month',
      configTypeBeforeReload: 'attachment',
      reconcilePath: 'warning',
      createRecordStatus: 422,
      pickerButtonsAfterReconcile: 0,
      applyDisabledBeforeReconcile: true,
    }],
  })
  const c = json.checks[0]
  assert.equal(c.name, 'ui.timeline.config-replay')
  assert.equal(c.ok, false)
  assert.equal(c.baseId, 'bas_pilot01')
  assert.equal(c.viewId, 'viw_tl01')
  assert.equal(c.labelValue, 'fld_pilot_owner', 'safe field-ID value kept (replay signal)')
  assert.equal(c.zoomValue, 'month', 'whitelisted enum kept (replay signal)')
  assert.equal(c.configTypeBeforeReload, 'attachment')
  assert.equal(c.reconcilePath, 'warning')
  assert.equal(c.createRecordStatus, 422)
  assert.equal(c.pickerButtonsAfterReconcile, 0)
  assert.equal(c.applyDisabledBeforeReconcile, true)
})

test('scrubs IP / email / home-path / JWT in retained config strings', () => {
  const { json } = sanitize({
    apiBase: 'http://192.168.1.222',
    webBase: 'http://192.168.1.222',
    outputDir: '/Users/someone/repo/output',
    checks: [{ name: 'api.login-token', ok: true, source: 'login' }],
  })
  assert.equal(json.apiBase, 'http://[IP]')
  assert.equal(json.webBase, 'http://[IP]')
  assert.equal(json.outputDir, '/[USER]/repo/output')
  assert.equal(json.checks[0].source, 'login', 'config/structural key value kept')
})

test('a clean report reports clean and leaks nothing', () => {
  const res = sanitize({
    apiBase: 'http://192.168.1.222',
    checks: [{ name: 'x', ok: false, fld_owner: 'Alice Customer', viewId: 'viw_1' }],
  })
  assert.equal(res.clean, true)
  assert.equal(res.patternHits.length, 0)
  assert.equal(res.structHits.length, 0)
  const text = JSON.stringify(res.json)
  for (const leak of ['192.168', 'Alice', 'Customer']) {
    assert.ok(!text.includes(leak), `must not leak "${leak}"`)
  }
})

test('residual free-text detector fires when a leak is injected post-sanitize', () => {
  // Direct unit of the detector via the export: a string with a space under a
  // non-config key that survived would be flagged. We simulate by sanitizing a
  // value the model treats as safe-enum, then assert a free-text value is NOT
  // considered safe.
  assert.equal(valueIsProvablySafe('month'), true)
  assert.equal(valueIsProvablySafe('fld_x'), true)
  assert.equal(valueIsProvablySafe('Alice Customer'), false)
  assert.equal(valueIsProvablySafe('客户张三'), false)
})

test('redacts person names under nested name/assignee keys (no global name whitelist)', () => {
  const res = sanitize({
    checks: [{
      name: 'ui.import.people-repair',
      ok: false,
      selectedPerson: { name: 'Alice Customer' },
      assignee: { name: '客户张三' },
    }],
  })
  const c = res.json.checks[0]
  assert.equal(c.name, 'ui.import.people-repair', 'top-level check id (dotted) is kept')
  assert.equal(c.selectedPerson.name, REDACTION, 'nested person name must NOT survive via a global name whitelist')
  assert.equal(c.assignee.name, REDACTION)
  assert.equal(res.clean, true)
  const text = JSON.stringify(res.json)
  assert.ok(!text.includes('Alice') && !text.includes('张三'), 'no person name leaks')
})

test('keeps check-id-shaped names + auth-source labels, redacts free-text names', () => {
  assert.equal(valueIsProvablySafe('ui.timeline.config-replay'), true)
  assert.equal(valueIsProvablySafe('api.embed-host.persisted-busy-form-save'), true)
  assert.equal(valueIsProvablySafe('api.dev-token'), true)
  assert.equal(valueIsProvablySafe('AUTH_TOKEN'), true, 'auth-source label (not the token)')
  assert.equal(valueIsProvablySafe('login'), true)
  assert.equal(valueIsProvablySafe('Alice Customer'), false)
  assert.equal(valueIsProvablySafe('Alice'), false, 'bare capitalised name is not check-id-shaped')
  // CHECK_ID_RE is namespace-anchored (ui./api.) — generic lowercase dotted
  // business slugs / lowercase names must NOT pass as check ids.
  assert.equal(valueIsProvablySafe('alice.customer'), false, 'lowercase dotted name is not a known check namespace')
  assert.equal(valueIsProvablySafe('acme.order'), false, 'business slug is not a known check namespace')
})

test('markdown is pattern-scrubbed but NEVER certified publishable', () => {
  const md = sanitizeMarkdown('host 192.168.1.222 owner alice@corp.example')
  assert.ok(md.includes('[IP]'))
  assert.ok(md.includes('[EMAIL]'))
  // prose business text (no pattern) cannot be guaranteed removed — by contract
  // the CLI exits non-zero for .md; here we just assert the scrub ran.
  assert.ok(!md.includes('192.168.1.222'))
})
