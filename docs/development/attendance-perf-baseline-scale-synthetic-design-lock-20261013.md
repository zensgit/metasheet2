# Attendance baseline scale synthetic qualification — 2026-10-13

Owner authorized 10000/20000-row baseline qualification in the owned Mac mini fully synthetic environment, focused checks, independent review and development/verification MD. Frozen initial main: `316b06e93a8eaa0012394ae5ddf36ae157db79ab`. No deployment, real CI variable or branch-protection change, customer data, shared operational dispatch or public PR is authorized.

## Contract

- New owned checkout and fresh PostgreSQL database; two canonical synthetic tenants, private generated credentials and namespace admissions. Record actual backend health SHA, auth/me tenant, consumer checkout SHA separately. Never invent runtime identity from the consumer checkout.
- Existing consumers and fail-closed binding remain unchanged unless a scoped regression is reproduced. Missing/blank org, wrong tenant, missing/wrong runtime SHA and refresh drift stop before the next write. Valid positive controls are mandatory.
- Execute the scheduled standard 10000-row profile and explicit manual standard 20000-row profile, each at least three consecutive qualified rounds, sequentially on one frozen runtime. The manual dispatch input defaults to10000; this qualification explicitly chooses20000. Other standard workflow settings: commit mode, sync preview, async commit, CSV upload/export enabled, payload auto, rollback true, work-date span366, commit max420000ms, rollback max30000ms. Preserve original retry/poll settings; unset optional preview/export bounds are not invented SLOs.
- Verify generator unique user/date cardinality and intended insert/update/skip statistics. Witness actual committed business data, export semantics and consumer rollback; a successful summary alone is insufficient. Default anomalies export must not be described as full-record export. Any added observer/readback timing overhead is measured and disclosed.
- Keep group creation/sync disabled. Classify retained batch/item/job/event/auth metadata separately from business records. Consumer rollback and extra final private-baseline restore are separate proofs.
- Compare per-round timings and range/median; three rounds do not support a reliable tail-percentile claim. No threshold inflation, downscaled inputs, skip-when-unreachable green or speculative optimization.
- All heavy tests/builds run in Mac mini owned paths. Preserve other chats' worktrees and runtimes. Private logs/dumps/credentials and endpoint/resource identities remain private; report only counts, codes, timings, hashes and source identities.

## Gates

| Gate | Required proof |
|---|---|
| Ready target | Fresh unexcluded migrations, actual health SHA, two-tenant login/auth proof, isolated local source/config |
| Negative binding | All specified wrong/missing identity cases reject before business writes; valid refresh-drift control |
| Small control | Actual preview/commit/export/rollback behavior and content readback before scale |
| 10000 rows | At least three sequential rounds, exact profile, intended cardinality/statistics, existing time limits, real export and rollback |
| 20000 rows | Same requirements, three rounds, no mixed-source qualification |
| Correctness sensitivity | Focused/neighbor checks; meaningful guard mutation when a scoped code repair is needed; restore and quality pass |
| Independent review | Astra high, not an implementer, independently audits exact patch and measurement/binding/cleanup evidence; actionable findings resolved |
| Cleanup | Owned processes stopped; private baseline restoration and business readback, metadata residuals explicit |
| Deliverable | Reproducible harness, exact source/runtime/profile, per-round results and limits in development/verification MD |

Grok4.7 handles bounded offline generator/measurement audit; Sol6.1 high handles harness and any separately assigned minimal repair; parent owns private runtime execution and final audit. Kimi may provide a bounded advisory task only with verified invocation identity, never as substitute for runtime proof. No extra product capability or highscale line is opened. Public branch/PR, merge, deployment and shared operational configuration remain separate owner decisions.
