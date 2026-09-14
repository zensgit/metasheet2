# Isolated UAT configuration verification

Status: historical local configuration checkpoint. Its static-only limitations below
describe the 2026-09-12 window. Subsequent independent-guest runtime acceptance is
recorded separately in [the 2026-09-14 report](elearning-isolated-runtime-acceptance-20260914.md).

Historical source snapshot: `d738c2486227170f72bf0241644f91d3ba2615a3`.
This docs-only publication does not include the private/local configuration or
test tooling. Commands below record prior execution in that source worktree;
they are not instructions or claims that these tools exist in this report PR.

Product base: `1c22d3b328f377dface03b222bf57d09f4b7dec0`.
Writer/reviewer: Codex implementation and local static self-review; no independent model
review or runtime acceptance is claimed in this window.

## Gates

- `node --test scripts/ops/elearning-isolated-uat-contract.test.mjs`: 38/38 pass.
- Thirty-seven in-memory configuration mutations must fail validation, then the unchanged
  original passes: shared project; external/internet network; external volume; fixed shared
  container; public port; Docker socket mount; shared env file; shared DB/Redis/store;
  removed memory/CPU/PID limits; app enabled; TLS bypass; mutable product image;
  each of nine missing capability flags; each of five missing pull policies and logging
  configurations; unbounded logging size. Flag names must match the complete exact set and
  every value must be false; logging must be exactly json-file, 5m times two files per service.
  The prior eight-name set omitted WATCH_CHALLENGE (runtime default OFF); the corrected
  census is checked against the canonical backend declarations, not just a duplicated list.
- The hardened positive test failed against the prior template without pull policy
  (`undefined` versus `never`), before the configuration was corrected.
- `docker compose -f docker/elearning-uat/compose.json config --no-interpolate --format json`:
  successful schema render only. No Docker daemon resources are created by this command.
- `node --check scripts/ops/elearning-isolated-uat-contract.test.mjs` and `git diff --check`:
  required before local commit.

## Honest limits

Static mutations prove these configuration guards, not arbitrary future safety or live
isolation. Render uses unresolved required placeholders, not actual secret material. Operator
overrides, certificate permissions, approved dependency image digests, empty volume state,
memory pressure, store minimum resources, runtime readiness, full migration/replay, download
TLS, no-leak tests and complete synthetic training flow still require an execution window.
No shared selector is changed: this dedicated ops test is local-only and not claimed as CI-wired.
No service, database, volume, network, credential or certificate was created in this window.
PG/store disk hard quotas remain absent and are an explicit execution blocker. Offline actual
image ID/OCI revision checks and approved locally present dependency digests remain execution
preconditions, not facts established by this static test.

The shared staging operator was identified separately; whole-environment data classification
remains unknown. Existing attendance synthetic cleanup and health SHA evidence do not establish
that other organizations contain no real data. No shared backup was taken.
