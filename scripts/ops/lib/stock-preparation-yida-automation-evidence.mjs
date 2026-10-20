import assert from 'node:assert/strict'

/** Acceptance-only, values-free evidence gate. The caller supplies the parsed
 * frames from ONE original configured-app run and its trusted CLI scenario.
 * Neither a different scenario nor a source-file-presence fallback suffices. */
export function validateYidaAutomationEvidence(records, scenario = 'manual', yidaCase) {
  assert(Array.isArray(records) && ['manual', 'interval'].includes(scenario), 'PLM_FULL_APP_YIDA_AUTO_INPUT_INVALID')
  assert(yidaCase === undefined || yidaCase === 'remaining-unknown' && scenario === 'manual', 'PLM_FULL_APP_YIDA_AUTO_CASE_INVALID')
  for (const record of records) {
    assert(record && typeof record === 'object' && !Array.isArray(record) && typeof record.stage === 'string',
      'PLM_FULL_APP_YIDA_AUTO_RECORD_INVALID')
    assert(!['failed', 'actual-stop-failed', 'production-stop-failed', 'harness-emergency-cleanup'].includes(record.stage)
      && !(record.stage.startsWith('yida-automation-') && record.stage.endsWith('-failed')),
    'PLM_FULL_APP_YIDA_AUTO_FAILED_RECORD')
  }
  const one = stage => {
    const found = records.flatMap((record, index) => record.stage === stage ? [{ record, index }] : [])
    assert.equal(found.length, 1, 'PLM_FULL_APP_YIDA_AUTO_UNIQUE_PROOF_REQUIRED')
    return found[0]
  }
  const absent = stage => assert(!records.some(record => record.stage === stage), 'PLM_FULL_APP_YIDA_AUTO_SCENARIO_MIXED')
  const order = (...items) => assert(items.every((item, index) => !index || items[index - 1].index < item.index),
    'PLM_FULL_APP_YIDA_AUTO_ORDER_INVALID')
  const initialized = one('yida-initialization-browser-and-authority-verified')
  const offBrowser = one('yida-automation-default-off-browser-verified')
  const offMain = one('yida-automation-default-off-main-verified')
  const positive = one('production-stop-positive-control')
  const stopped = one('actual-stop-resolved'), verified = one('production-stop-verified')
  assert([0, 1].includes(offBrowser.record.counts?.expectedConsoleErrors), 'PLM_FULL_APP_YIDA_AUTO_OFF_CONSOLE_INVALID')
  assert.deepEqual({ ...offBrowser.record, counts: { ...offBrowser.record.counts, expectedConsoleErrors: 0 } }, {
    stage: 'yida-automation-default-off-browser-verified', evidence: { actualPanel: true, openingQuiet: true,
      actualServerDraftMembers: true, actualSdkRuleCreated: true, ruleNotAuthorization: true, twoRowsSelected: true,
      originalPreviewOff403: true, errorRetained: true, approvalAndRequestAbsent: true, responseStubs: 0, storageInjections: 0 },
    counts: { requests: 4, responses: 4, ruleGets: 1, rulePosts: 1, initializationGets: 1, previewPosts: 1, expectedConsoleErrors: 0 },
    actualRuleMatched: true, grants: 0, requests: 0, admissions: 0, ledgers: 0,
  }, 'PLM_FULL_APP_YIDA_AUTO_OFF_BROWSER_INVALID')
  assert.deepEqual(offMain.record, { stage: 'yida-automation-default-off-main-verified', realMain: true,
    realPasswordJwt: true, installedPlugin: true, ruleVersionRoundTrip: true, refusedProjectMismatch: true,
    refusedVersionMismatch: true, refusedScopeClaims: true, refusedForeignOwnerAndTenant: true,
    originalLoopObserved: true, originalRequestReplay: true, originalRevocation: true, defaultOff: true,
    grants: 1, requests: 1, admissions: 0, ledgers: 0, externalSend: false, newSa06dBrowserProof: false,
  }, 'PLM_FULL_APP_YIDA_AUTO_OFF_MAIN_INVALID')
  if (yidaCase === 'remaining-unknown') {
    for (const stage of ['yida-automation-natural-interval-verified','yida-automation-inflight-ready',
      'yida-automation-inflight-stop-verified','yida-automation-authorized-browser-verified',
      'yida-automation-fresh-consent-fence-verified','yida-automation-synthetic-execution-verified']) absent(stage)
    const remaining = one('yida-automation-remaining-unknown-verified'), attempts = remaining.record.workerAttempts
    assert(Number.isSafeInteger(attempts) && attempts >= 1 && attempts <= 64, 'PLM_FULL_APP_YIDA_AUTO_REMAINING_WORKER_REQUIRED')
    assert.deepEqual(remaining.record, { stage: 'yida-automation-remaining-unknown-verified', actualMain: true,
      realPasswordJwt: true, approvedRows: 2, maximumExecutions: 2, executionsUsed: 1, remainingExecutions: 1,
      unusedRowRequested: true, originalWorkerRetryResolved: true, workerAttempts: attempts, serialBlocked: true,
      originalUnknownHistoryUnchanged: true, ledgers: 1, admissions: 1, snapshots: 1, tokenCalls: 1, formCalls: 1,
      refusedCalls: 0, revokedWithoutRefund: true, externalSend: false, businessVerified: false,
      originalBusinessSnapshotUnchanged: true, originalSendFlagsRestored: true,
    }, 'PLM_FULL_APP_YIDA_AUTO_REMAINING_INVALID')
    order(initialized, offBrowser, offMain, remaining, positive, stopped, verified)
  } else if (scenario === 'manual') {
    absent('yida-automation-remaining-unknown-verified')
    absent('yida-automation-natural-interval-verified')
    absent('yida-automation-inflight-ready'); absent('yida-automation-inflight-stop-verified')
    const browser = one('yida-automation-authorized-browser-verified')
    const freshFence = one('yida-automation-fresh-consent-fence-verified')
    const execution = one('yida-automation-synthetic-execution-verified')
    const inspections = browser.record.counts?.inspections
    assert(Number.isSafeInteger(inspections) && inspections >= 4 && inspections <= 64,
      'PLM_FULL_APP_YIDA_AUTO_INSPECTION_COUNT_INVALID')
    assert.deepEqual(browser.record, { stage: 'yida-automation-authorized-browser-verified',
      evidence: { realPageApproval: true, realPageRequests: 2, actualServerPreviews: 2, manualOnly: true,
        acknowledged: 1, outcomeUnknown: 1, unknownBlocksNextCreate: true, revokedWithoutRefund: true,
        businessVerified: false, responseStubs: 0, storageInjections: 0 },
      counts: { requests: 8 + inspections, responses: 8 + inspections, previews: 2, approvals: 1, submissions: 2,
        inspections, revocations: 1 },
      session: { realPasswordLogin: true, freshBrowserContext: true, productionBundle: true,
        servedBundleBytesVerified: true, matchingProjectBoard: true }, browserAndPreviewServerClosed: true,
    }, 'PLM_FULL_APP_YIDA_AUTO_AUTH_BROWSER_INVALID')
    const fresh = freshFence.record
    const freshCounts = ['metadataAttempts', 'nativeUnknownLookupAttempts', 'nativeUnknownLookupCompletions', 'nativeUnknownRowsRead']
    assert(freshCounts.every(key => Number.isSafeInteger(fresh[key]) && fresh[key] >= 1 && fresh[key] <= 64)
      && fresh.nativeUnknownLookupCompletions === fresh.nativeUnknownLookupAttempts
      && fresh.nativeUnknownRowsRead === fresh.nativeUnknownLookupCompletions
      && fresh.nativeUnknownLookupCompletions <= fresh.metadataAttempts,
    'PLM_FULL_APP_YIDA_AUTO_FRESH_FENCE_PATH_REQUIRED')
    assert.deepEqual(fresh, { stage: 'yida-automation-fresh-consent-fence-verified', actualMain: true, realPasswordJwt: true,
      freshConsentCreated: true, freshRequestQueued: true, realWorkerClaimed: true, metadataAttempts: fresh.metadataAttempts,
      nativeUnknownLookupAttempts: fresh.nativeUnknownLookupAttempts, nativeUnknownLookupCompletions: fresh.nativeUnknownLookupCompletions,
      nativeUnknownRowsRead: fresh.nativeUnknownRowsRead, nativeUnknownLookupErrors: 0, nativeQueryPositiveControl: true,
      retryFenceResolved: true, retryConsumerState: 'in_progress',
      freshGrantExecutionsUsed: 0, newAdmissions: 0, newExecutionSnapshots: 0, existingLedgerRows: 2,
      existingUnknownHistoryUnchanged: true, originalGrantExecutionsUsed: 2, originalSerialBlocked: true,
      freshConsentRevoked: true, syntheticTokenCalls: 2, syntheticFormCalls: 2, refusedVendorCalls: 0,
      externalSend: false, businessVerified: false,
    }, 'PLM_FULL_APP_YIDA_AUTO_FRESH_FENCE_INVALID')
    assert.deepEqual(execution.record, { stage: 'yida-automation-synthetic-execution-verified', actualMain: true,
      actualJwt: true, actualBrowserCreatedRule: true, actualInstalledBinding: true, actualSharedWorker: true,
      actualNativeSenderAndLedger: true, syntheticTokenCalls: 2, syntheticFormCalls: 2, acknowledged: 1,
      outcomeUnknown: 1, executionsUsed: 2, executionLimit: 2, sameRequestReplayNoNewAttempt: false,
      consumerRows: 2, consumerAttempts: 2, unknownConsumerDeadLettered: true, unknownRetainsAdmittedRequest: true,
      nextRequestDeniedAfterUnknownAtExhaustedBudget: false, revocationDoesNotRefundOrClearUnknown: true,
      businessVerified: false, externalSend: false, browserApproved: true, browserRequested: true,
      inFlightStopProven: false, originalSendFlagsRestored: true, originalBusinessSnapshotUnchanged: true,
    }, 'PLM_FULL_APP_YIDA_AUTO_EXECUTION_INVALID')
    order(initialized, offBrowser, offMain, browser, freshFence, execution, positive, stopped, verified)
  } else {
    absent('yida-automation-remaining-unknown-verified')
    absent('yida-automation-authorized-browser-verified'); absent('yida-automation-synthetic-execution-verified')
    absent('yida-automation-fresh-consent-fence-verified')
    const natural = one('yida-automation-natural-interval-verified')
    const ready = one('yida-automation-inflight-ready'), terminal = one('yida-automation-inflight-stop-verified')
    assert.deepEqual(natural.record, { stage: 'yida-automation-natural-interval-verified', actualMain: true, realPasswordJwt: true,
      realRuleHttpCreated: true, intervalMs: 2000, intervalOnlyConsent: true, naturalRequests: 2,
      manualRequestsRejected: 1, manualRequestsAccepted: 0, phaseAnchorVerified: true, occurrenceKeysVerified: 2,
      manualOccurrencesExcluded: true, actualSharedOutboxRows: 2, consumerAttempts: 2, acknowledged: 1, heldDispatching: 1,
      executionLimit: 2, executionsUsed: 2, externalSend: false, businessVerified: false,
    }, 'PLM_FULL_APP_YIDA_AUTO_NATURAL_INTERVAL_INVALID')
    assert.deepEqual(ready.record, { stage: 'yida-automation-inflight-ready', actualMain: true, actualJwt: true,
      actualInstalledBinding: true, actualSharedWorker: true, acknowledgedBeforeStop: 1, dispatchingBeforeStop: 1,
      requests: 2, executionsUsed: 2, heldNativeForm: true, abortBeforeStop: false, externalSend: false,
      originalBusinessSnapshotUnchanged: true,
    }, 'PLM_FULL_APP_YIDA_AUTO_INFLIGHT_READY_INVALID')
    assert.deepEqual(terminal.record, { stage: 'yida-automation-inflight-stop-verified', actualHostStop: true,
      sameStopPromise: true, signalAbortedAfterStopRequested: true, stopPendingBeforeLateResponse: true,
      mainPoolOpenBeforeLateResponse: true, lateValid2xxNotAcknowledged: true, acknowledged: 1,
      unresolvedDispatching: 1, outcomeUnknownCommitted: 0, unresolvedRequestAdmitted: true, serialBlocked: true,
      executionsUsed: 2, executionsRefunded: 0, syntheticTokenCalls: 2, syntheticFormCalls: 2,
      businessVerified: false, externalSend: false, originalSendFlagsRestored: true,
    }, 'PLM_FULL_APP_YIDA_AUTO_INFLIGHT_STOP_INVALID')
    order(initialized, offBrowser, offMain, positive, natural, ready, stopped, terminal, verified)
  }
  return Object.freeze({ scenario, defaultOff: true, authorizedBrowser: scenario === 'manual' && !yidaCase, inFlightStop: scenario === 'interval' })
}
