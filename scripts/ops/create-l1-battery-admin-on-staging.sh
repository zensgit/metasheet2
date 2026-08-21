#!/usr/bin/env bash
# ============================================================================
# create-l1-battery-admin-on-staging.sh
#
# Ensures the staging platform-admin account the Multitable L1 battery logs in
# as (POST /api/auth/login, project convention — never a minted token) exists
# and is a REAL RBAC admin. The account must match the GitHub secrets consumed
# by .github/workflows/multitable-l1-battery.yml:
#   STAGING_BATTERY_ADMIN_EMAIL    (value: l1-battery-admin@example.com)
#   STAGING_BATTERY_ADMIN_PASSWORD (the password, provided to THIS script as a
#                                   chmod-600 host file — never on the command line)
#
# Runs ON the deploy host (23.254.236.11) against the metasheet-staging-backend /
# metasheet-staging-postgres containers. It is the durable, reviewable replacement
# for an ad-hoc scratchpad helper that reproduced two owner-CONFIRMED defects.
#
# ---------------------------------------------------------------------------
# WHY THIS SCRIPT EXISTS — the defects it fixes (owner reviews, 2026-08-21)
# ---------------------------------------------------------------------------
#
# P1-ESC — PRIVILEGE ESCALATION via PROMOTE-BEFORE-LOGIN (owner review 4).
#   The predecessor ordered the steps: register (accept 409 ALREADY_EXISTS as OK)
#   → RBAC promotion → login-verify. Because the promotion ran BEFORE the password
#   was ever verified, an attacker who PRE-REGISTERED l1-battery-admin@example.com
#   with THEIR OWN password was handed admin: register returned 409, the script
#   promoted the pre-empted account, and only THEN did login fail (401) and the
#   script exit 1 — but `UPDATE users SET role='admin'` and the user_roles admin
#   membership were ALREADY COMMITTED. Reproduced on real Postgres:
#       register: 409 ALREADY_EXISTS / promotion asserted OK / login: 401 FAILED
#       script_rc=1 / db_state = attacker-user | role=admin | memberships=1
#   A failed script still left the attacker a durable RBAC admin.
#
#   FIX — verify the identity BEFORE granting it: LOGIN-FIRST, promote by id.
#   The order is now register → LOGIN → promote:
#     1. Register is a mere precondition (409 already-exists is fine ONLY as a
#        precondition — it NEVER triggers a grant; it proves nothing about whose
#        password controls the account).
#     2. LOGIN with the INTENDED password. It must return success:true; we capture
#        the SERVER-AUTHORITATIVE data.user.id. If login fails (wrong password ⇒
#        the email is pre-empted by someone whose password we do not control, or
#        our own register failed) the script ABORTS non-zero with ZERO privilege/promotion
#        writes. NOTE: register runs FIRST and commits its own row, so a login that then fails on
#        a 500/network error may leave a plain (role='user', no admin membership) row behind — that
#        is harmless and the script is safe to re-run (register is idempotent, promotion never ran).
#        writes — it never reaches the promotion.
#     3. Promote BY that verified data.user.id (not by an email lookup), in the one
#        atomic transaction below. The net invariant: NO code path grants admin to
#        an account we did not just authenticate.
#
# P1 — CREDENTIAL LEAK INTO THE CONTAINER (and stranded host secret).
#   The old helper did:
#       docker cp "$PWFILE" "$BACKEND:/tmp/l1pw.$$"        # register
#       docker cp "$PWFILE" "$BACKEND:/tmp/l1pw.$$"        # login-verify
#   `docker cp INTO a container` writes to its WRITABLE LAYER, where the secret
#   OUTLIVES the process: a stopped/killed container is absent from `docker ps`
#   yet `docker cp <stopped>:/tmp/l1pw... -` still returns the password bytes
#   (proven with real Docker — see the sibling workflow fix's report). The old
#   in-container `docker exec ... rm` and the outer `&& rm -f /tmp/l1pw` ran
#   ONLY on success, so a failed register/login, an SSH drop, or a Ctrl-C
#   stranded the password on BOTH the deploy host AND inside the container.
#
#   FIX — stdin-only ingestion + unconditional trap.
#   * NOTHING secret is ever written into the container. The password is read
#     from the host file, base64-framed in a shell variable (base64 is an
#     ENCODING, not a protection — it just lets the value survive byte-exact on
#     one line), and PIPED to `docker exec -i` on STDIN. The container-side
#     `node` reads it from process.stdin and holds it only in process memory —
#     never a container file. Mirror of the ratified pattern in
#     .github/workflows/multitable-l1-battery.yml and
#     scripts/ops/dingtalk-lifecycle-staging-canary-remote.sh.
#   * The password NEVER appears in argv/ps on host or container: only the
#     non-secret EMAIL and the postgres user/db are ever command-line args.
#   * A `trap ... EXIT INT TERM HUP` SCRUBS the host password file on EVERY exit
#     path — success, failure, SSH drop, or Ctrl-C — so it can never be stranded
#     the way the old `&& rm` (success-only) allowed. This script therefore
#     CONSUMES-ONCE the password file you pass it: it is gone when the script
#     returns, for any reason. (Design tension noted deliberately: requirement 2
#     says "trap removes any host temp secret file" while the usage note says
#     "then delete the host password file". Removing the OPERATOR-provided file
#     itself is the choice made here, because THAT file — the scp'd one — is
#     exactly what the old success-only `&& rm` left stranded on failure; a
#     script-created temp copy would only add a SECOND recoverable copy on disk.
#     The trailing `rm -f` in the usage line below is kept as a documented,
#     harmless no-op safety net.)
#
# P2 — NON-ATOMIC, MIS-GUARDED PROMOTION left a fake admin.
#   The old helper promoted with THREE autocommit statements (no transaction):
#       UPDATE users SET role='admin' WHERE email=...;
#       INSERT INTO roles (id,name)
#         SELECT 'admin','admin' WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name='admin');
#       INSERT INTO user_roles ... ON CONFLICT DO NOTHING;
#   Migration 054 seeds roles as ('admin','管理员'), so `name='admin'` never
#   matches → NOT EXISTS is TRUE → the INSERT attempts ('admin','admin') → a
#   PRIMARY KEY violation on roles.id. With no transaction, statement 1 has
#   ALREADY COMMITTED `users.role='admin'`, statement 2 aborts, statement 3
#   never runs — so there is NO `user_roles` row. The RBAC admin check the
#   battery's login actually uses is
#       SELECT 1 FROM user_roles WHERE user_id=$1 AND role_id='admin'
#   (packages/core-backend/src/rbac/service.ts:isAdmin; mirrored by
#   login-alias-service.ts), so the account looked promoted (role column) yet was
#   NOT admin — a stranded, misleading half-state. Reproduced on real Postgres.
#
#   FIX — one atomic, asserted, idempotent transaction.
#   * `psql -1 -v ON_ERROR_STOP=1` wraps ALL statements in a single
#     BEGIN/COMMIT. `-1` is load-bearing: without it the `roles` INSERT
#     autocommits and survives even when the assertion fails (verified).
#   * `INSERT ... ON CONFLICT (id) DO NOTHING` / `ON CONFLICT (user_id, role_id)
#     DO NOTHING` — idempotent and collision-free regardless of the seeded
#     roles.name.
#   * It ENDS with an assertion that EXACTLY one user has the email AND EXACTLY
#     one `user_roles` admin membership exists for that user (the precise read
#     path above). Any shortfall RAISEs → the whole transaction rolls back and
#     psql exits non-zero → this script exits non-zero. Re-running yields the
#     same asserted 1/1 end-state.
#
# ---------------------------------------------------------------------------
# USAGE (run ON the deploy host)
#   # From your machine — write the password with printf (NO trailing newline)
#   # so the bytes match the STAGING_BATTERY_ADMIN_PASSWORD secret exactly:
#   printf '%s' "$THE_PASSWORD" > /tmp/l1pw && chmod 600 /tmp/l1pw
#   scp /tmp/l1pw               <host>:/tmp/l1pw
#   scp create-l1-battery-admin-on-staging.sh <host>:/tmp/mk-l1-admin.sh
#   ssh <host> 'bash /tmp/mk-l1-admin.sh /tmp/l1pw; rm -f /tmp/l1pw /tmp/mk-l1-admin.sh'
#   # (the script already scrubs /tmp/l1pw via its EXIT trap; the trailing
#   #  `rm -f` above is a harmless belt-and-suspenders no-op.)
#
# Optional environment overrides (all NON-secret):
#   BATTERY_ADMIN_EMAIL   default l1-battery-admin@example.com
#   BACKEND_CONTAINER     default metasheet-staging-backend
#   POSTGRES_CONTAINER    default metasheet-staging-postgres
# ============================================================================
set -euo pipefail

PWFILE="${1:-}"
if [[ -z "$PWFILE" ]]; then
  echo "usage: $0 /path/to/password-file   (chmod-600 file containing exactly the admin password, no trailing newline)" >&2
  exit 2
fi

# Scrub the host password file on EVERY exit path (success, failure, SSH drop,
# Ctrl-C). Set BEFORE any operation that can fail, so nothing can strand it.
cleanup() {
  local rc=$?
  if [[ -n "${PWFILE:-}" && -e "$PWFILE" ]]; then
    rm -f -- "$PWFILE" 2>/dev/null || true
  fi
  return "$rc"
}
trap cleanup EXIT INT TERM HUP

# The backend's register handler stores sanitizeEmail(email) =
# email.trim().toLowerCase().slice(0,255) (packages/core-backend/src/routes/auth.ts).
# If we registered under a raw email but promoted/looked-up by a different casing,
# the promotion's `WHERE email = :'em'` would find ZERO rows → the assertion would
# roll the transaction back and this script would exit non-zero AFTER having created
# an account it then refuses to promote. So NORMALIZE ONCE, up front, to that exact
# canonical form and use the SAME $EMAIL for register argv, the promotion `-v em=`,
# and the login identifier — the three must agree by construction.
EMAIL_RAW="${BATTERY_ADMIN_EMAIL:-l1-battery-admin@example.com}"
EMAIL="$(printf '%s' "$EMAIL_RAW" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]' | cut -c1-255)"
BACKEND="${BACKEND_CONTAINER:-metasheet-staging-backend}"
PGC="${POSTGRES_CONTAINER:-metasheet-staging-postgres}"

# ---- input validation (fail-closed) ---------------------------------------
if [[ ! -f "$PWFILE" ]]; then
  echo "ERROR: password file '$PWFILE' is not a regular file" >&2
  exit 1
fi
if [[ ! -s "$PWFILE" ]]; then
  echo "ERROR: password file '$PWFILE' is empty — refusing to create an admin with an empty password" >&2
  exit 1
fi
chmod 600 "$PWFILE" 2>/dev/null || true
# Non-secret; validated (post-normalization) so it can never carry a shell/SQL
# surprise downstream. The backend's email regex also rejects internal whitespace,
# so trim (leading/trailing only) + lowercase is a fixed point of sanitizeEmail for
# any value that passes here — register stores exactly what we promote/look up by.
if [[ ! "$EMAIL" =~ ^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$ ]]; then
  echo "ERROR: BATTERY_ADMIN_EMAIL '$EMAIL_RAW' did not normalize to a valid email address (got '$EMAIL')" >&2
  exit 1
fi

# ---- container liveness (fail-closed, with a reason) ----------------------
require_running() {
  local name="$1" state
  state="$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || true)"
  if [[ "$state" != "true" ]]; then
    echo "ERROR: container '$name' is not running (state='${state:-absent}') — refusing to proceed" >&2
    exit 1
  fi
}
require_running "$BACKEND"
require_running "$PGC"

echo "[create-l1-admin] target email=${EMAIL} backend=${BACKEND} postgres=${PGC}"

# ---- credential framing: base64 in a shell VARIABLE, never a file/argv -----
# The value never touches argv (printf is a builtin) and never a container file:
# it is piped to `docker exec -i` on STDIN below.
PW_B64="$(base64 < "$PWFILE" | tr -d '\n')"
if [[ -z "$PW_B64" ]]; then
  echo "ERROR: base64 framing of the password produced nothing" >&2
  exit 1
fi

# The container-side program. It reads the base64 password on STDIN, decodes it
# in-process, and drives the real auth endpoint. Only the NON-secret mode and
# email arrive as argv; the password is never a command-line argument, never a
# container file. Idempotent register: 2xx = created, 409 "already exists" = OK.
NODE_PROG="$(cat <<'NODEJS'
const http = require("http");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { buf += c; });
process.stdin.on("end", () => {
  const pw = Buffer.from(buf.trim(), "base64").toString("utf8");
  const mode = process.argv[1];
  const email = process.argv[2];
  const port = Number(process.env.PORT || 8900);
  if (!pw) { console.error(mode + ": empty password after decode — refusing"); process.exit(91); }
  const isReg = mode === "register";
  const path = isReg ? "/api/auth/register" : "/api/auth/login";
  const payload = isReg
    ? { email: email, password: pw, name: "l1 battery admin" }
    : { identifier: email, email: email, password: pw };
  const body = JSON.stringify(payload);
  const req = http.request(
    { host: "127.0.0.1", port: port, path: path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
    (r) => {
      let d = "";
      r.on("data", (c) => { d += c; });
      r.on("end", () => {
        if (isReg) {
          const created = r.statusCode >= 200 && r.statusCode < 300;
          const dup = r.statusCode === 409 && /already exists/i.test(d);
          const ok = created || dup;
          console.log("register: status=" + r.statusCode +
            (created ? " CREATED" : dup ? " ALREADY_EXISTS(idempotent)" : " FAILED"));
          process.exit(ok ? 0 : 1);
        } else {
          // Login-FIRST identity verification. We must (a) authenticate with the
          // INTENDED password and (b) capture the server-authoritative user id so
          // the promotion can target EXACTLY the account we just proved we control.
          // A 409 on register does NOT prove control — the email may be pre-empted
          // by an attacker whose password we do not have. Only a success:true login
          // does. Diagnostics go to STDERR; the ONLY thing written to STDOUT is the
          // verified id (USERID=<id>), so the caller can capture it cleanly.
          let parsed = null;
          try { parsed = JSON.parse(d); } catch (e) { parsed = null; }
          const authed = r.statusCode >= 200 && r.statusCode < 300 && parsed && parsed.success === true;
          if (!authed) {
            console.error("login verify: status=" + r.statusCode + " FAILED — the intended password does not authenticate this email; refusing to promote");
            process.exit(1);
          }
          const uid = parsed.data && parsed.data.user ? parsed.data.user.id : undefined;
          if (!uid || typeof uid !== "string") {
            console.error("login verify: status=" + r.statusCode + " OK but server returned no data.user.id — refusing to promote");
            process.exit(1);
          }
          console.error("login verify: status=" + r.statusCode + " OK (server user id captured)");
          process.stdout.write("USERID=" + uid + "\n");
          process.exit(0);
        }
      });
    }
  );
  req.on("error", (e) => { console.error(mode + " request error: " + String(e)); process.exit(1); });
  req.write(body);
  req.end();
});
NODEJS
)"

# ---- 1) register (idempotent), password on STDIN --------------------------
# Register is ONLY a precondition: a 2xx means we created the account, a 409
# ALREADY_EXISTS means the email is already taken — by us on a prior run, OR by
# someone else. Register alone therefore proves NOTHING about whose password
# controls the account, so it MUST NOT gate the promotion. Identity is verified
# by the login step below, never here.
echo "[create-l1-admin] step 1/3: register via /api/auth/register (stdin credential)"
if ! printf '%s' "$PW_B64" | docker exec -i "$BACKEND" node -e "$NODE_PROG" register "$EMAIL"; then
  echo "ERROR: register step failed — see status above" >&2
  exit 1
fi

# ---- 2) login FIRST — verify the identity BEFORE granting it --------------
# P1 (owner review 2026-08-21): the promotion MUST run only AFTER we have proven,
# with the INTENDED password, that we control this account. If we promoted on the
# strength of register's 409 (as the predecessor did), an attacker who PRE-EMPTED
# the email with THEIR OWN password would be granted admin, and only THEN would
# login fail — the admin grant already committed (reproduced on real Postgres:
# attacker row left role='admin' with a user_roles admin membership despite the
# script exiting non-zero). So we log in HERE, capture the SERVER-AUTHORITATIVE
# data.user.id, and in step 3 promote ONLY that verified id. A login failure
# (wrong password ⇒ the email is controlled by someone else, or our own register
# failed) ABORTS with ZERO PRIVILEGE writes (no role change, no user_roles admin grant) — we NEVER
# promote an account whose
# password we do not control. `if ! LOGIN_OUT="$(...pipeline...)"` propagates the
# pipeline's non-zero status under `set -o pipefail`, so a 401 aborts before any psql.
echo "[create-l1-admin] step 2/3: login-first identity verification via /api/auth/login (stdin credential)"
if ! LOGIN_OUT="$(printf '%s' "$PW_B64" | docker exec -i "$BACKEND" node -e "$NODE_PROG" login "$EMAIL")"; then
  echo "ERROR: login verification failed — the intended password does not authenticate '${EMAIL}'; refusing to promote (no privilege writes; a plain user row from register may remain, safe to re-run)" >&2
  exit 1
fi
# Extract the server-verified user id (the ONLY thing the login step writes to
# stdout). Empty ⇒ login "succeeded" without an id we can key the grant on ⇒ abort.
USER_ID="$(printf '%s\n' "$LOGIN_OUT" | sed -n 's/^USERID=//p' | head -n1)"
if [[ -z "$USER_ID" ]]; then
  echo "ERROR: login verification returned no server user id — refusing to promote (no privilege writes; a plain user row from register may remain, safe to re-run)" >&2
  exit 1
fi

# ---- 3) atomic, asserted, idempotent promotion BY VERIFIED ID -------------
# Single transaction (psql -1) with ON_ERROR_STOP. The grant is keyed on the
# server-verified :'uid' captured above — NOT an email lookup — so we can only ever
# promote the exact account whose password we just authenticated. The NON-secret
# email :'em' is still passed so the assertion can additionally confirm the
# verified id belongs to the intended email (catches a login returning another
# account's id). The quoted heredoc (<<'SQL') keeps the `$$` DO-block delimiters
# and `:'uid'`/`:'em'` literal for psql. The closing assertion rolls the whole
# thing back on any shortfall.
echo "[create-l1-admin] step 3/3: atomic RBAC promotion by verified id (single transaction, asserted)"
PGU="$(docker exec "$PGC" printenv POSTGRES_USER 2>/dev/null || true)"
if [[ -z "$PGU" ]]; then
  echo "ERROR: could not resolve POSTGRES_USER from container '$PGC'" >&2
  exit 1
fi
PGD="$(docker exec "$PGC" printenv POSTGRES_DB 2>/dev/null || true)"
if [[ -z "$PGD" ]]; then
  echo "ERROR: could not resolve POSTGRES_DB from container '$PGC'" >&2
  exit 1
fi
if ! docker exec -i "$PGC" psql -U "$PGU" -d "$PGD" -1 -v ON_ERROR_STOP=1 -v uid="$USER_ID" -v em="$EMAIL" <<'SQL'
UPDATE users SET role = 'admin' WHERE id = :'uid';
INSERT INTO roles (id, name) VALUES ('admin', 'admin') ON CONFLICT (id) DO NOTHING;
INSERT INTO user_roles (user_id, role_id)
  SELECT u.id, 'admin' FROM users u WHERE u.id = :'uid'
  ON CONFLICT (user_id, role_id) DO NOTHING;
-- Stash the (non-secret) verified id + email in transaction-local GUCs so the
-- assertion block can read them without psql variable interpolation inside the
-- dollar-quoted body.
SELECT set_config('l1battery.uid', :'uid', true);
SELECT set_config('l1battery.email', :'em', true);
DO $$
DECLARE
  u_count int;
  m_count int;
  e_count int;
  uid text := current_setting('l1battery.uid', true);
  em text := current_setting('l1battery.email', true);
BEGIN
  SELECT count(*) INTO u_count FROM users WHERE id = uid;
  SELECT count(*) INTO m_count FROM user_roles WHERE user_id = uid AND role_id = 'admin';
  SELECT count(*) INTO e_count FROM users WHERE id = uid AND email = em;
  IF u_count <> 1 OR m_count <> 1 OR e_count <> 1 THEN
    RAISE EXCEPTION 'promotion assertion failed: users=% admin_memberships=% email_match=% (expected 1/1/1) for id %',
      u_count, m_count, e_count, uid;
  END IF;
  RAISE NOTICE 'promotion asserted OK: users=% admin_memberships=% for id % (email %)', u_count, m_count, uid, em;
END $$;
SQL
then
  echo "ERROR: promotion transaction failed and was rolled back — no partial admin state was left" >&2
  exit 1
fi

echo "[create-l1-admin] DONE — ${EMAIL} exists (server-verified id ${USER_ID}), authenticated with the intended password, and is an RBAC admin. Host password file scrubbed on exit."
