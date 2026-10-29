# Bootstrap admin login JSON validation — 2026-10-30

Source: `fecce88a0e68f8fdd183d73d380e056c7ffb32ab`.
Parent: Draft #6652, `e33325f8a8d4281d2663205761af4fd36ce64aaf`.

## Problem and change

The Bash bootstrap accepted nonempty email and passwords of at least 12 characters,
but interpolated their raw values into login JSON. Quotes, backslashes, control
characters or JSON-looking content could corrupt or change the request, despite
successful hash/SQL steps.

Use the already-required Node runtime to JSON-serialize the final effective email
and password. Pass those values to Node through its environment and send the JSON
to curl on stdin. Serialization failure stops before curl under the existing shell
error handling. No credential or authorization policy, file-over-environment
priority, SQL, local-account flow or PowerShell implementation changes.

## Actual checks

Reuse the existing fake bcrypt/psql fixture and owned loopback HTTP server. An
optional strict login handler parses the actual curl body, requires exactly email
and password keys and checks their exact effective values. Its omitted-option
behavior and all prior assertions remain unchanged.

Seven Bash cases cover ordinary values, password double quotes, backslashes,
newline/tab, JSON-looking injection, a quoted email local part and file credential
priority. The quoted-email case checks serialization fidelity, not real backend
email acceptance.

- Original source: five causal HTTP 400 failures, two controls pass.
- Corrected source: seven pass; zero failures, skips, cancellations or todos.
- Actual local runtime: Node 24.14.1. Both product files match the tested frozen
  files byte-for-byte; passed cases were not rerun for materialization/docs.
- Independent source and actual-result review accepts the minimal change.
- Fixture temporary directories are empty and the owned source capsule is removed.

The first result collector assumed TAP while Node emitted spec output. Its parser
failure is retained; corrected counts come from the same unchanged raw output,
without rerunning tests.

## Delivery boundaries

Compact evidence: `artifacts/plm-admin-login-json-20261030/verification.json`.
This source commit is followed by one documentation/evidence commit. Existing CI
already selects both paths; current-head Node 20/full-contract results remain
pending rather than being inherited from #6652.

This is an actual synthetic HTTP fixture with stubbed hashing/SQL, not an actual
MetaSheet login, PostgreSQL, build/image, installation, browser or business
acceptance. Test/review agents were requested as Sol 6.1 medium; actual profiles
were not separately returned. Source23, W2, Claude-owned scope and Work browser
HOLDs remain. Keep Draft; no merge, deployment, production enablement or real
business notification is authorized. The whole engineering goal remains open.
