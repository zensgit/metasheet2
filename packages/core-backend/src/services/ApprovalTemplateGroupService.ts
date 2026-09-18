/**
 * Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), §6 phase 1 service layer.
 *
 * Owns every write to `approval_template_groups` / `approval_template_group_links` (§2 DDL,
 * `zzzz20260918090100_create_approval_template_groups.ts`). Every exported function takes `orgId`
 * as an explicit, required, caller-supplied parameter — same convention as
 * `directory/local-directory-org.ts` — this module never reads `req` and never defaults the org;
 * the route layer resolves `orgId` from `req.authenticatedTenantId` ONLY (§2 "org 从哪来" / A‴)
 * and this file trusts whatever it is handed.
 *
 * Lock order (§2 锁序表), enforced by which statements each function issues and in what order:
 *   L0 = pg_advisory_xact_lock(hashtext('atg:' || org)); L1 = approval_template_groups row FOR
 *   UPDATE; L2 = approval_template_group_links row (upsert / UPDATE, implicit).
 *   create: L0. rename: L0→L1. archive: L0→L1→L2 (batch). unarchive: L0→L1. link: L1→L2 (no L0 —
 *   only-read-for-uniqueness/sort-order paths take L0, and linking does neither). unlink: L2 only
 *   (independent UPDATE, primary-key row lock suffices).
 *
 * `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` is the FIRST statement after BEGIN in every
 * L0-taking transaction (§2: a later SET aborts the transaction under a REPEATABLE READ default
 * pool with 25001; a bare RR snapshot taken by the advisory-lock SELECT itself would still see a
 * stale MAX(sort_order) after waiting on the lock — RACE-B2 in the lock's verification history).
 *
 * The seven error codes this lock introduces are ALL raised here (as `ServiceError`, imported from
 * `ApprovalBridgeService.ts` — the SAME class `routes/approvals.ts`'s `handleApprovalsError` /
 * `sendServiceError` already special-case) except `ORG_ID_NOT_ACCEPTED` / `SESSION_ORG_REQUIRED`,
 * which are pure request-shape concerns the route layer owns before it ever calls into this file:
 *   GROUP_NOT_FOUND (404) · GROUP_ARCHIVED (409) · GROUP_NAME_TAKEN (409) · GROUP_NOT_ARCHIVED
 *   (409) · GROUP_SORT_CONFLICT (500, §2 DEFERRABLE side effect ③ — a COMMIT-time 23505 on
 *   `atg_sort_unique`, not a statement-time one). "ALL" above means all of the lock's ratified
 *   domain codes; `requireName` below also raises `GROUP_NAME_REQUIRED` (400), an implementer's
 *   input-shape validation (same footing as this router's `APPROVAL_GROUP_ID_REQUIRED` /
 *   `APPROVAL_ACTOR_REQUIRED`), not an eighth ratified outcome.
 *
 * `GROUP_ARCHIVED` on re-archiving an already-archived group is this implementer's choice, not
 * lock text: the lock defines archive-of-an-already-archived-group behaviour nowhere and no
 * acceptance row exercises it. Reusing the SAME code the lock already assigns to the link-time
 * "this group is archived" case (rather than inventing an eighth code) reads correctly for both
 * the link-time and archive-time occurrences of the same underlying fact.
 *
 * `GROUP_NAME_UNSUPPORTED` (400, added in the design-gate-A3 回流修复 round, 2026-09-18) is
 * likewise an implementer's request-shape mapping, not a ninth ratified code — see
 * `mapGroupConstraintError`'s doc comment. Erratum 3 is a CANDIDATE, now in its REDRAFT v2 shape
 * (PROPOSED 2026-09-19/20, pending owner confirmation — NOT owner-ratified, NOT authorized; see
 * the lock's "勘误 3" header entry and `lock-errata-proposed-grouping-v2.13-20260919.md`'s
 * "勘误 3(重拟)" option (i)) that rewrites the `name` CHECK's predicate to an EXPLICIT-trim-set
 * `btrim(...) <> ''` — ASCII space/TAB/CR/LF plus U+3000, U+200B/200C/200D, U+2060, U+FEFF —
 * leaving the two `org_id` non-blank CHECKs untouched. Candidate v1 (a bare `btrim(name) <> ''`)
 * was refuted by gate round 8 P2-1: `btrim/2`'s default trim set is the ASCII space alone, so an
 * all-zero-width name landed a 201. On THIS candidate branch the `name` arm of
 * `mapGroupConstraintError`'s 23514 mapping is unreachable through the production route (see
 * `requireName`, which delegates to `./approval-template-group-name-rule`, whose edge-trim set is
 * a strict superset of the DB set) — see `mapGroupConstraintError`'s own doc comment for why the
 * arm is being KEPT (not deleted) until the owner actually confirms.
 *
 * §3.0 `...WithClient` split (added for the A-3 backfill design proposal,
 * `docs/development/approval-template-groups-phase2-design-20260918.md` §3.0 — the split itself
 * ships here ahead of any A-3 handler code because it is a hard prerequisite for A-3's
 * execute/rollback to exist at all, not because A-3 is implemented in this commit; A-3's
 * preview/execute/rollback endpoints, batch tables, and CI wiring remain OUT of scope pending
 * independent gate review of that design proposal — see taskbook
 * `impl-taskbook-A-grouping-20260918.md:72,:227`):
 *
 * `createApprovalTemplateGroup` / `linkApprovalTemplateToGroup` / `archiveApprovalTemplateGroup`
 * each open their OWN `transaction(...)` call, which — per `connection-pool.ts`'s
 * `pool.connect()` — hands out a NEW connection every time. A future composed caller (backfill's
 * execute/rollback) that itself opened a `transaction(...)` and then `await`ed one of these
 * exported functions FROM INSIDE that callback would acquire a SECOND connection and attempt to
 * re-take the SAME org's L0 advisory lock from it while the first connection still holds that lock
 * open (waiting on the inner call to resolve) — a confirmed same-session cross-connection
 * deadlock, not a theoretical one (same failure shape as memory note
 * `feedback_lock_taking_port_needs_lock_order_census`, #4899). Each of the three functions above is
 * therefore split into a `...WithClient(client, ...)` primitive carrying the body that used to live
 * inside its `transaction(async (client) => { ... })` callback, plus the original exported name
 * kept as a thin wrapper: `transaction(async (client) => { ...; return xWithClient(client, ...) })`.
 * A composed caller opens exactly ONE `transaction(...)` and calls the `...WithClient` primitives
 * directly on that single `client`/connection.
 *
 * **One statement is NOT byte-identical inside the split, by necessity, not oversight**:
 * `createApprovalTemplateGroupWithClient` and `archiveApprovalTemplateGroupWithClient` do NOT
 * themselves issue `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` — only their thin wrappers do,
 * as the first statement inside the `transaction(...)` callback, exactly where it sat before this
 * split. Reason: §2 requires that SET to be the very FIRST statement after `BEGIN` on the
 * connection (a later SET aborts the whole transaction with `25001` under a REPEATABLE READ
 * default pool). If the SET lived inside the `...WithClient` body instead, a composed caller
 * chaining two such primitives on the same connection (e.g. a future create-then-link) would issue
 * it a SECOND time after the first primitive's own queries had already run on that connection —
 * exactly the failure this paragraph exists to prevent. `linkApprovalTemplateToGroupWithClient`
 * needs no SET at all (link takes no L0 — see the lock-order table above — so no MAX()/uniqueness
 * read on this path is isolation-sensitive). Re-acquiring the L0 advisory lock itself IS safe to
 * repeat inside `...WithClient` bodies: `pg_advisory_xact_lock` is reentrant within one
 * session/transaction and returns immediately once already held by it, so a composed caller that
 * takes L0 once at the top of its own transaction and then calls a `...WithClient` primitive that
 * re-takes the SAME key does not block on itself.
 *
 * `requireName`'s validation stays in the thin `createApprovalTemplateGroup` wrapper, BEFORE
 * `transaction(...)` is even invoked — same as before this split — so an invalid name still fails
 * synchronously with zero connections acquired, rather than opening and rolling back a transaction.
 * `createApprovalTemplateGroupWithClient` therefore takes an already-validated/trimmed `name`.
 */

import { randomUUID } from 'node:crypto'
import type { QueryResult } from 'pg'
import { query, transaction } from '../db/pg'
import { ServiceError } from './ApprovalBridgeService'
import { classifyGroupName } from './approval-template-group-name-rule'

/** Matches `transaction()`'s handler-client shape (`db/pg.ts`) — the connection a `...WithClient` primitive runs its statements on. */
type TxClient = { query: (sql: string, params?: unknown[]) => Promise<QueryResult> }

/**
 * §13.2 changesRequired #10 (design-gate-A3-phase2, ownerLevel=false, already decided): the SET
 * obligation becomes a typecheck gate, not a runtime assertion. `AtgTxClient` is `TxClient`
 * branded with a `unique symbol` phantom property that exists ONLY at the type level — no object
 * literal or plain `TxClient` value structurally has it, so TypeScript rejects passing a raw
 * `TxClient` (or any value not produced by `beginApprovalTemplateGroupTxn` below) anywhere an
 * `AtgTxClient` is required, with a "property is missing" error at compile time. This is
 * deliberately NOT a `SELECT current_setting('transaction_isolation')` runtime check — the gate
 * report explicitly rejected that approach: on this repo's READ COMMITTED default server config
 * the assertion is always true regardless of whether THIS transaction issued its own SET, so it
 * would be silently vacuous on exactly the failure path it exists to catch (lock v2.6 P2-C is the
 * same shape of vacuous check). A missing SET here is a REPEATABLE-READ-pool correctness bug
 * (§2/§3.0), not a value comparison — only a compile-time gate that is impossible to satisfy
 * without calling `beginApprovalTemplateGroupTxn` can be trusted to catch it.
 */
declare const ATG_TX_BRAND: unique symbol
export type AtgTxClient = TxClient & { readonly [ATG_TX_BRAND]: true }

/**
 * The ONLY producer of `AtgTxClient`. Issues `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` —
 * which §2/§3.0 require to be the FIRST statement after `BEGIN` on the connection — and returns
 * the SAME client object, now carrying the brand. All three `...WithClient` primitives below
 * accept ONLY `AtgTxClient`, per §13.2's verbatim gate output (not narrowed to two of the three —
 * see the file-header note above `linkApprovalTemplateToGroupWithClient`'s thin wrapper for why
 * `link` gaining a SET it did not previously issue is a deliberate, disclosed consequence of this,
 * not an oversight). A future composed caller (W8 execute / W9 rollback) calls this exactly ONCE
 * at the top of its own single `transaction(...)` callback and threads the returned `AtgTxClient`
 * into every `...WithClient` call in that transaction — calling it a second time on the same
 * client would re-issue the SET after other statements have already run on the connection, which
 * §2 forbids; nothing in this file's current callers does that (each opens its own transaction and
 * calls this once), and this note exists for whoever writes the composed caller next.
 */
export async function beginApprovalTemplateGroupTxn(client: TxClient): Promise<AtgTxClient> {
  await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
  return client as AtgTxClient
}

export interface ApprovalTemplateGroupRow {
  id: string
  orgId: string
  name: string
  sortOrder: number | null
  createdBy: string
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

export interface ApprovalTemplateGroupLinkRow {
  orgId: string
  templateId: string
  groupId: string | null
  linkedBy: string
  linkedAt: string
  unlinkedAt: string | null
}

interface RawGroupRow {
  id: string
  org_id: string
  name: string
  sort_order: number | string | null
  created_by: string
  created_at: string | Date
  updated_at: string | Date
  archived_at: string | Date | null
}

interface RawLinkRow {
  org_id: string
  template_id: string
  group_id: string | null
  linked_by: string
  linked_at: string | Date
  unlinked_at: string | Date | null
}

const GROUP_COLUMNS = 'id, org_id, name, sort_order, created_by, created_at, updated_at, archived_at'
const LINK_COLUMNS = 'org_id, template_id, group_id, linked_by, linked_at, unlinked_at'

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value
}

function toIsoOrNull(value: string | Date | null): string | null {
  return value === null ? null : toIso(value)
}

function mapGroupRow(row: RawGroupRow): ApprovalTemplateGroupRow {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    sortOrder: row.sort_order === null ? null : Number(row.sort_order),
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    archivedAt: toIsoOrNull(row.archived_at),
  }
}

function mapLinkRow(row: RawLinkRow): ApprovalTemplateGroupLinkRow {
  return {
    orgId: row.org_id,
    templateId: row.template_id,
    groupId: row.group_id,
    linkedBy: row.linked_by,
    linkedAt: toIso(row.linked_at),
    unlinkedAt: toIsoOrNull(row.unlinked_at),
  }
}

function newGroupId(): string {
  return `atg_${randomUUID()}`
}

/**
 * Design-gate A-3 (`design-gate-A3-phase2-20260918.md`, P1-3, real-DB-measured M5): the lock's §2
 * non-blank CHECKs (`atg_name_nonblank`, `atg_org_nonblank`, `atgl_org_nonblank`) are
 * `CHECK (col ~ '[!-~]')` — printable-ASCII-only, copied verbatim from
 * `zzzz20260715210000_create_approval_attachments.ts:22-25`, where it guards two IDENTIFIER
 * columns, never a human-typed display name. Applied to `name` it rejects every pure-CJK group
 * name (`'人事' ~ '[!-~]'` = false; measured), which is the product's OWN placeholder text
 * (`TemplateAuthoringView.vue:221`: "如 请假 / 采购 / 报销") — so unmapped, this was a raw
 * `DatabaseError` (code 23514, statusCode undefined) reaching `handleApprovalsError`'s generic-500
 * fallback (it only special-cases `ServiceError`), on the exact endpoint this row's create handler
 * serves. `org_id`'s two occurrences are defense-in-depth only — the route layer already 403s a
 * blank `req.authenticatedTenantId` before any call into this file (§2 "org 从哪来" / A‴) — mapped
 * anyway so any other caller of these exported functions gets a typed 400, not a DB leak.
 *
 * The above describes the state as RATIFIED. On THIS branch, `name`'s CHECK has since been
 * rewritten as Erratum 3 CANDIDATE REDRAFT v2 (PROPOSED 2026-09-19/20, pending owner confirmation
 * — see `mapGroupConstraintError`'s doc comment below for the current, accurate status of this
 * Set and the branch that consumes it). `atg_org_nonblank` / `atgl_org_nonblank` keep the
 * ratified `~ '[!-~]'` predicate and this Set still maps them.
 */
const NONBLANK_CHECK_CONSTRAINTS = new Set(['atg_name_nonblank', 'atg_org_nonblank', 'atgl_org_nonblank'])

/**
 * Maps raw PostgreSQL constraint violations onto the lock's typed `ServiceError`s:
 *  - 23505 (unique_violation) — whether raised at statement time (the IMMEDIATE
 *    `uq_atg_org_name_active` partial index) or at COMMIT time (the DEFERRABLE
 *    `atg_sort_unique`). `error.constraint` (not just `error.code`) is the discriminator: a
 *    same-name concurrent write can hit the immediate name index first even when the caller's
 *    intent was a sort-order collision (§2 / acceptance E, "同名行会先撞立即唯一索引").
 *  - 23514 (check_violation) on one of `NONBLANK_CHECK_CONSTRAINTS` — see the block comment above.
 *    This is a REQUEST-SHAPE mapping, not a loosening of the CHECK: the constraint itself is a
 *    RATIFIED §2 clause and only an owner-approved lock erratum can widen it. This slice's
 *    verification MD's §23.5 "owner 勘误请示" originally asked to widen `atg_name_nonblank` to a
 *    bare `CHECK (btrim(name) <> '')`; gate round 8 P2-1 refuted that wording (btrim/2's default
 *    trim set is the ASCII space alone, so an all-zero-width name still passed), and the erratum
 *    was redrafted. On THIS branch the REDRAFT v2 predicate — an explicit trim set of ASCII
 *    space/TAB/CR/LF + U+3000 + U+200B/200C/200D + U+2060 + U+FEFF — has been applied to the
 *    migration as an Erratum 3 CANDIDATE (PROPOSED 2026-09-19/20, pending owner confirmation —
 *    NOT owner-ratified, NOT authorized; see the lock's own "勘误 3" header entry and
 *    `lock-errata-proposed-grouping-v2.13-20260919.md`'s "勘误 3(重拟)" option (i)). As a direct
 *    consequence, the `atg_name_nonblank` member of `NONBLANK_CHECK_CONSTRAINTS` is not known to
 *    be reachable for `name` through the production route — a pure-CJK (or any other name with a
 *    visible character) passes the CHECK, and a name with no glyph-carrying character is
 *    short-circuited by `requireName` with 400 `GROUP_NAME_REQUIRED` before any DB round-trip.
 *    That is a BOUNDED statement, not a closure claim (gate round 1 P2-1 falsified the previous
 *    unbounded version of this sentence): the rule module's edge-trim set is a strict SUPERSET of the
 *    DB's, so nothing it returns can violate the CHECK, and its visible-character requirement
 *    rejects every value the suite exercises — but the predicate carries its own disclosed
 *    residue (U+2800 is the one member of `BLANK_GLYPH_CODE_POINTS` that no other conjunct
 *    already excludes; see `./approval-template-group-name-rule`'s header). This branch of
 *    the `if` below, and `atg_name_nonblank` in the Set above, are being KEPT — not deleted — on
 *    purpose: deleting them would be an unreviewed narrowing of this mapping's surface bundled
 *    into a candidate that has not been confirmed, which is exactly the kind of unilateral call
 *    this file must not make. Delete only once the owner actually confirms Erratum 3 (or rejects
 *    it, in which case the branch reverts to load-bearing and nothing here needs to change). The
 *    two `org_id` members are UNCHANGED by this candidate and remain (defense-in-depth) reachable.
 * Anything else (including an already-typed `ServiceError` thrown deeper in the same transaction,
 * e.g. GROUP_NOT_FOUND/GROUP_ARCHIVED) passes through unchanged.
 */
// Exported (2026-09-18, W8 execute unit, design-gate-A3-phase2 changesRequired #11): the
// composed backfill execute handler (`routes/approvals.ts`) wraps its ENTIRE `transaction(...)`
// call in this SAME mapper — not a second, divergent copy — for the identical reason every
// thin wrapper in this file already does: `atg_sort_unique` is DEFERRABLE INITIALLY DEFERRED, so
// a real duplicate-sort-order collision only raises 23505 at COMMIT, which a try/catch INSIDE the
// transaction callback cannot observe.
export function mapGroupConstraintError(error: unknown): unknown {
  if (error instanceof ServiceError) return error
  const pgErr = error as { code?: unknown; constraint?: unknown } | null
  if (pgErr && typeof pgErr === 'object' && pgErr.code === '23505') {
    if (pgErr.constraint === 'uq_atg_org_name_active') {
      return new ServiceError('An active group with this name already exists', 409, 'GROUP_NAME_TAKEN')
    }
    if (pgErr.constraint === 'atg_sort_unique') {
      return new ServiceError('Group sort order conflict', 500, 'GROUP_SORT_CONFLICT')
    }
  }
  if (
    pgErr
    && typeof pgErr === 'object'
    && pgErr.code === '23514'
    && typeof pgErr.constraint === 'string'
    && NONBLANK_CHECK_CONSTRAINTS.has(pgErr.constraint)
  ) {
    // `atg_name_nonblank` arm: not reachable for `name` through the production route on this
    // branch since Erratum 3 candidate REDRAFT v2 (PROPOSED 2026-09-19/20, pending owner
    // confirmation — see doc comment above). KEPT, not deleted, until the owner actually
    // confirms — do not narrow this Set or this branch as part of the candidate; that would be
    // an implementer decision the candidate does not license.
    //
    // MESSAGE, ROUND-2 FIX (gate round 1 §3 / P3-4). The previous message read '当前锁文 CHECK
    // 只接受可打印 ASCII,纯中文名待 owner 勘误' and was left in place with the stated reason
    // that this slice's real-DB suite had "froze[n] [it] with `toContain` assertions". That
    // reason was FALSE and the gate verified it: no test in this repository asserts that string
    // (`grep -rn '只接受可打印 ASCII' packages apps` ⇒ the single hit was this source line
    // itself). An exemption reason that can be checked and found false is worse than no
    // exemption (`feedback_exemption_reasons_rot_make_them_data`), so the reason is deleted and
    // the message is corrected instead. The wording below is accurate for ALL THREE members of
    // `NONBLANK_CHECK_CONSTRAINTS` — the two `org_id` arms (still the ratified printable-ASCII
    // predicate, still reachable defence-in-depth) and the `name` arm — and it names the
    // constraint through `details.constraint` rather than guessing which column failed. The
    // error CODE is unchanged: `GROUP_NAME_UNSUPPORTED` is the shipped code for this mapping and
    // renaming it would be a public-contract change this candidate is not licensed to make.
    return new ServiceError(
      '名称或组织标识未通过数据库 CHECK 约束(详见 details.constraint)',
      400,
      'GROUP_NAME_UNSUPPORTED',
      { constraint: pgErr.constraint },
    )
  }
  return error
}

// BEGIN → SET TRANSACTION ISOLATION LEVEL READ COMMITTED (first statement, unconditionally) →
// pg_advisory_xact_lock(hashtext('atg:' + org)) (L0) → caller body. Issued as the first two
// statements inside each L0-taking function's own `transaction(...)` call below (inlined at each
// call site — same convention as `directory/local-directory-org.ts`'s reparent transaction, which
// does not factor this pair out into a shared wrapper either — so each call site's statement
// ORDER is visible at the call site itself). See file header for why the SET's position is
// load-bearing, not decorative.

/**
 * Application-layer name rule — Erratum 3 CANDIDATE, ROUND-4 REVISION (PROPOSED 2026-09-20,
 * pending owner confirmation; NOT ratified, NOT authorized, NOT merged).
 *
 * WHAT MOVED IN ROUND 4, AND WHY. The rule itself — length cap, edge trim, "at least one visible
 * character" — is unchanged in behaviour; it now lives in `./approval-template-group-name-rule`,
 * a module with ZERO runtime imports, and this file calls it. The reason is the owner's
 * 2026-09-20 ruling on erratum 3: 「暂缓定案:支持两层规则,但先提交准确字符规则及上述反例测试」,
 * written after an own-machine NO-DATABASE probe of the rule as the round-3 DOCUMENTS spelled it
 * (`[\p{L}\p{N}\p{P}\p{S}]`) returned `true` for U+3164 / U+115F / U+2800 —
 * 「字符属于这些类别,不等于可见」. The owner was right about the prose and the prose was not the
 * code: the shipped round-3 predicate already excluded `\p{Default_Ignorable_Code_Point}` and
 * U+2800. The fix for that class of disagreement is not better prose — it is making the rule
 * IMPORTABLE without a database, so `scripts/dev/probe-group-name-rule.mjs`, the real-DB suite and
 * this service all evaluate the same function objects. This file therefore no longer spells the
 * predicate at all; see that module's header for the predicate, its four conjuncts, which of them
 * can flip a verdict today, and the disclosed non-closure.
 *
 * WHAT THE OWNER'S RULING DOES NOT AUTHORIZE, restated at the call site: the two `org_id` CHECKs
 * and the migration are untouched by round 4 (`git diff` on the migration file is empty), the lock
 * text is unchanged, and the rule stays a CANDIDATE.
 *
 * RESIDUE, carried forward verbatim from round 3 because it is still true: the edge trim is a
 * TRIM, not a REJECT — U+200B + 'HR' + U+200B becomes `'HR'`, and an INTERNAL invisible
 * ('a' + U+200B + 'b') is preserved, so 'H' + U+200B + 'R' and `'HR'` are DIFFERENT names under
 * `uq_atg_org_name_active` while rendering identically (gate round 1 P3-5, an accepted
 * consequence). And the DB layer is WEAKER than this one: an NBSP-only name, and each blank code
 * point outside the CHECK's ten-member trim set, is rejected HERE with 400 even though a DIRECT
 * SQL insert of the same value SUCCEEDS — measured by the suite's RESIDUE cases. That asymmetry is
 * the reason this function, not the CHECK, is the primary rule.
 */
function requireName(name: unknown): string {
  const verdict = classifyGroupName(name)
  // Discriminated on `stage`, not on `ok`: this package compiles with `strict: false`, under which
  // TypeScript does not narrow a union by a boolean-literal discriminant (measured — the `ok`
  // version failed `tsc --noEmit` with TS2339 on every field of the rejecting members).
  if (verdict.stage === 'accepted') return verdict.name
  if (verdict.stage === 'length') {
    throw new ServiceError(
      `name must be at most ${verdict.maxLength} characters`,
      400,
      'GROUP_NAME_TOO_LONG',
      { maxLength: verdict.maxLength, actualLength: verdict.actualLength },
    )
  }
  // Both remaining stages — `trimmed-to-empty` and `no-visible-character` — are the SAME public
  // outcome (400 `GROUP_NAME_REQUIRED`), deliberately: which of the two rejected a name is a
  // diagnostic for the probe and the suite, not a distinction a caller should be able to observe
  // and enumerate the trim set from. The code is unchanged from round 3.
  throw new ServiceError('name is required', 400, 'GROUP_NAME_REQUIRED')
}

/** Read-only — no lock taken (§2 锁序表: "只读路径不取 L0"). */
export async function listApprovalTemplateGroups(orgId: string): Promise<ApprovalTemplateGroupRow[]> {
  const result = await query<RawGroupRow>(
    `SELECT ${GROUP_COLUMNS} FROM approval_template_groups
      WHERE org_id = $1
      ORDER BY (archived_at IS NOT NULL), sort_order NULLS LAST, archived_at DESC NULLS LAST, name`,
    [orgId],
  )
  return result.rows.map(mapGroupRow)
}

/**
 * L0 body only — no SET (see §3.0 file-header note: the wrapper below issues it). Caller must
 * already hold (or be about to take) this connection's L0 for `orgId`; this function takes it
 * itself (idempotently) so it is safe to call standalone via the wrapper below.
 */
export async function createApprovalTemplateGroupWithClient(
  client: AtgTxClient,
  orgId: string,
  name: string,
  createdBy: string,
): Promise<ApprovalTemplateGroupRow> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`atg:${orgId}`])
  const maxRow = await client.query(
    `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM approval_template_groups WHERE org_id = $1`,
    [orgId],
  )
  const nextSortOrder = Number((maxRow.rows[0] as { next: number | string })?.next ?? 1)
  const id = newGroupId()
  const inserted = await client.query(
    `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${GROUP_COLUMNS}`,
    [id, orgId, name, nextSortOrder, createdBy],
  )
  return mapGroupRow(inserted.rows[0] as RawGroupRow)
}

/** L0 only. sort_order = COALESCE(MAX(sort_order), 0) + 1 within the org (archived rows are NULL, MAX ignores them). Thin wrapper over `createApprovalTemplateGroupWithClient` — see §3.0 file-header note. */
export async function createApprovalTemplateGroup(
  orgId: string,
  name: string,
  createdBy: string,
): Promise<ApprovalTemplateGroupRow> {
  const trimmedName = requireName(name)
  try {
    return await transaction(async (client) => {
      const txClient = await beginApprovalTemplateGroupTxn(client)
      return createApprovalTemplateGroupWithClient(txClient, orgId, trimmedName, createdBy)
    })
  } catch (error) {
    throw mapGroupConstraintError(error)
  }
}

/** L0→L1 (§2 v2.5 P1: renaming must take L0, not just L1 — see RACE-C in the lock's history). */
export async function renameApprovalTemplateGroup(
  orgId: string,
  groupId: string,
  name: string,
): Promise<ApprovalTemplateGroupRow> {
  const trimmedName = requireName(name)
  try {
    return await transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`atg:${orgId}`])
      const locked = await client.query(
        `SELECT ${GROUP_COLUMNS} FROM approval_template_groups WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [orgId, groupId],
      )
      if (locked.rows.length === 0) {
        throw new ServiceError('Group not found', 404, 'GROUP_NOT_FOUND')
      }
      const updated = await client.query(
        `UPDATE approval_template_groups SET name = $3, updated_at = now()
           WHERE org_id = $1 AND id = $2
           RETURNING ${GROUP_COLUMNS}`,
        [orgId, groupId, trimmedName],
      )
      return mapGroupRow(updated.rows[0] as RawGroupRow)
    })
  } catch (error) {
    throw mapGroupConstraintError(error)
  }
}

/**
 * Shared statement TEXT for "unlink every member of a group" / "archive a group row" — design doc
 * §4.1's requirement, on top of §13 changesRequired #9's "the repo may keep only ONE copy of a
 * reused statement's text": W9 rollback (`rollbackApprovalTemplateGroupBackfillWithClient` below)
 * must NOT call this function (it is unconditional — see that function's own file-header note for
 * why an unconditional archive would undo batch-external state), but it must also not paste a
 * second copy of these two statements' SQL text. A shared plain FUNCTION (rather than these two
 * exported strings) was rejected: the two call sites need the identical text run under DIFFERENT
 * surrounding lock discipline — this function's caller takes `groupId`'s `FOR UPDATE` in the
 * statement immediately below; rollback's caller has already taken that same row lock in its own
 * §13.2 unified pre-lock step and must NOT re-issue a second `FOR UPDATE` here (doing so is the
 * exact L2→L1 sequence design-gate M3 found deadlocking against a concurrent plain link/unlink
 * request's L1→L2 order — see rollback's file-header note). A function wrapping both statements
 * would need a "caller already holds the lock" flag threaded through both call sites just to skip
 * its own lock acquisition; a plain exported SQL-text constant keeps each caller's own lock
 * sequencing visible at its own call site instead of hidden behind a parameter.
 */
export const ATG_UNLINK_ALL_GROUP_MEMBERS_SQL =
  'UPDATE approval_template_group_links SET group_id = NULL, unlinked_at = now() WHERE org_id = $1 AND group_id = $2'
export const ATG_ARCHIVE_GROUP_ROW_SQL = `UPDATE approval_template_groups SET archived_at = now(), sort_order = NULL, updated_at = now()
   WHERE org_id = $1 AND id = $2
   RETURNING ${GROUP_COLUMNS}`

/**
 * L0→L1→L2 (batch). Transactional per I2: lock the group row, unlink every member (an UPDATE,
 * never a DELETE — I2′), THEN clear sort_order and set archived_at. Concurrent link/re-link
 * attempts block on the SAME group row's FOR UPDATE (their own L1 acquire in
 * `linkApprovalTemplateToGroup`) and re-check `archived_at` after this commits (acceptance B).
 * Body only — no SET (see §3.0 file-header note: the wrapper below issues it).
 */
export async function archiveApprovalTemplateGroupWithClient(
  client: AtgTxClient,
  orgId: string,
  groupId: string,
): Promise<ApprovalTemplateGroupRow> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`atg:${orgId}`])
  const locked = await client.query(
    `SELECT ${GROUP_COLUMNS} FROM approval_template_groups WHERE org_id = $1 AND id = $2 FOR UPDATE`,
    [orgId, groupId],
  )
  if (locked.rows.length === 0) {
    throw new ServiceError('Group not found', 404, 'GROUP_NOT_FOUND')
  }
  if ((locked.rows[0] as RawGroupRow).archived_at !== null) {
    throw new ServiceError('Group is already archived', 409, 'GROUP_ARCHIVED')
  }

  // I2 / I2′: unlink (UPDATE, not DELETE) every member of this group before archiving it.
  // org_id = $1 is carried here too (every other write/read in this file does — §2 "SELECT
  // 必须带 org 谓词"), even though `atg_<uuid>` ids are already globally unique and the
  // composite `atgl_group_fk` makes a cross-org link row for this exact groupId impossible
  // today: correctness should rest on this predicate, not on an invariant enforced elsewhere.
  await client.query(ATG_UNLINK_ALL_GROUP_MEMBERS_SQL, [orgId, groupId])

  const updated = await client.query(ATG_ARCHIVE_GROUP_ROW_SQL, [orgId, groupId])
  return mapGroupRow(updated.rows[0] as RawGroupRow)
}

/** Thin wrapper over `archiveApprovalTemplateGroupWithClient` — see §3.0 file-header note. */
export async function archiveApprovalTemplateGroup(orgId: string, groupId: string): Promise<ApprovalTemplateGroupRow> {
  try {
    return await transaction(async (client) => {
      const txClient = await beginApprovalTemplateGroupTxn(client)
      return archiveApprovalTemplateGroupWithClient(txClient, orgId, groupId)
    })
  } catch (error) {
    throw mapGroupConstraintError(error)
  }
}

/**
 * L0→L1 (I8). Members do NOT come back (archiving already unlinked them and there is no history
 * column to restore from — this is Q4's ratified "no" answer, not an oversight). A same-org active
 * name conflict is checked explicitly BEFORE the UPDATE so it surfaces as a clean 409
 * `GROUP_NAME_TAKEN` *before* attempting a write that would fail anyway — the failure mode the
 * lock's G row names for removing this check (an unmapped 500 raw-23505 leak) does NOT reproduce
 * against this file's `mapGroupConstraintError`: that mapper is generic across every caller
 * (create/rename/unarchive), so the immediate `uq_atg_org_name_active` violation this UPDATE would
 * itself raise is caught and mapped to the SAME 409 `GROUP_NAME_TAKEN` regardless (confirmed by
 * mutation-testing this block out — no observable change; the mutation that DOES falsify the 409
 * is removing `mapGroupConstraintError`'s `uq_atg_org_name_active` branch itself, shared with A's
 * own mutation proof). This check therefore is not the SOLE guard, but IS still load-bearing for
 * not attempting a doomed write inside the L0 critical section.
 */
export async function unarchiveApprovalTemplateGroup(orgId: string, groupId: string): Promise<ApprovalTemplateGroupRow> {
  try {
    return await transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`atg:${orgId}`])
      const locked = await client.query(
        `SELECT ${GROUP_COLUMNS} FROM approval_template_groups WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [orgId, groupId],
      )
      if (locked.rows.length === 0) {
        throw new ServiceError('Group not found', 404, 'GROUP_NOT_FOUND')
      }
      const row = locked.rows[0] as RawGroupRow
      if (row.archived_at === null) {
        throw new ServiceError('Group is not archived', 409, 'GROUP_NOT_ARCHIVED')
      }

      const conflict = await client.query(
        `SELECT 1 FROM approval_template_groups WHERE org_id = $1 AND name = $2 AND archived_at IS NULL AND id <> $3`,
        [orgId, row.name, groupId],
      )
      if ((conflict.rowCount ?? 0) > 0) {
        throw new ServiceError('An active group with this name already exists', 409, 'GROUP_NAME_TAKEN')
      }

      const maxRow = await client.query(
        `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM approval_template_groups WHERE org_id = $1`,
        [orgId],
      )
      const nextSortOrder = Number((maxRow.rows[0] as { next: number | string })?.next ?? 1)

      const updated = await client.query(
        `UPDATE approval_template_groups SET archived_at = NULL, sort_order = $3, updated_at = now()
           WHERE org_id = $1 AND id = $2
           RETURNING ${GROUP_COLUMNS}`,
        [orgId, groupId, nextSortOrder],
      )
      return mapGroupRow(updated.rows[0] as RawGroupRow)
    })
  } catch (error) {
    throw mapGroupConstraintError(error)
  }
}

/**
 * L1→L2. First-and-re-link is ONE atomic upsert (v2.3 — a bare UPDATE affects 0 rows on first
 * link with no error; SELECT-then-branch races two concurrent first-links into different groups
 * into a double INSERT 23505). The group row's FOR UPDATE (L1) is taken BEFORE the upsert so a
 * concurrent archive (which also takes L1 on the same row) serializes against this: whichever
 * commits first wins, and the loser's `archived_at IS NULL` check (if it is this function) or its
 * own read of a since-archived row (if it is the archiver reading a since-added link — not
 * possible here since archive runs its unlink UPDATE only after re-checking under its OWN lock)
 * observes the fresh state (acceptance B). No L0: this path neither writes `name` nor assigns
 * `sort_order` (§2 锁序表 invariant). Body only (no SET either — link takes neither, see §3.0
 * file-header note). The `client` parameter type is `AtgTxClient` (see the file-header note above
 * `linkApprovalTemplateToGroup` below for why the thin wrapper now issues a SET this path never
 * needed on its own).
 */
export async function linkApprovalTemplateToGroupWithClient(
  client: AtgTxClient,
  orgId: string,
  templateId: string,
  groupId: string,
  linkedBy: string,
): Promise<ApprovalTemplateGroupLinkRow> {
  const locked = await client.query(
    `SELECT archived_at FROM approval_template_groups WHERE org_id = $1 AND id = $2 FOR UPDATE`,
    [orgId, groupId],
  )
  if (locked.rows.length === 0) {
    throw new ServiceError('Group not found', 404, 'GROUP_NOT_FOUND')
  }
  if ((locked.rows[0] as { archived_at: string | Date | null }).archived_at !== null) {
    throw new ServiceError('Group is archived', 409, 'GROUP_ARCHIVED')
  }

  const upserted = await client.query(
    `INSERT INTO approval_template_group_links (org_id, template_id, group_id, linked_by, linked_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (org_id, template_id) DO UPDATE SET
       group_id = EXCLUDED.group_id,
       unlinked_at = NULL,
       linked_by = EXCLUDED.linked_by,
       linked_at = EXCLUDED.linked_at
     RETURNING ${LINK_COLUMNS}`,
    [orgId, templateId, groupId, linkedBy],
  )
  return mapLinkRow(upserted.rows[0] as RawLinkRow)
}

/**
 * Thin wrapper over `linkApprovalTemplateToGroupWithClient` — see §3.0 file-header note.
 *
 * **Disclosed deviation from §3.0's "语句、顺序、错误映射逐字不变" promise (design-gate-A3-phase2
 * §13.2 changesRequired #10, `AtgTxClient` retrofit, this step)**: `link` takes no L0 and, before
 * this change, issued no `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` at all — nothing on its
 * path reads a value (`MAX(sort_order)`, an existence check) that a REPEATABLE READ snapshot could
 * make stale. §13.2 requires ALL THREE `...WithClient` primitives to accept only `AtgTxClient`,
 * and the only way to produce that brand is `beginApprovalTemplateGroupTxn`, which unconditionally
 * issues the SET. Narrowing "all three" to "the two that need it" would be treating the gate's own
 * ownerLevel=false decision as implementer discretion (memory
 * `feedback_second_narrower_artifact_is_contract_narrowing`), so this wrapper now issues a SET on
 * every call, same as `create`/`archive` — a real, if inert, per-connection statement it did not
 * emit before. Verified this does not change link's own behaviour: re-ran
 * `approval-template-groups-lifecycle.db.test.ts` / `approval-template-groups-serialization.db.test.ts`
 * against `metasheet2_lock_a3` after this change (results in this step's commit message) — link's
 * assertions (upsert semantics, L1 ordering against archive, 23503/23514 mappings) are unaffected
 * because none of them depend on isolation level; the SET's only observable effect is a slightly
 * larger no-op on the wire. `rename`/`unarchive` are NOT part of this retrofit — they have no
 * `...WithClient` split (§3.0 lists only create/archive/link) and keep issuing their own inline
 * SET exactly as before this step.
 */
export async function linkApprovalTemplateToGroup(
  orgId: string,
  templateId: string,
  groupId: string,
  linkedBy: string,
): Promise<ApprovalTemplateGroupLinkRow> {
  try {
    return await transaction(async (client) => {
      const txClient = await beginApprovalTemplateGroupTxn(client)
      return linkApprovalTemplateToGroupWithClient(txClient, orgId, templateId, groupId, linkedBy)
    })
  } catch (error) {
    throw mapGroupConstraintError(error)
  }
}

/**
 * L2 only — an independent UPDATE, NEVER routed through the upsert (§2: passing `group_id = NULL`
 * into the upsert would hit `atgl_state_check` 23514). Idempotent: 0 rows affected (already
 * unlinked, or never linked at all) is success, not an error (acceptance H).
 */
export async function unlinkApprovalTemplateFromGroup(
  orgId: string,
  templateId: string,
): Promise<{ changed: boolean }> {
  const result = await query(
    `UPDATE approval_template_group_links SET group_id = NULL, unlinked_at = now()
       WHERE org_id = $1 AND template_id = $2 AND group_id IS NOT NULL`,
    [orgId, templateId],
  )
  return { changed: (result.rowCount ?? 0) > 0 }
}

// ── A-3 backfill ("按现有 category 建组并挂接") — design-gate A3-phase2, W7 preview ─────────────
//
// `docs/development/approval-template-groups-phase2-design-20260918.md` §5.2 / P3-3
// (design-gate changesRequired, `reviews/design-gate-A3-phase2-20260918.md`): preview and (later)
// execute MUST decide "create a new group for this category / attach to an existing one / skip
// this category entirely" through the SAME function, or the two can silently diverge (preview
// shows a plan execute would not actually carry out). `classifyBackfillCategory` below is that
// function — pure, no DB access, so both callers can share it without composing another
// transaction. It is intentionally the ONLY place this module decides "is `category` storable as
// a group name" — the boolean is a straight port of the `btrim(category) ~ '[!-~]'` predicate the
// design's `eligible` SQL query (§3.1) uses, so a caller building that SQL later has a second,
// independent (JS) implementation to diff against rather than a copy of the same expression.

export type BackfillCategorySkipReason = 'CATEGORY_BLANK_AFTER_TRIM' | 'CATEGORY_NOT_STORABLE_AS_GROUP_NAME'

export type BackfillCategoryClassification =
  | { action: 'skip'; reason: BackfillCategorySkipReason; trimmedCategory: string }
  | { action: 'create'; trimmedCategory: string }
  | { action: 'attach'; trimmedCategory: string; existingGroupId: string }

/**
 * Mirrors PostgreSQL's ONE-ARGUMENT `btrim(text)`, which trims only the ASCII space character
 * (0x20) from both ends — NOT `String.prototype.trim()`'s full Unicode-whitespace set (tabs,
 * newlines, NBSP, … all survive). A category of `'\tHR\t'` therefore stays `'\tHR\t'` here, same
 * as it would under the SQL `eligible` predicate — reimplementing this with `.trim()` would let a
 * tab-padded legacy category disagree between the two, which is exactly the divergence this
 * function exists to prevent (see the file-header block above this function).
 */
function pgBtrim(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value.charCodeAt(start) === 0x20) start++
  while (end > start && value.charCodeAt(end - 1) === 0x20) end--
  return value.slice(start, end)
}

/**
 * Mirrors the POSIX bracket expression `[!-~]` (ASCII 0x21–0x7E, "printable and not a space") that
 * `atg_name_nonblank` / `atgbb_org_nonblank` (§2 DDL) and the execute `eligible` predicate (§3.1)
 * all use for "storable as a group name". `test()` on a non-empty match anywhere in the string is
 * the same semantics as SQL's `~` operator against this pattern (a containment match, not a
 * full-string anchor).
 */
const STORABLE_GROUP_NAME_PATTERN = /[!-~]/

/**
 * §5.2 / P3-3: given one candidate template's raw `category` value and the org's current
 * `{ trimmed name → active group id }` snapshot, decide skip / create / attach. `rawCategory` is
 * the UNTRIMMED database value (including `null`, which is treated identically to `''` — a
 * template with no category set at all is "blank after trim", not a fourth outcome). The skip
 * branch (blank / not-storable) never consults `existingGroupIdByTrimmedName` — callers that only
 * need to know whether a category is skip-eligible (e.g. to build the trimmed-name set to query
 * existing groups for, BEFORE that map exists) may call this with an empty map and read only
 * `.action === 'skip'` / `.trimmedCategory` off the result; the `existingGroupId` branch is only
 * meaningful once the real map is supplied.
 */
export function classifyBackfillCategory(
  rawCategory: string | null,
  existingGroupIdByTrimmedName: ReadonlyMap<string, string>,
): BackfillCategoryClassification {
  const trimmedCategory = pgBtrim(rawCategory ?? '')
  if (trimmedCategory === '') {
    return { action: 'skip', reason: 'CATEGORY_BLANK_AFTER_TRIM', trimmedCategory }
  }
  if (!STORABLE_GROUP_NAME_PATTERN.test(trimmedCategory)) {
    return { action: 'skip', reason: 'CATEGORY_NOT_STORABLE_AS_GROUP_NAME', trimmedCategory }
  }
  const existingGroupId = existingGroupIdByTrimmedName.get(trimmedCategory)
  return existingGroupId
    ? { action: 'attach', trimmedCategory, existingGroupId }
    : { action: 'create', trimmedCategory }
}

// ── A-3 backfill — design-gate A3-phase2, W9 rollback (2026-09-18, 续做步骤 12) ─────────────────
// `docs/development/approval-template-groups-phase2-design-20260918.md` §4 / §13.1 changesRequired
// #1/#2/#4/#7 (verbatim, folded into the proposal). Lives HERE, unlike preview/execute — rollback
// needs no `ApprovalTemplateVisibilityActor` / `applyTemplateVisibilityFilter` (it undoes exactly
// what a batch recorded, regardless of the caller's template-visibility scope), so it has none of
// the reason those two functions were pushed out to `routes/approvals.ts`.

export interface ApprovalTemplateGroupBackfillRollbackResult {
  rolledBackAt: string
}

/**
 * §4's transaction skeleton (§13 changesRequired #1 — the pseudocode's original two independent
 * code blocks, §4.2 and §4.3, had no shared skeleton naming ONE lock order across both; that gap
 * is exactly what design-gate M3 found deadlocking).
 *
 * Does NOT call `unlinkApprovalTemplateFromGroup` / `archiveApprovalTemplateGroupWithClient` (§4.1
 * — both are UNCONDITIONAL: the former clears `group_id` on any row that currently has one, the
 * latter unlinks every current member of a group; either would undo batch-EXTERNAL state a
 * subsequent manual action produced after this batch's `execute` ran). Instead:
 *  - §4.2: a single set-based `UPDATE … FROM` join against `..._batch_links`, whose join
 *    predicate is the optimistic-concurrency token this batch itself recorded (`group_id` AND
 *    `linked_at`, both still exactly what `execute` wrote) — a row that no longer matches BOTH is
 *    SKIPPED (left exactly as some other, later action left it), not an error.
 *  - §4.3: for each group THIS batch created (`created_new = true` in `..._batch_groups`), archive
 *    it ONLY if, after the §4.2 unlink above has already run, it has zero remaining members — using
 *    `ATG_UNLINK_ALL_GROUP_MEMBERS_SQL` / `ATG_ARCHIVE_GROUP_ROW_SQL` (the SAME statement text
 *    `archiveApprovalTemplateGroupWithClient` runs, reused as text per §4.1, not called as a
 *    function). A group attached to (`created_new = false`) is NEVER archived by rollback — it
 *    predates this batch, so archiving it would be a batch-external write.
 *
 * §13.2 unified lock order, landed here exactly as execute lands it: L0 → ONE deterministic
 * `ORDER BY id FOR UPDATE` pre-locking every EXISTING group this batch touches → every L2 write
 * below. The §4.3 loop reads its `archived_at` snapshot from that SAME pre-lock result and never
 * re-issues a second `FOR UPDATE` on a group row — re-locking there would be "unlink batch links
 * (L2) THEN take a group's FOR UPDATE (L1)", the literal L2→L1 order design-gate M3 reproduced a
 * deterministic deadlock against a concurrent plain link/unlink request's L1→L2 order.
 */
export async function rollbackApprovalTemplateGroupBackfillWithClient(
  client: AtgTxClient,
  orgId: string,
  batchId: string,
): Promise<ApprovalTemplateGroupBackfillRollbackResult> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`atg:${orgId}`]) // L0 — same key as create/archive/link/execute; rollback competes on the same org-wide lock.

  const batchRow = await client.query(
    `SELECT rolled_back_at FROM approval_template_group_backfill_batches WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [batchId, orgId],
  )
  const batchRows = batchRow.rows as Array<{ rolled_back_at: string | Date | null }>
  if (batchRows.length === 0) {
    // org_id = $2 is part of the WHERE, not a separate check after a bare id lookup — a batchId
    // that exists but belongs to a DIFFERENT org is indistinguishable from "does not exist" here,
    // the same fail-closed shape every other org-scoped lookup in this file already uses.
    throw new ServiceError('Backfill batch not found', 404, 'APPROVAL_TEMPLATE_GROUP_BACKFILL_BATCH_NOT_FOUND')
  }
  const existingRolledBackAt = batchRows[0].rolled_back_at
  if (existingRolledBackAt !== null) {
    // §13 changesRequired #7 (design-gate Q4, already ratified into the proposal): 409, NOT an
    // idempotent 200. A second rollback call on an already-rolled-back batch cannot tell "nothing
    // to undo because this batch was already undone" apart from "nothing to undo because every one
    // of this batch's rows happens to have been mutated by something else since" — a 200 with an
    // empty result would let those two render identically (the `finding_attendance_denied_renders_as_all_clear`
    // shape). The 409's `details.rolledBackAt` lets a caller that retried after a timeout tell
    // "already done" apart from "never happened" without a second ambiguous 200.
    throw new ServiceError(
      'Backfill batch was already rolled back',
      409,
      'APPROVAL_TEMPLATE_GROUP_BACKFILL_BATCH_ALREADY_ROLLED_BACK',
      { rolledBackAt: toIso(existingRolledBackAt) },
    )
  }

  // §13.2 unified lock order: read (not lock) every group id this batch touched — from EITHER
  // detail table, a group could appear in `..._batch_groups` only (attach path, no links if the
  // category had zero eligible templates — not reachable from execute today, but this query does
  // not assume otherwise) or in `..._batch_links` only were that ever possible — then pre-lock all
  // of them in ONE deterministic-order statement before any L2 write below.
  const targetGroupIdsResult = await client.query(
    `SELECT group_id FROM approval_template_group_backfill_batch_links WHERE batch_id = $1 AND org_id = $2
     UNION
     SELECT group_id FROM approval_template_group_backfill_batch_groups WHERE batch_id = $1 AND org_id = $2`,
    [batchId, orgId],
  )
  const targetGroupIds = (targetGroupIdsResult.rows as Array<{ group_id: string }>).map((row) => row.group_id)

  const archivedAtByGroupId = new Map<string, string | Date | null>()
  if (targetGroupIds.length > 0) {
    const lockedResult = await client.query(
      `SELECT id, archived_at FROM approval_template_groups WHERE org_id = $1 AND id = ANY($2) ORDER BY id FOR UPDATE`,
      [orgId, targetGroupIds],
    )
    for (const row of lockedResult.rows as Array<{ id: string; archived_at: string | Date | null }>) {
      archivedAtByGroupId.set(row.id, row.archived_at)
    }
  }

  // §4.2 landed SQL (§13 changesRequired #2): set-based server-side join, the optimistic-
  // concurrency token compared entirely inside Postgres — `linked_at` never round-trips through
  // JS on either the write side (execute, already fixed) or here on the compare side. A batch-link
  // row whose `(group_id, linked_at)` no longer BOTH match the live `approval_template_group_links`
  // row has been touched by something else since `execute` ran and is left exactly as that other
  // action left it.
  await client.query(
    `UPDATE approval_template_group_links l
        SET group_id = NULL, unlinked_at = now()
       FROM approval_template_group_backfill_batch_links b
      WHERE b.batch_id = $1 AND b.org_id = l.org_id AND b.template_id = l.template_id
        AND l.group_id = b.group_id AND l.linked_at = b.linked_at`,
    [batchId],
  )

  // §4.3: `remaining` is computed AFTER the §4.2 unlink above (so this batch's own now-undone
  // members never count toward it), for every group this batch marked `created_new = true` only.
  const batchGroupsResult = await client.query(
    `SELECT group_id, created_new FROM approval_template_group_backfill_batch_groups WHERE batch_id = $1 AND org_id = $2`,
    [batchId, orgId],
  )
  for (const row of batchGroupsResult.rows as Array<{ group_id: string; created_new: boolean }>) {
    if (!row.created_new) continue // attached to an already-existing group — never rollback's to archive (§4.3)
    if (!archivedAtByGroupId.has(row.group_id)) continue // no longer exists (impossible today — groups are never hard-deleted — kept fail-safe) — skip, not an error
    if (archivedAtByGroupId.get(row.group_id) !== null) continue // already archived (e.g. by a manual archive after execute) — skip, not an error
    const remaining = await client.query(
      `SELECT count(*)::text AS n FROM approval_template_group_links WHERE org_id = $1 AND group_id = $2 AND unlinked_at IS NULL`,
      [orgId, row.group_id],
    )
    if (Number((remaining.rows[0] as { n: string }).n) === 0) {
      // The SAME two statements `archiveApprovalTemplateGroupWithClient` issues, reused as
      // exported SQL text (§4.1) — NOT a second `FOR UPDATE` (already held by the pre-lock step
      // above; see this function's file-header note for the M3 deadlock a re-lock here would
      // reintroduce).
      await client.query(ATG_UNLINK_ALL_GROUP_MEMBERS_SQL, [orgId, row.group_id])
      await client.query(ATG_ARCHIVE_GROUP_ROW_SQL, [orgId, row.group_id])
    }
    // ELSE: remaining > 0 — a batch-external action added a member to this batch-created group
    // after `execute` ran. Left active, untouched — this is the batch-external-state guarantee
    // §4/§9 name, not a partial failure.
  }

  const rolledBack = await client.query(
    `UPDATE approval_template_group_backfill_batches SET rolled_back_at = now() WHERE id = $1 AND org_id = $2 RETURNING rolled_back_at`,
    [batchId, orgId],
  )
  return { rolledBackAt: toIso((rolledBack.rows[0] as { rolled_back_at: string | Date }).rolled_back_at) }
}

/**
 * Thin wrapper — opens the ONE `transaction(...)` call this composed operation runs on, the same
 * convention as every other composed operation in this file (§3.0 file-header note).
 */
export async function rollbackApprovalTemplateGroupBackfillBatch(
  orgId: string,
  batchId: string,
): Promise<ApprovalTemplateGroupBackfillRollbackResult> {
  try {
    return await transaction(async (client) => {
      const txClient = await beginApprovalTemplateGroupTxn(client)
      return rollbackApprovalTemplateGroupBackfillWithClient(txClient, orgId, batchId)
    })
  } catch (error) {
    throw mapGroupConstraintError(error)
  }
}

// ── A-3 backfill — batch list (design-gate A3-phase2, P1-5 / changesRequired #5, 2026-09-18) ────
// `docs/development/approval-template-groups-phase2-design-20260918.md` §2.1 index / §6.1 endpoint
// row / §13.1 changesRequired #5 (real-DB M-series gate report, `reviews/design-gate-A3-phase2-
// 20260918.md`): a `batchId` appears in exactly one other place today — execute's own response —
// so an operator whose execute request timed out, or who simply wants to audit what has already
// been rolled back, had no way to discover a `batchId` to pass to rollback at all. That is an
// already-shipped reachability gap, not a missing test: §2.1's own comment concedes the batch head
// table carries no "in progress" state column because a request that dies mid-flight is supposed
// to be resolved by "list the batches and see", and this function is that list.
//
// Read-only, no lock (§2 锁序表: "只读路径不取 L0") — same convention as `listApprovalTemplateGroups`
// above. Lives here, not `routes.ts`, for the SAME reason rollback does (this file's W9 section
// header): a batch's own bookkeeping is fixed at `execute` time and carries no dependency on the
// caller's current `ApprovalTemplateVisibilityActor` / `applyTemplateVisibilityFilter` scope, so
// none of the reasons preview/execute were pushed out to `routes.ts` apply here.

export interface ApprovalTemplateGroupBackfillBatchSummary {
  batchId: string
  createdBy: string
  createdAt: string
  rolledBackAt: string | null
}

export interface ApprovalTemplateGroupBackfillBatchListPage {
  batches: ApprovalTemplateGroupBackfillBatchSummary[]
  limit: number
  offset: number
  total: number
}

/**
 * `limit`/`offset` are the caller's already-clamped values (the route layer owns clamping, same
 * division of responsibility as every other paginated read in `routes.ts`) — this function trusts
 * them as-is rather than re-validating, the same convention `listApprovalRecordLinkOptions`'s
 * callers already use elsewhere in this router.
 *
 * `ORDER BY created_at DESC, id DESC` — the `..._backfill_batches_org_created_idx` index (§2.1)
 * covers `(org_id, created_at DESC)`; `id DESC` is a deterministic tiebreaker for the (currently
 * unreachable outside artificial clock skew, but not provably impossible) case of two batches in
 * the same org sharing a `created_at` timestamptz value, so pagination across two calls cannot
 * silently reorder or drop a row at a page boundary.
 */
export async function listApprovalTemplateGroupBackfillBatches(
  orgId: string,
  limit: number,
  offset: number,
): Promise<ApprovalTemplateGroupBackfillBatchListPage> {
  const countResult = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM approval_template_group_backfill_batches WHERE org_id = $1`,
    [orgId],
  )
  const total = Number((countResult.rows[0] as { n: string } | undefined)?.n ?? '0')

  const rowsResult = await query<{
    id: string
    created_by: string
    created_at: string | Date
    rolled_back_at: string | Date | null
  }>(
    `SELECT id, created_by, created_at, rolled_back_at
       FROM approval_template_group_backfill_batches
      WHERE org_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [orgId, limit, offset],
  )

  return {
    batches: rowsResult.rows.map((row) => ({
      batchId: row.id,
      createdBy: row.created_by,
      createdAt: toIso(row.created_at),
      rolledBackAt: toIsoOrNull(row.rolled_back_at),
    })),
    limit,
    offset,
    total,
  }
}
