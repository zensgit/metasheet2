# On-prem package runtime closure repair

## Scope and approval

Repair the three package omissions reproduced while qualifying main
`aa7918bccf0b71d4339f29475e907be66fd28965` after #6396. Base for this PR:
`d7f391ac4d5992547dbd753a6e0d68d0dfe76b3f`; intervening changes are documentation only.
Owner authorizes implementation, Draft PR, CI and Mac mini synthetic isolated
rehearsals. Merge, real historical repair, deployment and enablement remain HOLD.

## Change

- Multitable builder ships live `src/db/migrations` as well as the legacy SQL
  stream, preserving the two existing SQL migration names in upgraded ledgers.
- Multitable builder ships the shell/PowerShell web publishers called by its
  packaged operational entrypoints.
- Attendance builder ships the core backend's required MSSQL workspace helper.
- Each verifier rejects its missing files. Required plugin CI runs positive
  and missing-file checks. Existing provenance pins are recomputed for the
  changed builder/verifier; no pin rules or bypasses change.

No runtime/API/schema changes, ledger edits, migration exclusions or flags.
Packages remain dependency-free archives and use frozen dependency installs.

## Gates

| Gate | Required evidence |
|---|---|
| Regression | New tests fail on old lists, pass after repair; neighboring archive/migration tests pass |
| Archive | Both builders and TGZ verifiers pass; checksums, compiled repair CLI/service, no node_modules, ZIP parity |
| Negative archives | With valid checksums, removing each repaired required file makes verification fail |
| Dependencies | Independent cold production installs; declared runtime packages resolve inside extracted roots |
| Fresh install | Actual packaged installer, compiled production server, login, default-off clock operations, replay |
| Upgrade | Exact pre-timezone program HTTP record, actual package upgrade/migration replay, compiled repair CLI preview/apply/replay, default-off checkout |
| Restore | Before-upgrade and after-repair backups restore to new empty databases; full fingerprints and program behavior match |
| CI | Current head's required checks; new test executes in test (20.x) |
| Boundary | No merge/real repair/deploy/enable; synthetic secrets private, public evidence counts/codes/digests only |

Mac profile: Node 20, PostgreSQL 16, native arm64 and manual service manager;
no Windows/nginx/PM2/Redis topology qualification. Existing restore-session
search_path compatibility method must be recorded explicitly, never described
as an unmodified standard pg_restore pass. Candidate packages built before merge
must identify the PR source SHA, not claim main provenance. Final verification MD
and deployment checklist accompany the actual rehearsal receipts.
