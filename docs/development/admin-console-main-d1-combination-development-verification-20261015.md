# Admin-console release: latest-main combination verification

## Why the previously green head was not merged

#6410 head `3c660fd2ef` passed 24 applicable workflows plus the expected Strict skip. Before merge, main advanced from `fa784a2d9f` to `d1e77dd41c4e7a360d10425cf849071109ee72da`: #6398 changed attendance reports/admin UI and the legacy rollback conflict policy; #6402 added an owner decision-register entry. The old green was preserved as historical evidence, not reused for the new combination.

Frozen combined source: `36d9fc53ffc3686fe7520047dc6a2609b1007491`, with parents the already qualified aggregate `fd3cda0908` and incoming main `d1e77dd41c`. This is a bounded compatibility verification for the existing admin-console release, not a claim to qualify every feature in #6398 or start the task-dispatch capability described by #6402.

## Source and test-chain preservation

The local aggregate merge conflicted only in the approval web guard. Both seven-path role-directory blocks were retained. The incoming final test command's token set was a subset of the existing command; keeping the existing command preserves all incoming tests and the three role tests (`roleMembers`, `builtinCatalogPresentation`, `roleManagementSave`). The required runner/token file merged without dropping tests. Independent review checked token multisets and both registration points, not just workflow syntax.

Role-members routes, tenant/permission checks, raw builtin-name save behavior, scanner registration/follow-up tests, and earlier grant/revoke guards remain unchanged from their qualified source. New attendance content search is scoped to its attendance subtree, not the role panel. Legacy rollback now rejects an already-rolled-back batch with the existing conflict code; native rollback tests below cover the combination. No owner flags, real CI settings, migrations, or deployment controls were changed by this release work.

## Mac mini verification

The dedicated source mirror matched the frozen commit's complete tree and changed-file digests. All data were synthetic, on the owned cluster. Counts are per command and overlap; they are not a distinct-test total.

| Frozen source `36d9fc53ff` | Result |
|---|---|
| All 16 changed attendance web spec files | 310 passed |
| Five role-directory/search/registration web files | 28 passed |
| Six earlier admin/password/permission web neighbors | 163 passed |
| Values-free mount registry, AST scan, role API neighbors | 140 passed |
| Actual PostgreSQL `attendance-w4c3a-import-rollback.db.test.ts` | 49 passed, not skipped |
| `validate:all` | Passed |
| Product backend health and four real synthetic account logins | Exact source match, all tenant checks passed |
| Fresh full restore and shutdown | All 445 table count/content hashes equal; four users, zero sessions; owned backend/web/PostgreSQL stopped |

Sol 6.1 high independently returned bounded static PASS at this exact source, including the test-chain UNION, attendance/role separation, unchanged auth/flag guards, and rollback-conflict compatibility. It did not independently run the native tests or attest remote CI.

## Publication and remaining gates

Update only the existing #6410 branch with incoming main plus this verification MD, preserving its public screenshots and scoped scanner follow-up. Require complete `apps`, `packages`, `plugins`, `.github/workflows`, and `scripts/ops` tree equality to the qualified combination before publication. The new head must pass its own applicable CI, then exact-head protected merge, then final main automatic CI and deployment-job skip checks. This MD does not claim those later gates already passed.

The previously observed zero/nonzero attendance golden timing issue remains an explicit operational TODO even though #6408's one bounded retry passed. Do not weaken its assertions, increase timeouts, or retry repeatedly to manufacture green. No deployment, customer-data access, external business write, or edits to another worktree occurred.
