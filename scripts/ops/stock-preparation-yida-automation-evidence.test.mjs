import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { validateYidaAutomationEvidence } from './run-stock-preparation-plm-full-app.mjs'

// Independent metadata fixtures, NOT JWT, DB, browser or sender substitutes.
// Other original validators check their own complete frames in the real CLI.
function remainingEvidence() {
  const original = evidence('manual')
  return [...original.slice(0, 3), { stage: 'yida-automation-remaining-unknown-verified', actualMain: true,
    realPasswordJwt: true, approvedRows: 2, maximumExecutions: 2, executionsUsed: 1, remainingExecutions: 1,
    unusedRowRequested: true, originalWorkerRetryResolved: true, workerAttempts: 1, serialBlocked: true,
    originalUnknownHistoryUnchanged: true, ledgers: 1, admissions: 1, snapshots: 1, tokenCalls: 1, formCalls: 1,
    refusedCalls: 0, revokedWithoutRefund: true, externalSend: false, businessVerified: false,
    originalBusinessSnapshotUnchanged: true, originalSendFlagsRestored: true }, ...original.slice(-3)]
}
test('remaining-unknown acceptance requires the explicitly selected fresh full-main case', () => {
  assert.doesNotThrow(() => validateYidaAutomationEvidence(remainingEvidence(), 'manual', 'remaining-unknown'))
  for (const selector of [undefined, null, '', 'unknown', true]) {
    assert.throws(() => validateYidaAutomationEvidence(remainingEvidence(), 'manual', selector))
  }
  assert.throws(() => validateYidaAutomationEvidence(remainingEvidence(), 'interval', 'remaining-unknown'))
  assert.throws(() => validateYidaAutomationEvidence(evidence('manual'), 'manual', 'remaining-unknown'))
  assert.throws(() => validateYidaAutomationEvidence(evidence('interval'), 'manual', 'remaining-unknown'))
})
for (const key of Object.keys(remainingEvidence()[3]).filter(key => key !== 'stage')) {
  test(`remaining-unknown rejects absent or changed ${key}`, () => {
    for (const value of [undefined, null, false, 0, 2, 'true']) {
      const records = remainingEvidence()
      if (records[3][key] === value) continue
      if (key === 'workerAttempts' && value === 2) continue
      records[3][key] = value
      assert.throws(() => validateYidaAutomationEvidence(records, 'manual', 'remaining-unknown'))
    }
  })
}
for (const [index, record] of remainingEvidence().entries()) {
  test(`remaining-unknown requires unique ordered frame ${record.stage}`, () => {
    const missing = remainingEvidence(); missing.splice(index, 1)
    assert.throws(() => validateYidaAutomationEvidence(missing, 'manual', 'remaining-unknown'))
    assert.throws(() => validateYidaAutomationEvidence([...remainingEvidence(), record], 'manual', 'remaining-unknown'))
    if (index > 0) {
      const swapped = remainingEvidence(); [swapped[index-1], swapped[index]] = [swapped[index], swapped[index-1]]
      assert.throws(() => validateYidaAutomationEvidence(swapped, 'manual', 'remaining-unknown'))
    }
  })
}
function evidence(scenario) {
  const start = [
    { stage: 'yida-initialization-browser-and-authority-verified' },
    { stage: 'yida-automation-default-off-browser-verified', evidence: { actualPanel: true, openingQuiet: true,
      actualServerDraftMembers: true, actualSdkRuleCreated: true, ruleNotAuthorization: true, twoRowsSelected: true,
      originalPreviewOff403: true, errorRetained: true, approvalAndRequestAbsent: true, responseStubs: 0, storageInjections: 0 },
    counts: { requests: 4, responses: 4, ruleGets: 1, rulePosts: 1, initializationGets: 1, previewPosts: 1, expectedConsoleErrors: 0 },
    actualRuleMatched: true, grants: 0, requests: 0, admissions: 0, ledgers: 0 },
    { stage: 'yida-automation-default-off-main-verified', realMain: true, realPasswordJwt: true, installedPlugin: true,
      ruleVersionRoundTrip: true, refusedProjectMismatch: true, refusedVersionMismatch: true, refusedScopeClaims: true,
      refusedForeignOwnerAndTenant: true, originalLoopObserved: true, originalRequestReplay: true, originalRevocation: true,
      defaultOff: true, grants: 1, requests: 1, admissions: 0, ledgers: 0, externalSend: false, newSa06dBrowserProof: false },
  ]
  const positive = { stage: 'production-stop-positive-control' }
  const stopped = { stage: 'actual-stop-resolved' }, verified = { stage: 'production-stop-verified' }
  if (scenario === 'manual') return [...start,
    { stage: 'yida-automation-authorized-browser-verified', evidence: { realPageApproval: true, realPageRequests: 2,
      actualServerPreviews: 2, manualOnly: true, acknowledged: 1, outcomeUnknown: 1, unknownBlocksNextCreate: true,
      revokedWithoutRefund: true, businessVerified: false, responseStubs: 0, storageInjections: 0 },
    counts: { requests: 12, responses: 12, previews: 2, approvals: 1, submissions: 2, inspections: 4, revocations: 1 },
    session: { realPasswordLogin: true, freshBrowserContext: true, productionBundle: true,
      servedBundleBytesVerified: true, matchingProjectBoard: true }, browserAndPreviewServerClosed: true },
    { stage: 'yida-automation-fresh-consent-fence-verified', actualMain: true, realPasswordJwt: true, freshConsentCreated: true,
      freshRequestQueued: true, realWorkerClaimed: true, metadataAttempts: 1, nativeUnknownLookupAttempts: 1,
      nativeUnknownLookupCompletions: 1, nativeUnknownRowsRead: 1, nativeUnknownLookupErrors: 0, nativeQueryPositiveControl: true,
      retryFenceResolved: true, retryConsumerState: 'in_progress',
      freshGrantExecutionsUsed: 0, newAdmissions: 0, newExecutionSnapshots: 0, existingLedgerRows: 2,
      existingUnknownHistoryUnchanged: true, originalGrantExecutionsUsed: 2, originalSerialBlocked: true,
      freshConsentRevoked: true, syntheticTokenCalls: 2, syntheticFormCalls: 2, refusedVendorCalls: 0,
      externalSend: false, businessVerified: false },
    { stage: 'yida-automation-synthetic-execution-verified', actualMain: true, actualJwt: true, actualBrowserCreatedRule: true,
      actualInstalledBinding: true, actualSharedWorker: true, actualNativeSenderAndLedger: true, syntheticTokenCalls: 2,
      syntheticFormCalls: 2, acknowledged: 1, outcomeUnknown: 1, executionsUsed: 2, executionLimit: 2,
      sameRequestReplayNoNewAttempt: false, consumerRows: 2, consumerAttempts: 2, unknownConsumerDeadLettered: true,
      unknownRetainsAdmittedRequest: true, nextRequestDeniedAfterUnknownAtExhaustedBudget: false,
      revocationDoesNotRefundOrClearUnknown: true, businessVerified: false, externalSend: false,
      browserApproved: true, browserRequested: true, inFlightStopProven: false,
      originalSendFlagsRestored: true, originalBusinessSnapshotUnchanged: true }, positive, stopped, verified]
  return [...start, positive,
    { stage: 'yida-automation-natural-interval-verified', actualMain: true, realPasswordJwt: true,
      realRuleHttpCreated: true, intervalMs: 2000, intervalOnlyConsent: true, naturalRequests: 2,
      manualRequestsRejected: 1, manualRequestsAccepted: 0, phaseAnchorVerified: true, occurrenceKeysVerified: 2,
      manualOccurrencesExcluded: true, actualSharedOutboxRows: 2, consumerAttempts: 2, acknowledged: 1, heldDispatching: 1,
      executionLimit: 2, executionsUsed: 2, externalSend: false, businessVerified: false },
    { stage: 'yida-automation-inflight-ready', actualMain: true, actualJwt: true, actualInstalledBinding: true,
      actualSharedWorker: true, acknowledgedBeforeStop: 1, dispatchingBeforeStop: 1, requests: 2, executionsUsed: 2,
      heldNativeForm: true, abortBeforeStop: false, externalSend: false, originalBusinessSnapshotUnchanged: true }, stopped,
    { stage: 'yida-automation-inflight-stop-verified', actualHostStop: true, sameStopPromise: true,
      signalAbortedAfterStopRequested: true, stopPendingBeforeLateResponse: true, mainPoolOpenBeforeLateResponse: true,
      lateValid2xxNotAcknowledged: true, acknowledged: 1, unresolvedDispatching: 1, outcomeUnknownCommitted: 0,
      unresolvedRequestAdmitted: true, serialBlocked: true, executionsUsed: 2, executionsRefunded: 0,
      syntheticTokenCalls: 2, syntheticFormCalls: 2, businessVerified: false, externalSend: false, originalSendFlagsRestored: true }, verified]
}
const rejected = /PLM_FULL_APP_YIDA_AUTO_/u
for (const scenario of ['manual', 'interval']) {
  test(`SA06D evidence accepts only its complete ${scenario} scenario without mutation`, () => {
    const records = evidence(scenario), before = structuredClone(records)
    assert.deepEqual(validateYidaAutomationEvidence(records, scenario), { scenario, defaultOff: true,
      authorizedBrowser: scenario === 'manual', inFlightStop: scenario === 'interval' })
    assert.deepEqual(records, before)
  })
  for (const stage of evidence(scenario).map(row => row.stage)) {
    test(`SA06D ${scenario} rejects missing ${stage}`, () => {
      assert.throws(() => validateYidaAutomationEvidence(evidence(scenario).filter(row => row.stage !== stage), scenario), rejected)
    })
    test(`SA06D ${scenario} rejects duplicate ${stage}`, () => {
      const records = evidence(scenario); records.push(structuredClone(records.find(row => row.stage === stage)))
      assert.throws(() => validateYidaAutomationEvidence(records, scenario), rejected)
    })
  }
  for (let index = 1; index < evidence(scenario).length; index++) {
    test(`SA06D ${scenario} rejects swapped adjacent proof pair ${index}`, () => {
      const records = evidence(scenario)
      ;[records[index - 1], records[index]] = [records[index], records[index - 1]]
      assert.throws(() => validateYidaAutomationEvidence(records, scenario), rejected)
    })
  }
  test(`SA06D ${scenario} cannot borrow the other scenario`, () => {
    const other = scenario === 'manual' ? 'interval' : 'manual'
    assert.throws(() => validateYidaAutomationEvidence(evidence(other), scenario), rejected)
    const mixed = [...evidence(scenario), ...evidence(other).filter(row => !evidence(scenario).some(value => value.stage === row.stage))]
    assert.throws(() => validateYidaAutomationEvidence(mixed, scenario), rejected)
  })
  for (const stage of ['failed', 'actual-stop-failed', 'production-stop-failed', 'harness-emergency-cleanup', 'yida-automation-inflight-stop-failed']) {
    test(`SA06D ${scenario} rejects a failure even when success frames exist: ${stage}`, () => {
      assert.throws(() => validateYidaAutomationEvidence([...evidence(scenario), { stage }], scenario), rejected)
    })
  }
  test(`SA06D ${scenario} rejects an extra proof claim`, () => {
    const records = evidence(scenario); records[1].unverifiedExtra = true
    assert.throws(() => validateYidaAutomationEvidence(records, scenario), rejected)
  })
}
for (const [scenario, stage, field, replacement] of [
  ['manual', 'yida-automation-default-off-main-verified', 'realPasswordJwt', false],
  ['manual', 'yida-automation-default-off-main-verified', 'refusedForeignOwnerAndTenant', false],
  ['interval', 'yida-automation-default-off-main-verified', 'refusedScopeClaims', false],
  ['manual', 'yida-automation-default-off-main-verified', 'admissions', 1],
  ['manual', 'yida-automation-default-off-browser-verified', 'grants', 1],
  ['manual', 'yida-automation-authorized-browser-verified', 'browserAndPreviewServerClosed', false],
  ['manual', 'yida-automation-fresh-consent-fence-verified', 'realWorkerClaimed', false],
  ['manual', 'yida-automation-fresh-consent-fence-verified', 'metadataAttempts', 0],
  ['manual', 'yida-automation-fresh-consent-fence-verified', 'nativeUnknownLookupAttempts', 0],
  ['manual', 'yida-automation-fresh-consent-fence-verified', 'nativeUnknownLookupCompletions', 0],
  ['manual', 'yida-automation-fresh-consent-fence-verified', 'nativeUnknownRowsRead', 0],
  ['manual', 'yida-automation-fresh-consent-fence-verified', 'nativeUnknownLookupErrors', 1],
  ['manual', 'yida-automation-fresh-consent-fence-verified', 'nativeQueryPositiveControl', false],
  ['manual', 'yida-automation-fresh-consent-fence-verified', 'retryFenceResolved', false],
  ['manual', 'yida-automation-fresh-consent-fence-verified', 'retryConsumerState', 'pending'],
  ['interval', 'yida-automation-natural-interval-verified', 'realRuleHttpCreated', false],
  ['interval', 'yida-automation-natural-interval-verified', 'naturalRequests', 0],
  ['interval', 'yida-automation-natural-interval-verified', 'manualRequestsAccepted', 1],
  ['interval', 'yida-automation-natural-interval-verified', 'phaseAnchorVerified', false],
  ['interval', 'yida-automation-natural-interval-verified', 'occurrenceKeysVerified', 0],
  ['interval', 'yida-automation-natural-interval-verified', 'manualOccurrencesExcluded', false],
  ['interval', 'yida-automation-natural-interval-verified', 'executionLimit', 0],
  ['interval', 'yida-automation-natural-interval-verified', 'externalSend', true],
  ['manual', 'yida-automation-fresh-consent-fence-verified', 'newAdmissions', 1],
  ['manual', 'yida-automation-fresh-consent-fence-verified', 'newExecutionSnapshots', 1],
  ['manual', 'yida-automation-fresh-consent-fence-verified', 'existingLedgerRows', 3],
  ['manual', 'yida-automation-fresh-consent-fence-verified', 'existingUnknownHistoryUnchanged', false],
  ['manual', 'yida-automation-fresh-consent-fence-verified', 'freshGrantExecutionsUsed', 1],
  ['manual', 'yida-automation-fresh-consent-fence-verified', 'syntheticTokenCalls', 3],
  ['manual', 'yida-automation-fresh-consent-fence-verified', 'refusedVendorCalls', 1],
  ['manual', 'yida-automation-synthetic-execution-verified', 'consumerAttempts', 3],
  ['manual', 'yida-automation-synthetic-execution-verified', 'actualNativeSenderAndLedger', false],
  ['manual', 'yida-automation-synthetic-execution-verified', 'unknownRetainsAdmittedRequest', false],
  ['manual', 'yida-automation-synthetic-execution-verified', 'externalSend', true],
  ['manual', 'yida-automation-synthetic-execution-verified', 'inFlightStopProven', true],
  ['manual', 'yida-automation-synthetic-execution-verified', 'sameRequestReplayNoNewAttempt', true],
  ['interval', 'yida-automation-inflight-ready', 'abortBeforeStop', true],
  ['interval', 'yida-automation-inflight-ready', 'heldNativeForm', false],
  ['interval', 'yida-automation-inflight-stop-verified', 'outcomeUnknownCommitted', 1],
  ['interval', 'yida-automation-inflight-stop-verified', 'unresolvedDispatching', 0],
  ['interval', 'yida-automation-inflight-stop-verified', 'lateValid2xxNotAcknowledged', false],
  ['interval', 'yida-automation-inflight-stop-verified', 'mainPoolOpenBeforeLateResponse', false],
  ['interval', 'yida-automation-inflight-stop-verified', 'stopPendingBeforeLateResponse', false],
  ['interval', 'yida-automation-inflight-stop-verified', 'executionsUsed', 1],
  ['interval', 'yida-automation-inflight-stop-verified', 'executionsRefunded', 1],
  ['interval', 'yida-automation-inflight-stop-verified', 'originalSendFlagsRestored', false],
]) test(`SA06D ${scenario} rejects changed ${stage}/${field}`, () => {
  const records = evidence(scenario); records.find(row => row.stage === stage)[field] = replacement
  assert.throws(() => validateYidaAutomationEvidence(records, scenario), rejected)
})
for (const count of [null, 3, 65, 4.5]) test(`SA06D manual rejects invalid read count ${String(count)}`, () => {
  const records = evidence('manual'); records[3].counts.inspections = count
  assert.throws(() => validateYidaAutomationEvidence(records, 'manual'), rejected)
})
for (const value of [null, {}, [null], [{ stage: 1 }]]) test(`SA06D malformed record set ${JSON.stringify(value)} is rejected`, () => {
  assert.throws(() => validateYidaAutomationEvidence(value), rejected)
})
test('SA06D invalid scenario is not converted into a default', () => {
  assert.throws(() => validateYidaAutomationEvidence(evidence('manual'), 'other'), rejected)
})
test('SA06D OFF console count is checked but may be zero or one', () => {
  const records = evidence('manual'); records[1].counts.expectedConsoleErrors = 1
  assert.doesNotThrow(() => validateYidaAutomationEvidence(records, 'manual'))
  records[1].counts.expectedConsoleErrors = 2
  assert.throws(() => validateYidaAutomationEvidence(records, 'manual'), rejected)
})
test('SA06D public orchestration invokes the real gate; deleting that call loses the rejection', () => {
  const source = readFileSync(new URL('./run-stock-preparation-plm-full-app.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('    validateProductionStopEvidence(records)')
  const end = source.indexOf('    yidaOwnerOffLogs =', start)
  assert(start >= 0 && end > start)
  const body = source.slice(start, end), needle = '    validateYidaAutomationEvidence(records, automationScenario, yidaCase)\n'
  assert.equal(body.split(needle).length, 2)
  const invoke = (code, records) => {
    let calls = 0
    const noop = () => {}
    runInNewContext(code, { records, automationScenario: 'manual', yidaCase: undefined, validateProductionStopEvidence: noop,
      validateK3Evidence: noop, validateYidaEvidence: noop, validateYidaOwnerOffEvidence: noop,
      validateYidaInitializationEvidence: noop, validateAutomationEvidence: noop,
      validateYidaAutomationEvidence: (...args) => { calls++; return validateYidaAutomationEvidence(...args) } })
    return calls
  }
  assert.equal(invoke(body, evidence('manual')), 1)
  const incomplete = evidence('manual').filter(row => row.stage !== 'yida-automation-synthetic-execution-verified')
  assert.throws(() => invoke(body, incomplete), rejected)
  assert.equal(invoke(body.replace(needle, ''), incomplete), 0)
})
