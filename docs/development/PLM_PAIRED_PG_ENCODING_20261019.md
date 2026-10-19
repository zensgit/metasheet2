# Paired verifier UTF8 fixture: design and PG16 validation

2026-10-19. Source `41491e383c3f890397a857a2bb04d75136c375bf`, parent `f40b38ef72e2fd6bce5d2f6938e6490d88084990`. The source change is confined to the existing paired verifier. Product identity, approval and installation logic are unchanged by this slice.

## Reproduced problem and change

The verifier sets `LC_ALL=C` and `LANG=C`, then originally invoked `initdb` without an encoding. With the actual owned PostgreSQL 16.15 runtime, that exact initialization returned **160015 / SQL_ASCII**, failing the expected UTF8 fixture condition. The source probe stopped the database, independently confirmed stopped status and removed only its matching owned directory. This is an environment-fidelity issue, not a newly asserted cause of the earlier native CI failures.

The seven-line addition explicitly initializes UTF8, queries the actual server version number/encoding over the owned socket, records both in the proof and asserts UTF8. It does not impose a new PostgreSQL major-version compatibility policy or modify any existing database. The existing status/timeout/signal/symlink cleanup self-check passed; it starts no real cluster.

## Actual PostgreSQL16 cross-process evidence

Both profiles used the exact committed helper source above, real **160015 / UTF8**, native product `4f5d2f4964b6b781ab059fe1696597912e0e36de`, Meta product `430effa1e9aef4b36be7b7da1ad191fbb2128990`, and the generated-package renderer at native `05b1d23e814cbbd7c4378b9fb960251358caf291`. The current renderer bytes were frozen throughout. The official fixed-source owned PG16 build uses existing SSL/ICU libraries; no global package upgrades, default cluster or shared service changes were performed.

- **Generated personal approval/write/ECO profile passed.** Real authenticated approval-card actions produced exactly one native immutable command/vote with native subject 42 and independent RBAC actor 900. The two-person threshold remained incomplete. Separate approval and BOM-purpose grants passed purpose-isolation controls; Meta identity was distinct. One real row PATCH and one idempotent ECO intent produced distinct source/target versions and the expected native actor. Outage/unbind and retries with the Meta write switch off revoked the original frozen grant exactly once. Local logout/rebind/revoke and late-callback controls passed. No external notification sender ran.
- **Configuration upgrade and snapshot restore profile passed.** A real encrypted intent persisted before upgrade; identity material stayed unchanged while sharing was disabled. The source outage left durable cancellation pending. Actual PostgreSQL backup/restore preserved all rows in **86 Meta tables** and **3 native SQLite stores** at new paths before fresh processes started; original database/native paths were unavailable. Real HTTP verified retained target CSV under target ACL, outsider refusal, no new share after unlink/disable, frozen cancellation/revoke acknowledgement, idempotent retries and unchanged native business data/write-audit count zero. Explicit native audience confirmation, rendered destination grid and existing pre-review engine were exercised. The one completion-notification proof is a synthetic local test row, not a real business notification.

Codex independently checked actor/effect counts, PG version/encoding, cleanup and restoration invariants in the actual JSON results. Each profile stopped its own Node/native/database children and proxy, proved the owned cluster stopped and removed only its matched directory. The [compact hash/effect receipt](../../artifacts/plm-paired-pg-encoding-20261019/verification.json) binds both complete raw proofs retained under `/tmp/plm-package-personal-approval-pg16-20261019.*` and `/tmp/plm-package-config-restore-pg16-20261019.*`.

Separate native exact-f803 validation ran all 43 personal-workflow modules on actual PG16.15/UTF8: **792 passed, zero skipped**. Its [source-bound evidence commit](https://github.com/zensgit/yuantus-plm/commit/5d53f6dbb8dbc5c7d11aa8711ff8c56661921dc3) records the unchanged source and cleanup. It does not turn missing original CI logs into a known root cause.

## Delivery and remaining gates

The source commit and this one closeout-document/evidence commit are distinct; publish as a Draft stacked on #6457 and check its actual document head. Native package verifier-pin propagation follows parent CI termination. Existing native #363/#349 remain blocked by their actual runner/MinIO/artifact failures; no passing CI item was rerun or gate relaxed for these local checks.

These are source-process proofs with actual Meta PostgreSQL and native SQLite; native PostgreSQL races are covered separately by the exact-f803 792-test run. They do not qualify the Linux ECR image, full installed70/PM2/Nginx lifecycle, volume backup/restore, customer/device or production acceptance. Local Docker API remains unresponsive. Current production-SPA/distribution receipts remain retained, and the complete window remains incomplete. No merge, deployment, production enablement or issue closure is part of this slice.
