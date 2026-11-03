# Archive Capture Policy Proposal

Status: DESIGN ONLY. No scheduler, retention default, customer storage, flag change,
or deployment is authorized by this document. Base is main `23dfdf417686b931a515bf03abbce1d6471c3098`.

## Existing Authority

The local filesystem provider implements durable object storage, not a capture
schedule. `recovery-archive-section-bootstrap.ts` allocates and persists snapshot
reservations; `recovery-archive-coverage-plan.ts::planRecoveryArchiveCoverageIndex`
plans coverage from authoritative inputs. Neither a successful unlock nor a
restorable seeded archive proves continuous production capture or a recovery SLA.
The current local-storage lock explicitly leaves capture/coverage policy selection
outside storage-provider implementation.

## Recommended Contract

1. Start with an explicit, operator-requested capture of a selected organization,
   base and table. Do not silently select every table or install a periodic job.
2. Bind capture to a sealed source endpoint and complete section/coverage receipts.
   Publish a recoverable catalog state only after all mandatory sections and
   authenticated object receipts are durable. Partial work remains non-restorable.
3. An eventual schedule must explicitly bind table scope, cadence, timezone and
   concurrent-run budget. A failed or overdue capture is visible as such; an older
   successful archive cannot be relabeled current. Retry must reuse effect identity.
4. Retention must be explicitly selected independently from capture cadence, object
   quotas and restore replay horizons. Preserve legal holds and monotone provider
   pin/delete authority. No key retirement while retained objects still require it.
5. Capacity exhaustion stops new publication with a values-free reason. It must not
   silently shorten retention, delete held objects, or weaken completeness checks.
6. A backup set includes database/catalog, immutable archive objects and encrypted
   custody packages. Its unlock secret is separately held. Same-host filesystem
   tests are not NAS durability or independent offsite-backup evidence.

## Decisions Before Runtime Implementation

The owner must select the protected table scope, acceptable recovery-point gap,
recovery-time objective, cadence/timezone, retention duration, storage ceiling,
and backup-copy/offline-custody arrangement. Recommendations can be measured on
synthetic workloads first; none is assigned a numeric default in this slice.

## Future Verification

Use isolated synthetic data to prove complete-vs-partial publication, exact source
binding, same-request retry, crash/restart at every publication boundary, overdue
status, capacity refusal, held-object preservation and missing-section negatives.
Mutation removal of a receipt/coverage check must reject publication. A restore
must exercise the public reader and canonical authority/writer path, not only
decrypt private fixture bytes. Record measured RPO/RTO separately from configured
objectives, without inferring production guarantees.
