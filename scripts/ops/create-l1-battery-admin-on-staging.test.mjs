#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Guards for scripts/ops/create-l1-battery-admin-on-staging.sh (owner-review
// P1+P2 fix, 2026-08-21).
//
// P1: the ad-hoc predecessor `docker cp`'d the admin password INTO the backend
//     container (/tmp/l1pw.$$), where it survives a stop/kill in the writable
//     layer, and its cleanup ran ONLY on success (`&& rm -f`). The shipped
//     script must ingest the password on STDIN only (no container write) and
//     scrub the host password file with an unconditional trap.
// P2: the predecessor promoted with THREE autocommit statements. Migration 054
//     seeds roles as ('admin','管理员'), so its `WHERE NOT EXISTS ... name='admin'`
//     guard fired a PK violation on roles.id AFTER `UPDATE users SET role='admin'`
//     had already committed and BEFORE the user_roles insert — leaving a fake
//     admin (role column set, no RBAC membership). The shipped script must
//     promote in ONE transaction that ends with an assertion (exactly one user +
//     exactly one user_roles admin membership) and rolls back on any shortfall.
//
// LAYERS:
//   1. STRUCTURAL (hermetic): parse the script text. The load-bearing predicates
//      are shared with the mutation tests so the two can never diverge into
//      different definitions of the same guard.
//   2. MUTATION-PROVE (hermetic): apply each defect to a COPY of the script text
//      in memory and assert the matching structural gate flips red — the file on
//      disk is never touched (satisfies "never restore with git checkout --": we
//      mutate strings, not the file).
//   3. GOLDEN (real Docker, OPT-IN via L1_ADMIN_DOCKER_GOLDENS=1): run the SHIPPED
//      script end-to-end against a mock backend container + a real Postgres, and
//      prove with `docker diff` that the ingestion writes NOTHING into the
//      container, reproduce the OLD `docker cp`-in leak to show the golden has
//      teeth, and confirm a stopped container yields no credential. Kept opt-in
//      (LOUD skip when unset) so it never runs in a required hermetic lane and a
//      docker hiccup can never red a required check.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(__dirname, 'create-l1-battery-admin-on-staging.sh')
const scriptText = readFileSync(scriptPath, 'utf8')
// This harness's own path — the P3 readiness gate is a property of THIS file, so a
// couple of gates read it back to prove the target-db-query readiness contract.
const selfPath = fileURLToPath(import.meta.url)

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Several gates must look at what the script DOES, not what its header comment
// SAYS — the header deliberately quotes the removed `docker cp … l1pw` lines and
// names `psql -1` / BEGIN in prose so a reader sees what the bug was. A naive
// whole-text grep would red on the explanation of the fix.
function stripShellComments(text) {
  return text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')
}
const executable = stripShellComments(scriptText)

// A command is in COMMAND position (a real invocation, not a word inside an echo
// string) when what precedes it on the line ends at a command boundary.
const CMD_POSITION_RE = /(?:^|[;&|(){}!]|\$\(|\b(?:if|then|else|elif|do|while|until)\b)\s*$/

function invocationsOf(text, cmd) {
  const out = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('#')) continue
    for (let idx = line.indexOf(cmd); idx >= 0; idx = line.indexOf(cmd, idx + 1)) {
      // reject `docker exec` matching inside `docker execute`-like words / mid-token
      const before = line.slice(0, idx)
      const after = line.slice(idx + cmd.length, idx + cmd.length + 1)
      if (CMD_POSITION_RE.test(before) && (after === '' || /\s/.test(after))) {
        out.push(line.slice(idx))
        break
      }
    }
  }
  return out
}

// ---- docker cp census (class, not one path literal) -----------------------
// The predecessor's defect was a `docker cp` with a CONTAINER-PREFIXED
// DESTINATION. Enumerate every `docker cp` invocation and require that no
// operand at a destination position is container-prefixed. Positional-invariant
// so a flag-shifted `docker cp -a SRC CONTAINER:DST` cannot slip past.
function dockerCpOperands(line) {
  const after = line.slice(line.indexOf('docker cp') + 'docker cp'.length)
  const own = after.split('|')[0].split(';')[0]
  return own
    .trim()
    .split(/\s+/)
    .filter((t) => t !== '' && t !== '\\')
    .filter((t) => !t.startsWith('>') && !t.startsWith('2>') && !t.startsWith('&>'))
    .filter((t) => t === '-' || !t.startsWith('-'))
}
function containerPrefixedOperandIndexes(line) {
  return dockerCpOperands(line)
    .map((tok, i) => (/(\$\{?(?:BACKEND|PGC|CONTAINER|POSTGRES_CONTAINER|BACKEND_CONTAINER)\}?):/.test(tok) ? i : -1))
    .filter((i) => i >= 0)
}
function noContainerPrefixedCpDestination(text) {
  return invocationsOf(text, 'docker cp').every((line) => containerPrefixedOperandIndexes(line).every((i) => i === 0))
}

// ---- docker exec argv secret census ---------------------------------------
// No `docker exec` invocation may carry the password (the PW_B64 variable) or a
// `-e …PASSWORD…` env token as an argv — the secret must reach the container on
// STDIN only. The password variable name is the one thing that must never appear
// after `docker exec`.
function dockerExecArgvCarriesSecret(line) {
  // strip a trailing `<<'SQL'`/redirection tail — heredoc BODY is not argv
  const argv = line.replace(/<<'?\w+'?.*$/, '')
  if (/\bPW_B64\b/.test(argv)) return true
  if (/-e\s+\S*PASSWORD/i.test(argv)) return true
  if (/-e\s+\S*PW_B64/.test(argv)) return true
  return false
}
function noDockerExecCarriesSecret(text) {
  return invocationsOf(text, 'docker exec').every((line) => !dockerExecArgvCarriesSecret(line))
}

// ---- stdin ingestion present ----------------------------------------------
function stdinIngestionPresent(text) {
  // the password is base64-framed in a shell var and piped to `docker exec -i`
  const framesToVar = /PW_B64="\$\(base64 < "\$PWFILE" \| tr -d '\\n'\)"/.test(text)
  const pipedOnStdin = /printf '%s' "\$PW_B64" \| docker exec -i "\$BACKEND" node -e "\$NODE_PROG"/.test(text)
  const readsStdin = /process\.stdin\.on\("end"/.test(text) && /Buffer\.from\(buf\.trim\(\), "base64"\)/.test(text)
  return framesToVar && pipedOnStdin && readsStdin
}

// ---- trap scrubs the host secret ------------------------------------------
function trapScrubsHostSecret(text) {
  const trapLine = text.split('\n').find((l) => /^\s*trap\s+cleanup\b/.test(l))
  if (!trapLine) return false
  const hasExit = /\bEXIT\b/.test(trapLine)
  const hasInt = /\bINT\b/.test(trapLine)
  const hasTerm = /\bTERM\b/.test(trapLine)
  // cleanup must actually rm the password file, not merely be declared.
  const cleanupRemoves = /cleanup\(\)\s*\{[\s\S]*?rm -f -- "\$PWFILE"[\s\S]*?\}/.test(text)
  return hasExit && hasInt && hasTerm && cleanupRemoves
}

// ---- single-transaction promotion with post-assert ------------------------
// The atomicity arm is a disjunction (psql -1 OR an explicit BEGIN;…COMMIT;).
// It must NOT be satisfied by the plpgsql DO block's own `BEGIN`/`END` (no
// semicolon), which is why the explicit-tx arm requires `BEGIN;` with a
// semicolon. Comments are stripped first so the header's prose mention of
// `psql -1` / BEGIN cannot keep this green after the `-1` is mutated away.
// The promotion psql is located by its unique `-v uid=` marker (the verified-id
// grant) — NOT any psql — so schema/seed psql calls or a future added psql can
// never shift what these gates read.
function promotionIsSingleTransaction(execText) {
  const psqlLine = execText.split('\n').find((l) => /\bpsql\b/.test(l) && /-v uid=/.test(l))
  const hasPsql1 = Boolean(psqlLine && /(?:^|\s)-1(?:\s|$)/.test(psqlLine))
  const hasExplicitTx = /\bBEGIN\s*;/.test(execText) && /\bCOMMIT\s*;/.test(execText)
  return hasPsql1 || hasExplicitTx
}
function promotionHasErrorStop(execText) {
  const psqlLine = execText.split('\n').find((l) => /\bpsql\b/.test(l) && /-v uid=/.test(l))
  return Boolean(psqlLine && /ON_ERROR_STOP=1/.test(psqlLine))
}
function promotionAssertsExactlyOne(execText) {
  const raises = /RAISE EXCEPTION 'promotion assertion failed/.test(execText)
  const guardsCounts = /IF u_count <> 1 OR m_count <> 1 OR e_count <> 1 THEN/.test(execText)
  // The grant is keyed on the server-verified id, so the assertion counts BY id.
  const countsUsersById = /SELECT count\(\*\) INTO u_count FROM users WHERE id = uid/.test(execText)
  // the membership count must be the EXACT RBAC read path: user_roles.role_id='admin'
  const countsAdminMembership = /SELECT count\(\*\) INTO m_count FROM user_roles WHERE user_id = uid AND role_id = 'admin'/.test(
    execText,
  )
  // and the verified id must belong to the INTENDED email (catches a login that
  // returned some OTHER account's id).
  const countsEmailMatch = /SELECT count\(\*\) INTO e_count FROM users WHERE id = uid AND email = em/.test(execText)
  return raises && guardsCounts && countsUsersById && countsAdminMembership && countsEmailMatch
}

// ---- P2-A (gate review 4): each conjunct of the 1/1/1 assertion is load-bearing ----
// The gate neutered `e_count := 1;` (a constant assignment BEFORE the IF) and the whole suite
// stayed green — the structural guard only matched the IF *text*, not the value feeding it. Close
// that: (1) no count var may be assigned a constant (the exact mutation), and (2) each is assigned
// by its correctly-SCOPED SELECT count, so neutering a conjunct's *computation* also reds here.
// This runs in the hermetic obs-kit contract (required) lane — a regression to any arm is CI-caught.
test('P2-A: no promotion count var is constant-assigned, and each is scoped correctly', () => {
  const execText = scriptText
  // (1) the gate's mutation shape — a constant assignment to any count var — is forbidden.
  for (const v of ['u_count', 'm_count', 'e_count']) {
    assert.doesNotMatch(
      execText,
      new RegExp(`\\b${v}\\s*:=\\s*\\d`),
      `${v} must be computed by a SELECT count, never constant-assigned (this is exactly the gate-4 mutation that bypassed the assertion)`,
    )
  }
  // (2) each conjunct's count is scoped to the verified id, and additionally: m_count to the admin
  //     membership (the arm that catches the original fake-admin), e_count to the intended email.
  assert.match(execText, /SELECT count\(\*\) INTO u_count FROM users WHERE id = uid;/, 'u_count: users by verified id')
  assert.match(execText, /SELECT count\(\*\) INTO m_count FROM user_roles WHERE user_id = uid AND role_id = 'admin';/, "m_count: admin membership by id (the fake-admin arm)")
  assert.match(execText, /SELECT count\(\*\) INTO e_count FROM users WHERE id = uid AND email = em;/, 'e_count: id-belongs-to-email')
  // and the IF still guards all three as a conjunction that RAISEs.
  assert.match(execText, /IF u_count <> 1 OR m_count <> 1 OR e_count <> 1 THEN/)
  assert.match(execText, /RAISE EXCEPTION 'promotion assertion failed/)
})

// ---- P1 (privilege escalation): login-FIRST + promote-by-verified-id -------
// The promotion must run only AFTER a successful login, and must be keyed on the
// id that login returned — not an email lookup. This is a DATA-FLOW invariant, so
// two independent predicates enforce it: (a) the login step textually precedes the
// promotion psql, and (b) the promotion's -v uid= value is the variable populated
// from the login capture, guarded by a non-empty check before the psql runs.
function loginBeforePromotion(execText) {
  const lines = execText.split('\n')
  const loginIdx = lines.findIndex((l) => /docker exec -i "\$BACKEND" node -e "\$NODE_PROG" login "\$EMAIL"/.test(l))
  const promoteIdx = lines.findIndex((l) => /\bpsql\b/.test(l) && /-v uid=/.test(l))
  return loginIdx >= 0 && promoteIdx >= 0 && loginIdx < promoteIdx
}
function promotesByVerifiedLoginId(execText) {
  const lines = execText.split('\n')
  // (1) the login invocation is CAPTURED into LOGIN_OUT (not run bare / for effect)
  const capturesLogin =
    /LOGIN_OUT="\$\(printf '%s' "\$PW_B64" \| docker exec -i "\$BACKEND" node -e "\$NODE_PROG" login "\$EMAIL"\)"/.test(execText)
  // (2) USER_ID is derived from THAT captured login output (the USERID= line)
  const derivesUserId = /USER_ID="\$\(printf[^\n]*"\$LOGIN_OUT"[^\n]*USERID=/.test(execText)
  // (3) the promotion is keyed on that captured id (both the psql -v and the SQL)
  const psqlUidIdx = lines.findIndex((l) => /\bpsql\b/.test(l) && /-v uid="\$USER_ID"/.test(l))
  const promotesByUid = psqlUidIdx >= 0 && /UPDATE users SET role = 'admin' WHERE id = :'uid';/.test(execText)
  // (4) a non-empty guard aborts if no id was captured — and it must run BEFORE the
  // promotion, not merely exist. An index comparison closes the escape hatch of a
  // guard relocated AFTER the psql (which would leave the grant ungated).
  const guardIdx = lines.findIndex((l) => /if \[\[ -z "\$USER_ID" \]\]; then/.test(l))
  const guardsEmptyBeforePromotion = guardIdx >= 0 && psqlUidIdx >= 0 && guardIdx < psqlUidIdx
  return capturesLogin && derivesUserId && promotesByUid && guardsEmptyBeforePromotion
}

// ---- P3: this harness's own real-Docker readiness gate --------------------
// The readiness helper (waitForTargetDbQueryable) must gate on a `SELECT 1` query
// against the TARGET db, NOT on `pg_isready` (which returns success before the DB
// is queryable → the golden flakes). Operates on passed-in text so the mutation
// test can prove reverting to pg_isready reds this check.
function readinessQueriesTargetDb(harnessText) {
  // Anchor on the helper's DEFINITION signature (name + "(pg," — the comma marks the
  // definition, not the zero-arg "(pg)" call site). The regex-literal form below uses
  // an escaped paren, so it does NOT textually match itself; this comment deliberately
  // avoids writing the bare signature so the census reads the real helper body, not this line.
  const m = harnessText.match(/waitForTargetDbQueryable\(pg,[\s\S]*?\n}/)
  if (!m) return false
  const body = m[0]
  return /'psql'/.test(body) && /'SELECT 1'/.test(body) && !/pg_isready/.test(body)
}

// ---- email normalized ONCE and used consistently everywhere ---------------
// The backend's register handler stores sanitizeEmail(email) =
// trim().toLowerCase().slice(0,255). If register wrote a normalized email but the
// promotion read a raw one, `WHERE email = :'em'` would find zero rows → rollback →
// an account created but never promoted. So $EMAIL must be normalized (trim +
// lowercase) up front and the SAME $EMAIL must feed register, `-v em=`, and login.
function emailNormalizedAndConsistent(text) {
  const normalizes = /EMAIL="\$\(printf '%s' "\$EMAIL_RAW"[\s\S]*?tr '\[:upper:\]' '\[:lower:\]'[\s\S]*?\)"/.test(text)
  const registerUsesEmail = /register "\$EMAIL"/.test(text)
  const promoteUsesEmail = /-v em="\$EMAIL"/.test(text)
  const loginUsesEmail = /login "\$EMAIL"/.test(text)
  // the RAW value must never reach a downstream register/login/psql site
  const rawNotDownstream =
    !/(?:register|login) "\$EMAIL_RAW"/.test(text) && !/-v em="\$EMAIL_RAW"/.test(text)
  return normalizes && registerUsesEmail && promoteUsesEmail && loginUsesEmail && rawNotDownstream
}

// ---------------------------------------------------------------------------
// 1. STRUCTURAL GUARDS (against the real file)
// ---------------------------------------------------------------------------

test('structural: script is set -euo pipefail (fail-closed)', () => {
  assert.match(scriptText, /^set -euo pipefail$/m)
})

test('structural: NO docker cp anywhere writes into a container (the class, not one path literal)', () => {
  const cps = invocationsOf(scriptText, 'docker cp')
  // The strongest possible form: the shipped script contains ZERO `docker cp`.
  assert.equal(cps.length, 0, `the shipped script must contain no docker cp at all: ${JSON.stringify(cps)}`)
  assert.equal(noContainerPrefixedCpDestination(scriptText), true)
  // Positive control on the census itself (attack your own criterion): a
  // synthetic container-destination copy MUST be rejected, incl. a flag-shifted one.
  assert.equal(
    noContainerPrefixedCpDestination('docker cp "$PWFILE" "$BACKEND:/tmp/l1pw"'),
    false,
    'the census must reject a docker cp INTO the container',
  )
  assert.equal(
    noContainerPrefixedCpDestination('docker cp -a "$PWFILE" "$BACKEND:/tmp/l1pw"'),
    false,
    'the census must reject a flag-shifted docker cp INTO the container',
  )
  assert.equal(
    noContainerPrefixedCpDestination('docker cp "$BACKEND:/tmp/evidence.json" "$OUT/evidence.json"'),
    true,
    'sanity: a container-prefixed SOURCE (copy OUT) must still be allowed',
  )
})

test('structural: no docker exec invocation carries the password on argv (stdin-only)', () => {
  const execs = invocationsOf(scriptText, 'docker exec')
  assert.ok(execs.length >= 3, `sanity: the script must actually invoke docker exec: ${execs.length}`)
  assert.equal(noDockerExecCarriesSecret(scriptText), true)
  // Positive control: an env-var ingestion of the password MUST be rejected.
  assert.equal(
    noDockerExecCarriesSecret('docker exec -e ADMIN_PASSWORD="$PW" "$BACKEND" node x.js'),
    false,
    'the census must reject `docker exec -e …PASSWORD…`',
  )
  assert.equal(
    noDockerExecCarriesSecret('printf %s "$PW_B64" | docker exec -i "$BACKEND" node -e "$PW_B64"'),
    false,
    'the census must reject the password variable appearing as an argv token',
  )
})

test('structural: credentials are ingested on STDIN (base64 var → docker exec -i, container reads process.stdin)', () => {
  assert.equal(stdinIngestionPresent(scriptText), true)
})

test('structural: an unconditional trap on EXIT/INT/TERM scrubs the host password file', () => {
  assert.equal(trapScrubsHostSecret(scriptText), true)
  // HUP is additionally covered (SSH drop), belt-and-suspenders.
  const trapLine = scriptText.split('\n').find((l) => /^\s*trap\s+cleanup\b/.test(l))
  assert.match(trapLine, /\bHUP\b/, 'the trap should also cover HUP (SSH drop)')
})

test('structural: promotion is ONE transaction (psql -1) with ON_ERROR_STOP and an exactly-one assertion on the real RBAC read path', () => {
  assert.equal(promotionIsSingleTransaction(executable), true, 'promotion must be a single transaction (psql -1 / BEGIN;…COMMIT;)')
  assert.equal(promotionHasErrorStop(executable), true, 'promotion must set ON_ERROR_STOP=1')
  assert.equal(
    promotionAssertsExactlyOne(executable),
    true,
    'promotion must end asserting exactly one user (by id) + exactly one user_roles admin membership + the id belongs to the intended email',
  )
  // The promotion inserts are idempotent (safe re-run) and keyed on the verified id.
  assert.match(executable, /INSERT INTO roles \(id, name\) VALUES \('admin', 'admin'\) ON CONFLICT \(id\) DO NOTHING;/)
  assert.match(executable, /INSERT INTO user_roles[\s\S]*?SELECT u\.id, 'admin' FROM users u WHERE u\.id = :'uid'[\s\S]*?ON CONFLICT \(user_id, role_id\) DO NOTHING;/)
})

test('structural: the email is normalized (trim+lowercase) once and the SAME $EMAIL feeds register, promotion, and login', () => {
  assert.equal(emailNormalizedAndConsistent(scriptText), true)
})

test('structural: P1 — login runs BEFORE promotion, and the promotion is keyed on the server-verified login id (data-flow, not just position)', () => {
  assert.equal(loginBeforePromotion(executable), true, 'the login step must textually precede the promotion psql')
  assert.equal(
    promotesByVerifiedLoginId(executable),
    true,
    'the promotion must be keyed on $USER_ID captured from the login step, guarded by a non-empty check',
  )
  // Positive control on the ORDER criterion itself (attack your own criterion): a
  // synthetic script whose login line sits AFTER the promotion psql MUST red.
  const inverted = [
    'docker exec -i "$PGC" psql -U "$PGU" -d "$PGD" -1 -v ON_ERROR_STOP=1 -v uid="$USER_ID" -v em="$EMAIL"',
    'LOGIN_OUT="$(printf \'%s\' "$PW_B64" | docker exec -i "$BACKEND" node -e "$NODE_PROG" login "$EMAIL")"',
  ].join('\n')
  assert.equal(loginBeforePromotion(inverted), false, 'the order criterion must reject login-after-promotion')
})

test('structural: login verification hits the real endpoint, requires success:true, and captures the server data.user.id', () => {
  assert.match(scriptText, /docker exec -i "\$BACKEND" node -e "\$NODE_PROG" login "\$EMAIL"/)
  assert.match(scriptText, /"\/api\/auth\/login"/)
  // login authenticates (success:true) …
  assert.match(scriptText, /const authed = r\.statusCode >= 200 && r\.statusCode < 300 && parsed && parsed\.success === true/)
  // … captures the server-authoritative user id …
  assert.match(scriptText, /const uid = parsed\.data && parsed\.data\.user \? parsed\.data\.user\.id : undefined/)
  // … refuses to proceed without it, and emits ONLY the id on stdout for the caller.
  assert.match(scriptText, /refusing to promote/)
  assert.match(scriptText, /process\.stdout\.write\("USERID=" \+ uid \+ "\\n"\)/)
})

test('structural: the header documents the stdin-only + trap + single-tx design and BOTH P1s (leak + privilege escalation)', () => {
  const header = scriptText.slice(0, scriptText.indexOf('set -euo pipefail'))
  assert.match(header, /stdin-only ingestion/i)
  assert.match(header, /WRITABLE LAYER/)
  assert.match(header, /trap .*EXIT INT TERM HUP/)
  assert.match(header, /single (transaction|atomic)|one atomic/i)
  assert.match(header, /USAGE/)
  // the privilege-escalation fix must be documented: login-first, promote by id.
  assert.match(header, /PRIVILEGE ESCALATION/i)
  assert.match(header, /LOGIN-FIRST/i)
  assert.match(header, /promote (only )?by (that )?(verified )?id/i)
})

test('structural (harness P3): the real-Docker readiness gate queries the TARGET db (SELECT 1), not pg_isready', () => {
  const selfText = readFileSync(selfPath, 'utf8')
  assert.equal(
    readinessQueriesTargetDb(selfText),
    true,
    'waitForTargetDbQueryable must gate on a psql SELECT 1 against the target db (not pg_isready)',
  )
  // the golden stack must actually USE that gate (not an inlined pg_isready loop)
  assert.match(selfText, /waitForTargetDbQueryable\(pg\)/)
})

// ---------------------------------------------------------------------------
// 2. MUTATION-PROVE (in-memory string mutations; file on disk untouched)
// ---------------------------------------------------------------------------

test('mutation: reintroducing a `docker cp` of the secret INTO the container reds the docker-cp census', () => {
  // sanity: pristine passes
  assert.equal(noContainerPrefixedCpDestination(scriptText), true)
  const mutated = scriptText.replace(
    'PW_B64="$(base64 < "$PWFILE" | tr -d \'\\n\')"',
    'docker cp "$PWFILE" "$BACKEND:/tmp/l1pw.$$"\nPW_B64="$(base64 < "$PWFILE" | tr -d \'\\n\')"',
  )
  assert.notEqual(mutated, scriptText, 'mutation must actually change the text')
  assert.equal(noContainerPrefixedCpDestination(mutated), false, 'a reintroduced docker cp INTO the container must red the census')
})

test('mutation: a flag-shifted `docker cp -a … CONTAINER:…` still reds the census', () => {
  const mutated = scriptText.replace(
    'PW_B64="$(base64 < "$PWFILE" | tr -d \'\\n\')"',
    'docker cp -a "$PWFILE" "$BACKEND:/tmp/l1pw"\nPW_B64="$(base64 < "$PWFILE" | tr -d \'\\n\')"',
  )
  assert.notEqual(mutated, scriptText)
  assert.equal(noContainerPrefixedCpDestination(mutated), false)
})

test('mutation: passing the password as `docker exec -e …PASSWORD` reds the argv-secret census', () => {
  assert.equal(noDockerExecCarriesSecret(scriptText), true)
  const mutated = scriptText.replace(
    'docker exec -i "$BACKEND" node -e "$NODE_PROG" register "$EMAIL"',
    'docker exec -i -e ADMIN_PASSWORD="$PW_B64" "$BACKEND" node -e "$NODE_PROG" register "$EMAIL"',
  )
  assert.notEqual(mutated, scriptText)
  assert.equal(noDockerExecCarriesSecret(mutated), false)
})

test('mutation: making the promotion non-transactional (drop `-1`) reds the single-transaction gate', () => {
  // sanity: pristine passes
  assert.equal(promotionIsSingleTransaction(executable), true)
  const mutatedText = scriptText.replace(
    'psql -U "$PGU" -d "$PGD" -1 -v ON_ERROR_STOP=1 -v uid="$USER_ID" -v em="$EMAIL"',
    'psql -U "$PGU" -d "$PGD" -v ON_ERROR_STOP=1 -v uid="$USER_ID" -v em="$EMAIL"',
  )
  assert.notEqual(mutatedText, scriptText, 'mutation must actually remove the -1')
  const mutatedExec = stripShellComments(mutatedText)
  // The DO block still contains a plpgsql `BEGIN`/`END`; the gate must NOT be
  // fooled by it (that is the 枚举陷阱 the disjunction-with-semicolon avoids).
  assert.match(mutatedExec, /^\s*BEGIN$/m, 'sanity: the plpgsql BEGIN is still present after the mutation')
  assert.equal(
    promotionIsSingleTransaction(mutatedExec),
    false,
    'without -1 (and no explicit BEGIN;…COMMIT;) the promotion is no longer a single transaction — the plpgsql BEGIN must not keep it green',
  )
})

test('mutation: dropping the trim+lowercase normalization (register raw email) reds the email-consistency gate', () => {
  assert.equal(emailNormalizedAndConsistent(scriptText), true)
  const mutated = scriptText.replace(
    /EMAIL="\$\(printf '%s' "\$EMAIL_RAW"[\s\S]*?\)"/,
    'EMAIL="$EMAIL_RAW"',
  )
  assert.notEqual(mutated, scriptText, 'mutation must actually drop the normalization')
  assert.equal(
    emailNormalizedAndConsistent(mutated),
    false,
    'without trim+lowercase, register would store sanitizeEmail(email) while the promotion reads the raw casing',
  )
})

test('mutation: deleting the exactly-one RAISE assertion reds the post-assert gate', () => {
  assert.equal(promotionAssertsExactlyOne(executable), true)
  const mutatedText = scriptText.replace(
    /IF u_count <> 1 OR m_count <> 1 OR e_count <> 1 THEN\n\s*RAISE EXCEPTION 'promotion assertion failed[\s\S]*?END IF;/,
    '-- assertion removed by mutation',
  )
  assert.notEqual(mutatedText, scriptText, 'mutation must actually remove the assertion')
  assert.equal(promotionAssertsExactlyOne(stripShellComments(mutatedText)), false)
})

test('mutation: P1 — reverting the promotion to an email lookup (not the verified id) reds the promote-by-verified-id gate', () => {
  // sanity: pristine passes
  assert.equal(promotesByVerifiedLoginId(executable), true)
  // The exact defect class: grant the account that MATCHES THE EMAIL rather than the
  // one whose password we just authenticated. An attacker who pre-empted the email
  // would be the one holding it → they get promoted.
  const mutatedText = scriptText
    .replace('-v uid="$USER_ID" -v em="$EMAIL"', '-v em="$EMAIL"')
    .replace("UPDATE users SET role = 'admin' WHERE id = :'uid';", "UPDATE users SET role = 'admin' WHERE email = :'em';")
  assert.notEqual(mutatedText, scriptText, 'mutation must actually revert to the email lookup')
  assert.equal(
    promotesByVerifiedLoginId(stripShellComments(mutatedText)),
    false,
    'a promotion keyed on the email (not the verified login id) must red the data-flow gate',
  )
})

test('mutation: P1 — running the login step for effect only (dropping the id capture + non-empty guard) reds the data-flow gate', () => {
  assert.equal(promotesByVerifiedLoginId(executable), true)
  // Simulate the predecessor's "login is just a check" shape: the capture into
  // LOGIN_OUT and the USER_ID derivation/guard are gone, so nothing keys the grant
  // on an authenticated id.
  const mutatedText = scriptText
    .replace(
      'if ! LOGIN_OUT="$(printf \'%s\' "$PW_B64" | docker exec -i "$BACKEND" node -e "$NODE_PROG" login "$EMAIL")"; then',
      'if ! printf \'%s\' "$PW_B64" | docker exec -i "$BACKEND" node -e "$NODE_PROG" login "$EMAIL"; then',
    )
  assert.notEqual(mutatedText, scriptText, 'mutation must actually drop the capture')
  assert.equal(
    promotesByVerifiedLoginId(stripShellComments(mutatedText)),
    false,
    'without capturing LOGIN_OUT the promotion cannot be keyed on the verified id — the gate must red',
  )
})

test('mutation: P1 — relocating the empty-id guard to AFTER the promotion reds the ordering conjunct (guard must PRECEDE the grant)', () => {
  assert.equal(promotesByVerifiedLoginId(executable), true)
  const guardBlock =
    'if [[ -z "$USER_ID" ]]; then\n' +
    '  echo "ERROR: login verification returned no server user id — refusing to promote (ZERO database writes)" >&2\n' +
    '  exit 1\n' +
    'fi'
  assert.ok(scriptText.includes(guardBlock), 'sanity: the empty-id guard block exists verbatim')
  // Remove the guard from its (pre-promotion) position and re-append it at the very
  // end — AFTER the promotion. Every other conjunct still holds; only the ordering breaks.
  const mutatedText = scriptText.replace(guardBlock + '\n', '') + '\n' + guardBlock + '\n'
  assert.notEqual(mutatedText, scriptText, 'mutation must relocate the guard')
  const mutatedExec = stripShellComments(mutatedText)
  assert.match(mutatedExec, /if \[\[ -z "\$USER_ID" \]\]; then/, 'sanity: the guard is still present (just moved)')
  assert.equal(
    promotesByVerifiedLoginId(mutatedExec),
    false,
    'a guard that runs AFTER the promotion cannot protect it — the ordering conjunct must red',
  )
})

test('mutation (harness P3): reverting the readiness gate to pg_isready reds the target-db-query structural check', () => {
  const selfText = readFileSync(selfPath, 'utf8')
  // sanity: pristine passes
  assert.equal(readinessQueriesTargetDb(selfText), true)
  const mutated = selfText.replace(
    "const q = d(['exec', '-i', pg, 'psql', '-U', user, '-d', db, '-tA', '-c', 'SELECT 1'])\n    if (q.status === 0 && q.stdout.trim() === '1') return",
    "const q = d(['exec', pg, 'pg_isready', '-U', user, '-d', db])\n    if (q.status === 0) return",
  )
  assert.notEqual(mutated, selfText, 'mutation must actually swap SELECT 1 for pg_isready')
  assert.equal(
    readinessQueriesTargetDb(mutated),
    false,
    'a pg_isready readiness gate (no target-db SELECT 1) must red the structural check — that is the P3 race',
  )
})

// ---------------------------------------------------------------------------
// 3. GOLDEN — real Docker, OPT-IN. End-to-end run of the SHIPPED script against
//    a mock backend container + a real Postgres, plus the leak reproduction.
// ---------------------------------------------------------------------------

function goldenSkipReason() {
  if (process.env.L1_ADMIN_DOCKER_GOLDENS !== '1') {
    return 'L1_ADMIN_DOCKER_GOLDENS != 1 (real-Docker goldens are opt-in; they never run in a required hermetic lane)'
  }
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' })
  if (probe.error) return `docker-unreachable: CLI not usable: ${probe.error.message}`
  if (probe.status !== 0) return `docker-unreachable: daemon not reachable (exit ${probe.status}): ${(probe.stderr || '').trim()}`
  // A usable node base image (for the mock backend) and postgres image must exist.
  const nodeImg = spawnSync('docker', ['image', 'inspect', 'node:20-alpine'], { encoding: 'utf8' })
  if (nodeImg.status !== 0) {
    const pull = spawnSync('docker', ['pull', '-q', 'node:20-alpine'], { encoding: 'utf8' })
    if (pull.status !== 0) return `no-usable-base-image: node:20-alpine not present and not pullable: ${(pull.stderr || '').trim()}`
  }
  const pgImg = spawnSync('docker', ['image', 'inspect', 'postgres:15-alpine'], { encoding: 'utf8' })
  if (pgImg.status !== 0) {
    const pull = spawnSync('docker', ['pull', '-q', 'postgres:15-alpine'], { encoding: 'utf8' })
    if (pull.status !== 0) return `no-usable-base-image: postgres:15-alpine not present and not pullable: ${(pull.stderr || '').trim()}`
  }
  return null
}

const GOLDEN_SKIP = goldenSkipReason()
if (GOLDEN_SKIP) {
  console.error(
    `[golden] REAL-DOCKER GOLDEN SKIPPED — ${GOLDEN_SKIP}. The structural + mutation cases above still ran; the real-container proof did NOT.`,
  )
}

function d(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...opts })
}

// The mock backend: a long-running HTTP server implementing the exact
// register/login contract (201/{success:true}, 409 "already exists", 200 on
// matching password), backed by an in-memory Map. Runs as the container's main
// process so `docker exec … node -e` (the shipped ingestion) reaches it on
// 127.0.0.1:$PORT. Deliberately holds NO filesystem state — so any file that
// `docker diff` reports after the shipped run would be the ingestion leaking.
// The server-authoritative user id the mock returns on register/login. It is the
// SAME deterministic function used to seed the postgres users row (mockUserId
// below), so the id the shipped script captures at login reconciles EXACTLY with
// the row the promotion targets — mirroring production, where the real backend's
// register writes the row and login returns that same id. Faithful to the real
// login response shape: { success:true, data:{ user:{ id, ... }, token } }.
const MOCK_BACKEND_SERVER = `
const http = require('http');
const users = new Map();
function uid(email){ return 'u-' + Buffer.from(String(email)).toString('hex'); }
function readBody(req, cb){ let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ try{ cb(JSON.parse(b||'{}')); }catch(e){ cb({}); } }); }
http.createServer((req,res)=>{
  if(req.url==='/api/auth/register' && req.method==='POST'){
    readBody(req,(o)=>{
      if(users.has(o.email)){ res.writeHead(409,{'Content-Type':'application/json'}); res.end(JSON.stringify({success:false,error:'User with this email already exists'})); return; }
      users.set(o.email,o.password); res.writeHead(201,{'Content-Type':'application/json'}); res.end(JSON.stringify({success:true,data:{user:{id:uid(o.email),email:o.email}}}));
    });
  } else if(req.url==='/api/auth/login' && req.method==='POST'){
    readBody(req,(o)=>{
      const id=o.identifier||o.email;
      if(users.has(id) && users.get(id)===o.password){ res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({success:true,data:{token:'t',user:{id:uid(id),email:id}}})); }
      else { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({success:false,error:'Invalid account or password'})); }
    });
  } else { res.writeHead(404); res.end('{}'); }
}).listen(Number(process.env.PORT||8900),'127.0.0.1',()=>{ console.error('mock backend up'); });
`

// Deterministic server-authoritative id, replicated byte-for-byte from the mock
// backend's uid() above. The golden seeds the postgres users row with THIS id so
// the shipped script's login-captured data.user.id keys the promotion onto exactly
// that row (as production does: register writes the row, login returns its id).
function mockUserId(email) {
  return 'u-' + Buffer.from(String(email)).toString('hex')
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user');
CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_roles (user_id TEXT NOT NULL, role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE, PRIMARY KEY (user_id, role_id));
-- migration 054 seeds roles exactly like this ('admin','管理员') — the P2 trap:
INSERT INTO roles (id, name) VALUES ('admin','管理员'),('user','普通用户') ON CONFLICT (id) DO NOTHING;
`

// P3 — readiness must mean "the TARGET database accepts a query", not "the server
// port is up". `pg_isready` returns success as soon as the postmaster answers the
// startup packet, which on the official postgres image can happen BEFORE the target
// database is created and queryable (the entrypoint runs init on a throwaway server,
// then restarts). A `pg_isready` gate followed by an immediate connect to the target
// db therefore flakes (owner saw 19/20 fail on the PR run, pass on rerun). Gate on
// `SELECT 1` against the TARGET db with a bounded retry, and fail LOUDLY on timeout.
function waitForTargetDbQueryable(pg, { user = 'ms', db = 'metasheet', tries = 60, delayMs = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const q = d(['exec', '-i', pg, 'psql', '-U', user, '-d', db, '-tA', '-c', 'SELECT 1'])
    if (q.status === 0 && q.stdout.trim() === '1') return
    spawnSync('sleep', [String(delayMs / 1000)])
  }
  assert.fail(
    `target database ${db} never accepted a SELECT 1 within ${tries} tries (~${(tries * delayMs) / 1000}s) — readiness gate exhausted; this means the target DB was never queryable, not merely that the server port was up`,
  )
}

function withGoldenStack(fn, { backendMode = 'mock' } = {}) {
  const id = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const backend = `l1admin-backend-${id}`
  const pg = `l1admin-pg-${id}`
  d(['rm', '-f', backend, pg])
  // Postgres
  let r = d(['run', '-d', '--name', pg, '-e', 'POSTGRES_USER=ms', '-e', 'POSTGRES_PASSWORD=ms', '-e', 'POSTGRES_DB=metasheet', 'postgres:15-alpine'])
  assert.equal(r.status, 0, `postgres must start: ${r.stderr}`)
  // Backend: either the long-running mock HTTP server (PORT=8900), or a 'noserver'
  // container that has `node`/`sh` (so `docker exec` works and the ingestion runs)
  // but NOTHING listening on 8900 — so register's node one-liner gets ECONNREFUSED
  // and the script exits non-zero AFTER ingestion, exercising the trap on a failure.
  if (backendMode === 'noserver') {
    r = d(['run', '-d', '--name', backend, '-e', 'PORT=8900', 'node:20-alpine', 'sleep', '3600'])
  } else {
    r = d(['run', '-d', '--name', backend, '-e', 'PORT=8900', 'node:20-alpine', 'node', '-e', MOCK_BACKEND_SERVER])
  }
  assert.equal(r.status, 0, `backend must start: ${r.stderr}`)
  try {
    // wait for the TARGET db to actually accept a query (P3 fix — not pg_isready)
    waitForTargetDbQueryable(pg)
    // schema + seed
    const sr = d(['exec', '-i', pg, 'psql', '-U', 'ms', '-d', 'metasheet', '-v', 'ON_ERROR_STOP=1'], { input: SCHEMA_SQL })
    assert.equal(sr.status, 0, `schema load must succeed: ${sr.stderr}`)
    // the freshly-registered user is created by the script's register step, so we
    // do NOT pre-seed it here — but the mock backend register writes only to its
    // in-memory Map, not to postgres, so seed the users row the promotion needs.
    // (In production the real backend's register writes the users row itself.) The
    // id is the SAME server-authoritative id the mock login returns (mockUserId),
    // so the login-first flow's promote-by-verified-id keys onto exactly this row.
    const ur = d(['exec', '-i', pg, 'psql', '-U', 'ms', '-d', 'metasheet', '-v', 'ON_ERROR_STOP=1'], {
      input: `INSERT INTO users (id,email,name,password_hash,role) VALUES ('${mockUserId('l1-battery-admin@example.com')}','l1-battery-admin@example.com','l1 battery admin','x','user') ON CONFLICT (id) DO NOTHING;`,
    })
    assert.equal(ur.status, 0, `user seed must succeed: ${ur.stderr}`)
    fn({ backend, pg })
  } finally {
    d(['rm', '-f', backend, pg])
  }
}

function makePwFile(password) {
  const dir = mkdtempSync(join(tmpdir(), 'l1admin-pw-'))
  const f = join(dir, 'pw')
  writeFileSync(f, password) // exact bytes, no trailing newline
  chmodSync(f, 0o600)
  return { dir, f }
}

function runScript(pwFile, backend, pg, extraEnv = {}) {
  return spawnSync('bash', [scriptPath, pwFile], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      BACKEND_CONTAINER: backend,
      POSTGRES_CONTAINER: pg,
      ...extraEnv,
    },
  })
}

// diff paths added under /tmp by the container (the leak surface), baseline-relative.
function tmpDiffAdds(container) {
  const r = d(['diff', container])
  const lines = (r.stdout || '').split('\n').filter(Boolean)
  return lines.filter((l) => /^A\s|\/tmp/.test(l))
}

// Simulate an attacker PRE-EMPTING the target email: POST /api/auth/register to the
// mock backend with a password WE DO NOT CONTROL, so the account exists but only the
// attacker's password authenticates it. Runs inside the backend container against
// 127.0.0.1:8900 (the same server the shipped ingestion talks to).
function preRegisterAttacker(backend, email, password) {
  const prog = `
const http=require('http');
const body=JSON.stringify({email:${JSON.stringify(email)},password:${JSON.stringify(password)},name:'attacker'});
const req=http.request({host:'127.0.0.1',port:Number(process.env.PORT||8900),path:'/api/auth/register',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{ if(r.statusCode>=200&&r.statusCode<300){process.exit(0);} console.error('attacker pre-register status='+r.statusCode); process.exit(1); })});
req.on('error',(e)=>{console.error('attacker pre-register error '+e);process.exit(1)});
req.write(body);req.end();
`
  return d(['exec', '-i', backend, 'node', '-e', prog])
}

// Read the current (role, admin-membership-count) for the account, keyed on email.
function readAccountState(pg, email) {
  const check = d(['exec', '-i', pg, 'psql', '-U', 'ms', '-d', 'metasheet', '-tA'], {
    input: `SELECT (SELECT role FROM users WHERE email='${email}') , (SELECT count(*) FROM user_roles ur JOIN users u ON u.id=ur.user_id WHERE u.email='${email}' AND ur.role_id='admin');`,
  })
  return check.stdout.trim()
}

test(
  'golden (real Docker): the SHIPPED script promotes to a real 1/1 admin and its stdin ingestion writes NOTHING into the backend container',
  { skip: GOLDEN_SKIP ?? false },
  () => {
    withGoldenStack(({ backend, pg }) => {
      const { dir, f } = makePwFile('S3cure-Passw0rd!battery')
      try {
        const before = tmpDiffAdds(backend)
        const r = runScript(f, backend, pg)
        assert.equal(r.status, 0, `shipped script must succeed; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
        assert.match(r.stdout, /DONE — l1-battery-admin@example\.com exists .*is an RBAC admin/)

        // (P1) baseline-relative docker diff: the ingestion added NOTHING under /tmp.
        const after = tmpDiffAdds(backend)
        const delta = after.filter((l) => !before.includes(l))
        assert.deepEqual(delta, [], `stdin ingestion must not write into the container; docker diff delta:\n${delta.join('\n')}`)

        // (P1) the host password file was scrubbed by the trap.
        assert.equal(existsSync(f), false, 'the trap must scrub the host password file on exit')

        // (P2) the DB ends in the exact RBAC read-path state: 1 user, 1 admin membership.
        const check = d(['exec', '-i', pg, 'psql', '-U', 'ms', '-d', 'metasheet', '-tA'], {
          input: `SELECT (SELECT count(*) FROM users WHERE email='l1-battery-admin@example.com') , (SELECT count(*) FROM user_roles ur JOIN users u ON u.id=ur.user_id WHERE u.email='l1-battery-admin@example.com' AND ur.role_id='admin');`,
        })
        assert.equal(check.stdout.trim(), '1|1', `DB must be exactly 1 user / 1 admin membership, got: ${check.stdout.trim()}`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  },
)

test(
  'golden (real Docker): P1 — a PRE-EMPTED email + WRONG password exits non-zero and leaves users.role + user_roles ZERO-changed (no admin grant)',
  { skip: GOLDEN_SKIP ?? false },
  () => {
    // THE P1 privilege-escalation golden. An attacker pre-registers the target email
    // with THEIR OWN password; the operator then runs the script with the INTENDED
    // (different) password. Under the fixed login-first flow, register's 409 does NOT
    // trigger a grant — login is attempted with the intended password, FAILS (401),
    // and the script aborts BEFORE any psql runs. The attacker's account must be left
    // exactly as it was: role='user', ZERO user_roles admin membership. (Under the
    // predecessor's promote-before-login order this golden reds: the promotion would
    // have committed role='admin' + a membership despite the non-zero exit.)
    withGoldenStack(({ backend, pg }) => {
      const EMAIL = 'l1-battery-admin@example.com'
      const { dir, f } = makePwFile('S3cure-Passw0rd!battery') // the INTENDED password
      try {
        // Attacker pre-empts the email with a password we do NOT control.
        const pre = preRegisterAttacker(backend, EMAIL, 'attacker-controlled-pw')
        assert.equal(pre.status, 0, `attacker pre-registration must succeed for this repro: ${pre.stderr}`)

        // BEFORE: the seeded row is a plain user with no admin membership.
        const before = readAccountState(pg, EMAIL)
        assert.equal(before, 'user|0', `precondition: attacker account must start role=user, 0 admin memberships, got: ${before}`)

        // Operator runs the script with the intended (different) password.
        const r = runScript(f, backend, pg)

        // AFTER — the CORE P1 invariant, asserted FIRST so a promote-before-login
        // regression reds precisely HERE (role='admin', memberships=1) rather than on
        // some incidental message check: role + user_roles must be ZERO-changed.
        const after = readAccountState(pg, EMAIL)
        assert.equal(
          after,
          'user|0',
          `P1: a failed/refused run must leave the pre-empted account ZERO-changed (role=user, 0 admin memberships), got: ${after} — a non-'user|0' here means the promotion committed BEFORE login gated it`,
        )
        assert.equal(after, before, 'P1: the account state must be byte-identical before and after a refused promotion')

        // It MUST also exit non-zero, having aborted BEFORE the promotion (login-first).
        assert.notEqual(r.status, 0, `script must exit non-zero on a pre-empted email; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
        assert.doesNotMatch(r.stdout, /atomic RBAC promotion/, 'the promotion step must NOT run when login fails')
        assert.match(r.stderr, /refusing to promote|ZERO database writes/i)

        // The host password file was still scrubbed on this failure exit.
        assert.equal(existsSync(f), false, 'the trap must scrub the host password file even on the pre-emption abort')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  },
)

test(
  'golden (real Docker): on a FAILURE exit (backend server down mid-run) the host password file is STILL scrubbed and nothing was written into the container',
  { skip: GOLDEN_SKIP ?? false },
  () => {
    // The exact P1 scenario: register fails (no server), so the old success-only
    // `&& rm` would have stranded the password. This is the assertion that retires
    // the P1 on the failure path — the success-path scrub is not enough on its own.
    withGoldenStack(
      ({ backend, pg }) => {
        const { dir, f } = makePwFile('S3cure-Passw0rd!battery')
        try {
          const before = tmpDiffAdds(backend)
          const r = runScript(f, backend, pg)
          assert.notEqual(r.status, 0, `register against a backend with no listening server must fail; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
          // THE point: the trap fired on a non-zero exit and removed the host secret.
          assert.equal(existsSync(f), false, 'the trap MUST scrub the host password file even on a failure exit (retires the P1 host-stranding)')
          // And the stdin ingestion still wrote nothing into the container on this path.
          const after = tmpDiffAdds(backend)
          const delta = after.filter((l) => !before.includes(l))
          assert.deepEqual(delta, [], `even on the failure path the ingestion must write nothing into the container; delta:\n${delta.join('\n')}`)
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      },
      { backendMode: 'noserver' },
    )
  },
)

test(
  'golden (real Docker): a non-canonical BATTERY_ADMIN_EMAIL (uppercase) is normalized so register/promote/login agree — still exit 0 and 1/1 on the LOWERCASE row',
  { skip: GOLDEN_SKIP ?? false },
  () => {
    // The seeded users row is lowercase (mirroring what the real backend's register,
    // via sanitizeEmail, would store). If the script promoted by the RAW uppercase
    // email it would match zero rows → RAISE → rollback → non-zero. Passing here
    // proves the trim+lowercase normalization makes the three sites agree.
    withGoldenStack(({ backend, pg }) => {
      const { dir, f } = makePwFile('S3cure-Passw0rd!battery')
      try {
        const r = runScript(f, backend, pg, { BATTERY_ADMIN_EMAIL: 'L1-Battery-Admin@Example.COM' })
        assert.equal(r.status, 0, `normalized uppercase override must succeed; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
        const check = d(['exec', '-i', pg, 'psql', '-U', 'ms', '-d', 'metasheet', '-tA'], {
          input: `SELECT (SELECT count(*) FROM users WHERE email='l1-battery-admin@example.com') , (SELECT count(*) FROM user_roles ur JOIN users u ON u.id=ur.user_id WHERE u.email='l1-battery-admin@example.com' AND ur.role_id='admin');`,
        })
        assert.equal(
          check.stdout.trim(),
          '1|1',
          'promotion must target the normalized lowercase email the backend stored — a raw-uppercase promotion would find 0 rows and roll back',
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  },
)

test(
  'golden (real Docker): re-running the SHIPPED script is idempotent (still exit 0, still 1/1)',
  { skip: GOLDEN_SKIP ?? false },
  () => {
    withGoldenStack(({ backend, pg }) => {
      const { dir, f } = makePwFile('S3cure-Passw0rd!battery')
      const { dir: dir2, f: f2 } = makePwFile('S3cure-Passw0rd!battery')
      try {
        assert.equal(runScript(f, backend, pg).status, 0)
        const r2 = runScript(f2, backend, pg)
        assert.equal(r2.status, 0, `re-run must succeed; stdout:\n${r2.stdout}\nstderr:\n${r2.stderr}`)
        assert.match(r2.stdout, /register: status=409 ALREADY_EXISTS\(idempotent\)/)
        const check = d(['exec', '-i', pg, 'psql', '-U', 'ms', '-d', 'metasheet', '-tA'], {
          input: `SELECT (SELECT count(*) FROM users WHERE email='l1-battery-admin@example.com') , (SELECT count(*) FROM user_roles ur JOIN users u ON u.id=ur.user_id WHERE u.email='l1-battery-admin@example.com' AND ur.role_id='admin');`,
        })
        assert.equal(check.stdout.trim(), '1|1')
      } finally {
        rmSync(dir, { recursive: true, force: true })
        rmSync(dir2, { recursive: true, force: true })
      }
    })
  },
)

test(
  'golden (real Docker): after the SHIPPED run, a STOPPED backend container yields no credential via docker cp; and the OLD docker-cp-in leak IS recoverable (teeth)',
  { skip: GOLDEN_SKIP ?? false },
  () => {
    withGoldenStack(({ backend, pg }) => {
      const { dir, f } = makePwFile('S3cure-Passw0rd!battery')
      const hostCreds = mkdtempSync(join(tmpdir(), 'l1admin-leak-'))
      try {
        // Run the shipped (clean) script.
        assert.equal(runScript(f, backend, pg).status, 0)

        // THE OLD LEAK, reproduced: docker cp the password INTO the container the way
        // the predecessor did — then stop the container and read it back out.
        writeFileSync(join(hostCreds, 'password'), 's3cr3t-99')
        const cpIn = d(['cp', join(hostCreds, 'password'), `${backend}:/tmp/l1pw-leak`])
        assert.equal(cpIn.status, 0, `the OLD ingestion (docker cp INTO the container) must succeed for this reproduction: ${cpIn.stderr}`)

        // docker diff now SHOWS the leaked file (proves the diff assertion above has teeth).
        const diffAfterLeak = d(['diff', backend]).stdout || ''
        assert.match(diffAfterLeak, /\/tmp\/l1pw-leak/, 'docker diff must show a docker cp-in leak — otherwise the clean-path diff assertion is vacuous')

        // Stop the container; it is now absent from docker ps and docker exec refuses…
        assert.equal(d(['stop', backend]).status, 0)
        const ps = d(['ps', '--format', '{{.Names}}'])
        assert.ok(!ps.stdout.split('\n').some((n) => n.trim() === backend), 'a stopped container is absent from docker ps')
        assert.notEqual(d(['exec', backend, 'true']).status, 0, 'docker exec must refuse a stopped container')

        // …yet the leaked credential is STILL recoverable from its writable layer.
        const recovered = spawnSync('bash', ['-c', `docker cp '${backend}:/tmp/l1pw-leak' - | tar -xO`], { encoding: 'utf8' })
        assert.equal(recovered.status, 0, 'reading the OLD leak back out of a stopped container must succeed — that is the vulnerability')
        assert.equal(recovered.stdout, 's3cr3t-99', 'the docker cp-in credential survives in the writable layer of a stopped container')

        // But the SHIPPED script's own ingestion left NO credential path to recover.
        const cleanProbe = spawnSync('bash', ['-c', `docker cp '${backend}:/tmp/l1pw' - 2>/dev/null | tar -tf - 2>/dev/null`], { encoding: 'utf8' })
        assert.notEqual(cleanProbe.stdout.trim(), 'l1pw', 'the shipped stdin-only ingestion must leave no /tmp/l1pw credential in the container')
      } finally {
        rmSync(dir, { recursive: true, force: true })
        rmSync(hostCreds, { recursive: true, force: true })
      }
    })
  },
)
