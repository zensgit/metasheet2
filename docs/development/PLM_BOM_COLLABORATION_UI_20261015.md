# BOM collaboration UI recovery — design and verification

## Scope

The published backend in Draft #6413 supports explicit snapshot sharing and rule configuration, but its BOM panel had no corresponding controls. This slice restores the missing historical UI on source d6cd2064d9800589d6a9fd8d79e9363b00b3aad6 in a separate branch. It does not replace the current backend or import old backend code.

After an explicit BOM load, the panel offers sharing/management. The dialog lists accessible destinations and bindings; a new share requires a chosen Base, name, fresh preview and explicit consent. An uncertain create outcome retains its request identifier for retry. Source refresh/disable uses expected-version CAS. Navigation uses native route identifiers rather than a server-provided arbitrary URL. The dialog explains snapshot persistence and the MetaSheet permission boundary; assigning a reviewer does not grant access.

Rule editors expose the approved per-rule recipient timing, explicit deadline/SLA values and escalation recipients, plus independent local-review versus PLM-success Webhook modes. Targets and completion granularity require explicit choices; send-permission loss still allows disabling an existing rule. Backend ACL/source ownership/version checks remain authoritative. This UI does not itself enable a source listener or infer consent from a saved Webhook rule.

## Session and source invalidation

Source/Part changes invalidate prior loads, ECO responses and row-update presentation. Account/session changes clear the rendered BOM, preview, sharing entry, rule state and pending result generation. Unmount unsubscribes the session listener and invalidates results. Requests issued before a switch may already have reached the server; UI invalidation is not cancellation or rollback of server-side work. Dialog requests use AbortSignal in addition to generation checks. The shared UUID helper retains the current application's intranet/non-secure-context behavior.

## Verification

- Restored UI/service tests initially passed 48 cases.
- Two new account-switch regressions failed before the panel subscribed to session transitions: existing BOM remained visible; a late response restored its sharing entry. Both pass after the correction.
- Final focused collection: 116 passed, 0 failed, 0 skipped across eight modules, including the panel, share dialog, both rule editors, client validation, embedded BOM, service regressions and the UUID access guard.
- Full web application `vue-tsc --noEmit -p apps/web/tsconfig.app.json` passed.
- Targeted ESLint initially reported two attribute-linebreak warnings in a newly restored component. Its autofix changed only those attributes. The final targeted lint passes with zero warnings.
- Installed dependencies are reused through local untracked symlinks; no lockfile/install changes. Node 20.20.2 / Vitest 1.6.1.
- Kimi Code CLI 2.1.1 with explicit `kimi-code/k3` returned monthly-quota 403. It produced no review. Grok Build displayed Grok 4.7 (xhigh), read the three authorized source files, then entered connection retries without a final review. The session was interrupted/closed after about five minutes; this is not a review pass. Neither auxiliary attempt changed product files.

## Remaining work and evidence limits

The 116 tests use rendered Vue components, native memory-router navigation and mocked HTTP responses. They do not prove real-browser layout or actual full-stack authorization. Browser screenshots and a real backend rehearsal are pending before the UI PR closeout. Listener enable/rebind controls, authoritative supplier/difference views, remaining W21/W22 surfaces and full-window acceptance remain open. Existing #336/#6413/#338/#339 CI follows their own exact heads. No merge, deployment, production source access or external customer notifications are performed.

## Typed target follow-up

An additional regression failed with the ported panel: typing P2 while P1 was loading allowed the P1 response to restore its sharing entry. Typed Part changes now clear the current result and pending result generation immediately, without making a network request. A subsequent explicit P2 load is permitted. The new red control had 1 failed / 31 passed; the final eight-module run has 116 passed / 0 failed / 0 skipped. Session switches also clear the Part input; source/route changes retain the explicit prefill contract.
