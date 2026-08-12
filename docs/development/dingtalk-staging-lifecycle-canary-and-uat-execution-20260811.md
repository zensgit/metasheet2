# DingTalk staging lifecycle canary and UAT execution record (2026-08-11/12)

- Status: **PARTIAL EXECUTION / ALIAS PASS / PENDING ADMIT + SSO-ACTIVATE INTENT PASS WITH BROWSER OAUTH NOT EXECUTED / DEPROVISION APPLY NOT COMPLETE + TWO SAFE RECOVERIES PASS / U1-U13 NOT EXECUTED**
- Repository evidence head: `51f23ec7255c3fb0d9abc21bfbe4c3bce8e1c48f`
- Lifecycle staging deploy SHA: `51f23ec7255c3fb0d9abc21bfbe4c3bce8e1c48f`
- Production-readiness inventory deploy SHA: `24794811b1c800402006b30d6e4fa9df670e124e`
- Owner instruction: keep all lifecycle flags OFF after every canary; do not convert missing real-enterprise evidence into PASS.

This is a values-free execution record. It contains counts, booleans, reason enums, SHAs,
GitHub Actions run ids, timestamps, and non-secret synthetic operator labels. It intentionally
omits passwords, tokens, real names, login identifiers, email addresses, phone numbers, DingTalk
user ids, union ids, and corp-id values.

## 1. Environment boundary

Two independently configured deployment roots were observed and must not be conflated:

| Evidence lane | Deployed SHA | Purpose |
|---|---|---|
| Lifecycle staging canary (`STAGING_DEPLOY_PATH`) | `51f23ec7255c3fb0d9abc21bfbe4c3bce8e1c48f` | Exact lifecycle status, retained-journal recovery, and terminal OFF proof |
| Production-readiness inventory (`DEPLOY_PATH`) | `24794811b1c800402006b30d6e4fa9df670e124e` | Read-only DingTalk integration, account, Stream, and flag inventory |

The matching code SHA is not used to infer shared runtime state between the two roots; each
runtime fact below is tied to its own workflow run and artifact. Production enablement remains a
separate owner/ops decision.

## 2. Canary administrator credential

Two staging-only administrator credentials have separate purposes and must not be conflated:

- `staging-owner-admin` and `STAGING_OWNER_ADMIN_PASSWORD` belong to the human-admin
  bootstrap/rotation path. The value was repaired/rotated through the real administrative API,
  was not printed or committed, and is retained in the operator's macOS Keychain and GitHub
  Actions secret storage. Secret metadata records an update at `2026-08-11T15:00:47Z`.
- The alias operator uses the fixed lifecycle-canary administrator and the separate
  `LIFECYCLE_CANARY_LOGIN_IDENTIFIER` / `LIFECYCLE_CANARY_LOGIN_PASSWORD` secrets.

Alias login proof is not inferred from either secret's presence. Hardened-deploy alias run
[31529335625](https://github.com/zensgit/metasheet2/actions/runs/31529335625) proved all three
password-login legs using the lifecycle-canary credential:

- before alias enable: `pre_login_ok=true`;
- while alias-only was live: `post_on_login_ok=true`;
- after rollback to OFF: `post_rollback_login_ok=true`.

Password rotation and secret assignment do not authorize any lifecycle flag.

### 2.1 Real DingTalk account binding and login

The operator completed the DingTalk consent in an authenticated
`staging-owner-admin` browser session. The callback returned to the settings page with the
bound result, and a fresh status read showed all of the following simultaneously:

```text
dingtalk_available=true
dingtalk_enabled=true
dingtalk_identity_bound=true
directory_managed=false
```

The browser then logged out of the password-authenticated session, returned to `/login`, and
selected `Use DingTalk login`. Without entering the local password again, the real DingTalk
OAuth callback completed and redirected to the authenticated `/attendance` page. The earlier
fail-closed `unlinked_enabled_local_user` result therefore changed to a successful login only
after the explicit binding operation.

This is evidence for account binding and DingTalk OAuth login only. It is not evidence for the
interactive-card Stream callback gate in Section 6.

### 2.2 Designated DingTalk administrator login

The operator selected the existing active directory account designated for this staging
administrator check. A read-only inventory first proved that it was linked to one local user and
had a complete DingTalk identity, but had no DingTalk login grant and did not have the platform
administrator role. With explicit owner approval, the administrative API then performed exactly
two auditable access-graph changes for that existing local user:

```text
platform_admin=true
dingtalk_login_grant_enabled=true
directory_linked=true
identity_union_id_present=true
identity_open_id_present=true
```

The OAuth chooser initially presented a different cached DingTalk account. That account was not
authorized; the operator returned to the account chooser and completed consent with the designated
administrator account. The backend recorded a fresh DingTalk login at
`2026-08-11T16:40:37.205Z`, the callback redirected to the authenticated `/attendance` page, and
the same browser session subsequently loaded `/admin/users` successfully. This proves both the
real DingTalk login and effective platform-administrator authorization. It does not identify or
authorize a destructive pending/deprovision canary subject.

After the hardened staging deploy, the previously completed real OAuth binding/login was rechecked
through the still-authenticated session and administrator views. The recorded last-login time
remained `2026-08-11T16:40:37.205Z`; this recheck is not represented as a second callback. The OAuth
identity's corp and union identifiers matched the single linked directory account's corp and union
identifiers, the local account was active, the DingTalk grant was enabled, and the effective roles
included platform administrator. This is an identifier-level binding proof; no display-name or
account-nickname inference is used. The linked directory account belongs to the shared employee
integration and therefore remains disqualified as a destructive canary subject.

These access-graph changes did not write any lifecycle environment switch. The fresh OFF proof in
Section 3 was taken after the changes.

## 3. Exact OFF baseline

[Lifecycle status run 31504862038](https://github.com/zensgit/metasheet2/actions/runs/31504862038)
completed successfully at repository head
`325917c0a484522ef9ce87b286d5d986d4e205b3`. Its downloaded values-free artifact reports:

| Check | Result |
|---|---|
| staging build SHA | `ddec28b12ebff97fae33af45553d77c149d816e1` |
| backend health | `true` |
| migrations pending zero | `true` |
| mode | `off` |
| `AUTH_LOGIN_USE_ALIASES` | `false` |
| `DIRECTORY_PENDING_ACTIVATION_ENABLED` | `false` |
| `DIRECTORY_DEPROVISION_ENABLED` | `false` |
| transition applied | `false` (read-only status action) |

A later hardened-deploy status run
[31528753683](https://github.com/zensgit/metasheet2/actions/runs/31528753683) and exact-SHA OFF
preflight run [31528911914](https://github.com/zensgit/metasheet2/actions/runs/31528911914)
completed at repository and deployed head
`24794811b1c800402006b30d6e4fa9df670e124e`. Their downloaded artifacts report a healthy backend,
zero pending migrations, `mode=off`, all three lifecycle flags `false`, and
`transition_applied=false`. These supersede the earlier lifecycle-deploy terminal-state proof.

After the dedicated canary application/integration exercises, [#4875](https://github.com/zensgit/metasheet2/pull/4875)
landed empty-fetch journal recovery and [#4877](https://github.com/zensgit/metasheet2/pull/4877)
landed exact pre-deprovision sync-failure recovery. Attendance staging deploy
[31559288370](https://github.com/zensgit/metasheet2/actions/runs/31559288370) pinned backend and
web to exact SHA `51f23ec7255c3fb0d9abc21bfbe4c3bce8e1c48f`, reported zero pending
migrations, and preserved the non-lifecycle staging mode. Recovery run
[31559371562](https://github.com/zensgit/metasheet2/actions/runs/31559371562) then cleared the retained
journal only after exact failed-run, zero-ledger, source-active, and unchanged-access-graph proofs.
Independent read-only status run
[31559480395](https://github.com/zensgit/metasheet2/actions/runs/31559480395) is the current terminal
proof: exact deployed SHA, healthy backend, zero pending migrations, mode `off`, all three lifecycle
flags `false`, and `transition_applied=false`.

## 4. Canary sequence

| Order | Stage | Result | Durable evidence / reason |
|---|---|---|---|
| 1 | alias-only | **PASS, rolled back** | Hardened-deploy run `31529335625`; transient ON was proven by real password login and success required a return to exact OFF |
| 2 | pending admission | **PASS for admit + SSO activate intent, rolled back; browser OAuth NOT EXECUTED** | Runs `31551343313` and `31551426867` used an explicit owned subject, never auto-selected it, and left lifecycle flags OFF |
| 3 | deprovision | **ATTEMPTED, NOT COMPLETE** | Empty-source and duplicate-sentinel attempts made no lifecycle mutation; both retained journals were recovered with zero ledger and unchanged access graph. A second unique DingTalk sentinel is still required for a real apply/restore cycle |

### 4.1 Alias result

The hardened-deploy alias rerun
[31529335625](https://github.com/zensgit/metasheet2/actions/runs/31529335625) reported the following
values in its downloaded artifact. Identical numeric counters in an earlier run do not substitute
for this run-bound evidence:

```text
transition_applied=true
alias_on_applied=true
pre_login_ok=true
post_on_login_ok=true
post_rollback_login_ok=true
rolled_back_to_off=true
backfill_ok=true
backfill_inserted=0
backfill_collisions=0
backfill_skipped_empty=20
cutover_ready=true
cutover_can_enable=true
```

Its final artifact again reported mode `off`, all three flags `false`, healthy backend,
zero pending migrations, and deployed SHA
`24794811b1c800402006b30d6e4fa9df670e124e`. Alias rows created by a backfill would be allowed to
persist, but this execution inserted zero rows. The earlier successful run `31504979575` remains
historical evidence against the older deploy; it is not used as proof for the hardened deploy.

### 4.2 Pending admission result

A dedicated canary application, department, employee, and manual integration were created before
execution. The workflow consumed only the explicit directory-account secret and did not auto-select
an account.

- [Run 31551343313](https://github.com/zensgit/metasheet2/actions/runs/31551343313) transiently enabled
  pending admission, admitted the explicit subject, proved `pending_activation`, and rolled back to
  exact mode `off`.
- [Run 31551426867](https://github.com/zensgit/metasheet2/actions/runs/31551426867) used the production
  `PENDING_SSO_ACTIVATE` intent to activate the same subject while lifecycle flags remained OFF.

Both artifacts are values-free and report `subject_owned=true`, `subject_auto_selected=false`, and
successful password-backed administrator login. They do **not** prove browser OAuth denial or
post-activation browser OAuth success: both browser checkpoints remain `NOT_EXECUTED`. Pending
production enablement therefore remains a separate NO-GO decision despite the server-side canary.

### 4.3 Deprovision attempts, recovery, and remaining gate

The earlier read-only directory preview saw no removal candidate and reported zero
would-deactivate accounts. A later browser inspection showed that the active integration is a
shared employee integration, so it is explicitly disqualified from destructive canary use.
Deprovision cannot be proven by editing the local database or by selecting a real employee.

The only other visible staging integration has a different corp anchor, zero accounts, and a
failed most-recent sync. It cannot be repurposed as the dedicated integration for the authenticated
corp without a separately authorized reconfiguration and valid source credentials.

After Section 4.2 succeeds, an authorized operator must create/use a separate active DingTalk
integration that contains exactly the selected account (all active and inactive account rows
count), has scheduler, admission automation, and member-group projection disabled, and uses
`mark_inactive`. Apply requires
`DINGTALK_SOURCE_DISABLED_DEDICATED_EXCLUSIVE_CONFIRMED`, which attests that the source is disabled
and no other operator will sync or edit this dedicated integration until the lifecycle flags are
proven OFF. The preview and one-account checks are not an atomic scope lock, so this exclusive
window is mandatory. The apply sequence then requires an exact one-subject preview and planner result,
persists a random sync run UUID before env/HTTP, transiently enables only deprovision, and starts
the async sync with that UUID. A lost 202 or runner crash retains the exact recovery journal;
retries cannot start a second provider pull with the same UUID. Recovery binds only that run's
single event and exact membership/grant/user effect triple. Restore probes the exact event tuple,
reverses it, verifies the exact effect set and access graph, and leaves all three flags OFF.
An exact run that terminates without a matching ledger event leaves a fail-closed journal. It must
be resolved through a reason-specific, owner-reviewed recovery path; deleting the journal to force
a new apply is prohibited.

The dedicated integration and explicit target passed the ownership/exclusivity gates, but a real
destructive apply/restore cycle is still incomplete:

1. An attempt with only the target removed produced the provider's empty-directory safeguard. No
   event/effect was written and no access-graph row changed. After the source was restored,
   [run 31555162698](https://github.com/zensgit/metasheet2/actions/runs/31555162698) proved the exact
   `empty_directory_fetch` abort, zero ledger, active source, unchanged user/membership/grant graph,
   all flags OFF, and cleared that journal without claiming restore.
2. A second attempt kept the source nonempty by using an employee already present in another
   integration. The sync failed before deprovision on the global provider/corp/external-key unique
   constraint. [Run 31555714636](https://github.com/zensgit/metasheet2/actions/runs/31555714636)
   retained the `run_bound` journal and returned all flags to OFF. [#4877](https://github.com/zensgit/metasheet2/pull/4877),
   merge `51f23ec7255c3fb0d9abc21bfbe4c3bce8e1c48f`, added an exact-signature recovery that refuses
   sibling/generic uniqueness errors. [Run 31559371562](https://github.com/zensgit/metasheet2/actions/runs/31559371562)
   proved that exact failed run, zero event/effect rows before and after recovery sync, active
   source, unchanged access graph, flags OFF, and then cleared the journal. It explicitly reports
   `end_to_end_restore_claimed=false`.

The remaining external prerequisite is a **second dedicated DingTalk employee identity with a real,
unique phone number that is absent from every other integration**. It is needed only as a temporary
source sentinel so the provider fetch remains nonempty when the target departs. Reusing an existing
employee or inventing a phone number is prohibited. After it exists, the controlled sequence is:
target absent + sentinel present -> apply; target re-added -> restore; sentinel removed; terminal
status OFF.

## 5. DingTalk directory readiness

[Production-readiness inventory run 31529929612](https://github.com/zensgit/metasheet2/actions/runs/31529929612)
completed successfully against deployed SHA
`24794811b1c800402006b30d6e4fa9df670e124e` and reported:

| Signal | Result |
|---|---|
| read-only probe | `true` |
| active DingTalk integrations | `1` |
| active corp-anchored integrations | `1` |
| active directory accounts | `2` |
| active linked local users | `2` |
| at least two linked users ready | `true` |
| directory UAT baseline ready | `true` |
| app key / app secret / agent id readiness | `true` |
| allowed-corp allowlist | `configured` |
| password-capable alias administrators in this deployment root | `0` |
| pending users | `0` |
| all lifecycle/Stream flags OFF | `true` |
| log level | ready (`LOG_LEVEL` missing; runtime default is `info`) |

This historical inventory proves a usable directory baseline. The later server-side pending
canary completed as recorded in Section 4.2; it does not prove browser OAuth or destructive
deprovision completion, and it is not interactive-card readiness.

## 6. U1-U13 and real callback corp-anchor

The canonical procedure remains
`docs/development/dingtalk-hardening-real-uat-evidence-pack-20260713.md`. No row below is
simulated.

| Gate | Result | Blocking evidence |
|---|---|---|
| U1-U13 (including U3-a and U11-b) | **NOT EXECUTED** | Stream client id, client secret, card template id, and integration id are all absent from the runtime inventory |
| U11-a real callback corp-anchor | **NOT EXECUTED** | No real card can be sent/clicked without the Stream/template configuration; no callback frame was captured |
| P1 latest storage-health precondition | conditionally ready, recheck at UAT start | Latest observed `Attendance Remote Storage Health (Prod)` run [31453711071](https://github.com/zensgit/metasheet2/actions/runs/31453711071) was successful; the evidence pack requires a fresh check at the actual UAT start |
| P2 exact target SHA | known per environment | See Section 1; do not mix the two deployment roots |
| P3 real corp + two linked users | directory subset ready only | Corp anchor and two linked users exist, but Stream app/template configuration is absent |
| P4 `LOG_LEVEL=info|debug` | **READY** | Inventory reported `log_level_ready=true`, reason `missing`; `core/logger.ts` defaults an unset/empty value to `info` |

Runtime inventory details for the missing Stream prerequisites:

```text
client_id_present=false
client_secret_present=false
template_id_present=false
integration_id_present=false
credentials_ready=false
```

Required external action: configure the four staging Stream/template inputs through the
approved secret/configuration channel, re-confirm the ready log level at the controlled UAT
window start, execute the canonical U1-U13 procedure with real human clicks, capture only values-free
booleans/status enums, and turn the Stream flag back OFF after U13. Secrets must not be pasted
into this document or chat.

## 7. Production and transfer gates

| Decision | Current verdict |
|---|---|
| production alias enable | **NO GO** until owner reviews staging evidence and separately authorizes production |
| production pending enable | **NO GO**; server-side staging admit/activate passed, but browser OAuth checkpoints and owner GO remain incomplete |
| production deprovision enable | **NO GO**; safe-abort/recovery paths passed, but destructive apply/restore has not completed |
| interactive-card Stream enable | **NO GO**; U1-U13/U11-a not executed |
| Transfer T3-T5 | **FROZEN**; real two-corp T2-Gate remains separate and unexecuted |

The safe terminal state for this execution is therefore:

```text
AUTH_LOGIN_USE_ALIASES=false
DIRECTORY_PENDING_ACTIVATION_ENABLED=false
DIRECTORY_DEPROVISION_ENABLED=false
DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED=false
```

## 8. Next executable actions

1. Provision a second dedicated DingTalk sentinel employee with a real unique phone number and add
   it only to the dedicated canary department/integration.
2. Execute the destructive deprovision apply/restore sequence, remove the sentinel, and prove exact
   OFF again. Separately complete the pending browser OAuth checkpoints if production pending is to
   be considered.
3. Configure the staging Stream/template inputs, re-confirm the info/debug log level, execute U1-U13 and the
   real callback corp-anchor procedure.
4. Record named owners and explicit production switch decisions. Any absent evidence remains
   `NOT EXECUTED`.

Until those external actions occur, the lifecycle code line, alias canary, pending server-side
canary, and fail-closed deprovision recovery paths are closed. Destructive deprovision/restore,
production enablement, and real-enterprise acceptance are not.
