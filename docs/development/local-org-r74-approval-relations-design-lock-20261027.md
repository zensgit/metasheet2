# R74 native approval relations — Draft / HOLD

Base: `f3efc86c0159408ec8531b887d86a157368af666`. This is a bounded backport to the R74 maintenance branch, not a main upgrade. Refs #6079 and #6589. The human approved the named active-member projection exception; this does not change the old join endpoint.

## Contract

- Existing local membership `is_manager` supplies R74 direct_manager. It is a department-level manager, not a new per-person reporting line.
- New independent `is_department_head` supplies local dept_head and its existing department-chain walk. External-provider raw-list behavior is retained. Selection excludes the requester and requires active local source, department, account, linked user and same-org active membership.
- Platform-admin head GET/PATCH uses the existing local directory mount and strict boolean body. It does not set primary/manager, permissions or roles.
- Three platform-admin GETs provide a repeatable-read READ ONLY snapshot of workspace, members and candidates. They never bootstrap/reactivate an anchor. Literal search, strict paging/unknown-field refusal and expected-anchor matching apply.
- A separate POST member-projections accepts only integrationId/localUserId for an already-active same-org member without globally applied deprovision history. The existing POST accounts continues to refuse active membership with 409.
- The writer takes the user mutex, rereads membership/history, then takes an active local anchor SHARE NOWAIT lock. It creates only the native account/link, increments canonical generation once, and does not supersede applied evidence. A complete identical existing projection is an exact no-op. Partial/inactive/colliding projections are refused.
- This local directory account becomes a local organization basis. Later external unlink can retain the existing org membership; that consequence was explicitly included in the approved exception.
- No org-join, reactivation, role, permission, session or login grant; no new title editor or position/title copying. Existing archive semantics remain: archiving an account can deactivate org membership when no active sibling remains. It is not a harmless unlink.
- Routing-source policy and source-priority rules remain unchanged. Operators must inspect and explicitly decide policy changes separately. Approval snapshots remain immutable once created.
- No admin UI is added here. The handoff uses authenticated admin HTTP endpoints. The broader organization UI remains a separate unfinished Draft line.

## Gates

| Gate | Actual evidence / disposition |
| --- | --- |
| Exact R74 missing-head reproduction | Original resolver: one matching head failure, one unchanged manager positive, 18 filtered |
| Native head and real approval flow | Whole 20 passed; actual HTTP projection, memberships, two-step approvals and old/new snapshot separation |
| Read/projection behavior | 22 named cases covered across recorded phases, not a fresh whole-file final run |
| Deprovision/admin guard mutations | One matching red each, 21 excluded each; exact source restoration |
| Candidate/writer consistency | Expanded key-collision case red before fix, one pass afterward, 21 excluded |
| Migration | Fresh workflow schema ledger 441; actual nonempty rollback/apply 441→440→441 preserves old manager/primary; new head defaults false |
| CI registration | Two native whole-file lanes, no-DB exclusions, 7 unit contracts; changed trigger contract rechecked |
| Quality | Final backend type-check, validate:all and explicit eight-file lint exit 0 |
| Exact published-head CI | Pending publication; previous PR success is not this backport's evidence |
| Deployment / real UAT / owner acceptance | Not performed / not granted by these results |

All budgets and original permission/transaction ownership gates remain. Stream/lifecycle/external writes OFF. No merge, deployment, release or business configuration writes. Real UAT and business error 50004 excluded; historical 08:00 PUT stays inconclusive.
