# Time Machine G1 attachment metadata admission verification

Status: local bounded G1 PASS; publication/ordinary CI execution census OPEN.
Baseline `027c0111592a49863ccd053b5f32e8fe7a72bac0` (Draft #6228).
Freshly fetched main remains `8e2e40d1252bdb7104bd0d54b12a397f90ef1f9a`.
Authoritative slice: `multitable-timemachine-attachment-admission-design-lock-20261007.md`.
G2/G3, complete D-H2/D-L/D7 and owner stages remain OPEN.

## Result and source boundary

POST `/attachments` previously uploaded bytes and used an autocommit metadata INSERT.
A committed archive could therefore own the sheet before that INSERT and miss the new object.
With the existing two literal-`true` archive-protection flags selected, a sibling query adapter now
owns only the metadata transaction: source-free RC setup/check, canonical fence, current database
authority intersected with authenticated claims, live sheet/field/record/own-row revalidation,
direct noncached durable block read, original INSERT and confirmed commit.
Every non-null/unknown durable state refuses; an expired `archiving` lease is still a block.

Provider upload and existing refusal cleanup remain outside the ended transaction. The just-uploaded
object alone is cleaned after a known callback refusal. If the metadata callback completed and
COMMIT/release rejected, a module-private error identity withholds cleanup: PostgreSQL may already
have committed and a new claim may already have pinned the object. This returns a closed failure,
does not report 201 or retry, and conservatively retains an object even after a definite COMMIT
failure. It is not a no-orphan proof or a new cleanup worker. Error fields/DTO copies cannot mint
that cleanup exception.

Unselected flags return the original query reference, use original upload/INSERT/error behavior,
and introduce no transaction, fence or post-upload authority lookup. The global normalized legacy
flag and missing-column compatibility cache are unchanged. No new flag, migration, key/generation
mutation, provider/KMS operation, owner bypass or archive runtime caller was added.

| Source | Frozen SHA256 |
| --- | --- |
| attachment-metadata-admission.ts | c936467dc9fed43f8a76b55f27f020c3abf6e59321e3979aa42cb6fec38aa363 |
| attachment-service.ts | 68a2784fe233433538e28e8debd55100301e0485d5bbd0e050cf813ab6166541 |
| univer-meta.ts | c7da4d89f6a8ba419c5b5faa9ce6e9291520c3c57fb55b13a1fce7ca230aae1e |
| native HTTP spec | 6d7175df03641b591fb4223cab928e4009e39a0781c928d6e446f954edc5a1a5 |
| native fixture | 61edd4b1a0b597597f077cb2b4b241495ee284fb0e46c9ad2c09db3d34bf3924 |

## Executed evidence

- New whole unit file: 69 PASS, 0 skip. Existing attachment-service and archive-writer-block
  whole unit files: 33 + 10 PASS. The initially requested old mock API file remains excluded by
  its pre-existing config; the separate read-gate realDB file had 3 no-DB skips and contributes no
  local PASS. Those skips are not included in the 112 unit assertions above.
- New whole native HTTP/PG file: 43 PASS, 0 skip, comprising sentinel 1 and genuine database
  cases 42. Every standard fixture executes 34 actual existing migration ups. The early schema
  negative executes 11 actual existing ups; no fake DDL, disabled guard or fabricated SQL result.
  Principal/provider IO are synthetic; database statements/results and Express routing are real.
- Genuine claim before metadata, claim during provider upload, writer-first fence wait/pin set,
  and claim-first actual fence wait all execute. The latter inherits genuine session RR before
  BEGIN, independently of the production SET, and verifies RC admission and default restoration.
  Draft and record-bound 409 bodies and unchanged metadata/record/pin sets are exact.
- Actual post-upload sheet/field/type/record/scope/creator drift, inactive account, legacy/direct/
  role global revocations and stale-admin narrowing refuse. Fifteen actual unselected flag pairs
  preserve exact old HTTP/provider/query behavior; the unit matrix adds other literal spellings.
- A real metadata COMMIT is followed by an injected lost ACK. A separate native connection sees
  the row and idle backend; a genuine claim pins it before the failure is released. The response
  is closed 503 and provider deletion remains zero. Ordinary refusals clean only the new object;
  failed cleanup preserves the refusal and remains best effort.
- Eight source mutations each run the entire 43-case file, actual exit 1, matching named raw
  AssertionError, no skips: block, canonical fence, inherited RR plus isolation guard, current
  principal, field type, own-row policy, private uncertain-COMMIT brand, and cleanup retention.
  Exact input bytes are saved; only the intended production file differs per mutation. Every
  source is restored exactly. Final whole file: 43 PASS, 0 skip, actual exit 0.
- Node wiring/behavior: 15 PASS, 0 skip, including 18 armed realDB children failing their exact
  missing-DATABASE_URL sentinel. The new spec is excluded from no-DB collection and whole-file
  registered in the required Node 20 realDB step. Actual existing standalone package provenance
  guard exits 0; only `evidenceFiles.pluginTestsWorkflow` changed to
  `1767cde60c78e8635bcdbc82eff279418e1f3579f7315098ed1b8fc690d39985`.
- The existing OpenAPI upload contract now documents the selected-path 409 and uncertain-result
  503 using ErrorResponse. Bundled YAML/JSON and SDK types are regenerated. `pnpm openapi:build`
  and `pnpm openapi:guard` both exit 0.
- Frozen focused TypeScript and `pnpm validate:all` exit 0. The latter includes backend
  `tsc --noEmit`, archive-acceptance script compilation and configured web type checks.
- Dedicated native PG15: scratch databases/other clients zero before official fast stop, actual
  exit 0, PID/listener/postmaster.pid absent and TCP refused, private profile removed. Root also
  checks PID/listener/file/profile absence. Initialized stopped data and essential logs remain.

Evidence directory: `artifacts/tm-attachment-admission-20261007/` (ignored, retained locally).
Root native/mutation readback SHA256:
`77b718625982fb73eee599f668e8b2174549ad69be33a3a303c861a7824f042d`.
Native cleanup manifest SHA256:
`767fbb53e80a4476880f97427f6d78cf038ddad6cd43eef8bf0d07ebb9800e4a`.
Root quality/cleanup readback SHA256:
`d42114363fd70452a0e1a7757742002d39440e9749ef02963c98ab71317617e5`.
Root live cleanup check SHA256:
`acffac3202136b093215d9f7b470db50a046c2c5e2e37ee62131a3744d755f09`.

Initial adapter `getInternalPool` failure, earlier test-only type/matcher errors, and both root
reader errors are retained. Vitest JSON omits the error class and groups parameterized FAIL
headers; matching raw AssertionError sections and actual process exits qualify the final REDs.
None of those earlier failures is relabeled PASS or hidden by the final result.

## Reproduction and gates

Use DATABASE_URL for an owned disposable native PG; the spec creates/drops namespaced databases.
The cleaned private profile is intentionally unavailable. Executed test selections (reporter/output arguments are retained in process receipts):

```sh
METASHEET_REAL_DB_TEST_STEP=1 NODE_ENV=test pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/multitable-recovery-archive-attachment-admission-realdb.test.ts
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-attachment-metadata-admission.test.ts
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-attachment-service.test.ts tests/integration/multitable-attachments.api.test.ts tests/integration/multitable-attachment-readgate.security.test.ts tests/unit/multitable-recovery-archive-writer-block.test.ts
node --test scripts/ops/multitable-d2-archive-ci-wiring.test.mjs scripts/ops/multitable-d2-archive-fail-not-skip.test.mjs
node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs
pnpm openapi:build
pnpm openapi:guard
pnpm validate:all
```

| Lock gate | State | Evidence/boundary |
| --- | --- | --- |
| Real HTTP refusal, both directions | Local PASS | Genuine claim, exact response/state, actual native waits |
| Current authority/target revalidation | Local PASS | Fresh native revocations/drift and own-row policy |
| Provider IO and cleanup | Local PASS | Outside metadata TX; true committed/lost-ACK preserves pinned object |
| Flag parity | Local PASS | Actual HTTP matrix plus exact-query unit matrix |
| Guard refutation and local CI contract | Local PASS | 8 whole-file matching REDs; restored PASS; armed fail-not-skip |
| Ordinary exact-source CI execution | OPEN | Unique dispatch and raw terminal census required after publication |
| Full source writer closure | OPEN | G2 foreign-link reset and G3 retention, then remaining census/races |
| Complete D-H2/D-L and D7 | OPEN | Bytes/crypto/nonce/future coverage/finalize/abandonment/lifecycle/runtime |
| Owner stages | OPEN | Exact-SHA ratification, merge, flags, deployment and staging input |

This is not a new-source APFS rehearsal, full archive composer, independent durable/KMS qualification,
real-data acceptance or production enablement. Retained historical rehearsal and LC1..6 are unchanged.

## Exact-source CI collection correction

The original ordinary run 37562837310 at source `9a07ffd313a8463de59d329ac6901199c1f82f19`
is terminal FAILURE, not acceptance. Both Node lanes failed the same six cases in the exhaustive
field-schema fence-holder guard because the new attachment metadata holder was not ledgered.
Each lane actually ran the new admission unit69, attachment service33 and writer-block10 successfully;
field-holder guard43 passed/6 failed. The preceding core-backend failure skipped DB migration and
multitable real-DB steps, so this run did not execute the new whole native43 file. Four other jobs
succeeded; coverage was metadata-only skipped. Root verified exact source/tree/parent, all18 changed
Git blobs/bytes and six raw logs with18 continuous206 ranges. Two evidence-index relative path prefixes
have an additive corrected index/erratum; original receipts, raw failure and source are preserved.

Root reproduced the whole49-case guard at actual exit1,43 PASS/6 FAIL/0 skip before changing it.
The correction registers only `bindAttachmentMetadataAdmission :: acquireCanonicalSheetFence` as a
metadata-only holder: its real caller is storeAttachment's multitable_attachments INSERT; it reads
current field/row authority after the fence and writes no meta_records.data. No scanner assertion,
region check, existing classification or standing negative was removed. One in-memory real-source
counterexample adds a record-data UPDATE to that holder and proves guard C rejects the new write.
The whole guard now has50 cases, with all original49 preserved.

Four focused files now pass162/162,0 skip: admission69 + attachment service33 + writer-block10 +
field-holder guard50. Removing exactly the new ledger row produces7 named raw AssertionError failures
in the whole50-case guard, including the new counterexample; restoring exact bytes returns the same
four whole files to162 PASS/0 skip/actual exit0. All production source and the original native fixture/spec
remain byte-identical. Original local whole43 native evidence and eight production guard mutations
remain separately qualified; no test-only collection correction repeats or upgrades that native proof.

Process exits, before/final input SHA, raw logs/reporters and exact restoration are retained under
`artifacts/tm-attachment-admission-20261007/ci-collection-fix-20261007/`. Independent terminal failure
readback is `artifacts/tm-attachment-admission-ci-20261007/root-failed-ci-independent-readback-20261007.json`.
A corrected-source ordinary CI must execute the whole native file; its execution gate remains OPEN
until the new source's terminal logs are qualified. The failed source run is not retried.

| Additional gate | State |
| --- | --- |
| Missing-holder failure reproduced before correction | PASS: original whole49,43 PASS/6 FAIL/0 skip,actual exit1 |
| Truthful metadata-only census registration with data-write counterexample | PASS: whole50 + unchanged admission/service/writer neighbors,162 PASS/0 skip |
| Omission refutation and exact restoration | PASS: omitted row7 matching AssertionError RED, restored whole162 PASS |
| Corrected-source configured validation / source publication / CI | validate:all actual exit0; publication and new-source CI OPEN pending receipts |
| Complete TM / G2 / G3 / D-H2 / D-L / D7 / owner stages | OPEN |
