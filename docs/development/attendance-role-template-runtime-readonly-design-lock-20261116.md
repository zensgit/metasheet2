# Attendance template runtime boundary

## Scope

Attendance template metadata remains unchanged. Listing templates performs no database query or transaction in the final handler. Single and batch membership assignment do not create or repair permission catalogue entries or role-permission mappings. Existing published migrations remain unchanged.

Template metadata describes available templates, not an account's effective permissions. Deployment still requires a separately authorized, read-only inventory of template roles, catalogue codes and mappings in each environment. Missing entries must not trigger runtime repair.

## Preserved behavior

- Keep all template role SHARE prelocks, sorted namespace-admission locks, sorted user locks, locked actor authority and scope/target revalidation.
- Keep the existing assignment/revocation boundaries, membership effects, delegated-scope cleanup and auditing behavior.
- Remove only the two writer registry entries whose statements disappear. Other identifiers, statuses and registrations remain unchanged; this is not a writer conversion.
- Add no endpoint, flag, schema or migration.

## Verification gates

| Gate | Required evidence |
| --- | --- |
| Handler regressions | Existing boundary wholefile; exact GET metadata and zero SQL/transactions; both assign paths succeed, retain lock order and issue no catalogue/mapping writes. New tests fail against the previous runtime implementation. |
| Writer closure | Exact source/registry counts and symbol checks remain intact. Zero attendance catalogue/mapping write baseline; independent INSERT reintroduction controls for both tables. |
| Real PostgreSQL | Three actual registered final handlers, real SQL and activated administrator fixtures. Each starts with one employee mapping removed; assignments persist exact memberships, batch uses two distinct targets, and the mapping remains absent. |
| Isolation | Route transactions use SAVEPOINT/RELEASE within each case's outer transaction. Unconditional outer ROLLBACK restores the complete original role/catalogue/mapping sets and removes synthetic users/memberships, without reseeding. |
| CI | New PostgreSQL file runs wholefile exactly once in required approval-db and is excluded only from the no-DB runner. Frozen original command digests and existing lists remain intact. Missing/duplicate/wrong-lane/reordered/unknown additions are rejected. |
| Neighbors | Existing delegation, revocation, recovery-RBAC, writer and consumer/authorization-input wholefiles retain their assertions. |
| Independent checks | Restore the real old helper with each individual call in turn; corresponding regression must fail on behavior rather than compilation. Restore exact source bytes afterward. |

The PostgreSQL fixture exercises handler/SQL behavior and row state after SAVEPOINT release, not a production root-transaction COMMIT, HTTP authentication, contention or multi-connection serialization. Integration setup's existing RBAC test trust is not an authorization acceptance claim. This slice does not establish full authorization-writer closure or overall authorization readiness. Database, mutation and independent code-review gates are reported separately from no-DB local tests.
