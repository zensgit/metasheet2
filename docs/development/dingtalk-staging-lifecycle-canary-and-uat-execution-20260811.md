# DingTalk staging lifecycle canary and UAT execution record (2026-08-11/15)

- Status: **STAGING SERVER-SIDE CANARIES COMPLETE / ALIAS PASS / PENDING ADMIT + SSO-ACTIVATE INTENT + POST-ACTIVATION OAUTH PASS / DEPROVISION APPLY + RESTORE + POST-RESTORE OAUTH PASS / STREAM ON-OFF WINDOW EXECUTED AND RETURNED OFF / DEPROVISION-DENIAL BROWSER CHECKPOINT NOT EXECUTED / U1-U13 HUMAN CLICK MATRIX NOT EXECUTED**
- Repository evidence head: `cc69791604f338a90e07dc07da8118a2d7a68188`
- Lifecycle staging deploy SHA: `12f1f8c466ddf0fcbfcf2ea07902528ac02430f1`
- Production-readiness inventory deploy SHA: `cc69791604f338a90e07dc07da8118a2d7a68188`
- Owner instruction: keep all lifecycle flags OFF after every canary; do not convert missing real-enterprise evidence into PASS.

This is a values-free execution record. It contains counts, booleans, reason enums, SHAs,
GitHub Actions run ids, timestamps, and non-secret synthetic operator labels. It intentionally
omits passwords, tokens, real names, login identifiers, email addresses, phone numbers, DingTalk
user ids, union ids, and corp-id values.

## 0. 2026-08-15 authoritative closeout delta

This section supersedes stale `NOT EXECUTED` statements below only where it names a newer, exact
run or runtime observation. Historical run descriptions remain unchanged as provenance.

1. Deprovision apply
   [31778647232](https://github.com/zensgit/metasheet2/actions/runs/31778647232)
   at deployed SHA `12f1f8c466ddf0fcbfcf2ea07902528ac02430f1` again proved one exact
   target, one event, three effects, generation present, disabled access graph, and flags returned
   to OFF. Restore
   [31778860419](https://github.com/zensgit/metasheet2/actions/runs/31778860419)
   reversed the exact effect set, fully resolved the event, restored the active membership and
   enabled grant, and kept all lifecycle flags OFF. Terminal status
   [31779012880](https://github.com/zensgit/metasheet2/actions/runs/31779012880)
   independently re-proved exact SHA, healthy backend, zero migrations, and mode OFF.
2. PR [#4904](https://github.com/zensgit/metasheet2/pull/4904), merge
   `cc69791604f338a90e07dc07da8118a2d7a68188`, added the guarded staging OAuth configuration
   lane. Initial status
   [31815170511](https://github.com/zensgit/metasheet2/actions/runs/31815170511), prepare
   [31815302093](https://github.com/zensgit/metasheet2/actions/runs/31815302093), and final status
   [31815447966](https://github.com/zensgit/metasheet2/actions/runs/31815447966) proved the exact
   deployed SHA, healthy backend, all three lifecycle flags OFF, and exact client/corp/callback/
   public-URL/CORS configuration without emitting secret values.
3. The first real OAuth callbacks failed at DingTalk's `/v1.0/contact/users/me` with the bounded
   permission class `403 missing Contact.User.Read`. After the enterprise administrator granted
   `Contact.User.Read` and published the application version, the same endpoint succeeded. Two
   unlinked DingTalk identities were then rejected with the expected fail-closed policy class;
   one linked identity completed OAuth and established an authenticated session.
4. A values-free database correlation tied that successful callback's `last_login_at` timestamp
   to the fixed owned directory subject name `Lifecycle Canary Employee`, with an active linked
   account and matching corp/provider identity. It emitted only
   `is_lifecycle_canary_subject=true`, not provider identifiers or personal data. This proves the
   pending subject's post-activation OAuth positive checkpoint and the same subject's
   post-deprovision-restore OAuth positive checkpoint. It does **not** prove the browser denial
   checkpoint while the subject was deprovisioned; that remains `NOT EXECUTED`.
5. Final lifecycle status
   [31817757706](https://github.com/zensgit/metasheet2/actions/runs/31817757706) reported exact
   deployed SHA, healthy backend, zero pending migrations, mode OFF, and all three lifecycle flags
   false after the real OAuth exercise.
6. Staging Stream preparation
   [pre-status 31854272476](https://github.com/zensgit/metasheet2/actions/runs/31854272476),
   [prepare 31854315133](https://github.com/zensgit/metasheet2/actions/runs/31854315133), and
   [post-status 31854359627](https://github.com/zensgit/metasheet2/actions/runs/31854359627)
   ran against exact deployed SHA `12f1f8c466ddf0fcbfcf2ea07902528ac02430f1`. The prepare action
   reported `prepare_ok`, forced Stream OFF, required no backend restart, and retained one eligible
   configured-corp anchor with two linked local users. Both status runs proved Stream OFF, worker
   disabled, healthy backend and HTTPS gateway, and all lifecycle flags OFF.
   This closed the configuration-prepare precondition only. The later owner-approved window in
   items 9-11 proved start/stop but did not execute U1-U13 or the real callback corp-anchor.
7. Production read-only inventory
   [31818159368](https://github.com/zensgit/metasheet2/actions/runs/31818159368) at exact deployed
   SHA `cc69791604f338a90e07dc07da8118a2d7a68188` reports a ready two-linked-user directory
   baseline and all four flags OFF, but zero password-capable alias administrators and no Stream
   client secret/template/integration configuration. Production alias and Stream remain NO-GO.
8. A staging values-free T2-Gate inventory reported three active corp-anchored integrations across
   two distinct corp anchors, but only one corp with active directory accounts and zero cross-corp
   overlap groups. Automatic sync and schedules were both zero. The post-fix two-corp UAT entry
   criterion is therefore not met: a real second-enterprise member set and one real overlap person
   remain external owner inputs. Transfer T3-T5 stays frozen; local DB fabrication is prohibited.
9. The owner-approved Stream window used fresh storage-health run
   [31765617958](https://github.com/zensgit/metasheet2/actions/runs/31765617958), then Stream
   [on 31856025380](https://github.com/zensgit/metasheet2/actions/runs/31856025380) at exact
   deployed SHA `12f1f8c466ddf0fcbfcf2ea07902528ac02430f1`. The `on` artifact reported
   `reason=on_ok`, `stream_enabled=true`, `worker_state=started`, `backend_health=true`, and all
   lifecycle flags OFF. As designed, startup alone left `stream_connected=unknown`.
10. While Stream was on, the operator created the values-free staging approval `AP-100009` from the
    published UAT template. MetaSheet showed it as pending for the linked local assignee. No
    controllable DingTalk message surface or human confirmation was available in the window, so
    card receipt, callback execution, corp-anchor fields, duplicate/non-assignee behavior, and the
    remaining U1-U13 assertions were **NOT EXECUTED**. A pending MetaSheet approval is not delivery
    or callback evidence.
11. The fail-safe
    [off 31856520796](https://github.com/zensgit/metasheet2/actions/runs/31856520796) completed with
    `reason=off_ok`; terminal read-only
    [status 31856563224](https://github.com/zensgit/metasheet2/actions/runs/31856563224) independently
    proved `stream_enabled=false`, `worker_state=disabled`, `lifecycle_flags_all_off=true`, exact
    deployed SHA match, and healthy backend. This is a real worker-stop/OFF proof, not a claim that
    the unexecuted human-click matrix passed.
12. A second owner-authorized diagnostic window started from read-only
    [status 31860310854](https://github.com/zensgit/metasheet2/actions/runs/31860310854) and fresh
    [storage health 31860571244](https://github.com/zensgit/metasheet2/actions/runs/31860571244),
    then enabled Stream with
    [on 31860609204](https://github.com/zensgit/metasheet2/actions/runs/31860609204). The artifacts
    again proved exact deployed SHA `12f1f8c466ddf0fcbfcf2ea07902528ac02430f1`, healthy backend,
    `worker_state=started`, one eligible configured-corp anchor with two linked local users, and
    all lifecycle flags OFF. The two linked local users were also checked in the staging admin UI
    as distinct DingTalk identities before the window.
13. While that window was open, the operator created `AP-100010` for linked assignee `GH UI Smoke`
    (directory display name `周华`). The automation execution failed before send in 16 ms with the
    fixed error that `APPROVAL_CARD_LINK_SECRET` or the assignee integration's stored approval-card
    link secret was required. The selected `Staging DingTalk E4 HMR validation` integration then
    showed its one-tap card secret status as `未生成`. Therefore the missing DingTalk card is
    explained by a pre-send configuration failure; it is not evidence about Stream connectivity,
    card delivery, or callback behavior. No U1-U13 row advanced.
14. The timer-driven fail-safe
    [off 31861138171](https://github.com/zensgit/metasheet2/actions/runs/31861138171) succeeded.
    Terminal read-only
    [status 31861174400](https://github.com/zensgit/metasheet2/actions/runs/31861174400) independently
    proved Stream OFF, worker disabled, all lifecycle flags OFF, exact deployed SHA, and healthy
    backend. A later retry requires owner authorization to generate and store the random per-
    integration link secret first; secret generation and another Stream window are not authorized
    by this evidence record.
15. The owner then authorized generation of the random per-integration link secret and a third
    Stream window. The staging admin UI generated and encrypted the secret for
    `Staging DingTalk E4 HMR validation`, showed `密钥已生成`, and did not reveal its value. Fresh
    [status 31862815372](https://github.com/zensgit/metasheet2/actions/runs/31862815372) and
    [storage health 31862873263](https://github.com/zensgit/metasheet2/actions/runs/31862873263)
    passed before
    [on 31862904652](https://github.com/zensgit/metasheet2/actions/runs/31862904652). The artifacts
    proved the same exact deployed SHA, healthy backend, one eligible anchor with two linked local
    users, `worker_state=started`, and all lifecycle flags OFF.
16. The operator created fresh approval `AP-100011` for `GH UI Smoke`. Its automation passed the
    link-secret gate but DingTalk rejected the create-and-deliver request after 2699 ms because the
    Stream application `dingn9htcox9lc12rxmc` lacked `Card.Instance.Write`. No card was sent, so no
    U1-U13 or callback row advanced. Fail-safe
    [off 31863021812](https://github.com/zensgit/metasheet2/actions/runs/31863021812) succeeded, and
    terminal read-only
    [status 31863057131](https://github.com/zensgit/metasheet2/actions/runs/31863057131) proved
    `stream_enabled=false`, `worker_state=disabled`, `lifecycle_flags_all_off=true`, exact deployed
    SHA match, and healthy backend. Another window requires owner-side DingTalk permission grant
    and publication first; this record does not claim that external action is complete.
17. The owner published `Card.Instance.Write` for Stream application `dingn9htcox9lc12rxmc`, then
    authorized a fourth controlled window. Fresh
    [status 31863947642](https://github.com/zensgit/metasheet2/actions/runs/31863947642) and
    [storage health 31864023183](https://github.com/zensgit/metasheet2/actions/runs/31864023183)
    passed before
    [on 31864059132](https://github.com/zensgit/metasheet2/actions/runs/31864059132). The operator
    created approval `AP-100012` for `GH UI Smoke`; automation completed and returned
    `deliveryKind=interactive_card` with a non-secret delivery identifier. This proves the send
    path crossed the prior permission blocker, but the assignee had not yet confirmed receipt or
    clicked the card, so no callback or U11-a claim is made. The window was closed rather than left
    open while waiting for the human:
    [off 31864532416](https://github.com/zensgit/metasheet2/actions/runs/31864532416) succeeded and
    terminal read-only
    [status 31864575172](https://github.com/zensgit/metasheet2/actions/runs/31864575172) proved exact
    deployed SHA match, healthy backend, `stream_enabled=false`, `worker_state=disabled`, and all
    lifecycle flags OFF.
18. A later read-only HTTPS inventory used draft PR #4890's status-only probe:
    [31865023926](https://github.com/zensgit/metasheet2/actions/runs/31865023926). It found the
    digest-pinned staging Caddy gateway running and healthy, ports 80/443 listening, all three live
    URL settings matching the managed HTTPS origin/callback, and the pre-HTTPS backup still present.
    Stream and all lifecycle flags remained OFF. This is an honest pending operational state, not a
    production enablement: PR #4890 is still draft/unmerged, and no `https-off` mutation is
    authorized by this evidence record.

## 1. Environment boundary

Two independently configured deployment roots were observed and must not be conflated:

| Evidence lane | Deployed SHA | Purpose |
|---|---|---|
| Lifecycle staging canary (`STAGING_DEPLOY_PATH`) | `12f1f8c466ddf0fcbfcf2ea07902528ac02430f1` | Exact lifecycle status, deprovision apply/restore, OAuth correlation, and terminal OFF proof |
| Production-readiness inventory (`DEPLOY_PATH`) | `cc69791604f338a90e07dc07da8118a2d7a68188` | Read-only DingTalk integration, account, Stream, and flag inventory |

The differing code SHAs are not used to infer shared runtime state between the two roots; each
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
[31559480395](https://github.com/zensgit/metasheet2/actions/runs/31559480395) was the terminal proof for
that recovery head: exact deployed SHA, healthy backend, zero pending migrations, mode `off`, all
three lifecycle flags `false`, and `transition_applied=false`.

[#4879](https://github.com/zensgit/metasheet2/pull/4879), merge
`2bf058c2a4fd5abed76df347b3bfdb74dba148ee`, added the explicit second-sentinel contract. Staging
deploy [31573166502](https://github.com/zensgit/metasheet2/actions/runs/31573166502) pinned backend
and web to that exact SHA with `314/0` migrations. Read-only status
[31573329397](https://github.com/zensgit/metasheet2/actions/runs/31573329397), deprovision preflight
[31575076447](https://github.com/zensgit/metasheet2/actions/runs/31575076447), and terminal status
[31576139497](https://github.com/zensgit/metasheet2/actions/runs/31576139497) each reported a healthy
backend, zero pending migrations, mode `off`, all three lifecycle flags `false`, and
`transition_applied=false`. The terminal status supersedes the earlier terminal-state proof.

## 4. Canary sequence

| Order | Stage | Result | Durable evidence / reason |
|---|---|---|---|
| 1 | alias-only | **PASS, rolled back** | Hardened-deploy run `31529335625`; transient ON was proven by real password login and success required a return to exact OFF |
| 2 | pending admission | **PASS for admit + SSO activate intent; post-activation OAuth positive PASS; rolled back** | Runs `31551343313` and `31551426867` used an explicit owned subject and left lifecycle flags OFF; Section 0 ties the later successful real OAuth callback to that exact owned subject |
| 3 | deprovision | **PASS server-side, restored and rolled back; post-restore OAuth positive PASS; apply-time browser denial NOT EXECUTED** | Apply/restore reruns `31778647232` / `31778860419` proved the exact event/effects and graph restoration; Section 0 proves restored-subject OAuth without claiming the missing apply-time browser denial |

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
successful password-backed administrator login. The later real callback and values-free subject
correlation in Section 0 prove post-activation browser OAuth success for this exact subject. No
pre-activation browser denial was executed. Pending production enablement therefore remains a
separate NO-GO decision despite the staging positive checkpoint.

### 4.3 Deprovision attempts, recovery, and completed server-side cycle

The earlier read-only directory preview saw no removal candidate and reported zero
would-deactivate accounts. A later browser inspection showed that the active integration is a
shared employee integration, so it is explicitly disqualified from destructive canary use.
Deprovision cannot be proven by editing the local database or by selecting a real employee.

At that point, the only other visible staging integration had a different corp anchor, zero
accounts, and a failed most-recent sync. It could not be repurposed as the dedicated integration
for the authenticated corp without a separately authorized reconfiguration and valid source
credentials.

The completed cycle used a separate active DingTalk integration containing exactly the selected
linked account plus one distinct active unlinked sentinel (all active and inactive account rows
count), with scheduler, admission automation, and member-group projection disabled, using
`mark_inactive`. Apply required
`DINGTALK_SOURCE_DISABLED_DEDICATED_EXCLUSIVE_CONFIRMED`, which attests that the source is disabled
and no other operator will sync or edit this dedicated integration until the lifecycle flags are
proven OFF. The preview and exact target-plus-sentinel checks are not an atomic scope lock, so this
exclusive window was mandatory and remains required for any rerun. The apply sequence used an exact
one-subject preview and planner result, persisted a random sync run UUID before env/HTTP,
transiently enabled only deprovision, and started the async sync with that UUID. A lost 202 or
runner crash retains the exact recovery journal;
retries cannot start a second provider pull with the same UUID. Recovery binds only that run's
single event and exact membership/grant/user effect triple. Restore probes the exact event tuple,
reverses it, verifies the exact effect set and access graph, and leaves all three flags OFF.
An exact run that terminates without a matching ledger event leaves a fail-closed journal. It must
be resolved through a reason-specific, owner-reviewed recovery path; deleting the journal to force
a new apply is prohibited.

The dedicated integration and explicit target passed the ownership/exclusivity gates. Two earlier
pre-ledger attempts failed safely before the completed cycle:

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

[#4879](https://github.com/zensgit/metasheet2/pull/4879) then added an explicit sentinel secret and
enforced an exact two-account integration shape: the owned linked target plus one distinct active,
unlinked sentinel. Three early apply dispatches
([31574918042](https://github.com/zensgit/metasheet2/actions/runs/31574918042),
[31575135399](https://github.com/zensgit/metasheet2/actions/runs/31575135399), and
[31575274256](https://github.com/zensgit/metasheet2/actions/runs/31575274256)) rejected a malformed
sentinel secret at the UUID-shape gate before lifecycle env or ledger mutation. The operator then
corrected the secret through stdin without exposing its value.

The controlled source sequence was observed in the DingTalk administrator UI without recording
identifiers: organization membership remained five; the canary department changed from target plus
sentinel, to sentinel only for apply, back to both for restore, and finally to the target only after
the temporary sentinel was removed.

[Apply run 31575411459](https://github.com/zensgit/metasheet2/actions/runs/31575411459) proved the
exact target-and-sentinel gate, a one-target preview, one deactivated user/account, one ledger event,
three effects, and a present generation. It then restored all flags to OFF while retaining the
`ledger_bound` journal and disabled access graph for the explicit restore phase.

[Restore run 31575938536](https://github.com/zensgit/metasheet2/actions/runs/31575938536) synchronized
the re-added source with deprovision OFF, reversed exactly three effects, proved the event fully
resolved, restored one active membership and the enabled grant, cleared the journal, and left all
three lifecycle flags OFF. The original artifact deliberately reports password-login and OAuth
browser checkpoints as `NOT_EXECUTED` and `end_to_end_restore_claimed=false`; it remains the
run-bound server-side proof. The later Section 0 callback independently proves the restored owned
subject can log in through OAuth. The apply-time browser denial checkpoint was still not executed,
so this record does not rewrite the original artifact or claim that missing negative checkpoint.

## 5. DingTalk directory readiness

[Production-readiness inventory run 31579935836](https://github.com/zensgit/metasheet2/actions/runs/31579935836)
completed successfully after the lifecycle restore against deployed SHA
`2bf058c2a4fd5abed76df347b3bfdb74dba148ee` and reported:

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

This run-bound historical inventory proves that the usable directory baseline and exact OFF state
held after the server-side pending and deprovision canaries recorded in Sections 4.2 and 4.3. It
does not prove the omitted browser checkpoints and is not interactive-card readiness.

## 6. U1-U13 and real callback corp-anchor

The canonical procedure remains
`docs/development/dingtalk-hardening-real-uat-evidence-pack-20260713.md`. No row below is
simulated.

| Gate | Result | Blocking evidence |
|---|---|---|
| U1-U13 (including U3-a and U11-b) | **PARTIAL; NOT ACCEPTED** | The first three windows exposed and closed configuration/permission blockers. After `Card.Instance.Write` was published, the fourth window's `AP-100012` automation completed with `deliveryKind=interactive_card`. Assignee receipt, card-body inspection, callback, duplicate/non-assignee behavior, OA fallback, and the remaining human matrix are still unexecuted; a successful send alone is not U1 acceptance |
| U11-a real callback corp-anchor | **NOT EXECUTED** | No real card callback frame has been captured; configuration readiness is not callback evidence |
| Operational worker-stop/OFF control (not a U12/U13 acceptance verdict) | **PASS** | Runs `31856520796`/`31856563224`, `31861138171`/`31861174400`, `31863021812`/`31863057131`, and `31864532416`/`31864575172` prove clean operational stops and disabled worker; post-OFF OA fallback send and the full human callback sequence remain unexecuted |
| P1 latest storage-health precondition | **PASS at latest window start** | `Attendance Remote Storage Health (Prod)` run [31864023183](https://github.com/zensgit/metasheet2/actions/runs/31864023183) was successful before Stream `on` |
| P2 exact target SHA | known per environment | See Section 1; do not mix the two deployment roots |
| P3 real corp + two linked users | **READY for controlled staging `on` window** | Runs `31854315133` and `31854359627` report exactly one eligible configured-corp anchor with two linked users after successful prepare |
| P4 `LOG_LEVEL=info|debug` | **READY** | Inventory reported `log_level_ready=true`, reason `missing`; `core/logger.ts` defaults an unset/empty value to `info` |

Historical Stream inventory from run `31579935836` (superseded for staging readiness by
`31817945571`):

```text
client_id_present=false
client_secret_present=false
template_id_present=false
integration_id_present=false
credentials_ready=false
```

Those values are historical for run `31579935836`. Prepare run `31854315133` and post-status
`31854359627` supersede the missing-configuration diagnosis. The later controlled window
`31856025380 -> 31856520796 -> 31856563224` proved worker start followed by a safe return to OFF.
U1-U13 and the callback corp-anchor remain incomplete. The owner-authorized random link-secret
generation closed the second window's pre-send blocker without exposing the value, and publication
of `Card.Instance.Write` closed the third window's permission blocker. The fourth window produced a
real `interactive_card` delivery for `AP-100012`, then returned safely to OFF before waiting for the
human.

Required external action: the linked assignee must confirm receipt and be available for a short
owner-approved callback window together with a non-assignee. Execute the canonical U1-U13
procedure, capture only values-free booleans/status enums, and execute `off` before the window ends.
Secrets must not be pasted into this document or chat.

## 7. Production and transfer gates

| Decision | Current verdict |
|---|---|
| production alias enable | **NO GO** until owner reviews staging evidence and separately authorizes production |
| production pending enable | **NO GO**; staging admit/activate and post-activation OAuth positive passed, but production readiness and owner GO remain incomplete |
| production deprovision enable | **NO GO**; staging apply/restore and post-restore OAuth positive passed, but the apply-time browser denial checkpoint, production readiness, and separate owner GO remain incomplete |
| interactive-card Stream enable | **NO GO for production**; staging start/stop is proven, but the U1-U13/U11-a real-card matrix is not executed and production Stream inputs remain absent |
| Transfer T3-T5 | **FROZEN**; real two-corp T2-Gate remains separate and unexecuted |
| lifecycle production-enable owner | **NOT ASSIGNED**; do not infer an owner from repository or staging access |
| interactive-card UAT owner | one staging window was owner-authorized; a synchronized real-time assignee/non-assignee operator is still **NOT ASSIGNED** for the remaining click matrix |

The safe terminal state for this execution is therefore:

```text
AUTH_LOGIN_USE_ALIASES=false
DIRECTORY_PENDING_ACTIVATION_ENABLED=false
DIRECTORY_DEPROVISION_ENABLED=false
DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED=false
```

## 8. Next executable actions

1. Complete the remaining deprovision apply-time browser denial checkpoint if production lifecycle
   enablement is to be considered; do not infer it from server-side access denial.
2. Re-run a short Stream `on` window only with the linked assignee and non-assignee available for
   real card actions; complete U1-U13 and the real callback corp-anchor, then execute `off`.
3. Record named owners and explicit production switch decisions. Any absent evidence remains
   `NOT EXECUTED`.

The lifecycle code line and all three server-side staging canaries are closed with terminal OFF
proof. Post-activation and post-restore OAuth positives are complete for the exact owned subject;
the deprovision apply-time browser denial, production enablement, U1-U13, the real callback
corp-anchor, and the remaining real-enterprise acceptance are not complete.
