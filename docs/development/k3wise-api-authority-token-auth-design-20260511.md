# K3 WISE API Authority Token Auth - Design

## Context

The customer-side K3 server package was reviewed from:

```text
/Users/chouhua/Downloads/K3API.zip
```

The zip is not committed. It contains the deployed K3 WebAPI application,
operator documentation, logs, and a nested APITest C# sample. The logs include
live-looking authorization material, so findings below intentionally describe
shapes and endpoints only.

## Package Findings

The bundled APITest client and documentation show the real K3 WISE API flow:

1. Request a temporary token:

```text
GET /K3API/Token/Create?authorityCode=<redacted>
```

2. Send business calls with the token in the query string:

```text
POST /K3API/Material/Save?Token=<redacted>
POST /K3API/BOM/Save?Token=<redacted>
```

3. Send payloads under the `Data` envelope:

```json
{
  "Data": {
    "FNumber": "..."
  }
}
```

The sample also includes PO operations (`GetTemplate`, `GetList`, `GetDetail`,
`Save`, `Update`, `CheckBill`) and DES/ECB/PKCS7 helper code for encrypted
responses. Encryption support is not enabled in this slice; the first live path
needs plain JSON token auth.

## Prior Gap

`plugin-integration-core` originally assumed a login-session style K3 adapter:

- `POST /K3API/Login`
- `username`, `password`, `acctId`
- session header or cookie on subsequent requests
- default save body key `Model`

That still works for existing mocks, but it does not match this K3API package.
Against the real package, the adapter would fail before any material/BOM write.

## Design

### Backend Adapter

`plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs`
now supports both modes:

- `authMode: "authority-code"` or credentials containing `authorityCode`
  requests `/K3API/Token/Create` and caches the returned token until its
  reported validity approaches expiry.
- `authMode: "login"` continues to use the previous username/password/acctId
  path.
- business calls append the K3 token as `Token=<redacted>` query param.
- default K3 WISE save payload envelope is now `Data`, matching the customer
  package.
- K3 package response shapes are accepted through `StatusCode`, `Data.Code`,
  `Data.Token`, `Data.FItemID`, and `Data.FNumber`.

### Frontend Setup

`apps/web/src/services/integration/k3WiseSetup.ts` and
`apps/web/src/views/IntegrationK3WiseSetupView.vue` now expose a WebAPI auth
mode:

- `授权码 Token` is the default for the current K3API package.
- `账套登录` remains available for existing login-session deployments.
- the authority code is treated as a credential and is never echoed back.
- saved legacy systems without `authMode` but with `loginPath` still load as
  login mode.

## Non-goals

- Do not commit or redistribute the K3API package.
- Do not enable encrypted response support yet.
- Do not change SQL Server channel behavior.
- Do not automatically Submit/Audit after Save.
- Do not bypass the customer GATE or live-run approval controls.
