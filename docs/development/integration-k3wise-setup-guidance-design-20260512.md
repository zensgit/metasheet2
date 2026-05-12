# K3 WISE setup guidance design

## Context

The Windows on-prem K3 WISE setup page exposed internal integration scope fields next to K3 connection fields without enough operator guidance. During manual deployment testing, this caused three avoidable questions:

- whether `Tenant ID` should be removed;
- whether `Workspace ID` is required;
- whether `WebAPI Base URL` should include `/K3API` when advanced paths already contain `/K3API/...`;
- how an operator can tell that K3 WISE is actually connected.

## Decision

Keep `Tenant ID` visible but document it as an integration scope, not a K3 business field. The backend requires a tenant scope for external-system and pipeline routes, so removing it would make the form less honest and push the error later into API validation.

For the current single-tenant on-prem PoC:

- default `Tenant ID` to `default` when no local tenant is available;
- keep `Workspace ID` optional and advise leaving it blank for the current PoC;
- tell operators that K3 `acctId` belongs in the credential section, not in `Tenant ID`;
- change the Base URL placeholder to host-only form, for example `http://k3-server:port`;
- explain that advanced WebAPI paths already include `/K3API/...`;
- show a non-blocking warning when the Base URL contains `/K3API`;
- add a visible WebAPI connection state in the side rail.

## UX Contract

The page now describes the expected deployment values:

| Field | On-prem PoC guidance |
| --- | --- |
| Tenant ID | Use `default` for the single-tenant entity-machine test. |
| Workspace ID | Leave blank unless multiple workspace scopes are explicitly required. |
| WebAPI Base URL | Fill only protocol, host, and optional port. |
| Token/Login/Save paths | Keep `/K3API/...` path defaults unless the customer K3 API package differs. |
| WebAPI connection state | Save first, then click `Test WebAPI`; connected state requires a successful saved-system test. |

## Non-Goals

- This change does not alter backend authorization or route scope enforcement.
- This change does not hide `Tenant ID`, because the API still needs it.
- This change does not auto-test K3 on every form edit; connection testing remains an explicit operator action.
- This change does not change K3 adapter URL composition.

## Deployment Impact

Frontend-only change. No migration, runtime config, credential, or plugin behavior change.
