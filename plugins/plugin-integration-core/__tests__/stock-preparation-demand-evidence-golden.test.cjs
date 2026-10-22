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
const {
  MODES,
  installExpansionCaptureSwitch,
  observeAll,
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
      artifactRevision: '696b360c987b350bac7686783e9a6ce11f0e02595493ceb7184ac231f9519ddd',
      artifactDigest: 'ff75063b72609ef30ba88321004d11300061ecd8e8e52277bf7e6ac6c21fe387',
      planRevision: '301c321f477082411e5effe286229620ddb7260ef6c76d0af31002faa822cdda',
      planArtifactDigest: '5fb81318ac7d9ccc98c212e4712d47c1f5e501c83f11b937da007ac883136b45',
      targetRevision: '8646594765bcf5c667e34f34b9ec64f140776fd5e8b7e16cf90ac3b29699d461',
      publicJobDigest: '0b3b25e9c8b316cfde4c5234dbea0e48d995234dd01133732ac9c69919e4842e',
      storedJobDigest: 'b829e2397c516ce8e03590b4725806eb02bfc1cbd95769911849f89b501ef747',
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
      artifactRevision: 'a43990d2dca5f76d1cbf46a696f8b64e6c2cfffefef343738df7b09a353f223e',
      artifactDigest: '2dc97505ac654af19e4c1750136d7a74a40f9d5b0b12deef79d49e49fd5cd217',
      planRevision: 'e93ba3748a4eab09f776890a95b6fcadd5e29c5424f467b2610a12b9e1648fc9',
      planArtifactDigest: '128edb63afaa0d800ebd039d250f66b99670c879e0a0efe36481ddac16eb8601',
      targetRevision: '8646594765bcf5c667e34f34b9ec64f140776fd5e8b7e16cf90ac3b29699d461',
      publicJobDigest: '704887f8e739d402871bdbbe83c43700e89bb2b9a678872cb41f5a5db6fb8527',
      storedJobDigest: 'c4f8c64f06fa5292355957de6470bdfb4ec5c2a71c4688df3ce4bd2d291e0aab',
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
      artifactRevision: '3f07f5969268b9158d0704ccbd8b09cf9600f1371f26b51f0b51496029ab6633',
      artifactDigest: '18a04c1b3c7b7e8ed23ff49fffaa6e40a39b6d608ae9c41217d1ddd61c1b1170',
      planRevision: '0c356c75850e8d930f579444530df7cc7891725181e1117b6365255b2d786757',
      planArtifactDigest: '57a876251a930c93d2302cb4803161662d0fc436ff82591270bb18082e6760b0',
      targetRevision: '8646594765bcf5c667e34f34b9ec64f140776fd5e8b7e16cf90ac3b29699d461',
      publicJobDigest: '703f5978b4a65dcbfe9a8e9de2ca66662d5d61a341003e3960e487b9b27e4c68',
      storedJobDigest: 'a724e3f023eefd8910e605484cfdaa812177188927166d83743340b39c5cdd92',
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

  for (const mode of MODES) {
    const observed = await observeAll(harness, mode)
    const stripped = stripHarnessKeys(observed)

    await run(`[${mode}] every golden scenario was observed`, () => {
      assert.deepEqual(Object.keys(stripped).sort(), Object.keys(GOLDEN).sort())
    })

    for (const name of Object.keys(GOLDEN)) {
      await run(`[${mode}] ${name}: every hash and identity matches the ${GOLDEN_BASE_SHA.slice(0, 9)} golden`, () => {
        assert.deepEqual(stripped[name], GOLDEN[name])
      })
      await run(`[${mode}] ${name}: the switch carried every expansion of the scenario`, () => {
        assert.equal(observed[name].__expansionCalls, EXPECTED_EXPANSIONS[name])
        for (const call of observed[name].__calls) {
          assert.equal(call.mode, mode)
          assert.equal(Object.prototype.hasOwnProperty.call(call.input, 'demandEvidence'), mode !== 'off',
            `[${mode}] the expander input ${mode === 'off' ? 'must not' : 'must'} carry demandEvidence`)
        }
      })
      // The ON legs are only a byte-identity proof if the recorder really ran (or really faulted).
      await run(`[${mode}] ${name}: the expansion ${mode === 'off' ? 'carries no' : 'carries the'} demand evidence`, () => {
        for (const call of observed[name].__calls) {
          const evidence = call.result.demandEvidence
          if (mode === 'off') {
            assert.equal(Object.prototype.hasOwnProperty.call(call.result, 'demandEvidence'), false, 'capture off adds no key')
            continue
          }
          assert.equal(evidence.scheme, DEMAND_EVIDENCE_SCHEME)
          if (mode === 'on') {
            assert.ok(['complete', 'incomplete', 'project_not_found'].includes(evidence.completeness.status))
            assert.match(evidence.fingerprint, /^[0-9a-f]{64}$/)
          } else {
            assert.equal(evidence.completeness.status, 'capture_error', 'an injected fault is reported, never hidden')
            assert.equal(evidence.completeness.reasons.length, 1)
            assert.ok(['recorder_fault', 'finalize_fault'].includes(evidence.completeness.reasons[0]))
            assert.equal(Object.prototype.hasOwnProperty.call(evidence, 'observations'), false)
          }
        }
      })
    }

    await run(`[${mode}] structural parities the golden relies on`, () => {
      for (const name of Object.keys(GOLDEN)) {
        const entry = stripped[name]
        if (entry.apply) {
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
