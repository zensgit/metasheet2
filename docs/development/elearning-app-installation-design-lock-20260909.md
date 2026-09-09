# Cloud classroom optional installation

Status: implementation authorized by owner; local verification pending.

Scope: optional organization-scoped application, not a new learning capability.

- Reuse `platform_app_instances`, keyed by the authenticated organization in both
  tenant_id and workspace_id, app_id=elearning, instance_key=primary.
- Missing instance means not installed. Installation creates an inactive instance;
  it never grants RBAC, enables deployment flags, provisions storage, or sends messages.
- Only a hydrated global elearning administrator with active organization membership
  may install, enable, disable, or configure notification opt-in.
- Existing exact-true deployment flags remain an upper bound. Installation is an
  additional server gate, never a substitute for authentication or domain authorization.
- Enable/disable is separate from installation. Notifications default false.
- Disabled/uninstalled organizations cannot start business requests or new learning
  jobs. Already-admitted operations may drain; cleanup must remain possible so disabling
  does not strand objects or erase evidence. Disable does not delete learning data.
- The application catalog may advertise installation to administrators; My Apps only
  advertises an enabled installation. No automatic backfill installs existing tenants.
- Video storage remains deployment-owned and required only for the video capability;
  installation never claims to provision an object store.

Acceptance: same-org active admin, missing context, closed commands, repeat install
preserves state, missing/corrupt installation fails closed, HTTP and worker gates,
catalog visibility, notification opt-in, and enabled legacy learning regressions.

Delivery remains local until tests and independent review pass. No deployment, flag
enablement, real notification, or production database change is authorized by this slice.
