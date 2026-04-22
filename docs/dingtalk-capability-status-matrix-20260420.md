# DingTalk Capability Status Matrix

- Date: 2026-04-20
- Scope: current `main`
- Audience: product, engineering, implementation owners

## Legend

- `Implemented`: already in `main`
- `Implemented with constraints`: already in `main`, but with an explicit boundary you should know
- `Pending`: not in `main` yet

## Status Matrix

| Capability area | Status | Current behavior on `main` | Key references |
| --- | --- | --- | --- |
| DingTalk login bootstrap | Implemented | Users can start DingTalk login from the login page and complete the callback flow. | [LoginView.vue](../apps/web/src/views/LoginView.vue:278), [DingTalkAuthCallbackView.vue](../apps/web/src/views/DingTalkAuthCallbackView.vue:145) |
| Local user <-> DingTalk identity binding | Implemented | Local users can bind and unbind DingTalk from the session/settings flow. | [SessionCenterView.vue](../apps/web/src/views/SessionCenterView.vue:404), [auth.ts](../packages/core-backend/src/routes/auth.ts:1) |
| Directory mirror sync | Implemented | DingTalk departments and members sync into the directory mirror for review and downstream governance. | [directory-sync.ts](../packages/core-backend/src/directory/directory-sync.ts:1979), [DirectoryManagementView.vue](../apps/web/src/views/DirectoryManagementView.vue:1) |
| Manual synced-account -> local-user admission | Implemented | Admins can create a local user from a synced directory account and bind it in one step. Email is optional when username or mobile is supplied. | [admin-directory.ts](../packages/core-backend/src/routes/admin-directory.ts), [directory-sync.ts](../packages/core-backend/src/directory/directory-sync.ts) |
| Department-scoped auto-admission | Implemented | Selected departments can auto-create and auto-bind local users during sync. Missing-email accounts receive generated usernames and temporary-password onboarding packets. | [directory-sync.ts](../packages/core-backend/src/directory/directory-sync.ts), [DirectoryManagementView.vue](../apps/web/src/views/DirectoryManagementView.vue) |
| Auto-admission exclusion scopes | Implemented | Child departments can be explicitly excluded from auto-admission. | [directory-sync.ts](../packages/core-backend/src/directory/directory-sync.ts:2022), [dingtalk-directory-auto-admission-exclusions-development-20260418.md](../docs/development/dingtalk-directory-auto-admission-exclusions-development-20260418.md:1) |
| Forced password change for DingTalk-driven onboarding | Implemented | Generated temporary passwords set `must_change_password`, and the user is forced through password change on first login. | [auth.ts](../packages/core-backend/src/routes/auth.ts:433), [ForcePasswordChangeView.vue](../apps/web/src/views/ForcePasswordChangeView.vue:1) |
| DingTalk department -> platform member group projection | Implemented | Scoped synced departments can project into `platform_member_groups`. | [directory-sync.ts](../packages/core-backend/src/directory/directory-sync.ts:740), [DirectoryManagementView.vue](../apps/web/src/views/DirectoryManagementView.vue:191) |
| DingTalk group destinations | Implemented with constraints | Management-side UI can register DingTalk group robot webhooks and secrets. Destinations are manually registered, not auto-imported from DingTalk. | [dingtalk-group-destination-service.ts](../packages/core-backend/src/multitable/dingtalk-group-destination-service.ts:127), [MetaApiTokenManager.vue](../apps/web/src/multitable/components/MetaApiTokenManager.vue:1) |
| DingTalk group automation messages | Implemented | Tables can send `send_dingtalk_group_message` via automation rules, including public-form and internal links. | [automation-actions.ts](../packages/core-backend/src/multitable/automation-actions.ts:50), [automation-executor.ts](../packages/core-backend/src/multitable/automation-executor.ts:859), [MetaAutomationRuleEditor.vue](../apps/web/src/multitable/components/MetaAutomationRuleEditor.vue:188) |
| DingTalk person automation messages | Implemented | Tables can send `send_dingtalk_person_message` to selected local users that are already bound to DingTalk. | [automation-actions.ts](../packages/core-backend/src/multitable/automation-actions.ts:59), [automation-executor.ts](../packages/core-backend/src/multitable/automation-executor.ts:609), [MetaAutomationManager.vue](../apps/web/src/multitable/components/MetaAutomationManager.vue:187) |
| Delivery history | Implemented | Group and person deliveries both have history viewers. Group history exists at destination level and rule level. | [dingtalk-group-delivery-service.ts](../packages/core-backend/src/multitable/dingtalk-group-delivery-service.ts:82), [dingtalk-person-delivery-service.ts](../packages/core-backend/src/multitable/dingtalk-person-delivery-service.ts:93) |
| Notification template governance | Implemented | Presets, token assist, preview, copy actions, syntax warnings, and unknown-path warnings are already in `main`. | [MetaAutomationRuleEditor.vue](../apps/web/src/multitable/components/MetaAutomationRuleEditor.vue:1), [MetaAutomationManager.vue](../apps/web/src/multitable/components/MetaAutomationManager.vue:1) |
| Public form access modes | Implemented | Public forms support `public`, `dingtalk`, and `dingtalk_granted`. | [univer-meta.ts](../packages/core-backend/src/routes/univer-meta.ts:5362), [MetaFormShareManager.vue](../apps/web/src/multitable/components/MetaFormShareManager.vue:1) |
| Protected public-form allowlists | Implemented | Protected forms can restrict submission to selected local users and local member groups. | [univer-meta.ts](../packages/core-backend/src/routes/univer-meta.ts:5425), [MetaFormShareManager.vue](../apps/web/src/multitable/components/MetaFormShareManager.vue:335) |
| Internal deep-link processing | Implemented with constraints | DingTalk messages can include internal multitable links. Access still depends on local ACL. | [dingtalk-capability-guide-20260420.md](../docs/dingtalk-capability-guide-20260420.md:117) |
| Selecting raw DingTalk users as authority subjects | Pending | The authority subject remains local users and local member groups, not raw DingTalk user IDs. | [dingtalk-capability-guide-20260420.md](../docs/dingtalk-capability-guide-20260420.md:141) |
| No-email synced-account -> local-user admission on `main` | Implemented | Manual admission accepts `name + username/mobile` when email is missing. Auto-admission generates a username for missing-email accounts and returns onboarding packets. | [directory-sync.ts](../packages/core-backend/src/directory/directory-sync.ts), [DirectoryManagementView.vue](../apps/web/src/views/DirectoryManagementView.vue) |
| Shared group-destination catalog | Pending | Current group destinations are registered and listed per creator path, not yet a shared organization-wide catalog. | [dingtalk-group-destination-service.ts](../packages/core-backend/src/multitable/dingtalk-group-destination-service.ts:150) |
| Row/column-level fill assignment through DingTalk workflows | Pending | The current mainline supports table/form-level targeting, not yet a dedicated “this user fills this row/column” model. | [dingtalk-admin-operations-guide-20260420.md](../docs/dingtalk-admin-operations-guide-20260420.md:118) |

## Short conclusion

- The DingTalk mainline is already complete enough for:
  - sign-in and binding
  - directory-sync-driven local user creation
  - DingTalk group and person notifications
  - protected public forms
  - selected local user/member-group allowlists
- The main gaps are now governance refinements, not 0-to-1 capability gaps:
  - shared group destinations
  - finer fill assignment
  - no-email onboarding governance polish
