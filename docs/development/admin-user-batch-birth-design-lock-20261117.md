# Admin batch user birth transaction boundary

This B2 prerequisite converts only `admin-user-batch.ts:createOne`. Independent design review accepted this bounded batch contract. Single-create attendance composition, other birth producers and final W16 closure remain separate; no production purpose, flag or external capability is enabled.

## Command and atomicity

Add one data-only `createAdminBatchUserCommand` in `admin/admin-user-batch-birth-command.ts`. Capture an explicit closed plain-data input before the first await: actorId, generated userId, email, name, department, passwordHash and optional roleId. No client, callback, plan, runner or arbitrary column map. Derive all fixed user fields in the command. Keep the route's existing planning, limit100, sequential order, per-item transaction/result semantics, password generation/hash and post-commit cache/audit. Earlier successful rows remain committed when later rows fail; recheck actor per row.

Freeze the owned context and exact plan `{ intent:'BIRTH', roleIds:[roleId] or [], witness:{userIds:[actorId], admissionUserIds:[actorId]} }`. No top-level target locks, identity slot, R1, upgrade, takeover, custom root options, nested root or late acquire. Use the existing default READ COMMITTED root: R0 shared → selected role SHARE → actor R3 → actor R5. Actor must differ from generated target.

On entry and before business DML, require genuine open same-connection token, identical frozen plan/context, exact own keys and lists, shared world/BIRTH, exact actual actor locked and witnessed sets, exact selected-role keys, and empty born set. Missing/inactive/pending/deleted/purged actor is ordinary FORBIDDEN; malformed token is a contract failure. Raw users.role admin is sufficient; otherwise hold exact user_roles(actor,admin) child FOR SHARE through COMMIT using existing5000/10000 timeout convention. No token claim/is_admin/wildcard shortcut or requirement for an admin parent on the raw-admin path.

After actor authority, selected role must actually be held; disappearance after planning gives ROLE_NOT_FOUND before insert. No-role means no parent keys. Use `insertUserForBirth` exactly once, with the current batch fields and literals: null username/mobile/employee_no/position/hire_date; JSON text `'[]'` permissions; must_change_password and is_active true; is_admin iff display role admin; activated/local_password_set true. Omit created_at/updated_at to use the existing transaction-time database defaults; do not substitute application time. Returned ID must equal generated ID and actual born set must be exactly target, absent from locked/witness sets.

Repeat actual actor/parent/born checks before dependent writes. Keep same-transaction alias claims and optional `assignUserRoles` with platform-admin scope and tx executor. Invoke existing W16 once with target, attendance namespace, enabled false, actor and source admin_batch_create. No copied role/admission SQL or raw-client fallback. Private boundary enforces born semantics; shared W16 cannot globally reject single-create before that producer is converted.

## Registry and verification

Main owns truthful B-05 accounting and guards: the route's literal INSERT moves to the existing kernel birth primitive, so do not retain a fictional direct statement. A focused producer guard must prove the one root/insertUserForBirth/caller edge and reject raw SQL, alternate client/callback, aliases and loader bypasses. Do not weaken sibling guards or promote W16/W01/B-04/W-07b.

Focused unit and route coverage includes exact plan/context/order, role/no-role/admin role, raw/RBAC authority, every actor denial, missing parent, returned-ID/actual-born mismatch, failures at aliases/role/admission, no out-of-root DML, partial batch results and actor revocation between rows, uncertain COMMIT and post-commit failure distinction. Password appears only in the existing successful response, never evidence.

Real synthetic PG coverage includes actor and raw-child revocation both orders, selected-role deletion/content changes, world-exclusive competition, alias-conflicting births, full rollback at dependent writes and visibility only after COMMIT. Prove physical blocker/phase, full rows and unchanged neighbors. Mutate relevant guards to behavioral red, save source bytes and restore exactly. Missing/unreachable DB refuses instead of skip-green. New PG file is wired once into the existing required owner lane and default exclusion with removal/duplicate/relocation controls. Source/PG evidence and remote CI remain distinct.

Grok authors scoped source/tests; main integrates shared guards/workflows and runs DB/heavy serially against released bytes. Independent code review must close actual findings. No install, commit, push, deployment, staging or real-account/data operations. This slice alone is not full B2 acceptance.
