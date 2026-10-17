# Personal BOM paired HTTP verification

Run `verify.py` with explicit local paths to two isolated checkouts and existing dependencies:

```sh
python verify.py \
  --meta-checkout /absolute/path/to/metasheet2 \
  --native-checkout /absolute/path/to/Yuantus \
  --python /absolute/path/to/native-venv/bin/python \
  --node /absolute/path/to/node20 \
  --tsx /absolute/path/to/tsx/dist/cli.mjs \
  --pg-bin /absolute/path/to/postgresql/bin \
  --output /absolute/path/to/proof.json
```

Requires POSIX, OpenSSL at `/usr/bin/openssl`, native Python dependencies, installed MetaSheet dependencies, and local PostgreSQL binaries. The Python executable path preserves its virtual-environment symlink. It never installs dependencies or connects to an existing database. It creates a socket-only PostgreSQL cluster and private native global/identity/tenant SQLite files under its own temporary root; child environments, HOME and cwd are isolated. Every runtime resource, CA and private key is removed after shutdown.

Three distinct Meta processes run sequentially against that same disposable PostgreSQL store:

1. Issue and bind a real native `bom_write` grant through HTTP. Commit a line PATCH in native, then have the owned TLS proxy drop the response. Meta persists an unknown intent and exits. A changed payload under the same key is refused.
2. Restart Meta, revoke the previous native grant, and verify native 401 retains possible prior application. Bind a replacement for the same native person and replay the same frozen key/body. Commit ECO intent in native, drop its response, persist unknown, and exit.
3. Restart Meta again, revoke/rebind and recover ECO with its original key. Verify wrong Meta tenant and non-owner admin denial, unbind, refusal after unbind, cleared binding secrets and retained accepted intent/audit evidence.

The verifier compares stored key hashes across actual process restarts and hashes observed native mutation headers. An untrusted-certificate control must fail; the real calls trust only the owned test CA, without disabling TLS validation. All native mutations must carry personal `yuw_` grants despite a valid configured native read JWT. The personal service receives a separate real provider adapter with a deliberately stale origin, wrong native tenant/org and unusable shared header; only explicit persisted source authority can make the HTTP chain succeed. Native SQL must show quantity 8, exactly one ECO, one personal ECO receipt and one domain audit with Auth subject 42 / RBAC actor 900. All three issued write grants must be revoked. No HTTP fetch or native dependency is mocked.

The evidence records checkout heads **and executed source fingerprints** because a candidate can be uncommitted. A green result does not prove an unrelated checkout or later diff. Native uses the official tenant provisioning metadata builder; Meta runs the actual personal migrations with minimal ancillary tables. This is not a full default migration-chain rehearsal, whole `index.ts` application lifecycle, forced process-crash drill, browser/UI acceptance, production deployment or customer acceptance. Normal JWT membership logic has separate signed-carrier and PostgreSQL coverage; this HTTP chain deliberately uses the supported signed trusted-claims mode plus live service membership checks.

A separate fresh browser lane is available with `--browser --browser-cache /absolute/path/to/existing/ms-playwright`. It uses the installed Chromium cache without installing anything, an owned Vite cache and environment directory, the actual Vue BOM review/binding components, and the same real Meta/native HTTP boundary. It checks explicit binding, line/ECO response loss, refresh without automatic resend, frozen body/key/If-Match replay, a separate subsequent edit with the refreshed source ETag, and unbind while new writes and the management URL are disabled. The browser lane must pass against stable frontend fingerprints before it can be counted as UI acceptance. A harness boot or a known failing selector does not establish that acceptance; it also does not establish the whole product `index.ts` lifecycle, unified product entry, or managed installation.

The native line audit is checked directly in the owned business database: exact Auth identity, tenant/org, part/line, applied status, one row per distinct edit, and before/after quantities. Native line audit keys use the verified personal purpose/connection/subject/scope namespace; a scoped audit-key hash is intentionally not equal to a raw provider-header key hash. Stable provider retries are checked independently from the observed wire headers.

Use `--browser --customer-entry --browser-cache /absolute/path/to/existing/ms-playwright` for the customer-route lane. It resolves the real `/plm/bom-review` record from `appRoutes`, mounts its actual component through Vue Router, and follows the owned source/Part deep link before the same real personal line/ECO recovery chain. Its signed ordinary Meta user has no `integration:write`. Mount may read the selected BOM but may not mutate it. This is actual route/component plus server authorization evidence; it does not bootstrap the complete `main.ts` shell, establish SSO, provision a managed runtime or authorize deployment. Route authentication/feature policy has separate behavior tests.
