# DingTalk staging OAuth: preserve the active environment source

## Scope and failure

The previous prepare helper always read the checkout's historical env file and passed its candidate as APP_ENV_FILE. When the active Compose service loads a different runtime env file, the candidate can retain stale values and omit active-only settings. A synthetic run of the production build_candidate function reproduced both losses on main 4c78e75a0d.

This change repairs preparation only. It does not configure staging, deploy, enable Stream/lifecycle, execute real UAT, or include 50004. PR #6487 remains a separate Draft R71 candidate.

## Contract

| Gate | Required behavior |
| --- | --- |
| Existing owner gates | Full deployed SHA, healthy backend, explicit OFF posture and exact prepare confirmation remain mandatory. |
| Source identity | Use the running backend's Compose project, working directory, config files and interpolation env labels. Working directory must match staging. |
| Source ambiguity | Require one existing, regular, non-symlink backend env file. Multiple sources or unavailable inputs stop before candidate creation. |
| Runtime consistency | Render using the real Compose parser. Image defaults plus rendered service environment must exactly match the running container environment. Unknown or divergent state fails closed. |
| Preservation | Start from that active env file. Only the dedicated OAuth values, app URL/CORS and four OFF flags may change. |
| Candidate validation | Re-render original Compose inputs with the candidate substituted for every service env_file reference to the active file. Refuse active-file reuse by label_file before building a candidate. Compare the complete resolved model, allowing only the named backend environment changes. An explicit Compose override, an unrelated interpolated service change, or loss/change of an unrelated env value fails before writing. |
| Interpolation inputs | When the active file also supplies explicit --env-file or implicit project .env values, validate the candidate in that role too. File aliases are compared by file identity. |
| Apply and recovery | Existing atomic file replacement targets the resolved active source. Backend-only recreation and rollback use the original Compose inputs. No temporary candidate/override becomes a restart dependency. |
| Flags | Stream and all three lifecycle flags must stay OFF. Status reports Stream independently from lifecycle. |
| Evidence | Config, live env and image env snapshots remain private temporary files and are removed on exit. Public evidence contains outcomes/counts only. |

The installed Compose parser must support config --no-env-resolution and env_file !override; unsupported parsing fails before writes. This does not claim general support for multi-file environment layering: that shape is deliberately rejected until separately reviewed.

## Verification

Run on an isolated workspace with Docker Compose available (config parsing needs no Engine):

```sh
node --test scripts/ops/dingtalk-oauth-staging-config-contract.test.mjs scripts/ops/dingtalk-oauth-staging-config-env.test.mjs
bash -n scripts/ops/dingtalk-oauth-staging-config-remote.sh
pnpm validate:all
```

The behavioral suite uses real Compose parsing, synthetic inspect responses and an Engine shim that refuses mutations. A standalone Compose executable can be supplied through COMPOSE_TEST_BIN. No missing-parser skip is allowed. Both suites run in the path-scoped contract workflow and required test (20.x).

Final focused results: **29/29 passed with zero skipped on Compose 2.38.2 and 5.6.1 separately** (`oauth-compose238-home-final.log`, `oauth-compose561-home-final.log`). Cases cover literal/home-relative/interpolated paths, dotenv selection, active-only and quoted settings, live drift, multiple sources, missing config, project mismatch, OAuth environment overrides, global interpolation effects and candidate removal/change of unrelated keys. Neighbor ops contracts passed 82/82; `pnpm validate:all` exited 0 (`oauth-env-compat-validate.log`). Eight isolated guard removals each produced named assertion failures; source remained unchanged (`oauth-env-home-final-mutations/result.json`). Independent reviews verified shared consumers and the final home-source correction with no remaining findings in this bounded scope. Exact-head CI must still pass on the repair commit; these local results do not waive the initial CI failure.

This verification does not exercise a real Docker recreation, live credentials, platform OAuth, or rollback on staging. Those operational proofs remain a separately authorized window.

Independent review reproduced two previously missed shared consumers: another service env_file and backend label_file. Both were assertion-red before repair. Shared consumers may not cause non-backend effects; active-file label consumers are rejected to prevent secret material becoming labels.

Parser reference: [Docker Compose config](https://docs.docker.com/reference/cli/docker/compose/config/). Local behavior was exercised with Compose 2.38.2 and 5.6.1; actual staging parser compatibility and source-sharing shape must be checked before any authorized prepare operation. Legacy postgres/backend env sharing is intentional in the base Compose; preparation now refuses any resulting configuration changes outside the backend environment.

## Compose 2.x compatibility follow-up

The initial PR head failed eight contract CI cases on the runner's Compose 2.38.2; the same metadata omission was reproduced with 2.40.3. These versions discard env_file metadata during interpolated config output despite --no-env-resolution. The fallback obtains unresolved source expressions, then asks the original Compose project to interpolate them through private temporary labels; it reconstructs only source metadata, without implementing a separate dotenv/interpolation parser or applying that temporary model.

Interpolated Compose config output also doubles literal dollar signs for round-tripping. Decode that representation exactly once before comparing it with actual container bytes, while retaining raw escaping in the unresolved expressions given back to Compose. The fixture explicitly asserts literal environment bytes and includes a source path containing dollar signs, spaces and a hash character. The old fixture incorrectly mirrored serialized env strings; two focused positive controls failed before correcting production decoding.

The initial head's CI failure is not waived; all required checks must succeed on the updated head. Original static status evidence remains read-only and is separate from preparation compatibility.

Home-relative source paths use the same home expansion before project-relative normalization. A regression creates an identical project-local shadow source and asserts the selected path independently in Node, in addition to an explicit shell failure. Without that guard, a wrong file can pass environment/model equality while the active runtime file remains untouched. Both home-source controls were assertion-red before repair and passed on both Compose versions afterward.
