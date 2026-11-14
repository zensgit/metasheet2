'use strict'

// Batch-refresh step 2a — GOLDEN BYTE-IDENTITY of every hash and identity the stock-preparation pull
// mints off an expansion (plan docs/development/takeover-beiliao-20260821 §12.2 item 2: the old
// flow's tokens, confirmation fingerprints, source digests and snapshot batch identities stay
// byte-for-byte unchanged when demand evidence is captured).
//
// GOLDEN BASELINE: every literal in GOLDEN below was captured on origin/main
//   fae8946d19efaadc615b50758cd6f4a50d43a14e  (#6499)
// BEFORE any demand-evidence code existed, by running the harness in
// `support/stock-preparation-demand-evidence-golden-harness.cjs` over its synthetic sources. They
// are not re-derived here: a literal that has to move is a behaviour change of the old flow and
// needs its own reviewed reason, not a re-capture.
//
// RECAPTURED ONCE, REVIEW ROUND 1 (F1), and ONLY these 21 literals: `large.artifactRevision`,
// `artifactDigest`, `planRevision`, `planArtifactDigest`, `targetRevision`, `publicJobDigest`,
// `storedJobDigest` of `dash_drop`, `main_drawing_superseded` and `subtree_on`. Reason: the harness's
// large lane was not route-shaped — it snapshotted the RAW action and expanded with
// `expansionOptions: {}`, so the subtree never ran there and the background caps were the defaults.
// It now does what the start / run routes do (normalized action snapshot; re-normalized snapshot ->
// `largeBomExpansionOptionsForAction` + `requireCompleteBatch: false`). HOW: the round-1 harness was
// run in `off` mode over an LF `git -c core.autocrlf=false archive` copy of
// fae8946d19efaadc615b50758cd6f4a50d43a14e (its lib, whose expander has no capture code) in a scratch
// directory, and over this branch; the two outputs were byte-identical, and against the previous
// literals exactly the 21 keys above differed (`large.status` and everything outside `large` did not).
//
// RECAPTURED, R-71 ⑦.4 PR-4 (two template columns `issueConfirmDate` / `projectSpecModel`), and ONLY these
// 38 literals: `dryRun.evidenceDigest` / `dryRun.responseDigest` of the seven scenarios other than `not_found`,
// `archive.evidenceDigest` / `apply.responseDigest` of `dash_drop`, `main_drawing_superseded`, `subtree_on`,
// and the six `large` digests (`artifactRevision`, `artifactDigest`, `planRevision`, `planArtifactDigest`,
// `publicJobDigest`, `storedJobDigest`) of those three. Reason: every one of them hashes a payload that
// carries the frozen template's field list (the dry-run evidence's `summarizeTemplateForEvidence`, the plan
// summary's `plmSystemFields`, the large lane's action snapshot), and the list gained two columns. HOW: the
// harness was run on the PR-4 branch with the two `field(...)` lines removed from the template (and
// MACHINE_WRITEBACK_FIELD_IDS emptied to match): 0 literals moved, so the PR-4 planner / writer code moves
// nothing by itself; with the columns, exactly these 38 moved. Every dry-run `revision`, token subset,
// source-content revision, ledger fingerprint, archive id / batch identity / snapshot line and the written
// apply rows are unchanged.
//
// THE MATRIX. The same scenarios are replayed with the expander's demand-evidence capture OFF, ON,
// and ON with a recorder that throws from every hook (the harness adds `demandEvidence` to the
// expander input without wiring any production caller). All three legs must reproduce GOLDEN
// exactly, and the ON legs must show the recorder really ran (or really faulted and said so). If ON
// moves a digest, some hash reads the expansion object as a whole, or the evidence leaked into rows
// / summary / dry-run evidence; if THROWING moves one, a recorder fault reached the walk. (The
// "throwing store" leg belongs to step 2c, which adds the store.)
//
// What each digest covers (per scenario, where the scenario reaches it):
//   dryRun     revision, the stored token subset {actionId, parametersHash, revision, review},
//              evidence, the response minus token / clocks, counts / status / canApply, and the
//              expansion's rows / summary / rowErrors / errors as handed to every hash;
//              confirmationInputRevision when the ledger resolver ran
//   sourceContent  the #6475 content revision and its 32-hex digest
//   ledger     reconcile's pre-merge input revision; decisionId / stableDecisionKey /
//              inputFingerprint for the duplicate, anonymous and carry families
//   archive    archiveRevision, snapshot_ / sync_ ids (the mvp-persist route's recipe), batch
//              identity in both modes, snapshot lines, mvp evidence
//   apply      response minus clocks, dryRunRevision, sourceContentRevision, the written rows
//   large      artifact revision + artifact, plan revision + plan artifact, target revision, the
//              public job projection and the stored job
//
// VALUES-FREE: synthetic project numbers, part ids and drawing numbers only.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  MODES,
  SCENARIOS,
  actionFor,
  installExpansionCaptureSwitch,
  observeAll,
  routeShapedLargeExpansionOptions,
  stripHarnessKeys,
} = require('./support/stock-preparation-demand-evidence-golden-harness.cjs')

const { DEMAND_EVIDENCE_SCHEME } = require('../lib/stock-preparation-demand-evidence.cjs')

const GOLDEN_BASE_SHA = 'fae8946d19efaadc615b50758cd6f4a50d43a14e'

// How many expansions each scenario performs (dry-run, ledger reconcile, mvp-persist, apply's
// dry-run + recompute, large lane). Asserted so a scenario that silently stopped reaching a path —
// and therefore stopped pinning its hash — is a failure, not a quieter pass.
const EXPECTED_EXPANSIONS = Object.freeze({
  dash_drop: 5,
  main_drawing_superseded: 5,
  root_missing_component: 2,
  not_found: 1,
  global_read_failed: 1,
  duplicate_key_hold_with_ledger_decision: 2,
  subtree_on: 5,
  carry_family: 2,
})

// Review round 1 (F2): what the recorder must have SEEN, per scenario, on every ON-leg expansion
// (small dry-run, ledger, mvp-persist, apply, and the route-shaped large lane alike). A recorder whose
// hooks dispatch to nothing still mints a scheme, a status and a 64-hex fingerprint; it cannot mint
// these counts. Captured on this branch (they did not exist before it) and cross-checked by hand
// against each scenario's source.
const EXPECTED_ON_EVIDENCE = Object.freeze({
  dash_drop: { observations: 2, pathNodes: 1, status: 'complete', reasons: [] },
  main_drawing_superseded: { observations: 4, pathNodes: 1, status: 'complete', reasons: [] },
  root_missing_component: { observations: 2, pathNodes: 1, status: 'incomplete', reasons: ['part_missing'] },
  not_found: { observations: 0, pathNodes: 0, status: 'project_not_found', reasons: [] },
  // The detail read fails AFTER the path node was recorded `ok`.
  global_read_failed: { observations: 0, pathNodes: 1, status: 'incomplete', reasons: ['read_failed'] },
  duplicate_key_hold_with_ledger_decision: { observations: 2, pathNodes: 1, status: 'complete', reasons: [] },
  // 1 order line + 2 subtree roots (one skipped as already expanded) — in the large lane too.
  subtree_on: { observations: 3, pathNodes: 1, status: 'complete', reasons: [] },
  carry_family: { observations: 1, pathNodes: 1, status: 'complete', reasons: [] },
})

// The run route's own options builder, evaluated from its source (http-routes.cjs is pinned, so the
// helper is not exported for this test). Fails loudly if it is renamed or reshaped.
function routeLargeExpansionOptionsHelper(largeBomBackgroundExpansionCaps) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'http-routes.cjs'), 'utf8').replace(/\r\n/g, '\n')
  const start = source.indexOf('function largeBomExpansionOptionsForAction(')
  const end = source.indexOf('\n}\n', start)
  assert.ok(start >= 0 && end > start, 'http-routes.cjs still defines largeBomExpansionOptionsForAction')
  const isPlainObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value))
  // eslint-disable-next-line no-new-func
  return new Function('isPlainObject', 'largeBomBackgroundExpansionCaps', `${source.slice(start, end + 2)}\nreturn largeBomExpansionOptionsForAction`)(
    isPlainObject,
    largeBomBackgroundExpansionCaps,
  )
}

const GOLDEN = {
  dash_drop: {
    dryRun: {
      status: 'ready',
      canApply: true,
      counts: {
        add: 3,
        update: 0,
        skip: 0,
        inactive: 0,
        manual_confirm: 0,
      },
      revision: 'b2b6dde7149d4d7ece00a65abb840d9d0a1367d5a264a96abf47cc789ba83082',
      evidenceDigest: '9601617e159212865368b4d0f9b45e3d4dc08ccfac96441b749b181e062d5250',
      responseDigest: 'f68f7ff732999e82912dceb4f416f9e13fd7c3d6d15a4f7e53c1420209108eb5',
      rowsDigest: '39c3d3f78e4fa255d5ed63d837669cee672693adca4a1832d2f4f2bfb6eeaf9f',
      summaryDigest: 'aaaa3ba3dee6b7588687c727ccab0f715fb862c39dd6dbad9ce88683ec1b0393',
      rowErrorsDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      errorsDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      tokenSubsetDigest: 'bcff8a773db577812623ebe308f3eeaf2725e9f8b8c91c92af6b38fb96c3e8b0',
    },
    sourceContent: {
      revision: 'd46310f6fa79916502c299e87889ec294347b22a9f22a94a9ae3a338fb69c78d',
      digest: '2ed34a9ea0a8a3ff19631f81f290144f',
    },
    archive: {
      revision: 'b2b6dde7149d4d7ece00a65abb840d9d0a1367d5a264a96abf47cc789ba83082',
      archiveRevision: 'b2b6dde7149d4d7ece00a65abb840d9d0a1367d5a264a96abf47cc789ba83082',
      snapshotBatchId: 'snapshot_bfdeb542fd8455a2c15847d0fa63764a',
      syncRunId: 'sync_bfdeb542fd8455a2c15847d0fa63764a',
      batchIdentitySourceRevision: '101551c7313885577c5542572cc5f4c40d55e61cc4016ff7273aa3611b6819e9',
      batchIdentityMaterialCreateHour: '185b80eea9586a49893f897f67450a19b39c30ed91b166c8f1607b63366c0b10',
      snapshotLinesDigest: '2807c41d933fb53deb70872a65e808448cf9531d06d319228fc31f4b59c630cf',
      evidenceDigest: '9601617e159212865368b4d0f9b45e3d4dc08ccfac96441b749b181e062d5250',
      expansionResultDigest: '39c3d3f78e4fa255d5ed63d837669cee672693adca4a1832d2f4f2bfb6eeaf9f',
    },
    apply: {
      status: 'succeeded',
      dryRunRevision: 'b2b6dde7149d4d7ece00a65abb840d9d0a1367d5a264a96abf47cc789ba83082',
      sourceContentRevision: 'd46310f6fa79916502c299e87889ec294347b22a9f22a94a9ae3a338fb69c78d',
      responseDigest: '7ae1fc79be153a5b751292031c08dfd2466d8c82774704fd82a586132cdf7d06',
      writtenRowsDigest: '9f08e4c04d830e44c6a4ec2b2c03fddc23b35cbbd1efd1edf181f6692f930ee8',
    },
    large: {
      status: 'completed',
      artifactRevision: '45e3075ff31c8ac8f7111eccd5b7b3673d10b248c35b597bf8e109293798f8e2',
      artifactDigest: '863efaed1aba81c0f8fdf3055986b126cd0af5f1ac043eb0d49499911b8ec8bb',
      planRevision: '0d360b396333e0e5c1886ae363352c6abb32987408fcbf3fd27f1c08f70a8ee0',
      planArtifactDigest: 'a0b9f8046b6e7a90f50d41631d36a24df764e9283d336f3e32899b2a514c5362',
      targetRevision: '472472d045b7223785e68e092dc2a500102457f084c5a1e971c6b5b59b4ed449',
      publicJobDigest: 'ae31b26c38406a1cd7bcbf13a03fd7b6944a121a3b7f8a2f51bca69da8ee57a7',
      storedJobDigest: '660d4c3bcdce6dcb6804591c14053be4f304762136a93aeee4afcc4c68c91a00',
    },
  },
  main_drawing_superseded: {
    dryRun: {
      status: 'ready',
      canApply: true,
      counts: {
        add: 4,
        update: 0,
        skip: 0,
        inactive: 0,
        manual_confirm: 0,
      },
      revision: '74e81652f5fdc97c28d771f883859650a1aaf1de45125198055f8f752a8e38e3',
      evidenceDigest: 'f1d8d3c33c962152855ad6280ac472b00d64ef3e1782e6f2b0c25003cc78bebc',
      responseDigest: '2ff35d02299735c3b7fdb9fd683ca91ac58bf72aa1c5549d431e4e1db6cd0bb3',
      rowsDigest: '67c724d99c5adc5a73763715303ca6f3bd49c89823fdffeba87399f5d6a0481e',
      summaryDigest: '9c64e841059f6840752bbee18df6eb27d66af33fa1aaf43857771d326aff8bc7',
      rowErrorsDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      errorsDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      tokenSubsetDigest: 'e5a2d7b7931d6748a02ddd40308935c5fa9dea17f0ef8519b3e6d93335f0c29e',
    },
    sourceContent: {
      revision: '8d601edc3b62739c50898f4ba2ac790d6c74b244b87d1038fe379ff14936afb9',
      digest: 'edb8fed0a3bbcb33b091eea491bc36bf',
    },
    archive: {
      revision: '74e81652f5fdc97c28d771f883859650a1aaf1de45125198055f8f752a8e38e3',
      archiveRevision: '74e81652f5fdc97c28d771f883859650a1aaf1de45125198055f8f752a8e38e3',
      snapshotBatchId: 'snapshot_1384a5df190e1c33abafc91a72be7279',
      syncRunId: 'sync_1384a5df190e1c33abafc91a72be7279',
      batchIdentitySourceRevision: 'ca04063b9cf52db06c7cad6d0a48301c65da825742579835e3d495889fdf0b37',
      batchIdentityMaterialCreateHour: 'e31b1b5e21ecf4f4434e3a2e69d93e999fc0e73ab8000e2268c98da215fda526',
      snapshotLinesDigest: 'e19eabc8dffc4f08ac4dc5cc8c1f8c7aaac0f06b918abfba806d5abea71003fd',
      evidenceDigest: 'f1d8d3c33c962152855ad6280ac472b00d64ef3e1782e6f2b0c25003cc78bebc',
      expansionResultDigest: '67c724d99c5adc5a73763715303ca6f3bd49c89823fdffeba87399f5d6a0481e',
    },
    apply: {
      status: 'succeeded',
      dryRunRevision: '74e81652f5fdc97c28d771f883859650a1aaf1de45125198055f8f752a8e38e3',
      sourceContentRevision: '8d601edc3b62739c50898f4ba2ac790d6c74b244b87d1038fe379ff14936afb9',
      responseDigest: '9f93098ba2b56d275950e2454ad93f5b3aa07d5c370077408c8fb916e6ac2329',
      writtenRowsDigest: 'e1c6677ad2814516433828740a2cb2f0f60e66d2bb7028996a6ae95bc036dca8',
    },
    large: {
      status: 'completed',
      artifactRevision: 'f19179cec00327df39b76661f7faeb8aa2dbdc2888a5b4669901b7d8a3d2b6d1',
      artifactDigest: '9e1433790972e0e6581a810976e3016f01117b313c72dac414e67066a96baada',
      planRevision: 'fb43b3ec06b9e7b3a0f51bf3f69c215d64c022463eb9a79fcb5aa9e1c5203323',
      planArtifactDigest: 'a57d7c4ea4ec6a2aa8c6542d095a359e754db8c80840841811ee133f691b62fc',
      targetRevision: '472472d045b7223785e68e092dc2a500102457f084c5a1e971c6b5b59b4ed449',
      publicJobDigest: '2f97f7380665e0e6c105d84110fe7376fc8191e482e04198bc5805e60c9b574f',
      storedJobDigest: '492e1ece9d07fdbbc97aca5a5fe7d626bc7d9621704c94d00f9acbb81dae1eba',
    },
  },
  root_missing_component: {
    dryRun: {
      status: 'manual_confirm_required',
      canApply: true,
      counts: {
        add: 1,
        update: 0,
        skip: 0,
        inactive: 0,
        manual_confirm: 1,
      },
      revision: '2292e7cc4d136dae938781391b5c0b97498a52a59a937d9aae417488e9ced814',
      evidenceDigest: '8dea2a98ddcb83f1bfe79634675a7b3bb27db217bbd5aaf0bd25c045dae0b9f1',
      responseDigest: '442d25cd61f4041bd98ecfae29ce07530848d7bde28ea6e5fefd1d8b04db07de',
      rowsDigest: 'f4eb49732a28c97b3009e959230606a1a279a4c09dd4c8cdd4f6d926c25bc676',
      summaryDigest: 'cae6ee7ac9692f70659de7cd5308e84b9d66889a3b9b49ca84b31831c90dbfec',
      rowErrorsDigest: 'c1ebad72a794110c10d9ef7ffdc9b2018ac572f30af139aac42f88cd9322f8cb',
      errorsDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      tokenSubsetDigest: '0c3546ecc6b1e979c7709df0e8743ac6a917f2856da365320a03f3dc7b519775',
    },
    sourceContent: {
      revision: '83fa92caac2ab2502b52a5bb562215eefb2c01e8d03d4a2f0adcd30e8062bd59',
      digest: '3d9b7ae3d48ccf3fd12db8e26213e8c6',
    },
    ledger: {
      confirmationInputRevision: '2292e7cc4d136dae938781391b5c0b97498a52a59a937d9aae417488e9ced814',
      duplicateFamily: [],
      anonymousFamily: [
        {
          decisionId: 'sha256:8e7423b32e458d683fcb79fa0ee9eb4a',
          stableDecisionKey: 'sha256:24624a47e27da418313b98a211e52fbe',
          inputFingerprint: 'sha256:62913c0d7c6f76e82ef2cfd40b4e1e90',
        },
      ],
      carryFamily: [],
      derivedDigest: '1fd2f0d9f4e137bd01b3ecf5f3de0bf7f0860eb44aa4aa5c51efa0791f8a2044',
    },
  },
  not_found: {
    dryRun: {
      status: 'not_found',
      canApply: false,
      counts: {
        add: 0,
        update: 0,
        skip: 0,
        inactive: 0,
        manual_confirm: 0,
      },
      revision: '5f58373d24f0fbcca0ab65f06bc8d724cbd8ae427dff1e0c95d18a0b0cc85abb',
      evidenceDigest: '1364c19bc7d9cda32cfc9020db860e15b29ff9e17a2c9349f227455d290a2a15',
      responseDigest: 'dace3ea9aca4f3dc570029225aea301150ff4a1396536cce7f195a6b51da46aa',
      rowsDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      summaryDigest: 'f5902e68877cbafbaf3f2134b5c2a104feb89970cdae97612757d5800cbd74f9',
      rowErrorsDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      errorsDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    },
    sourceContent: {
      revision: 'ca69097d6450b60a35969682453b7310a3b782773491545d16de3999ba06bc80',
      digest: '5be88187e751fbf88038f5d877ce1f59',
    },
  },
  global_read_failed: {
    dryRun: {
      status: 'failed',
      canApply: false,
      counts: {
        add: 0,
        update: 0,
        skip: 0,
        inactive: 0,
        manual_confirm: 0,
      },
      revision: '9a111b25209e8a9a249c09db11462db1b5d5406809b60e8ddf7e6cc5dc1b87ae',
      evidenceDigest: 'ba17e7214fed5c44983283eb19dc38a5dc2b761cf8c255b59c698da08f1a4e0f',
      responseDigest: 'e0238d0b3ab1ef4a9af505d6e845f54ba0faa0e808b0d3b9185f8fe888b7b268',
      rowsDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      summaryDigest: 'b7e781c72da9124f9c36670f0a4a575bcab4b94cf1ca4d55de8952b86bf3ec1d',
      rowErrorsDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      errorsDigest: '8260d0afc04cb71076a045ab157c0c7464d56e43cfa20a3ffac2c842de6176d9',
    },
    sourceContent: {
      revision: 'b577f6a91024c809f89a9f429569b2b7e5a1c1ae0f1016cf2070a4e713be5962',
      digest: '3462917581df20f4819f8a99916ad72e',
    },
  },
  duplicate_key_hold_with_ledger_decision: {
    dryRun: {
      status: 'ready',
      canApply: true,
      counts: {
        add: 2,
        update: 0,
        skip: 0,
        inactive: 0,
        manual_confirm: 0,
      },
      revision: 'b696ece5e7c9e7867e0d05c18994270aedabf5c4f4f7b36100ebd81b0b9ce2a0',
      evidenceDigest: '0be1f2197c71e57e80a97a206a20e7851e7094e8ad915f6ee4ed11771a243d70',
      responseDigest: '8323aeef9f5b1b0aa99666199b1dce7ff5e41cb0ac7037fd8a280adc5100f89a',
      rowsDigest: '5e0f0153bef1b5df3f21355cac792b9754f565619bce3df61b8c5ca8c92f8a55',
      summaryDigest: '04d147988bb6a70bee0c880987b3744dddd25121e512d2e021e810001559005d',
      rowErrorsDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      errorsDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      tokenSubsetDigest: 'e6c3075695703873caf825e54388e773165b06cf42ecff67c7b3597f40bb2bea',
      confirmationInputRevision: '428c2b5789ab63311dd2e03595bacf48c3a330f01c34ee4933c1e56b9728805b',
    },
    sourceContent: {
      revision: '49f29599a8554b7cf5696bd87a31d8439c8b75ed4ca284fec9eb585b84d7580a',
      digest: '87b26541fb1aaf2f37503b73533de52a',
    },
    ledger: {
      confirmationInputRevision: '428c2b5789ab63311dd2e03595bacf48c3a330f01c34ee4933c1e56b9728805b',
      duplicateFamily: [
        {
          decisionId: 'sha256:9b6b56bea292d58655176b57b0096a2f',
          stableDecisionKey: 'sha256:791b2ad8be5c710829ae15db718c2da6',
          inputFingerprint: 'sha256:be8285a66a69d77410d71e276bca0271',
        },
      ],
      anonymousFamily: [],
      carryFamily: [],
      derivedDigest: 'e0e82cb49bc7c75906f8ef5051e91da31b84e9c412baeca62f1d081ff1136b34',
    },
  },
  subtree_on: {
    dryRun: {
      status: 'ready',
      canApply: true,
      counts: {
        add: 4,
        update: 0,
        skip: 0,
        inactive: 0,
        manual_confirm: 0,
      },
      revision: '71a384c5fcb7336ecc633ea0a080e20a376191b43cbc684d6715eb66dfaa02ab',
      evidenceDigest: '768bd0355f19fdc3df3c663fe3cf2d194e860cae9ed09c5ec1eac2069e7570ac',
      responseDigest: 'bc2df394ff1527a192e1f04d717b18553f41c97f62dec02eb21ceeb770eae52f',
      rowsDigest: '2a1e02e4e53b2de0e0b299fc05849f550d993a64840534b8b0946c63288a8fad',
      summaryDigest: '2f15a853bb137480ebbc4404e7061b35bad67ef97ba2c1de050250b67ca49b27',
      rowErrorsDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      errorsDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      tokenSubsetDigest: 'ae62e17563b0349b1b5a1d34c5e6610ded332ebe8bfb649b02b31f174728c07d',
    },
    sourceContent: {
      revision: 'c0550f4a77e4275cd41766b66a93db54b6ae2bd9c20e4c47156cf5d072c72fdb',
      digest: '29229abdd92e4cccbfc39097b467bc8a',
    },
    archive: {
      revision: '71a384c5fcb7336ecc633ea0a080e20a376191b43cbc684d6715eb66dfaa02ab',
      archiveRevision: '71a384c5fcb7336ecc633ea0a080e20a376191b43cbc684d6715eb66dfaa02ab',
      snapshotBatchId: 'snapshot_5645299f2dc7043c2707f223cf06795a',
      syncRunId: 'sync_5645299f2dc7043c2707f223cf06795a',
      batchIdentitySourceRevision: '1e7339d57a33ef62a0ebbfa6eddfaada23765c66c762497cea01a5971bb53d61',
      batchIdentityMaterialCreateHour: 'afe6549b81e17a5fc49e17b77487ca0515c0bff8d2d8fd93da95e5565bec0e13',
      snapshotLinesDigest: 'e45bbe3ef0a280fbd123d637ff8b25fb5276e26252c4bbbc9519142b69a5fe7d',
      evidenceDigest: '768bd0355f19fdc3df3c663fe3cf2d194e860cae9ed09c5ec1eac2069e7570ac',
      expansionResultDigest: '2a1e02e4e53b2de0e0b299fc05849f550d993a64840534b8b0946c63288a8fad',
    },
    apply: {
      status: 'succeeded',
      dryRunRevision: '71a384c5fcb7336ecc633ea0a080e20a376191b43cbc684d6715eb66dfaa02ab',
      sourceContentRevision: 'c0550f4a77e4275cd41766b66a93db54b6ae2bd9c20e4c47156cf5d072c72fdb',
      responseDigest: 'abe6b8fa81d67eff70c21c35dee6cdd4f2ca75b03f877d4648e0a605b27b6076',
      writtenRowsDigest: '44ce67507b09c1111821534f940e8c4b19e7cd92bc0d27c40226898c9c809f01',
    },
    large: {
      status: 'completed',
      artifactRevision: '76c6da99e2db3ec62ad6273efdb942e8a3367119f8e2b7018c9c355c879d8f65',
      artifactDigest: '2c8426f252bdf3a2febb68ccb545429bf101ea246f4640f9755e2f22cf8cf8e4',
      planRevision: 'b32e2f143aaffe14c18397eacd3fb972033c8e90519a52c748aea02b020d8e0e',
      planArtifactDigest: 'a46fec791827686205c6e210d429b012da77bc9e36a17f935dbe9c27a15e70bc',
      targetRevision: '472472d045b7223785e68e092dc2a500102457f084c5a1e971c6b5b59b4ed449',
      publicJobDigest: 'd00a028c8f8a44ceb29d4d0a3fbb724b695c8d5de8e4cdb3b9bdd012427b346f',
      storedJobDigest: '8749a9c27d2e1ce5850999ce5cbf79e463efbb1840142640c3154782c9f73ac9',
    },
  },
  carry_family: {
    dryRun: {
      status: 'manual_confirm_required',
      canApply: true,
      counts: {
        add: 1,
        update: 0,
        skip: 1,
        inactive: 0,
        manual_confirm: 1,
      },
      revision: 'e30e146f5da9330ed70eed94eb2b549f6bba5da53311e9ca0d43a92aeb66ccaa',
      evidenceDigest: '014d40539b4722aa4d1786b7a9840b1272ebe3e29b68a8d2fcc7547b6b9a8c98',
      responseDigest: '5a2274f9cc81b94ceca1a8d94c4565ca427dcf3df00cc9c1724685d53c524e99',
      rowsDigest: '9ada51bfd10ec36d89f6f0f2acfa846de01ed27b24c7ed261bd580f7f918a0fc',
      summaryDigest: '58497f63e4240e1d128f0525784cd2e6e60f3d36caeb1f3a40561f1c2fa6311e',
      rowErrorsDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      errorsDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      tokenSubsetDigest: '991b1f51680f681b8d7fe8f46b44ea3662ec3cf39106e876dc6b2251315d99c5',
    },
    sourceContent: {
      revision: '2441849d9185ed07f6aac914262e2e613e7ddc90a26e972a002b8ea3422fc985',
      digest: '404e0053b4b71a0d82675ed8172eef93',
    },
    ledger: {
      confirmationInputRevision: 'e30e146f5da9330ed70eed94eb2b549f6bba5da53311e9ca0d43a92aeb66ccaa',
      duplicateFamily: [],
      anonymousFamily: [],
      carryFamily: [
        {
          decisionId: 'sha256:2e82e9d946cd54f93541fa75ad0e7dc5',
          stableDecisionKey: 'sha256:fdeea9c177b5db2401ef5b97cb9e4f16',
          inputFingerprint: 'sha256:49027e7b9f840f61a936f2d565e0a30f',
        },
      ],
      derivedDigest: 'd499bce31a89b0dbc267bc5966ca65cc48011d5d01bf1fbac9000f5bd3a1cdd8',
    },
  },
}

let passed = 0
let failed = 0

async function run(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failed += 1
    console.error(`FAIL: ${name}`)
    console.error(error && error.stack ? error.stack : error)
  }
}

async function main() {
  assert.match(GOLDEN_BASE_SHA, /^[0-9a-f]{40}$/)
  const harness = installExpansionCaptureSwitch()

  await run('the large lane is route-shaped: the harness builds the run route\'s expansion options', () => {
    const routeHelper = routeLargeExpansionOptionsHelper(harness.tableActions.largeBomBackgroundExpansionCaps)
    const large = SCENARIOS.map((build) => build()).filter((scenario) => scenario.large)
    assert.ok(large.length >= 3)
    for (const scenario of large) {
      const normalized = harness.tableActions.assertStockPreparationTargetReady(actionFor(scenario))
      assert.deepEqual(routeShapedLargeExpansionOptions(harness.tableActions, normalized), routeHelper(normalized), scenario.name)
    }
    const subtree = harness.tableActions.assertStockPreparationTargetReady(actionFor(large.find((scenario) => scenario.name === 'subtree_on')))
    assert.ok(routeHelper(subtree).readPlan.projectSubtree, 'the subtree scenario\'s large lane carries the subtree block')
    // The two run-route facts the harness mirrors, as text (the route itself needs an HTTP host).
    const routes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'http-routes.cjs'), 'utf8').replace(/\r\n/g, '\n')
    assert.ok(routes.includes('const action = assertStockPreparationTargetReady(queuedJob.actionSnapshot)'), 'run route re-normalizes the snapshot')
    assert.ok(/expansionOptions: \{\n\s+\.\.\.largeBomExpansionOptionsForAction\(action\),/.test(routes), 'run route expands with the helper')
    assert.ok(routes.includes('requireCompleteBatch: Boolean(largeBomB2aAuthorization),'), 'run route arms the batch check only under B2a')
  })

  for (const handle of ['wired', 'absent']) for (const mode of MODES) {
    const observed = await observeAll(harness, mode, undefined, { handle })
    const stripped = stripHarnessKeys(observed)
    // PR-3a: a handle-absent apply is refused by the writer (asserted in the harness) — the one section that leg
    // cannot reproduce; every other section is the golden, byte for byte. PR-3b: likewise a large expansion planned
    // without the plan route's governance verdict is refused at approval (asserted in the harness), so that leg's
    // `large.targetRevision` is the refusal token; its artifact, plan revision, plan artifact and stored job (minus the
    // one new `governanceVerdict` key, asserted apart) are still the golden's.
    const goldenFor = (name) => {
      if (handle !== 'absent') return GOLDEN[name]
      return {
        ...GOLDEN[name],
        ...(GOLDEN[name].apply ? { apply: 'refused_governance_absent' } : {}),
        ...(GOLDEN[name].large ? { large: { ...GOLDEN[name].large, targetRevision: 'refused_governance_unconsulted' } } : {}),
      }
    }

    await run(`[${handle}][${mode}] every golden scenario was observed`, () => {
      assert.deepEqual(Object.keys(stripped).sort(), Object.keys(GOLDEN).sort())
    })

    for (const name of Object.keys(GOLDEN)) {
      await run(`[${handle}][${mode}] ${name}: every hash and identity matches the ${GOLDEN_BASE_SHA.slice(0, 9)} golden`, () => {
        assert.deepEqual(stripped[name], goldenFor(name))
      })
      await run(`[${handle}][${mode}] ${name}: the switch carried every expansion of the scenario`, () => {
        assert.equal(observed[name].__expansionCalls, EXPECTED_EXPANSIONS[name])
        for (const call of observed[name].__calls) {
          assert.equal(call.mode, mode)
          assert.equal(Object.prototype.hasOwnProperty.call(call.input, 'demandEvidence'), mode !== 'off',
            `[${mode}] the expander input ${mode === 'off' ? 'must not' : 'must'} carry demandEvidence`)
        }
      })
      // The ON legs are only a byte-identity proof if the recorder really ran (or really faulted).
      await run(`[${handle}][${mode}] ${name}: the expansion ${mode === 'off' ? 'carries no' : 'carries the'} demand evidence`, () => {
        for (const call of observed[name].__calls) {
          const evidence = call.result.demandEvidence
          if (mode === 'off') {
            assert.equal(Object.prototype.hasOwnProperty.call(call.result, 'demandEvidence'), false, 'capture off adds no key')
            continue
          }
          assert.equal(evidence.scheme, DEMAND_EVIDENCE_SCHEME)
          if (mode === 'on') {
            assert.match(evidence.fingerprint, /^[0-9a-f]{64}$/)
            assert.deepEqual({
              observations: evidence.counts.observations,
              pathNodes: evidence.counts.pathNodes,
              status: evidence.completeness.status,
              reasons: evidence.completeness.reasons,
            }, EXPECTED_ON_EVIDENCE[name], 'the recorder saw what the scenario holds')
          } else {
            assert.equal(evidence.completeness.status, 'capture_error', 'an injected fault is reported, never hidden')
            assert.equal(evidence.completeness.reasons.length, 1)
            assert.ok(['recorder_fault', 'finalize_fault'].includes(evidence.completeness.reasons[0]))
            assert.equal(Object.prototype.hasOwnProperty.call(evidence, 'observations'), false)
          }
        }
      })
    }

    await run(`[${handle}][${mode}] structural parities the golden relies on`, () => {
      for (const name of Object.keys(GOLDEN)) {
        const entry = stripped[name]
        if (entry.apply && typeof entry.apply === 'object') {
          // The apply recomputes the content revision the harness derived off the dry-run expansion.
          assert.equal(entry.apply.sourceContentRevision, entry.sourceContent.revision, `${name}: apply vs dry-run content revision`)
        }
        if (entry.archive) {
          // An empty sheet: the archive revision IS the dry-run revision (no people-owned column).
          assert.equal(entry.archive.archiveRevision, entry.archive.revision, `${name}: archive vs dry-run revision on an empty sheet`)
          assert.equal(entry.archive.expansionResultDigest, entry.dryRun.rowsDigest, `${name}: mvp-persist archives the dry-run rows`)
        }
      }
    })
  }

  console.log(`stock-preparation-demand-evidence-golden: ${passed} passed, ${failed} failed`)
  if (failed > 0) throw new Error(`${failed} check(s) failed`)
}

require('./support/fail-closed-suite-runner.cjs').runFailClosedMain('stock-preparation-demand-evidence-golden.test.cjs', main)
