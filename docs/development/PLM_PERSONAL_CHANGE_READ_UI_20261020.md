# Personal BOM change-read workspace UI — 2026-10-20

The existing managed BOM workspace now includes personal change-read management
for already imported collaboration sheets. The workflow lists actual eligible
Meta targets, requires an explicit selection, prepares the existing Native
purpose-specific consent link, accepts only the separately issued `yue_` grant,
and requires a separate explicit start. Binding does not start reading.
It reuses the existing personal/listener/approval/installation engines.

## Authority and browser behavior

The new cookie-authenticated discovery route is outside the normal bearer-only
route gate, like the existing managed consent routes. Its server transaction locks
the current managed identity/source and validates both Meta memberships and current
sheet-management ACL. It returns only target ID/name/version/base/sheet metadata.
Listing a retained Meta snapshot is not Native read authority and calls no Native
provider. Discovery remains possible when personal reads are off, so existing
personal authority can still be reduced. Wrong Meta tenant, API keys, lost target
permission and lost Meta membership are refused or omitted appropriately.

The client uses current-origin cookies, no-store and no-referrer, coordinated by
the existing browser identity lock. A stored normal bearer refuses the managed
operation instead of becoming a fallback. It validates the Native purpose page,
unique frozen fragment, source/root, review ID/version and exact Meta base/sheet.
The actual Native page remains responsible for the separate explicit confirmation
and Native object ACL. No editable source authority or Meta-as-Native subject is
introduced in the form.

Credentials live only in the password field and the one frozen request. Submit
clears the field immediately. They are never copied to local/session storage,
returned as metadata, logged or included in management links. Another-purpose
credential is refused before network I/O. Unknown request outcomes are not retried
automatically. A fresh state read can recover the server-side bound result.

Source/root changes, identity changes and late target-selection responses clear
or invalidate UI state. An old response cannot install a link or status into a new
context. The Native consent link opens only on user action with noopener/noreferrer.
The UI distinguishes bound from active, uses the existing start action/version,
and reports pending or rejected remote cleanup without claiming remote revocation.
Unbind text preserves the authorized-snapshot policy: existing imported data remain
under Meta target ACL; new reads stop.

## Existing configuration prerequisites

The data-source owner's existing persisted configuration must explicitly set
`config.options.personalChangeReadConnectionId` to the registered Native connection
ID. It is not the OAuth client ID or the Meta source ID. Native origin/tenant/org,
managed registration/mapping, Native grant feature/entitlement and the audited
Meta change-event destination policy must also be configured through their
existing engines. No approval grant or shared credential substitutes for the new
purpose. Installation-package handoff and combined installed acceptance of these
new settings remain open; this UI does not silently manufacture configuration.

## Verification

- Client transport/response/scope tests:21 passed. They cover frozen consent scope,
  purpose and ambiguous fragment refusals, cookie-only transport, no shared bearer,
  independent grant prefixes, no secret persistence, explicit versioned start,
  cleanup outcomes, malformed metadata and Native Unicode code-point limits.
- Actual Vue DOM tests:4 distinct cases qualified cumulatively. They verify explicit
  target/bind/start sequencing, immediate field clearing, snapshot retention text,
  identity/source/target switches and stale responses. The first run passed3 and
  failed one test's text expectation (`已有` versus actual `已导入的`); only that
  literal fixture was corrected, and only the failed case reran.
- Actual Meta PostgreSQL:2 new target-discovery cases passed,45 previously accepted
  cases deselected. Current sheet ACL, separate Meta tenant/org membership and API
  key refusals were exercised. A deliberately unusable stored shared credential
  is neither decrypted nor used; no Native request occurs on discovery.
- A focused HTTP route case passed, with authentication/service stubbed. It proves
  discovery precedes the normal bearer gate, rejects duplicate root parameters,
  and preserves no-store on authentication denial. It is not real managed-login
  authentication proof.
- Full backend TypeScript and frontend Vue TypeScript project checks pass with
  unchanged options. Frontend test dependencies are read-only package links in a
  newly owned local node_modules directory; caches/build-info stay in that owned
  directory. No dependency files or lockfile were changed.
- One client test command initially created its file in an extra nested directory
  because of the working directory; the exact owned file was moved to the intended
  location and the empty owned directories removed. Its import-resolution failure
  is retained, not counted as a product or passing test.

Production frontend/image compilation and visual browser QA are the next
verification steps for this source commit. Source tests are not installed package
or production acceptance. Real Native-issued grant plus real Meta authentication,
owned HTTP delivery and cross-process backup/restore still need their combined
proof. Current installed images predate these changes. The whole W01–W23 goal
remains active/incomplete. All publication remains held behind #363's valuable
queued job; no merge, deployment, production activation or business notice.
