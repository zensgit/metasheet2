# Attendance #4556 W4C-5 Synthetic Soak Runbook

Date: 2026-08-04
Status: **DRAFT / NOT EXECUTABLE**

This is a preparation-only runbook for the W4C-5 named synthetic staging soak.
It must not be used until the transition-safety amendment is RATIFIED, its core
hardening is on `main`, the operator tools pass an exact-head gate, and the
owner separately authorizes the exact staging org, image SHA, and start time.

## 0. Current Stop Conditions

At publication time every transition is blocked:

- `OD-W4C-61` is open;
- no safe operator transition command is accepted;
- no staging org is named here;
- no image SHA or observation window is approved here;
- no flag, deployment, staging access, or soak authorization is granted here.

Do not replace those missing inputs with defaults, wildcards, production data,
customer data, or a tunnel/browser session. Do not run direct SQL against
rollout, operation, result, pointer, source, or review tables.

## 1. Required Owner Packet

Before any staging command, record one durable owner decision containing:

- exact synthetic org ID;
- exact 40-character deployed backend and web image SHA;
- authorized first target (`shadow` only for a new campaign);
- approved start timestamp and minimum seven calendar-day window;
- confirmation that the data is synthetic and externally isolated;
- confirmation that external notifications and destinations are disabled;
- authorization limited to the named org/image/campaign;
- explicit exclusions for production, customer data, release tags, and issue
  closure.

An old campaign, old image, agent-authored approval, or broad “continue” does
not satisfy this packet.

## 2. Evidence Directory

Use one immutable campaign directory outside the repository. The future tool
must create, never overwrite, these redacted artifacts:

```text
manifest.json
status/day-N.json
shadow/day-N.json
entrypoints/day-N.json
reviews/day-N.json
drills/suspend.json
drills/resume.json
drills/reversal.json
integrity/pointers.json
integrity/history-hashes.json
cleanup/residue.json
summary.json
```

Each file is bound to campaign ID, org ID, exact image SHA, UTC capture time,
and tool SHA. Artifacts contain counts, hashes, closed codes, and synthetic IDs
only; no credentials, raw tokens, employee names, notification content, or
customer data.

## 3. Read-Only Preflight

After separate staging authorization, collect the existing attendance staging
`status` action first. It must show the exact backend/web image SHA, pending
migrations `0`, and healthy services. Status failure or ambiguity stops the
campaign without any repair, restart, deployment, or flag change.

The future W4C-5 `plan` command then reports every transition predicate without
DML. Required `PASS` facts before `legacy -> shadow` include:

- exact allowlisted synthetic org and `scope='synthetic_staging'`;
- legal current/target pair and expected rollout version;
- no unsafe legacy async job or incomplete operation/batch;
- every pre-W4 import batch closed or preimaged;
- no posture mismatch;
- complete P16 staging helper and cleanup inventory;
- manifest hash matches the owner packet and status artifact.

Any `BLOCKED`, unknown enum, missing table, malformed artifact, or stale version
stops. Plan output never authorizes apply.

## 4. Transition Discipline

No transition command exists in this runbook yet. After `OD-W4C-61=(a)` and the
hardening lands, the final runbook must name one canonical command that:

1. accepts explicit current state/version and target state;
2. requires the owner packet and evidence manifest;
3. prints the full plan and requires an exact confirmation token derived from
   its hash;
4. invokes only the hardened core boundary;
5. stores and returns the committed event/state/version;
6. immediately performs a read-only post-transition comparison.

There is no `--force`, wildcard org, direct SQL, skip-gate, or automatic next
transition. Every transition is one separately evidenced operation.

## 5. Observation Days

For seven distinct calendar days, collect status, shadow diff, entrypoint
coverage, review backlog, pointer validity, and history hashes. Synthetic events
must cover every W4 entrypoint. Product tests may create only campaign-scoped
synthetic users, groups, shifts, records, requests, imports, and approvals.

Daily acceptance requires:

- exact image and tool SHAs unchanged;
- services healthy and migrations pending `0`;
- zero critical shadow codes;
- zero unresolved review items;
- zero external notification/destination attempts;
- no unknown entrypoint, reason, posture, or schema;
- campaign residue accounted for.

A failed day is recorded, not rerun into disappearance. Repair, image change,
or contract change ends the campaign; a new separately authorized campaign is
required.

## 6. Drills

The campaign must include separately recorded synthetic-only drills:

- reversal restores the exact frozen predecessor and preserves append-only
  history;
- suspend blocks new source/result writes and preserves authoritative pointer;
- retryable authoritative jobs remain durable without operation rows;
- offline replay during suspension is read-only and has zero critical or
  unresolved diffs;
- resume returns authoritative and the first changed punch supersedes the
  preserved pointer;
- a mismatched frozen posture and source-bearing mismatch both block.

Drills do not authorize production incident procedures.

## 7. Cleanup and Final Report

Cleanup uses only canonical reversal/retirement paths enumerated by the P16
inventory. Direct deletes or dynamic SQL against W4-backed data are forbidden.
The final residue report must show zero campaign-owned live data and list every
retained append-only audit/history row by count and hash.

The final summary may state only “internal synthetic W4C-5 soak evidence PASS”
when all gates are proven. It must not state customer UAT, production
acceptance, deployment approval, release readiness, or issue closure.

## 8. Independent Gates

Before the runbook becomes executable:

1. transition hardening passes exact-head real-PostgreSQL, race, and mutation
   review;
2. tool plan/apply tests prove zero-DML fail-closed behavior;
3. the staging workflow/package contains the exact reviewed tools;
4. owner separately authorizes the exact campaign packet;
5. a final read-only boundary audit confirms no staging action has occurred
   during preparation.
