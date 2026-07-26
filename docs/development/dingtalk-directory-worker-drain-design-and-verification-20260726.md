# DingTalk directory worker-drain design and verification

Status: REVIEW-READY / NOT DEPLOYED

Date: 2026-07-26

Base: Phase A `c914ead0b21592392a6ebd38047c2ac54dc2fb78`

Runtime flags: unchanged

## 1. Purpose

The corp-scope schema expansion must not run while a pre-Phase-A worker can still match DingTalk
identities without the enterprise scope. A successful health check or a new container existing is
not proof that the old worker is gone.

This gate makes a staging deployment prove one managed backend worker is running the exact Phase A
artifact and is the only running container publishing the fixed staging backend port before
Phase B is eligible to migrate.

## 2. Locked contract

The trusted build path:

1. accepts only a full 40-character lowercase commit SHA;
2. requires the source checkout HEAD to equal that SHA and the checkout to be clean;
3. builds from `git archive` of the SHA, excluding ignored or post-check files from the context;
4. injects commit, image tag, repository source, and build time into both image builds;
5. verifies the OCI revision label and records each immutable Docker image ID in an external
   provenance JSON file;
6. writes that file with mode `0600`.

The provenance file is operator chain-of-custody evidence, not a cryptographic signature. The
deploy requires a regular, non-symlink file owned by the deploy user with mode `0400` or `0600`.
The trust model assumes the staging host, deploy user, and exact-archive build invocation are
controlled. A party that controls both Docker and that deploy user can forge the local evidence;
registry signing is outside this slice.

The deploy path:

1. accepts only the same full SHA and matching provenance JSON;
2. fixes every Compose invocation to the exact `metasheet2-dingtalk-staging` project and rejects
   any override before Compose mutation, so the staging compose file cannot target production;
3. restricts the health probe to `http://127.0.0.1:18900/health`;
4. applies Compose with `--remove-orphans`;
5. requires exactly one backend container in the managed Compose project;
6. requires the only running container publishing host port `18900` to be that same backend;
7. requires the complete running service set to be exactly `backend`, `postgres`, `redis`, `web`;
8. verifies configured image reference, immutable image ID, OCI revision, and health build commit;
9. emits one values-free PASS only after every check succeeds:

   ```text
   WORKER_DRAIN_GATE_PASS expected_project_workers=1 observed_project_workers=1 managed_project_old_workers=0 staging_ingress_workers=1 staging_ingress_unmanaged_workers=0 build_commit_match=1 image_match=1 image_id_match=1 revision_match=1 project_services_match=1
   ```

External owner/tag/URL/provenance values and external paths are checked for control characters
before this gate's value-bearing logging, so they cannot forge a PASS line. Identity mismatch
refusals remain values-free. The shared env-file validator may print a sanitized file path for
operator diagnosis; paths must not contain secrets.

## 3. Operational boundary

The PASS is a point-in-time assertion scoped to the managed Compose project and the fixed staging
backend ingress on host port `18900`. It is not a host lock, does not inventory unrelated host
processes, and cannot prevent a privileged actor from starting a container or changing another
upstream directly after the check. The operator must also verify that staging has no alternate
backend upstream outside the documented Compose service and fixed port.

For the Phase A to Phase B cutover, the operator must hold an exclusive host change window from the
PASS through migration completion. Any privileged Docker or Compose mutation in that interval
invalidates the evidence and requires a fresh gate run.

This PR does not merge or deploy Phase A or Phase B, run a directory sync, bind a user, create a
user, enable automatic sync/deprovision, or change a runtime flag.

## 4. Verification

The hermetic behavior suite executes the real Bash scripts through temporary PATH shims and covers
39 cases:

- one attested healthy backend produces PASS;
- the default command carries the exact staging Compose project and a production-project override
  fails before any Compose mutation;
- mutable/abbreviated identity, stale provenance, stale image reference, image-ID mismatch,
  revision mismatch, stale/missing/unhealthy health identity, zero/multiple project workers,
  multiple/unmanaged ingress workers, non-running backend, wrong project selector, and
  orphan, missing, and duplicate project service shapes fail closed;
- a non-loopback or `file://` health target, invalid pull posture, group-readable provenance,
  newline-bearing owner, and control-bearing file paths fail before Compose mutation and cannot
  forge a PASS;
- the build uses an archived context and all four provenance build arguments;
- mismatched/dirty/unverifiable source, non-canonical build source, and mismatched built revision
  fail closed.

Additional repository tests cover immutable deploy traceability and evidence-packet export. The
behavior suite and its source wiring guard run in both Node 18 and Node 20 legs of the `test`
matrix, and each suite asserts the other's invocation. A live GitHub branch-protection API read on
2026-07-26 confirmed `test (20.x)` is a strict required context. The Node 18 leg is additional
coverage, not claimed as a required context. The final four-file local run passed 65 of 65 tests.

The final product-code tree at `a5a4958d37dd7b20911fc4bb4ad8262e72ebd76f` was copied only
under `/private/tmp/dingtalk-worker-gate-mut-r2.AzDjbz` for 37 single-variable mutations. All 37
were killed, with zero survivors, zero syntax-invalid mutants, and zero wrong-red classifications.
The set covers the project and ingress selectors, ingress cardinality/identity, provenance
owner/mode/commit/image, path-control guards, image/ref/revision/health checks, orphan removal,
archive build boundary, source cleanliness and provenance arguments, and both CI wiring points.
The source worktree was not mutated or cleaned during this run.

After the final review moved the wiring guard into the required `test` job and added explicit
missing/duplicate service cases, three current-surface mutations ran under
`/private/tmp/dingtalk-worker-gate-final-mut-r3.vulhVO`: remove the behavior step, remove the
wiring-guard step, and bypass the exact service-set comparison. The first two were killed through
the remaining half of the mutual CI guard, and the third by the orphan/missing/duplicate service
tests. Each run failed only its designated assertions, with zero unrelated failures. The two old
wiring mutations are historical evidence only; this clean post-review run is the authoritative
evidence for current CI wiring.

## 5. Verification incident

During an early mutation rehearsal, an over-broad textual mutation changed the temporary build
script's cleanup target. The mutant deleted this isolated worktree. The canonical checkout and
other worktrees were inspected and were not changed; the branch still pointed at the Phase A base.

The files were reconstructed in a fresh isolated worktree. The final verification does not use
that unsafe mutation method. Baseline code is committed before any later discriminating mutation,
and mutation copies must live outside the source worktree with cleanup lines excluded from every
rewrite.

This incident is evidence about the test harness, not staging or production execution: no real
Docker build, deployment, migration, sync, bind, user creation, or flag change occurred.

## 6. Deployment finding and recovery

During the owner-authorized Phase A staging deployment on 2026-07-26, the version of
`deploy-dingtalk-staging.sh` then on `main` did not pass an explicit Compose project name. Running
it from the shared deploy checkout therefore selected the checkout directory's production Compose
project before the staging container-name conflict stopped the command. Staging backend/web were
not updated by that failed attempt. The production Redis container was briefly stopped and the
production Postgres container was removed; both were recreated or restarted from the production
Compose file and existing persistent volumes, and their health checks plus the production backend
health endpoint returned healthy/200 before staging work resumed.

Phase A was then deployed successfully to the staging project by explicitly setting
`COMPOSE_PROJECT_NAME=metasheet2-dingtalk-staging`. The exact merge/image SHA was
`ac05efa25fd0dfdae0779e7ae14a3a942a0c374e`; staging backend and web both served that immutable
tag and returned HTTP 200. Automatic provisioning remained `0`; Stream, deprovision, and pending
activation remained unset/default-off.

This finding is the load-bearing reason the script now fixes and validates the exact staging
project name before any Compose mutation. A caller cannot select the production project through
the environment, and the post-deploy container label must match the same staging project.

## 7. Remaining owner gates

1. review and merge this worker-drain hardening;
2. build/deploy the exact Phase A SHA through this hardened path and capture its PASS under an
   exclusive host change window;
3. review, retarget, and fully re-run Phase B CI;
4. migrate Phase B before releasing the host change window;
5. run the two-corp UAT;
6. perform only the separately authorized existing-user binding and same-corp callback proof.
