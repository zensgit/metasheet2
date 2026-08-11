# DingTalk staging lifecycle canary and UAT execution record (2026-08-11)

- Status: **PARTIAL EXECUTION / ALIAS + DESIGNATED ADMIN OAUTH LOGIN PASS / PENDING + DEPROVISION OPERATORS READY BUT NOT EXECUTED / U1-U13 NOT EXECUTED**
- Repository evidence head: `0287b250b33fe4c7ea98b880360af74fc08a5ebf`
- Lifecycle staging deploy SHA: `ddec28b12ebff97fae33af45553d77c149d816e1`
- Production-readiness inventory deploy SHA: `e27c8dbabb798cd1d3c407f1601430fd151df5bc`
- Owner instruction: keep all lifecycle flags OFF after every canary; do not convert missing real-enterprise evidence into PASS.

This is a values-free execution record. It contains counts, booleans, reason enums, SHAs,
and GitHub Actions run ids only. It intentionally omits passwords, tokens, names, email
addresses, phone numbers, DingTalk user ids, union ids, and corp-id values.

## 1. Environment boundary

Two independently configured deployment roots were observed and must not be conflated:

| Evidence lane | Deployed SHA | Purpose |
|---|---|---|
| Lifecycle staging canary (`STAGING_DEPLOY_PATH`) | `ddec28b12ebff97fae33af45553d77c149d816e1` | Exact lifecycle status and transient alias ON/OFF proof |
| Production-readiness inventory (`DEPLOY_PATH`) | `e27c8dbabb798cd1d3c407f1601430fd151df5bc` | Read-only DingTalk integration, account, Stream, and flag inventory |

Neither SHA is used as proof for the other environment. Production enablement remains a
separate owner/ops decision.

## 2. Canary administrator credential

The fixed staging-only administrator `staging-owner-admin` was repaired/rotated through the
real administrative API. The new value was not printed or committed. It is retained in the
operator's macOS Keychain and in the GitHub Actions secret
`STAGING_OWNER_ADMIN_PASSWORD`; GitHub secret metadata records an update at
`2026-08-11T15:00:47Z`.

The real login proof is not inferred from secret presence. Alias run
[31504979575](https://github.com/zensgit/metasheet2/actions/runs/31504979575) proved all three
password-login legs using the configured canary credential:

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

A second read-only status run
[31513394261](https://github.com/zensgit/metasheet2/actions/runs/31513394261) completed after the
designated administrator role/grant change at repository head
`0287b250b33fe4c7ea98b880360af74fc08a5ebf`. Its downloaded artifact again reports the same
staging build SHA, healthy backend, zero pending migrations, `mode=off`, all three lifecycle flags
`false`, and `transition_applied=false`. This is the current terminal-state proof; the earlier run
remains the pre-change baseline.

## 4. Canary sequence

| Order | Stage | Result | Durable evidence / reason |
|---|---|---|---|
| 1 | alias-only | **PASS, rolled back** | Run `31504979575`; transient ON was proven by real password login and success required a return to exact OFF |
| 2 | pending admission | **NOT EXECUTED** | Operator exists, but no explicitly owned DingTalk source employee has been proven in the target integration; no existing employee may be auto-selected |
| 3 | deprovision | **NOT EXECUTED** | Operator exists, but requires the same owned employee in a dedicated one-account integration plus a real source-side disable/removal |

### 4.1 Alias result

The alias run reported:

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
zero pending migrations, and the same staging build SHA. Alias rows created by a backfill
would be allowed to persist, but this execution inserted zero rows.

### 4.2 Pending admission gate

A read-only account inspection found active unmatched directory accounts, but none was
explicitly designated and owned as a staging test employee. Those accounts may represent real
people. Therefore the operator did not admit, activate, rename, disable, or otherwise mutate
them. Presence of an unmatched account is not consent to use it as a canary.

Required external input before execution:

1. create or designate one dedicated DingTalk staging employee owned by the test;
2. record only a values-free selection proof in the execution artifact;
3. run sync/admit with pending enabled in a rollback-armed window;
4. prove pending cannot log in, then activate it and prove the intended login path;
5. restore `DIRECTORY_PENDING_ACTIVATION_ENABLED=false` and re-prove mode OFF.

The operator accepts only the explicit directory-account secret. Its default phase proves pending
admission and OFF rollback. Optional `PENDING_SSO_ACTIVATE` uses the real SSO activation path, but
browser OAuth remains `NOT_EXECUTED` unless a human completes and observes that callback; the
script does not promote an unobserved browser step to PASS.

### 4.3 Deprovision gate

The earlier read-only directory preview saw no removal candidate and reported zero
would-deactivate accounts. A later browser inspection showed that the active integration is a
shared employee integration, so it is explicitly disqualified from destructive canary use.
Deprovision cannot be proven by editing the local database or by selecting a real employee.

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
be resolved through an owner-reviewed abandonment procedure; deleting the journal to force a new
apply is prohibited.

## 5. DingTalk directory readiness

[Production-readiness inventory run 31505420277](https://github.com/zensgit/metasheet2/actions/runs/31505420277)
completed successfully and reported:

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
| pending users | `0` |
| all lifecycle/Stream flags OFF | `true` |

This proves a usable directory baseline, not pending/deprovision canary completion and not
interactive-card readiness.

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
| P4 `LOG_LEVEL=info|debug` | **NOT PROVEN** | Inventory reported log-level reason `missing`; silence cannot be interpreted as callback-shape evidence |

Runtime inventory details for the missing Stream prerequisites:

```text
client_id_present=false
client_secret_present=false
template_id_present=false
integration_id_present=false
credentials_ready=false
```

Required external action: configure the four staging Stream/template inputs through the
approved secret/configuration channel, set `LOG_LEVEL=info` for the controlled UAT window,
execute the canonical U1-U13 procedure with real human clicks, capture only values-free
booleans/status enums, and turn the Stream flag back OFF after U13. Secrets must not be pasted
into this document or chat.

## 7. Production and transfer gates

| Decision | Current verdict |
|---|---|
| production alias enable | **NO GO** until owner reviews staging evidence and separately authorizes production |
| production pending enable | **NO GO**; staging pending canary not executed |
| production deprovision enable | **NO GO**; staging pending and deprovision canaries not executed |
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

1. Complete the target-enterprise selection for the operator-controlled DingTalk account and
   verify it appears in a read-only directory preview; otherwise provision it in the target corp.
2. Provision a dedicated staging DingTalk employee and a separate one-account manual integration;
   authorize that subject for pending and deprovision canaries.
3. Execute pending and prove rollback to OFF, then execute two-phase deprovision and prove restore
   plus rollback to OFF.
4. Configure the staging Stream/template inputs and `LOG_LEVEL=info`; execute U1-U13 and the
   real callback corp-anchor procedure.
5. Record named owners and explicit production switch decisions. Any absent evidence remains
   `NOT EXECUTED`.

Until those external actions occur, the lifecycle code line and alias staging canary are
closed, but production enablement and real-enterprise acceptance are not.
