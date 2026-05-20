# On-prem scheduled-task remote runbook update - verification - 2026-05-20

Companion to `onprem-scheduled-task-remote-runbook-design-20260520.md`.
Docs only. No `scripts/ops`, no `plugins/plugin-integration-core`, no DB
migration, no API runtime, no frontend, no K3 Save/Submit/Audit.

## Local evidence (all on the isolated worktree)

### 1. Runbook anchor confirmation

```text
grep -nE '^## 10\.2|584dbc88a' multitable-windows-onprem-easy-start-20260319.md

320:## 10.2) Scheduled-task remote apply (release 584dbc88a and later)
322:Verified on the on-prem bridge against release `584dbc88a` ...
329:1. **Pre-584dbc88a installs cannot self-fix on the first scheduled run.**
336:   pre-584dbc88a state, the **old** `deploy-remote.bat` is what executes; ...
348:   Either path leaves a `>=584dbc88a` `deploy-remote.bat` on disk before the
```

Section `10.2` is inserted between the existing `10.1` and `11`, and
the canonical release SHA `584dbc88a` (PR #1703 merge) is cited as the
boundary - so future operators reading "this runbook documents the
584dbc88a path" can grep the SHA directly.

### 2. Acceptance-text grep against the updated runbook

```text
grep -cF '<needle>' multitable-windows-onprem-easy-start-20260319.md

LastTaskResult                                            -> 6
[multitable-onprem-deploy-launcher] apply exit=0          -> 1
[multitable-onprem-deploy] apply exit=0                   -> 1
[multitable-onprem-deploy-remote] apply exit=0            -> 1
HOMEPATH                                                  -> 1
USERPROFILE                                               -> 1
APPDATA                                                   -> 2
pnpm                                                      -> 15
PM2                                                       -> 4
```

All three `apply exit=0` markers appear exactly once each, in the
"Success acceptance" block. `LastTaskResult` is referenced six times
(section narration + concrete check). The SYSTEM env requirement is
visible via the named variables and the `pnpm`/`PM2` rationale.

### 3. Secret-shape grep across all three changed files

Patterns searched, expected count `0` on each file:

| Pattern | runbook | design MD | verification MD |
| --- | --- | --- | --- |
| `eyJ[A-Za-z0-9_-]{6,}` (JWT shape) | 0 | 0 | 0 |
| `"password"\s*:\s*"[^<]` (populated password) | 0 | 0 | 0 |
| `Bearer [A-Za-z0-9._~+/=-]{8,}` (bearer token) | 0 | 0 | 0 |
| `postgres://[^ ]*:[^ <]*@` (raw PG URL with userinfo) | 0 | 0 | 0 |
| `[?&](token|secret|access_token|sessionId|password)=[^<&) ]` (populated secret query) | 0 | 0 | 0 |

The runbook intentionally mentions `password` (in the
`bootstrap-admin.bat` example argument list **already present** in the
file before this PR - the PR did not introduce that mention) but with
the literal placeholder `<StrongPasswordAtLeast12Chars>` and no real
value, so it does not match the populated-password pattern.

### 4. `git diff --check`

```text
git diff --check  -> exit 0
```

No trailing-whitespace or merge-conflict markers introduced.

## Acceptance criteria mapped to evidence

| Criterion | Evidence |
| --- | --- |
| Update an existing runbook, no duplicate doc | section `10.2` inserted into existing `multitable-windows-onprem-easy-start-20260319.md` |
| New `docs/development/...-design-20260520.md` | this PR adds it |
| New `docs/development/...-verification-20260520.md` | this PR adds it |
| Runbook records release `584dbc88a` scheduled-task validation passed | section heading cites `584dbc88a`; "Verified on the on-prem bridge against release `584dbc88a`" sentence |
| Upgrade-from-pre-584dbc88a gotcha documented | gotcha #1 in section 10.2 |
| SYSTEM-task Node/pnpm + HOME / HOMEPATH / USERPROFILE / APPDATA documented | gotcha #2 in section 10.2 (grep counts above) |
| Success criteria: LastTaskResult = 0 + three apply-exit markers + apply progression | "Success acceptance" block in section 10.2 (grep counts above) |
| Out-of-scope explicitly listed | "Out of scope (deliberate)" block in section 10.2 |
| grep confirms LastTaskResult, three markers, SYSTEM env | section 2 above |
| secret-shape grep 0 hits | section 3 above |
| `git diff --check` clean | section 4 above |

## Files touched

- `docs/deployment/multitable-windows-onprem-easy-start-20260319.md`
  (+ new section 10.2 only; sections 1-10.1 + 11 untouched)
- `docs/development/onprem-scheduled-task-remote-runbook-design-20260520.md`
  (new)
- `docs/development/onprem-scheduled-task-remote-runbook-verification-20260520.md`
  (this file, new)

## Deployment impact

None. Three Markdown files. Rollback = revert the PR. No CI gate, no
build behavior, no runtime, no DB.

## GATE-blocking status

Does **not** lift the customer GATE. The PR documents an operator-side
acceptance recipe for an already-shipped fix (584dbc88a); it does not
change any K3 Save / Submit / Audit behavior, does not add SQL or TLS
diagnostics, and does not touch `plugin-integration-core`.

## Operational note

Developed in an isolated `git worktree`
(`/tmp/ms2-sched-runbook-...`) per the parallel-session worktree
hazard memory. Branch verified
(`codex/onprem-scheduled-task-remote-runbook-20260520`) before commit
and push.
