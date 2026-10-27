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
// STOCK-PREPARATION-BOM.V3 — NOT A RECAPTURE. PLM version identity stamps `bomEvaluationVersion`
// (literal `stock-preparation-bom.v3`) on the large job, its artifact and its plan artifact, links the
// plan artifact to its artifact (`sourceArtifactRevision`) and hashes the version into the artifact and
// plan revisions. On every leg that moves exactly `large.artifactRevision`, `artifactDigest`,
// `planRevision`, `planArtifactDigest` and `storedJobDigest` of the three large scenarios, and no
// literal above was changed for it. `observed.large` keeps recording the REAL v3 results; this suite
// (a) asserts the v3 contract on the real objects — the literal on job / artifact / plan artifact /
// apply job, the source link, both revisions recomputed with the version from the raw expansion and the
// stored plan — and that the unprojected large lane moved exactly those five keys; (b) compares GOLDEN
// through the harness's `projectLargeToLegacyMain771`, which drops only the four version keys and
// re-mints the two revisions with main 771170234's frozen recipes; (c) compares the UNPROJECTED ON /
// THROWING legs to OFF in full; (d) calibrates that row or plan drift fails the projection and a
// version-free hash input or a wrong / missing link or version fails the contract. On the ABSENT handle (batch-refresh
// step 4 PR-3b) the large approval is refused and the capture carries `applyJob: null`: the apply-job leg of the
// contract is the WIRED handle's, and `large.targetRevision` is the refusal token (see `goldenFor`).
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
  LEGACY_MAIN771_RECIPES,
  MODES,
  SCENARIOS,
  STOCK_PREPARATION_BOM_V3,
  actionFor,
  assertLargeV3Contract,
  installExpansionCaptureSwitch,
  largeObservation,
  observeAll,
  projectLargeToLegacyMain771,
  resealLargeCapture,
  routeShapedLargeExpansionOptions,
  stripHarnessKeys,
} = require('./support/stock-preparation-demand-evidence-golden-harness.cjs')

const { DEMAND_EVIDENCE_SCHEME } = require('../lib/stock-preparation-demand-evidence.cjs')

const GOLDEN_BASE_SHA = 'fae8946d19efaadc615b50758cd6f4a50d43a14e'

// The large keys the v3 version identity moves (see the header); every other key stays as GOLDEN.
const V3_MOVED_LARGE_KEYS = Object.freeze(['artifactRevision', 'artifactDigest', 'planRevision', 'planArtifactDigest', 'storedJobDigest'])

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
      evidenceDigest: '866a96580532ee699c44c7ce7954c88acea8dbb37fa6fae1aab61058e167509f',
      responseDigest: 'b3f6e12b0de436359faf5eb7eea13afa8e8e2abc40dd2c345d7cf9285992e480',
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
      evidenceDigest: '866a96580532ee699c44c7ce7954c88acea8dbb37fa6fae1aab61058e167509f',
      expansionResultDigest: '39c3d3f78e4fa255d5ed63d837669cee672693adca4a1832d2f4f2bfb6eeaf9f',
    },
    apply: {
      status: 'succeeded',
      dryRunRevision: 'b2b6dde7149d4d7ece00a65abb840d9d0a1367d5a264a96abf47cc789ba83082',
      sourceContentRevision: 'd46310f6fa79916502c299e87889ec294347b22a9f22a94a9ae3a338fb69c78d',
      responseDigest: '6153a65b8c7e44c8352352a7c7eac689236a7598f729fc99668e790320251b56',
      writtenRowsDigest: '9f08e4c04d830e44c6a4ec2b2c03fddc23b35cbbd1efd1edf181f6692f930ee8',
    },
    large: {
      status: 'completed',
      artifactRevision: 'ab7ed3a41cffdf2ab31f1f45104561812701cfc92516b41645769f5590f67cc3',
      artifactDigest: '9263664e3f879dcb85a63853d7fbcfe96e0ed1c3a0e470ed0072dcfb630f4080',
      planRevision: 'c7bf5209e652a62082e2d371db059c2f3b7346d89a8c44e6b614a38b45b7a8c8',
      planArtifactDigest: '43159239974e2c13b36cb62eda770636fe83bb9a8a35dcf469ee0485057521b4',
      targetRevision: '472472d045b7223785e68e092dc2a500102457f084c5a1e971c6b5b59b4ed449',
      publicJobDigest: '7c1b12faf7b28c900817a4718ddacae75eff5181c2eb4804df0c517a77ec99ea',
      storedJobDigest: 'd57f477a197e1f5b7416a1ac5b71e13dc51fa09160be79d5dde7def3f5aecc07',
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
      evidenceDigest: '39e1472d89a8d731bcb9b9ea33213aedd8751593455ed7b74beed04ebd9dd427',
      responseDigest: '2b5485206f6c82fb1fad050179d3534ed631912450d0a2e411278592c3b8e5e7',
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
      evidenceDigest: '39e1472d89a8d731bcb9b9ea33213aedd8751593455ed7b74beed04ebd9dd427',
      expansionResultDigest: '67c724d99c5adc5a73763715303ca6f3bd49c89823fdffeba87399f5d6a0481e',
    },
    apply: {
      status: 'succeeded',
      dryRunRevision: '74e81652f5fdc97c28d771f883859650a1aaf1de45125198055f8f752a8e38e3',
      sourceContentRevision: '8d601edc3b62739c50898f4ba2ac790d6c74b244b87d1038fe379ff14936afb9',
      responseDigest: '1d8fb5163618a70cae011096951df62e18763e93ce6f734f93c0b524244f91dc',
      writtenRowsDigest: 'e1c6677ad2814516433828740a2cb2f0f60e66d2bb7028996a6ae95bc036dca8',
    },
    large: {
      status: 'completed',
      artifactRevision: 'c6d16ba67fedb98f785931ce38f532b963aba4a90315cba60fdbdccd2544c0e1',
      artifactDigest: 'a8551a847015afb8ef11de9590cca1ccb305ca6af2cf78777c26e5d74d72477c',
      planRevision: '9d6b371391f66f31ce10bb43c6c7c93ca37a55754fe38922607f5dbb0f487473',
      planArtifactDigest: '9bbde8aff46e3fc66743490d8dd438e4847036c0fbb8c938cec6fa538e037f77',
      targetRevision: '472472d045b7223785e68e092dc2a500102457f084c5a1e971c6b5b59b4ed449',
      publicJobDigest: '23c4cb3b85503d5f3f90351bc74e4ba4d4d954556b448b338518260bd25e5ea7',
      storedJobDigest: '3c7aae4b9cabb4f4409b791614c14cc27688315ebce085a61faed836a8c71e69',
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
      evidenceDigest: '93c031a23cc88a37a589910b644a2df00803be2f54ed2b4ac9deb56dc0bb1959',
      responseDigest: '0cb719cee5ab89feb2eb54cbdaa3ce99377c23e9a925ed78c16cd4635e8ad82f',
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
      evidenceDigest: 'be505c4c918d703287b46b204cc35d2e46eca4f9af01c917cd0b65dda24e9a96',
      responseDigest: '7a9687d2c4c17c4b5988f792790a026f62cb9be65dcf93fed3c2f10967c5ce35',
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
      evidenceDigest: 'aff5ca48f6bbb825cadbc8692ebf8103a521b053894d5555ff3922d57f01ee54',
      responseDigest: '0ff6bf202e24037b4c692235430e115bef1e238620ad28c81972eba8a393c444',
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
      evidenceDigest: '271012c3b67cca748dc2c05614329eacd1c3a11f10280f0704c3cb4248c9d691',
      responseDigest: '36a4adf18b05fde20016830032f8357b5d56fe04e81c014829a1e17a9ce65a48',
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
      evidenceDigest: '271012c3b67cca748dc2c05614329eacd1c3a11f10280f0704c3cb4248c9d691',
      expansionResultDigest: '2a1e02e4e53b2de0e0b299fc05849f550d993a64840534b8b0946c63288a8fad',
    },
    apply: {
      status: 'succeeded',
      dryRunRevision: '71a384c5fcb7336ecc633ea0a080e20a376191b43cbc684d6715eb66dfaa02ab',
      sourceContentRevision: 'c0550f4a77e4275cd41766b66a93db54b6ae2bd9c20e4c47156cf5d072c72fdb',
      responseDigest: '82961223769132119ea69f90f1bc9785b9566c282d2a7835731976af292d8ae6',
      writtenRowsDigest: '44ce67507b09c1111821534f940e8c4b19e7cd92bc0d27c40226898c9c809f01',
    },
    large: {
      status: 'completed',
      artifactRevision: '92391f84fdb05f0eb1774590cf548fc87ddcd88ef55e31a923c81497913cbc84',
      artifactDigest: '5fd8a18817bfcab6f09b66a92f209827075e398a76855ee5827e256c8de3f9e6',
      planRevision: '172c3444d2ea4a448deaab65ba529eae5a6f5ea0ff17817dad671002d9834359',
      planArtifactDigest: 'f5e7dd3404811761262ac0c8c51c9a3fe5a4f66177a2c0611e403bbc86f2c51a',
      targetRevision: '472472d045b7223785e68e092dc2a500102457f084c5a1e971c6b5b59b4ed449',
      publicJobDigest: 'fe00e99742537755df79be530064a5aa87430d2ce0852a65482ec8453a561a5b',
      storedJobDigest: '15da5df41bf6221ec5e762899b097db38905a8ce13274402fa6058ba6ad2853a',
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
      evidenceDigest: '3cc8e19b355927014dbb0056b30a96535161064962fae3e3664b65cfc2af1916',
      responseDigest: '0104841e35b6b1990fc19738245952022c46d0b5e9bcf80877744ae01bc587b7',
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
  // Production's hash function; the revision inputs are restated independently in the harness.
  const hashJson = harness.largeBomJobs.__internals && harness.largeBomJobs.__internals.hashJson

  await run('the large-BOM evaluation version is the literal stock-preparation-bom.v3', () => {
    assert.equal(STOCK_PREPARATION_BOM_V3, 'stock-preparation-bom.v3')
    assert.equal(harness.expansionModule.STOCK_PREPARATION_BOM_EVALUATION_VERSION, 'stock-preparation-bom.v3')
    assert.equal(typeof hashJson, 'function', 'stock-preparation-large-bom-jobs.cjs still exposes __internals.hashJson')
    assert.deepEqual([...MODES], ['off', 'on', 'throwing'])
  })

  // The historical lens: a large scenario goes through the main771 legacy projection (which asserts the
  // v3 contract first, so a missing version or link fails instead of being stripped); every other
  // scenario is compared exactly as observed.
  const historical = (name, entry, large) => {
    if (!GOLDEN[name].large) {
      assert.equal(large, undefined, `${name}: no large capture for a scenario without a large lane`)
      return entry
    }
    return projectLargeToLegacyMain771(entry, large, { hashJson })
  }

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

  for (const handle of ['wired', 'absent']) {
    const observedByMode = {}
    const strippedByMode = {}
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
    for (const mode of MODES) {
      const observed = await observeAll(harness, mode, undefined, { handle })
      const stripped = stripHarnessKeys(observed)
      observedByMode[mode] = observed
      strippedByMode[mode] = stripped

      await run(`[${handle}][${mode}] every golden scenario was observed`, () => {
        assert.deepEqual(Object.keys(stripped).sort(), Object.keys(GOLDEN).sort())
      })

      for (const name of Object.keys(GOLDEN)) {
        if (GOLDEN[name].large) {
          await run(`[${handle}][${mode}] ${name}: the large lane carries the literal ${STOCK_PREPARATION_BOM_V3} on job / artifact / plan artifact / apply job, linked and recomputable`, () => {
            // PR-3b: only the ABSENT handle's approval is refused (no apply job to carry the literal); the WIRED one is a job.
            assert.equal(observed[name].__large.applyJob === null, handle === 'absent', 'the apply job is present exactly on the wired handle')
            assertLargeV3Contract(observed[name].__large, { hashJson })
          })
          await run(`[${handle}][${mode}] ${name}: unprojected, the v3 identity moves exactly the version-bearing large keys`, () => {
            const { large: actualLarge, ...actualRest } = stripped[name]
            const { large: goldenLarge, ...goldenRest } = goldenFor(name)
            assert.deepEqual(actualRest, goldenRest)
            assert.deepEqual(Object.keys(actualLarge).sort(), Object.keys(goldenLarge).sort())
            for (const key of Object.keys(goldenLarge)) {
              if (V3_MOVED_LARGE_KEYS.includes(key)) assert.notEqual(actualLarge[key], goldenLarge[key], `large.${key} carries the version identity`)
              else assert.equal(actualLarge[key], goldenLarge[key], `large.${key} is version-free`)
            }
          })
        }
        await run(`[${handle}][${mode}] ${name}: every hash and identity matches the ${GOLDEN_BASE_SHA.slice(0, 9)} golden`, () => {
          assert.deepEqual(historical(name, stripped[name], observed[name].__large), goldenFor(name))
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

    // The ON / THROWING legs against OFF, UNPROJECTED and in full: the projection is a historical lens
    // only and never stands between the legs.
    for (const mode of MODES) {
      if (mode === 'off') continue
      await run(`[${handle}][${mode}] the full unprojected observation equals the off leg`, () => {
        assert.ok(strippedByMode.off, 'the off leg ran')
        assert.deepEqual(strippedByMode[mode], strippedByMode.off)
      })
    }

    // NEGATIVE CALIBRATION over the off leg's real captures. `resealLargeCapture` re-mints a mutated capture
    // with the chosen recipes, so each case is self-consistent except for the one thing it breaks.
    const isAssertion = (pattern) => (error) => error instanceof assert.AssertionError && pattern.test(error.message)
    for (const name of Object.keys(GOLDEN).filter((key) => GOLDEN[key].large)) {
      const large = observedByMode.off && observedByMode.off[name].__large
      const resealed = (options = {}) => {
        const next = resealLargeCapture(large, { hashJson, ...options })
        return { next, entry: { ...strippedByMode.off[name], large: largeObservation(harness.largeBomJobs, next) } }
      }
      await run(`[${handle}][calibration] ${name}: an unmutated reseal reproduces the real capture and the golden`, () => {
        const { next, entry } = resealed()
        assertLargeV3Contract(next, { hashJson })
        assert.deepEqual(entry, strippedByMode.off[name])
        assert.deepEqual(projectLargeToLegacyMain771(entry, next, { hashJson }), goldenFor(name))
      })
      await run(`[${handle}][calibration] ${name}: a drifted large row fails the historical projection`, () => {
        const { next, entry } = resealed({
          mutate(capture) {
            const holders = [capture.rawExpansion, capture.ran.artifact]
            if (Array.isArray(capture.planned.artifact && capture.planned.artifact.rows)) holders.push(capture.planned.artifact)
            for (const holder of holders) {
              assert.ok(Array.isArray(holder.rows) && holder.rows.length > 0, 'the large lane expanded rows')
              holder.rows[0] = { ...holder.rows[0], calibrationDrift: 'synthetic' }
            }
          },
        })
        assertLargeV3Contract(next, { hashJson })
        const projected = projectLargeToLegacyMain771(entry, next, { hashJson })
        assert.notEqual(projected.large.artifactRevision, GOLDEN[name].large.artifactRevision)
        assert.notDeepEqual(projected, goldenFor(name))
      })
      await run(`[${handle}][calibration] ${name}: a drifted plan decision count fails the historical projection`, () => {
        const { next, entry } = resealed({
          mutate(capture) {
            const counts = capture.planned.planArtifact.plan.counts || {}
            const key = Object.keys(counts).find((field) => typeof counts[field] === 'number')
            assert.ok(key, 'the plan carries numeric counts')
            counts[key] += 1
          },
        })
        assertLargeV3Contract(next, { hashJson })
        const projected = projectLargeToLegacyMain771(entry, next, { hashJson })
        assert.equal(projected.large.artifactRevision, GOLDEN[name].large.artifactRevision, 'the row side did not move')
        assert.notEqual(projected.large.planRevision, GOLDEN[name].large.planRevision)
        assert.notDeepEqual(projected, goldenFor(name))
      })
      await run(`[${handle}][calibration] ${name}: an artifact revision minted without the version fails the v3 contract`, () => {
        const { next, entry } = resealed({ artifactRevisionOf: LEGACY_MAIN771_RECIPES.artifactRevision })
        assert.throws(() => assertLargeV3Contract(next, { hashJson }), isAssertion(/v3 artifact revision/))
        assert.throws(() => projectLargeToLegacyMain771(entry, next, { hashJson }), isAssertion(/v3 artifact revision/))
      })
      await run(`[${handle}][calibration] ${name}: a plan revision minted without the version fails the v3 contract`, () => {
        const { next, entry } = resealed({ planRevisionOf: LEGACY_MAIN771_RECIPES.planRevision })
        assert.throws(() => assertLargeV3Contract(next, { hashJson }), isAssertion(/v3 plan revision/))
        assert.throws(() => projectLargeToLegacyMain771(entry, next, { hashJson }), isAssertion(/v3 plan revision/))
      })
      await run(`[${handle}][calibration] ${name}: a missing or wrong plan-artifact source link fails the v3 contract`, () => {
        for (const mutate of [
          (capture) => { delete capture.planned.planArtifact.sourceArtifactRevision },
          (capture) => { capture.planned.planArtifact.sourceArtifactRevision = '0'.repeat(64) },
        ]) {
          const { next, entry } = resealed({ mutate })
          assert.throws(() => assertLargeV3Contract(next, { hashJson }), isAssertion(/sourceArtifactRevision/))
          assert.throws(() => projectLargeToLegacyMain771(entry, next, { hashJson }), isAssertion(/sourceArtifactRevision/))
        }
      })
      await run(`[${handle}][calibration] ${name}: a missing or wrong version on any holder fails the v3 contract and the projection`, () => {
        const holders = {
          runJob: (capture) => capture.ran,
          runArtifact: (capture) => capture.ran.artifact,
          plannedJob: (capture) => capture.planned,
          plannedArtifact: (capture) => capture.planned.artifact,
          planArtifact: (capture) => capture.planned.planArtifact,
          // PR-3b: the ABSENT handle's approval was refused — there is no apply job to carry (or lose) the literal.
          ...(large.applyJob === null ? {} : { applyJob: (capture) => capture.applyJob }),
        }
        for (const [label, holderOf] of Object.entries(holders)) {
          for (const breakVersion of [
            (holder) => { delete holder.bomEvaluationVersion },
            (holder) => { holder.bomEvaluationVersion = 'stock-preparation-bom.v4' },
          ]) {
            const { next, entry } = resealed({ mutate: (capture) => breakVersion(holderOf(capture)) })
            assert.throws(() => assertLargeV3Contract(next, { hashJson }), isAssertion(/bomEvaluationVersion/), label)
            assert.throws(() => projectLargeToLegacyMain771(entry, next, { hashJson }), isAssertion(/bomEvaluationVersion/), label)
          }
        }
      })
      await run(`[${handle}][calibration] ${name}: an artifact revision alias downgraded to its old revision fails the v3 contract and the projection`, () => {
        // Old (version-free) revisions from a real reseal; each case downgrades exactly one alias of an otherwise v3 capture.
        const old = resealLargeCapture(large, {
          hashJson,
          artifactRevisionOf: LEGACY_MAIN771_RECIPES.artifactRevision,
          planRevisionOf: LEGACY_MAIN771_RECIPES.planRevision,
        })
        const oldArtifactRevision = old.ran.artifactRevision
        const oldPlanRevision = old.planned.planRevision
        const cases = [
          { label: 'ran.artifact.revision', pattern: /run job artifact\.revision alias/,
            downgrade: (capture) => { capture.ran.artifact.revision = oldArtifactRevision } },
          { label: 'planned.artifact.revision', pattern: /planned job artifact\.revision alias/,
            downgrade: (capture) => { capture.planned.artifact.revision = oldArtifactRevision } },
          { label: 'planned.planArtifact.revision', pattern: /plan artifact revision alias/,
            downgrade: (capture) => { capture.planned.planArtifact.revision = oldPlanRevision } },
          { label: 'planned.planArtifact.artifactRevision', pattern: /plan artifact artifactRevision alias/,
            downgrade: (capture) => { capture.planned.planArtifact.artifactRevision = oldArtifactRevision } },
        ]
        assert.notEqual(oldArtifactRevision, large.ran.artifactRevision, 'the old artifact revision differs from the v3 one')
        assert.notEqual(oldPlanRevision, large.planned.planRevision, 'the old plan revision differs from the v3 one')
        for (const { label, pattern, downgrade } of cases) {
          // Downgrade after the reseal so the reseal cannot rewrite the alias back; observe the downgraded capture.
          const { next } = resealed()
          downgrade(next)
          const entry = { ...strippedByMode.off[name], large: largeObservation(harness.largeBomJobs, next) }
          assert.throws(() => assertLargeV3Contract(next, { hashJson }), isAssertion(pattern), label)
          assert.throws(() => projectLargeToLegacyMain771(entry, next, { hashJson }), isAssertion(pattern), label)
        }
      })
    }
  }

  console.log(`stock-preparation-demand-evidence-golden: ${passed} passed, ${failed} failed`)
  if (failed > 0) throw new Error(`${failed} check(s) failed`)
}

require('./support/fail-closed-suite-runner.cjs').runFailClosedMain('stock-preparation-demand-evidence-golden.test.cjs', main)
