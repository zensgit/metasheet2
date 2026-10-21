# Cloud Classroom isolated runtime acceptance

Status: minimum synthetic training loop PASS in API and real Chromium UI.
Not a production deployment, shared-staging acceptance, or L0–L6 completion claim.

Publication source: local acceptance commit `d738c2486227170f72bf0241644f91d3ba2615a3`,
tree `3bcb5df6602ca88412999a52d517e7bbf1936d4a`. This docs-only publication branches
from `0029f409415265c0f53b349b77398c38d575e741`; that newer source tree was NOT the
runtime-under-test. The tested image remains the `1c22d3b...` revision below.

## Identity and environment

- Product revision: `1c22d3b328f377dface03b222bf57d09f4b7dec0` (backend and web).
- Isolated Lima 2.2.0 / Ubuntu ARM64; 2 CPUs, 4 GiB memory. Existing host services untouched.
- Guest Docker 29.1.3 / Compose 2.40.3. Actual AMD64 backend ran under Rosetta.
- Offline source/guest Config, RootFS layer diff IDs and architecture equal for all five
  images. Import manifest IDs differ; tag equality alone was not used as proof.
- Guest backend manifest: `sha256:19d43e596e171f8de310e81e72041eec3b27fa19932e4297d143467276e34b05`.
- Guest web manifest: `sha256:92db1929b360f3aa5dc5a7a53afb756f61212000d65d4d4cda87d9e2ef9fb56c`.
- PG15 and MinIO use separate guest ext4 disks (2 GiB / 512 MiB). Random-write/fsync
  ENOSPC probes recovered exactly their initial free blocks; probe paths removed.
- One new synthetic organization, two synthetic accounts, two synthetic courses.
  No customer dataset, external notification credential or shared database copied.

## Executed acceptance

| Gate | Result | Actual evidence |
| --- | --- | --- |
| Full empty database migration | PASS | 402 canonical migrations; second replay exit 0 |
| Backend/web runtime | PASS | Health and web build-info both exact product revision |
| Default installation | PASS | Initially not-installed; admin install creates inactive instance |
| Installation authority | PASS | Learner install 403; anonymous installation 401; extra body field 400 |
| Synthetic authentication | PASS | Real register/login; persisted org membership, no trusted-token bypass |
| Learner authorization | PASS | Initial missing namespace admission 403; normal synthetic role/admission provisioning restored read access |
| Storage transport | PASS | TLS verified, no insecure bypass; separate app identity |
| Storage scope | PASS | Scoped Put/Get/Delete; outside-prefix Put 403; listed buckets only the authorized test bucket |
| Video ingest/publish | PASS | Real generated 70s MP4 upload/server probe; video + objective exam published |
| Visibility/enrollment | PASS | Exact synthetic learner scope; enrollment and same-request replay |
| API watch/challenge | PASS | Wall-clock heartbeats; public raster challenge answered; server completion at 65000/70000ms |
| API exam | PASS | Public paper no answer key; 100 points/passed; repeated submit duplicate, stable score |
| Real browser login/enrollment | PASS | Chromium UI login and Register and start; no response interception |
| Real media playback | PASS | ReadyState 4/error null; 8.33s/87 frames, 50.51s/623 frames, natural end 70s/814 frames |
| Browser challenge | PASS | At 11s video paused; public image double-selection; acknowledgement and automatic playback resume |
| Browser exam/result | PASS | Clicked exam, selected visible answer, submitted; 100/100 Passed and Completed |
| Browser reload persistence | PASS | Reloaded learner page still shows both completed courses and 100/100 Passed |
| Publish authorization | PASS | Learner publish 403 |
| Network boundary | PASS | Host/guest application listeners loopback only; exact two relay targets; backend external TCP denied |
| Notification configuration | PASS | Installation notificationsEnabled=false; no real notifications sent |

Browser implementation used installed Playwright/Chromium. No API responses were mocked,
no media time/learning progress was assigned by test code, and no database answer key was read.
Fixtures were created through product APIs except explicit synthetic identity/RBAC bootstrap.
The browser invoked the real media play() operation, decoded frames, and clicked actual UI controls.

## Actual test flags

Only in this independent guest: master, CONTENT, MEDIA, ASSESSMENT, ENROLLMENT and
WATCH_CHALLENGE were true. ASSIGNMENT, INCENTIVE and ANALYTICS remained false.
RBAC_BYPASS=false and RBAC_TOKEN_TRUST=false. App notifications remained false.
No product defaults or production switches changed.

## Setup deviations and limits

- The guest-only unpublished internal PostgreSQL used explicit DB_SSL=false; initial
  production-default TLS connection failure was a deployment setting mismatch. Product
  defaults were unchanged. Store TLS remained verified.
- Docker 29 did not publish ports from an internal-only network. A guest loopback-only
  relay, capped at 64 MiB/32 tasks/20% CPU, preserved network isolation instead of adding
  an external network. This is test infrastructure, not a production ingress recommendation.
- MinIO ListBuckets returns accessible buckets, not necessarily 403. Actual result was
  confined to the authorized test bucket; no shared-S3 safety claim follows from this test.
- A setup exception exposed one newly generated test admin secret in a tool transcript.
  The secret was rotated; current authentication succeeded. Historical transcript removal
  is not claimed. No exposed value is copied here. Direct old-secret rejection is NOT RUN:
  do not reconstruct an old secret merely for testing. Guest credential directory is private.
- Challenge timeout/wrong-selection/expired-playback and second-organization runtime
  negatives are NOT RUN in this bounded live pass, not inferred from unit/CI success.
- Real notification delivery is intentionally NOT RUN. Storage is private test storage,
  not a configured production service. No paid resource was provisioned.
- Codex executed and inspected this UAT. A fresh Sol high read-only review of the
  exact source report and three screenshots returned P1=0/P2=0/P3=1; the P3 was the
  corroboration distinction now made below. This was not a second runtime execution
  or an independent runtime PASS. Existing product CI evidence remains distinct.

## Evidence and resource disposition

Private execution log and screenshot assets remain outside Git. Screenshots show only
synthetic data and no token: browser-video-playing.png, browser-challenge.png,
browser-passed-result.png. Guest preserves synthetic-account, course, watch, exam and
negative evidence under its root-owned private directory; do not publish credential files.

Independent screenshot corroboration is narrower than the execution record:
the playing screenshot shows rendered media/progress and a disabled exam; the
challenge screenshot shows the visible prompt and paused player; the result
screenshot shows Completed and 100/100 Passed. Screenshots alone do not establish
frame-count progression, acknowledgement/resume chronology, submission or reload
persistence. Those observations, and all API/DB/migration/identity/network/shutdown
results, are Codex execution reports, not independently reexecuted by the reviewer.

New PG/store data is retained for reproducibility; only quota-probe residue is zero.
Old UDIF diagnostic mounts/deleted-open-file residue remain separately retained and untouched;
do not report them as cleaned. Normal service/guest stop and measured resource release are
recorded in the private execution log after this acceptance. No existing resources deleted.

Final stop verified: all five task containers Exited (0), relay stopped, Lima reports
Stopped; no force stop. Browser runner exited 0. Host memory-free observation rose
from 35% to 48% (an observation, not an exclusive attribution of all freed memory).
Private window disk use 9,743,248 KiB; host free 20,515,696 KiB. No disk reclamation
is claimed: images, synthetic database, store and evidence were intentionally retained.
The loopback preview is unavailable while the guest is stopped.

This report is a docs-only publication artifact; it does not itself
prove a report PR merged, production enabled, or the original entire L0–L6 objective complete.
