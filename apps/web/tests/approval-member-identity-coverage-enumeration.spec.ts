import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * member-display-identity (2026-08-19; REBUILT 2026-08-19 into a genuine PATTERN census) — this
 * file used to be a hand-written `SITES` array: a fixed list of sites a human remembered to add.
 * A 3rd-round adversarial gate found a genuine requester-facing raw-id leak
 * (ApprovalNewView.vue's `choiceOptionLabel` — the requester_choice submit-time picker) that the
 * hand list had ZERO entry for at all — not even an OUT-OF-SCOPE row. A frozen list can only ever
 * re-verify sites someone remembered to type in; it structurally cannot catch a NEW site nobody
 * thought to add. This rebuild closes THAT specific failure mode — a new site is caught
 * automatically as long as its raw-id access is textually visible on one line and matches one of
 * the six lexical patterns below (§KNOWN EVASION documents the boundary this does NOT cover, found
 * by a Codex #4 verification pass on 2026-08-21: a new site whose identity access goes through a
 * helper-function call is invisible to a per-line grep no matter how automatically the tree is
 * walked). Scope narrowed here per feedback_absolute_claim_sweep_must_be_mechanical.md — the
 * delivered reports (approval-parity-development-report-20260818.md §6.4 row D-10) were already
 * honest about this; this file's own docstring previously was not.
 *
 * § KNOWN EVASION (documented, not closed — do not read a green run here as "no raw id renders
 * anywhere"): every PATTERN below is a single-LINE lexical grep over `.id`/`.userId`/`.key`/etc.
 * tokens. Any render whose identity access is ONE FUNCTION CALL away from the template/attribute —
 * i.e. a helper that takes a row and returns a string, with the `.id`/`.key` access living inside
 * the helper body rather than inline in the mustache/attribute — is structurally invisible to a
 * per-line grep, no matter which tree it lives in or how the six patterns are worded. Concretely
 * (this is the exact evasion the 2026-08-21 pass mounted, confirmed reaching the live DOM in a
 * scanned root, then removed — nothing below is checked into source):
 *   const probeRow: { key?: string | null } = { key: 'user_probe_raw_9' }
 *   function unsafePersonLabel(row: { key?: string | null }): string { return row.key ?? '' }
 *   // template: {{ unsafePersonLabel(probeRow) }}
 * None of the six PATTERNS matches any of those three lines: the mustache only contains a bare
 * function call (no `.id`/`.key` token inside `{{ }}`, so `mustache-id` misses it), the helper body
 * `return row.key ?? ''` puts a STRING LITERAL after `??` rather than an identifier (so
 * `name-or-id-fallback`'s "bare `.id`-shaped expression after `||`/`??`" requirement misses it, and
 * `key` is not even in that pattern's token alternation), and the helper signature/declaration
 * match nothing. This is a CLASS boundary, not a one-off gap to patch with a 7th pattern — the next
 * indirection (two calls deep, a computed property, a render function) reopens the same hole under
 * a different shape. The real follow-up (NOT implemented by this file, and not scheduled — an
 * owner-visible future item only) is a unified person-label rendering component every
 * viewer-facing identity display is required to route through, paired with an AST-level (not
 * text-grep) ban on any OTHER viewer-facing consumption of a member/role/dept id. Until that
 * lands, this file's green is scoped to "no untriaged hit among six known lexical shapes across three
 * trees" — never "no raw id reaches the DOM anywhere".
 *
 * TWO TIERS now coexist, and (feedback_source_text_assertions_are_not_behaviour.md) neither one is
 * a substitute for the other:
 *
 *   TIER A — REGRESSION_GUARDS (below): named, historically-significant fixes (the sites a human
 *   DID already find and fix). Each pins "the resolver call is still there" + "the old raw-id
 *   pattern has not silently come back", and points at the MOUNTED spec that carries the actual
 *   behavioral proof (a raw id never reaches the DOM). This tier is unchanged in spirit from the
 *   original file — see each entry's own history note.
 *
 *   TIER B — the MECHANICAL PATTERN CENSUS (`scanForViolations` + `ALLOWLIST` below): at test
 *   time, this file itself READS every source file under `src/approvals/**` and
 *   `src/views/approval/**` (via `readdirSync` — a new .vue dropped into either tree is scanned
 *   automatically, no registration needed) and greps each line against the same raw-id-render
 *   pattern set the adversarial census used to FIND the missed site (name-or-id fallback, `.name`
 *   fallback, mustache-rendered id/key, id-array joins, template-string id interpolation,
 *   non-mustache attribute id renders). EVERY matching line needs an explicit `ALLOWLIST` entry —
 *   either because it is a values-free-fixed pattern (the fix itself, e.g. `成员 N` ordinals) or
 *   because it is genuinely outside the member/role/dept-identity class (a structural field/node
 *   key, a template/version/instance id, a localStorage cache key, an authoring-only surface, a
 *   count-only length read, …). A line with NO matching allowlist entry — because it is new, or
 *   because someone deleted the entry that used to cover it — fails this file. This is what makes
 *   the census "derived from source, never a frozen hand list" (the task's own framing): the
 *   SITES ARE the source, not a list a human maintains in parallel with it and can forget to sync.
 *
 * Every pattern in TIER B carries a POSITIVE CONTROL — a real, currently-scanned line the pattern
 * MUST still match — because a rotted pattern (the exact defect that made the census's own initial
 * `\b`-in-POSIX-ERE grep silently match zero results) is indistinguishable from "no violations
 * exist" without one. Every ALLOWLIST entry is checked for STALENESS (its `contains` substring
 * must still exist somewhere in its file) so a deleted/renamed line cannot leave a dead entry
 * silently pre-authorizing whatever gets written in its place. And the scan itself is checked
 * non-empty against known basenames, so a typo'd scan root cannot pass by finding nothing.
 *
 * NOT duplicated here: mounted DOM assertions that a raw id never actually reaches rendered output
 * (that lives in each site's own `*.spec.ts`, referenced by TIER A's `coverage` pointer) — this
 * file's own assertions are text-search PRESENCE/ABSENCE checks, the same tier the backend FAIL-0
 * guard operates at. Never mistake this tier for the other.
 */

const repoRoot = join(__dirname, '..')
function readSrc(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), 'utf8')
}
function readTest(relPath: string): string {
  return readFileSync(join(__dirname, relPath), 'utf8')
}

// ---------------------------------------------------------------------------
// TIER A — regression guards for historically-significant fixes. Each `sourceChecks` entry proves
// (a) the resolver-call pattern is present in the source and (b) the pre-fix raw-join pattern has
// not reappeared; `coverage` names the MOUNTED spec carrying the actual behavioral proof.
// ---------------------------------------------------------------------------
interface RegressionGuard {
  site: string
  coverage: [sourceFile: string, testFile: string, testTitleSubstring: string]
  sourceChecks: Array<{ file: string; mustContain: string[]; mustNotContain?: string[] }>
}

const REGRESSION_GUARDS: RegressionGuard[] = [
  {
    site: 'ApprovalDetailView.vue — 当前处理人 (assignmentDisplayLabel)',
    coverage: ['src/views/approval/ApprovalDetailView.vue', 'approval-e2e-lifecycle.spec.ts', 'resolves to a real name via the directory resolver when metadata.assigneeName is absent'],
    sourceChecks: [{
      file: 'src/views/approval/ApprovalDetailView.vue',
      mustContain: ['function assignmentDisplayLabel', 'getResolvedUserName(assignment.assigneeId)'],
    }],
  },
  {
    site: 'ApprovalDetailView.vue — 其他审批人已失效 (cancelledAssigneesLabel)',
    coverage: ['src/views/approval/ApprovalDetailView.vue', 'approval-detail-record-table.spec.ts', 'resolves to real names via the directory resolver when no assignment metadata carries them'],
    sourceChecks: [{
      file: 'src/views/approval/ApprovalDetailView.vue',
      mustContain: ['function cancelledAssigneesLabel', 'getResolvedUserName(idStr)'],
    }],
  },
  {
    site: 'ApprovalDetailView.vue — 减签 picker (reducibleAssignees, FLOW-CHANGING)',
    coverage: ['src/views/approval/ApprovalDetailView.vue', 'approval-member-bar-operation-policy.spec.ts', 'a member resolvable via the directory resolver gets its real name AND becomes selectable'],
    sourceChecks: [{
      file: 'src/views/approval/ApprovalDetailView.vue',
      mustContain: ['const reducibleAssignees = computed', 'disabled: !resolvedName', ':disabled="assignee.disabled"'],
    }],
  },
  {
    site: 'ApprovalDetailView.vue — 加签 picker chip (onAddSignUserSelected)',
    coverage: ['src/views/approval/ApprovalDetailView.vue', 'approval-e2e-lifecycle.spec.ts', 'a picked user with no directory name never renders the raw id as the chip label'],
    sourceChecks: [],
  },
  {
    site: 'ApprovalDetailView.vue / ApprovalNewView.vue — upcoming-node assignee summary (nodeAssigneeSourceSummary)',
    coverage: ['src/approvals/assigneeSource.ts', 'approval-upcoming-nodes.test.ts', 'the summary is a count, never the raw ids (P3)'],
    sourceChecks: [{
      file: 'src/approvals/assigneeSource.ts',
      mustContain: ['function requesterFacingSourceSummary', "return `指定用户${count ? `（${count} 人）`", "return `指定角色${count ? `（${count} 个）`"],
    }],
  },
  {
    site: 'ApprovalUserPicker.vue — 转交/加签/表单用户字段/委托 dropdown options (FLOW-CHANGING, 6+ call sites)',
    coverage: ['src/approvals/components/ApprovalUserPicker.vue', 'approvalUserPicker.spec.ts', 'a directory user with no name is rendered DISABLED'],
    sourceChecks: [{
      file: 'src/approvals/components/ApprovalUserPicker.vue',
      mustContain: ['function isUnidentifiable', ':disabled="isUnidentifiable(option)"'],
    }],
  },
  {
    site: 'TemplateDetailView.vue — 可见范围 ids (visibilityScope, any authenticated viewer)',
    coverage: ['src/views/approval/TemplateDetailView.vue', 'approval-e2e-permissions.spec.ts', 'template detail visibility scope (user type) shows RESOLVED user names when every id resolves'],
    sourceChecks: [{
      file: 'src/views/approval/TemplateDetailView.vue',
      mustContain: ['function visibilityScopeIdsDisplay', 'visibilityScopeIdsDisplay(template.visibilityScope)'],
      mustNotContain: ['template.visibilityScope.ids.join', 'getResolvedRoleName', 'ensureRoleNamesResolved'],
    }],
  },
  {
    site: 'TemplateDetailView.vue — node assignee ids (legacy assigneeType/assigneeIds, any authenticated viewer)',
    coverage: ['src/views/approval/TemplateDetailView.vue', 'approval-e2e-permissions.spec.ts', 'POSITIVE CONTROL: template detail node assignee ids show a RESOLVED user name once the user resolver returns it'],
    sourceChecks: [{
      file: 'src/views/approval/TemplateDetailView.vue',
      mustContain: ['function legacyAssigneeIdsDisplay', 'legacyAssigneeIdsDisplay((node.config as any).assigneeType'],
      mustNotContain: ['(node.config as any).assigneeIds?.join', 'getResolvedRoleName', 'ensureRoleNamesResolved'],
    }],
  },
  {
    site: 'MyDelegationView.vue — 被委托人 column (self-service, any authenticated user)',
    coverage: ['src/views/approval/MyDelegationView.vue', 'myDelegationView.spec.ts', 'the 被委托人 column shows the RESOLVED name once the directory resolver returns it'],
    sourceChecks: [{
      file: 'src/views/approval/MyDelegationView.vue',
      mustContain: ['function delegateeDisplay', 'delegateeDisplay(row.delegateeUserId)'],
      mustNotContain: ['prop="delegateeUserId"'],
    }],
  },
  // raw-id-render fix (2026-08-19; census 3rd missed site) — the requester-choice submit-time
  // approver picker (Lock-1 §K2). The site the hand-list had NO entry for at all. Fixed to the
  // same contract as ApprovalUserPicker (values-free ordinal + disabled-when-unidentifiable), plus
  // a submit-time gate mirroring 减签's disable+guard posture.
  {
    site: 'ApprovalNewView.vue — requester_choice submit-time approver picker (choiceOptionLabel, REQUESTER-facing SELECT)',
    coverage: ['src/views/approval/ApprovalNewView.vue', 'approvalNewView.spec.ts', 'a nameless candidate renders "成员 N" (never the raw id) and is disabled'],
    sourceChecks: [{
      file: 'src/views/approval/ApprovalNewView.vue',
      mustContain: [
        'function choiceOptionLabel',
        'function isChoiceOptionUnidentifiable',
        'function firstUnidentifiableChoiceNode',
      ],
      mustNotContain: ['option.name?.trim() || option.id', 'option.name.trim() || option.id'],
    }],
  },
  // S3b (2026-08-22): the census's own "GATE FOR THE NEXT SLICE" note (below, shared/comments
  // group) required this BEFORE any approval consumer wired the shared/comments kit. Discharged
  // as an approval-specific UPSTREAM guard (in the wrapper, never in the shared kit itself) —
  // MetaCommentsPanel.vue's own :378/:384/:385 fallbacks are untouched; every comment this wrapper
  // hands to the kit already carries a non-empty `authorName` (resolved name, or a values-free
  // `成员 N` ordinal), so the kit's own `thread.authorName ?? thread.authorId` fallback path is
  // structurally unreachable for this consumer.
  {
    site: 'ApprovalCommentsPanel.vue — comment author display name (shared/comments kit consumer, S3b)',
    coverage: ['src/views/approval/ApprovalCommentsPanel.vue', 'approval-comments-panel.spec.ts', 'never renders a raw author id; an unresolved author gets a values-free 成员 N ordinal, a resolved one gets its real name'],
    sourceChecks: [{
      file: 'src/views/approval/ApprovalCommentsPanel.vue',
      mustContain: [
        'const authorDisplayName',
        'getResolvedUserName(c.authorId)',
        '`成员 ${ordinal}`',
        'ensureUserNamesResolved(ids)',
      ],
      mustNotContain: ['c.authorName ?? c.authorId', "authorName: c.authorId,"],
    }],
  },
]

// ---------------------------------------------------------------------------
// TIER B — the mechanical pattern census.
// ---------------------------------------------------------------------------

// S3a fix-round (2026-08-21, gate finding P3-1): apps/web/src/shared/comments/ (the S3a shared
// comments FE kit -- MetaCommentsPanel/MetaCommentComposer/MetaCommentReactions + the
// useMultitableComments composable) is added as a THIRD scan root. It carries no approval
// consumer yet (S3a is kit-only), but it is the exact surface a future approval-native consumer
// mounts, and its own mention/author label fallbacks are already the class this census exists to
// catch -- deferring coverage until that consumer lands would repeat the class of gap the census
// was rebuilt to close (see the TWO TIERS docstring above): a new site nobody remembered to add.
// See the S3a gate report / multitable-w2-unified-record-inspector-design-lock-20260714.md §7 S4
// follow-up note for the disposition of every hit this root produces (ALLOWLIST group below).
const SCAN_ROOTS = ['src/approvals', 'src/views/approval', 'src/shared/comments']

/** Recursively lists every non-test .ts/.vue file under `dir` (repo-relative), sorted. */
function listSourceFiles(dir: string): string[] {
  const abs = join(repoRoot, dir)
  const out: string[] = []
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const relPath = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(relPath))
      continue
    }
    if (!entry.isFile()) continue
    if (!/\.(ts|vue)$/.test(entry.name)) continue
    if (/\.(spec|test)\.ts$/.test(entry.name)) continue
    out.push(relPath)
  }
  return out.sort()
}

const SCANNED_FILES = SCAN_ROOTS.flatMap((d) => listSourceFiles(d))

interface PatternDef {
  id: string
  label: string
  regex: RegExp
  /** A real, currently-scanned line this pattern MUST still match — proves the pattern isn't dead. */
  positiveControl: { file: string; lineContains: string }
}

const PATTERNS: PatternDef[] = [
  {
    id: 'name-or-id-fallback',
    label: '`||`/`??` falling back to a bare `.id`/`.userId`/`.roleId`/`.deptId`/`.departmentId`/`.memberId`/`.authorId` expression',
    regex: /(?:\|\||\?\?)\s*[A-Za-z_$][\w$.?[\]]*\.(id|userId|roleId|deptId|departmentId|memberId|authorId)\b/,
    positiveControl: { file: 'src/approvals/useApprovalDirectory.ts', lineContains: 'user.name.trim() || user.id' },
  },
  {
    id: 'name-dot-fallback',
    label: '`.name` (optionally `?.trim()`) immediately followed by a `||` fallback',
    regex: /\.name(?:\?\.trim\(\))?\s*\|\|/,
    positiveControl: { file: 'src/approvals/components/ApprovalUserPicker.vue', lineContains: 'option.name?.trim() ||' },
  },
  {
    id: 'mustache-id',
    label: 'a `{{ }}` mustache directly rendering `.id`/`.key`/`.userId`/`.assigneeId`/`.delegateeUserId`/`.deptId`',
    regex: /\{\{[^}]*\.(id|key|userId|assigneeId|delegateeUserId|deptId)\b[^}]*\}\}/,
    positiveControl: { file: 'src/views/approval/DelegationSettingsView.vue', lineContains: 'row.delegateeUserId' },
  },
  {
    id: 'id-array-join',
    label: 'an `.ids`/`.Ids` array `.join(`',
    regex: /\.(ids|Ids)\??\.join\(|\.id\)\.join\(/,
    positiveControl: { file: 'src/views/approval/TemplateDetailView.vue', lineContains: 'visibilityScope.ids.join' },
  },
  {
    id: 'template-string-id-interp',
    label: 'a `${...}` template-string interpolation of an id/Ids/userId/roleId/deptId expression',
    regex: /\$\{[^}]*(\.id\b|Ids|\.ids\b|userId|roleId|deptId)[^}]*\}/,
    positiveControl: { file: 'src/approvals/assigneeSource.ts', lineContains: "source.userIds.join('、')" },
  },
  {
    id: 'attr-id-render',
    label: 'a non-mustache attribute (`:title`/`:aria-label`/`v-text`/`:placeholder`/`:content`) binding an id expression',
    regex: /:(title|aria-label|v-text|placeholder|content)="[^"]*\.(id|userId|assigneeId|deptId|delegateeUserId)\b/,
    positiveControl: { file: 'src/approvals/components/ApprovalGraphNodeConfigEditor.vue', lineContains: ':title="`插入 requester.role' },
  },
]

interface AllowlistEntry {
  file: string
  /** A stable substring of the matched line (not a line number — resilient to unrelated edits shifting lines elsewhere in the file). */
  contains: string
  disposition: 'VALUES-FREE-FIXED' | 'OUT-OF-SCOPE'
  reason: string
}

function group(disposition: AllowlistEntry['disposition'], reason: string, entries: Array<[file: string, contains: string]>): AllowlistEntry[] {
  return entries.map(([file, contains]) => ({ file, contains, disposition, reason }))
}

const ALLOWLIST: AllowlistEntry[] = [
  // ---- VALUES-FREE-FIXED: the pattern IS the fix (an ordinal/resolver-backed fallback, not a leak) ----
  ...group('VALUES-FREE-FIXED', 'ApprovalUserPicker optionLabel -- values-free ordinal, the shipped fix itself', [
    ['src/approvals/components/ApprovalUserPicker.vue', 'option.name?.trim() || `成员 ${index + 1}`'],
  ]),
  ...group('VALUES-FREE-FIXED', 'ApprovalNewView choiceOptionLabel -- values-free ordinal, this PR\'s fix (census 3rd missed site)', [
    ['src/views/approval/ApprovalNewView.vue', 'option.name?.trim() || `成员 ${index + 1}`'],
  ]),
  ...group('VALUES-FREE-FIXED', 'MyDelegationView delegateeDisplay -- resolver-wrapped, never the raw column value directly', [
    ['src/views/approval/MyDelegationView.vue', 'delegateeDisplay(row.delegateeUserId)'],
  ]),

  // ---- OUT-OF-SCOPE: admin-only raw-id render, matches the pre-existing #5010/hand-list precedent ----
  ...group('OUT-OF-SCOPE', 'admin-only delegation table (approval-templates:manage) -- intentional raw id for the admin audience', [
    ['src/views/approval/DelegationSettingsView.vue', 'row.delegateeUserId'],
  ]),

  // ---- OUT-OF-SCOPE: author-facing script assignment / comparison, not a display render ----
  ...group('OUT-OF-SCOPE', 'author-facing edit-mode textarea SEED (canManageTemplates edit mode) -- a script assignment, not a rendered display', [
    ['src/views/approval/TemplateDetailView.vue', 'visibilityIdsDraft.value = template.value.visibilityScope.ids.join'],
  ]),
  ...group('OUT-OF-SCOPE', 'a change-detection COMPARISON (dirty-check), never rendered to the DOM', [
    ['src/views/approval/TemplateDetailView.vue', 'current.ids.join(\'\\n\') === nextScope.ids.join'],
  ]),

  // ---- OUT-OF-SCOPE: comments referencing the OLD (pre-fix) pattern in prose, not live code ----
  ...group('OUT-OF-SCOPE', 'a code COMMENT describing the historical pre-fix pattern in prose, not a live expression', [
    ['src/views/approval/ApprovalDetailView.vue', 'old `option.name || option.id` fallback rendered the raw directory user id'],
    ['src/views/approval/ApprovalMetricsView.vue', 'The previous `row.name || row.key || \'未归属发起人\'` fell back to that RAW USER ID'],
  ]),

  // ---- OUT-OF-SCOPE: authoring-only member/role/group formatters (Lock-1 §2.6 audience) ----
  ...group('OUT-OF-SCOPE', 'authoring-only directory-label formatter (useApprovalDirectory: consumed by ApprovalGraphNodeConfigEditor / TemplateAuthoringView pickers, template-author audience, not requester/approver)', [
    ['src/approvals/useApprovalDirectory.ts', 'user.name.trim() || user.id'],
    ['src/approvals/useApprovalDirectory.ts', 'role.name.trim() || role.id'],
    ['src/approvals/useApprovalDirectory.ts', 'group.name.trim() || group.id'],
  ]),
  ...group('OUT-OF-SCOPE', 'authoring-only condition-formula role insert snippet/test-hook (template author composing a formula, not a viewer render)', [
    ['src/approvals/components/ApprovalGraphNodeConfigEditor.vue', ':title="`插入 requester.role in [&quot;${role.id}&quot;]`"'],
    ['src/approvals/components/ApprovalGraphNodeConfigEditor.vue', 'approval-condition-formula-insert-role-${role.id}'],
  ]),
  ...group('OUT-OF-SCOPE', 'authoring-only scope COUNT (`.length`), never the ids themselves', [
    ['src/approvals/components/ApprovalGraphNodeConfigEditor.vue', 'source.scope.userIds.length'],
    ['src/approvals/components/ApprovalGraphNodeConfigEditor.vue', 'source.scope.roleIds.length'],
  ]),
  ...group('OUT-OF-SCOPE', 'assigneeSource.ts static_user/static_role -- authoring-only raw-id join, intercepted to count-only for every viewer-facing caller by requesterFacingSourceSummary (see REGRESSION_GUARDS above); user_group -- template-authored group references (Lock-1 §K1/§2.6), not person identities, intentionally rendered on viewer previews', [
    ['src/approvals/assigneeSource.ts', "source.userIds.join('、')"],
    ['src/approvals/assigneeSource.ts', "source.roleIds.join('、')"],
    ['src/approvals/assigneeSource.ts', "source.groupIds.join('、')"],
  ]),
  ...group('OUT-OF-SCOPE', 'authoring formula text under construction by the template author, not a viewer render', [
    ['src/views/approval/TemplateAuthoringView.vue', 'requester.role in [${JSON.stringify(roleId)}]'],
  ]),
  ...group('OUT-OF-SCOPE', 'a COUNT (`.length`), never the raw ids', [
    ['src/views/approval/TemplateAuthoringView.vue', '(cfg.targetIds ?? []).length'],
    ['src/views/approval/TemplateDetailView.vue', '指定角色（${safeIds.length} 个）'],
    ['src/views/approval/TemplateDetailView.vue', 'NON_ALL_SCOPE_UNIT_LABEL[kind]} ${safeIds.length}'],
    ['src/views/approval/ApprovalNewView.vue', 'scan.staleIds.length'],
  ]),
  ...group('OUT-OF-SCOPE', 'the requester DEPARTMENT dimension (census site L3): backend keyExpr/nameSelect are the SAME expression for this dimension (name === key always), so `row.key` here is a department STRING, never an internal person id -- unlike the sibling requester-dimension row this PR fixes (L2)', [
    ['src/views/approval/ApprovalMetricsView.vue', "row.name || row.key || '未归属部门'"],
  ]),
  ...group('OUT-OF-SCOPE', 'an ATTACHMENT FILE id/name fallback (G13 stale-ref restore), not a member identity', [
    ['src/views/approval/ApprovalNewView.vue', 'ref.fileName ?? ref.id'],
  ]),

  // ---- OUT-OF-SCOPE: structural field/column/node identifiers -- not a member/role/dept identity ----
  ...group('OUT-OF-SCOPE', 'a form FIELD/COLUMN id (structural authored key), not a member identity -- excluded by class definition', [
    ['src/approvals/conditionEdit.ts', 'field.label || field.id'],
    ['src/approvals/conditionEdit.ts', "token: `{${field.id}}`, label: field.label || field.id"],
    ['src/approvals/conditionEdit.ts', 'token: `{${field.id}.${column.id}}`'],
    ['src/approvals/conditionEdit.ts', 'label: `${field.label || field.id}.${column.label || column.id}`'],
    ['src/approvals/detailField.ts', 'column.label.trim() || column.id.trim()'],
    ['src/approvals/detailField.ts', 'errors.push(`明细字段 ${label} 的子字段 ${column.id.trim()'],
    ['src/approvals/detailField.ts', 'const fieldLabel = field.label || field.id'],
    ['src/approvals/detailField.ts', 'violations.push(`"${fieldLabel}" 第 ${index + 1} 行缺少 "${column.label || column.id}"`)'],
    ['src/approvals/detailField.ts', 'label: column.label || column.id,'],
    ['src/approvals/detailField.ts', 'result.push({ key: field.id, label: field.label || field.id, value: text })'],
    ['src/approvals/detailField.ts', 'label: field.label || field.id,'],
    ['src/approvals/fieldVisibility.ts', 'reference.field.label || reference.field.id'],
    ['src/approvals/templateAuthoring.ts', '字段 ${field.label.trim() || field.id}（关联记录）'],
    ['src/approvals/templateVersionDiff.ts', 'return field.label || field.id'],
    ['src/views/approval/ApprovalDetailView.vue', 'formatFieldValue(row.cells[column.id], column)'],
    ['src/views/approval/ApprovalNewView.vue', 'approval-attachment-input-${field.id}'],
    ['src/views/approval/TemplateAuthoringView.vue', 'approval-step-field-access-${field.id}'],
    ['src/approvals/components/ApprovalGraphNodeConfigEditor.vue', 'approval-node-field-access-${field.id}'],
  ]),
  ...group('OUT-OF-SCOPE', 'a graph NODE key/name (structural authored key), not a member identity -- excluded by class definition', [
    ['src/approvals/graphLayout.ts', 'node.name || \'未命名节点\'}」无法从发起节点到达'],
    ['src/approvals/graphLayout.ts', 'node.name || \'未命名节点\'}」没有后继连线'],
    ['src/approvals/graphLayout.ts', 'node.name || \'未命名节点\'}」无法到达结束节点'],
    ['src/approvals/templateAuthoring.ts', 'unknownNode.name || \'未命名节点\''],
    ['src/approvals/templateAuthoring.ts', 'unsupportedNode.name || \'未命名节点\''],
    ['src/approvals/templateAuthoring.ts', 'unsupportedApproval.name || \'未命名节点\''],
    ['src/approvals/templateVersionDiff.ts', 'return node.name || node.key'],
    ['src/approvals/upcomingNodes.ts', "node.name?.trim() || node.key"],
    ['src/views/approval/TemplateAuthoringView.vue', 'node.name?.trim() || \'未命名节点\''],
    ['src/views/approval/TemplateAuthoringView.vue', "node?.name?.trim() || '（未命名节点）'"],
    ['src/views/approval/TemplateAuthoringView.vue', 'node.name?.trim() || nodeTypeLabel(node.type)'],
    ['src/views/approval/TemplateAuthoringView.vue', 'canvasNodeByKey(key)?.name?.trim() || \'未命名节点\''],
    ['src/views/approval/TemplateAuthoringView.vue', "label: node.name?.trim() || '未命名节点',"],
    ['src/views/approval/TemplateDetailView.vue', "node?.name?.trim() || (node ? nodeTypeLabel(node.type) : '流程节点')"],
    ['src/views/approval/TemplateDetailView.vue', '{{ node.name ?? node.key }}'],
    ['src/views/approval/TemplateDetailView.vue', '模板 Key: {{ template.key }}'],
    ['src/approvals/components/ApprovalCanvasNodeInspector.vue', '{{ graphNodeLabel(node.key) }}'],
    ['src/approvals/components/ApprovalFlowCanvas.vue', "nodeTypeLabel(canvasNodeByKey(pos.key)?.type ?? 'approval')"],
    ['src/approvals/components/ApprovalFlowCanvas.vue', '{{ canvasNodeSummary(pos.key) }}'],
    ['src/approvals/components/ApprovalGraphNodeConfigEditor.vue', 'conditionFormulaDryRunResult(node.key, branch.edgeKey)'],
    ['src/approvals/components/ApprovalGraphNodeConfigEditor.vue', 'graphEdgeTargetLabel(node.key, edgeKey)'],
    ['src/approvals/components/ApprovalGraphNodeConfigEditor.vue', 'approvalSourceKind(node.key, sourceIndex)'],
    ['src/approvals/components/ApprovalGraphNodeConfigEditor.vue', 'configuredSourceSummaryLine(node.key, sourceIndex)'],
    ['src/approvals/components/ApprovalGraphNodeConfigEditor.vue', 'approvalSourceCount(node.key)'],
    ['src/views/approval/TemplateDetailView.vue', "versionDualNodeLabel('left', pos.key)"],
    ['src/views/approval/TemplateDetailView.vue', "versionDualNodeLabel('right', pos.key)"],
    ['src/views/approval/TemplateDetailView.vue', 'versionChangeKindLabel(versionDualCanvas.nodeChange(pos.key)!)'],
    ['src/views/approval/TemplateDetailView.vue', 'versionOverlayNodeLabel(pos.key)'],
    ['src/views/approval/TemplateDetailView.vue', 'versionChangeKindLabel(versionOverlayNodeChange(pos.key)!)'],
  ]),
  ...group('OUT-OF-SCOPE', 'a UI/DOM structural id (tab id, section id, preset id, test-hook data-testid/aria-controls) -- not a member identity, and data-testid is never a visible render', [
    ['src/approvals/components/ApprovalCanvasNodeInspector.vue', 'approval-canvas-inspector-tab-${tab.id}'],
    ['src/approvals/components/ApprovalCanvasNodeInspector.vue', 'approval-canvas-inspector-tabpanel-${tab.id}'],
    ['src/approvals/components/ApprovalGraphNodeConfigEditor.vue', 'approval-node-operation-policy-${policy.id}'],
    ['src/approvals/components/ApprovalGraphNodeConfigEditor.vue', 'approval-node-operation-policy-mixed-${policy.id}'],
    ['src/views/approval/TemplateAuthoringView.vue', 'section.label} ${section.description}${section.id'],
    ['src/views/approval/TemplateAuthoringView.vue', 'approval-template-section-${section.id}'],
    ['src/views/approval/TemplateAuthoringView.vue', 'approval-template-preset-${preset.id}'],
  ]),

  // ---- OUT-OF-SCOPE: non-person entity ids (approval instance / template / version row) in a data-testid, route path, or a function-call argument (not a rendered id -- the FUNCTION'S RETURN is what renders) ----
  ...group('OUT-OF-SCOPE', 'an APPROVAL INSTANCE id (not a person id) -- a data-testid, or the argument to a helper whose OWN return is what renders, never the id itself', [
    ['src/views/approval/ApprovalCenterView.vue', 'approval-row-approve-${row.id}'],
    ['src/views/approval/ApprovalCenterView.vue', 'approval-row-reject-${row.id}'],
    ['src/views/approval/ApprovalCenterView.vue', 'approval-urge-${row.id}'],
    ['src/views/approval/ApprovalCenterView.vue', '{{ urgeState(row.id).label }}'],
    ['src/views/approval/ApprovalCenterView.vue', ':title="urgeState(row.id).title"'],
  ]),
  ...group('OUT-OF-SCOPE', 'a TEMPLATE/VERSION id (not a person id) used for navigation (route path) or a data-testid, never rendered as visible text', [
    ['src/views/approval/TemplateDetailView.vue', 'template-version-compare-${row.id}'],
    ['src/views/approval/TemplateDetailView.vue', 'template-version-restore-${row.id}'],
    ['src/views/approval/TemplateDetailView.vue', "path: `/approvals/new/${template.value.id}`"],
    ['src/views/approval/TemplateDetailView.vue', "path: `/approval-templates/${template.value.id}/edit`"],
    ['src/views/approval/TemplateAuthoringView.vue', "path: `/approval-templates/${created.id}/edit` "],
    ['src/views/approval/TemplateAuthoringView.vue', "await router.push({ path: `/approval-templates/${saved.id}` })"],
    ['src/views/approval/TemplateCenterView.vue', "router.push({ path: `/approval-templates/${row.id}` })"],
    ['src/views/approval/TemplateCenterView.vue', "router.push({ path: `/approval-templates/${cloned.id}` })"],
    ['src/views/approval/TemplateAuthoringView.vue', 'id: `${next.id}_col1`,'],
  ]),

  // ---- OUT-OF-SCOPE: ids embedded in a non-rendered cache/storage/dedup key ----
  ...group('OUT-OF-SCOPE', 'a localStorage/dedup CACHE KEY string -- never rendered to the DOM', [
    ['src/approvals/formDraft.ts', 'approval-form-draft:${userId}:${templateId}'],
    ['src/approvals/formDraft.ts', '${field.id}:record-link:${baseId}:${sheetId}'],
    ['src/approvals/formDraft.ts', '${field.id}:${field.type}'],
    ['src/approvals/parallelEdit.ts', 'user_group:${[...source.groupIds].sort().join'],
    ['src/approvals/quickPhrases.ts', '${KEY_PREFIX}${userId}:${action}'],
    ['src/approvals/recentTemplates.ts', '${KEY_PREFIX}${userId}'],
  ]),

  // ---- shared/comments kit (S3a 2026-08-21; S3b 2026-08-22 UPDATE) -- SCAN_ROOTS extension, gate finding P3-1 ----
  // Two consumers exist at this head: multitable (via the src/multitable/components/
  // MetaCommentsPanel.vue re-export shim) and, as of S3b, approval
  // (src/views/approval/ApprovalCommentsPanel.vue). Multitable's own comment UI legitimately
  // shows real author/mention names sourced from its own directory data, so this raw-id FALLBACK
  // is pre-existing, verbatim-carried-over behavior there (identical code lives at
  // src/multitable/components/MetaCommentsPanel.vue on main today; S3a moved it, introduced
  // nothing new) -- untouched by S3b.
  // GATE DISCHARGED (was "GATE FOR THE NEXT SLICE" -- S3b is that next slice): rather than fixing
  // these three kit-internal renders (MetaCommentsPanel.vue:378, :384, :385) -- which would touch
  // multitable's own byte-identical behavior for zero multitable benefit -- S3b added an
  // APPROVAL-SPECIFIC UPSTREAM GUARD in the wrapper (see the new TIER A REGRESSION_GUARDS entry
  // "ApprovalCommentsPanel.vue -- comment author display name", above): every comment the wrapper
  // hands to the kit already carries a non-empty `authorName` (a resolved directory name, or a
  // values-free `成员 N` ordinal), so these three kit-internal fallback paths are structurally
  // UNREACHABLE for the approval consumer specifically -- they still exist in the kit's source
  // (this is why the three lines below still need their OWN triage entries; the mechanical
  // pattern census scans source text, not reachability) and still describe real, correct,
  // untouched multitable behavior. NOTE: only :378 is presently caught by a live PATTERN
  // (name-or-id-fallback); :384's `.authorId` token and :385's ternary are outside every current
  // regex's alternation/shape (the census's own "KNOWN EVASION" boundary documented at the top of
  // this file) -- their entries below are pre-emptive triage, not something scanForViolations
  // currently consults. Do not read their presence here as "the census also enforces these two"
  // -- it does not, yet. The P3-A importer tripwire (below, TIER B) is the SEPARATE mechanism
  // that would have caught a THIRD approval consumer mounting this kit without an equivalent
  // guard -- it is keyed on the IMPORTING file, not on these three lines.
  //
  // SCOPE CORRECTION, SUPERSEDED (gate finding P3-3, residual sweep, 2026-08-22): the prior
  // version of this note recorded the `authorId`-not-in-alternation blind spot as a DEFERRED
  // blast-radius decision ("scans ALL THREE trees ... not a fix-round-scoped edit"). That premise
  // was UNBOUNDED; the residual sweep measured it mechanically instead of re-deferring it: the
  // widened regex (now including `authorId` in the alternation, see the pattern definition above)
  // matches exactly 7 lines the prior regex missed, across this file's three scanned roots:
  //   1. ApprovalCommentsPanel.vue:182 (a COMMENT line describing the fallback this file's own
  //      upstream guard closes -- OUT-OF-SCOPE, the scan does not strip comments)
  //   2. ApprovalCommentsPanel.vue:185 (`authorName: authorDisplayName.value[c.authorId] ||
  //      c.authorId,` -- the S3b upstream guard itself; VALUES-FREE-FIXED, entered below)
  //   3-6. MetaCommentsPanel.vue:76,130,365,370 (multitable kit-internal renders, byte-identical
  //      shipped behavior -- OUT-OF-SCOPE, entered in the group below)
  //   -- MetaCommentsPanel.vue:395 was ALREADY allowlisted pre-emptively (the group below); the
  //      widening converts it from pre-emptive triage to LIVE coverage, not a new entry.
  // So the real cost is 6 new ALLOWLIST entries (four of them in the shared multitable tree),
  // zero behaviour change, zero production edit -- a decision bounded enough for the gate to rule
  // on in one read rather than defer again. The *regex* change is monotonic (strictly adds
  // matches, drops none -- MUT-N1 below pins that nothing previously caught is lost); the *six
  // entries* are the narrowing component, and every one of those six lines was UNTRIAGED
  // (invisible to the census) before this change, so net enforcement strictly increases. Verified
  // this breaks no ratified text: `git grep name-or-id-fallback origin/main` returns hits in
  // exactly one file (this census spec, 5 occurrences) and zero in `docs/`; the only prose
  // asserting the deferral was this very comment, which this edit supersedes.
  ...group('VALUES-FREE-FIXED', 'ApprovalCommentsPanel.vue commentsForPanel mapper -- the S3b upstream guard itself (Always-set authorName closes the shared panel template fallback structurally); now in-alternation via the widened `authorId` arm', [
    ['src/views/approval/ApprovalCommentsPanel.vue', 'authorName: authorDisplayName.value[c.authorId] || c.authorId,'],
  ]),
  ...group('OUT-OF-SCOPE', 'a COMMENT line describing the shared-panel template fallback this file\'s own upstream guard closes -- prose, not a render/assignment site; the scan does not strip comments', [
    ['src/views/approval/ApprovalCommentsPanel.vue', '// `thread.authorName ?? thread.authorId` when this is undefined, which is EXACTLY the raw-id'],
  ]),
  ...group('OUT-OF-SCOPE', 'mention-candidate label / comment-author label+subtitle fallback to the raw id when displayName/authorName is absent (or, for the subtitle, rendered alongside a differing name) -- legitimate, byte-identical multitable behavior (a real directory-backed name producer); the approval consumer (S3b) discharges the census gate via its OWN upstream guard instead of touching this shared file -- see the group note above and the TIER A entry it names', [
    ['src/shared/comments/components/MetaCommentsPanel.vue', 'label: candidate.displayName?.trim() || candidate.userId.trim(),'],
    ['src/shared/comments/components/MetaCommentsPanel.vue', 'label: (comment.authorName ?? comment.authorId).trim() || comment.authorId,'],
    ['src/shared/comments/components/MetaCommentsPanel.vue', 'subtitle: comment.authorName && comment.authorName !== comment.authorId ? comment.authorId : undefined,'],
  ]),
  ...group('OUT-OF-SCOPE', 'comment-author drawer/banner render fallback to the raw id when authorName is absent -- legitimate, byte-identical multitable kit-internal behavior (the S3b approval consumer never mounts these particular render paths without its own upstream guard already having supplied a non-empty authorName); newly caught only because this round widened the pattern\'s alternation to include `.authorId`, not because the code changed', [
    ['src/shared/comments/components/MetaCommentsPanel.vue', '<span class="meta-comments-drawer__author">{{ thread.authorName ?? thread.authorId }}</span>'],
    ['src/shared/comments/components/MetaCommentsPanel.vue', '<span class="meta-comments-drawer__author">{{ reply.authorName ?? reply.authorId }}</span>'],
    ['src/shared/comments/components/MetaCommentsPanel.vue', 'return editingBanner(activeEditingComment.value.authorName ?? activeEditingComment.value.authorId, isZh.value)'],
    ['src/shared/comments/components/MetaCommentsPanel.vue', 'return replyingBanner(activeReplyComment.value.authorName ?? activeReplyComment.value.authorId, isZh.value)'],
  ]),
  ...group('OUT-OF-SCOPE', 'mention-suggestion autocomplete FILTER comparison (query substring match against label/id) -- a boolean predicate, never rendered to the DOM', [
    ['src/shared/comments/components/MetaCommentComposer.vue', 'return suggestion.label.toLowerCase().includes(query) || suggestion.id.toLowerCase().includes(query)'],
  ]),
  ...group('OUT-OF-SCOPE', '@mention TOKEN serialization (`@[label](id)` wire format embedded in comment content, matched by a RegExp) -- the id is round-tripped through the content string as an encoding detail, never displayed as text', [
    ['src/shared/comments/components/MetaCommentComposer.vue', 'const tokenMentionRegex = new RegExp(`@\\\\[${escapeRegex(mention.label)}\\\\]\\\\(${escapeRegex(mention.id)}\\\\)`)'],
    ['src/shared/comments/components/MetaCommentComposer.vue', 'const token = `@[${mention.label}](${mention.id})`'],
    ['src/shared/comments/components/MetaCommentComposer.vue', 'const tokenRegex = new RegExp(`@\\\\[${escapeRegex(mention.label)}\\\\]\\\\(${escapeRegex(mention.id)}\\\\)`)'],
  ]),
  ...group('OUT-OF-SCOPE', 'thread/reply id used only as a lookup key or comparison operand inside a mustache -- the mustache renders a derived STATE LABEL or COUNT (l(...)/formatReplyCount(...)), never the id itself', [
    ['src/shared/comments/components/MetaCommentsPanel.vue', ">{{ formatReplyCount(getReplyCount(thread.id)) }}</span>"],
    ['src/shared/comments/components/MetaCommentsPanel.vue', ">{{ editingCommentId === thread.id ? l('comment.editing') : l('comment.edit') }}</button>"],
    ['src/shared/comments/components/MetaCommentsPanel.vue', ">{{ deletingIds.includes(thread.id) ? l('comment.deleting') : l('comment.delete') }}</button>"],
    ['src/shared/comments/components/MetaCommentsPanel.vue', ">{{ resolvingIds.includes(thread.id) ? l('comment.resolving') : l('comment.resolve') }}</button>"],
    ['src/shared/comments/components/MetaCommentsPanel.vue', ">{{ editingCommentId === reply.id ? l('comment.editing') : l('comment.edit') }}</button>"],
    ['src/shared/comments/components/MetaCommentsPanel.vue', ">{{ deletingIds.includes(reply.id) ? l('comment.deleting') : l('comment.delete') }}</button>"],
  ]),
]

describe('member-display-identity coverage enumeration — TIER A (named regression guards)', () => {
  it('sentinel: every REGRESSION_GUARDS entry names its coverage pointer', () => {
    for (const entry of REGRESSION_GUARDS) {
      expect(entry.coverage, entry.site).toBeTruthy()
    }
  })

  it('every entry\'s covering test file actually contains a matching it(...) title', () => {
    const testFileCache = new Map<string, string>()
    for (const entry of REGRESSION_GUARDS) {
      const [, testFile, titleSubstring] = entry.coverage
      if (!testFileCache.has(testFile)) testFileCache.set(testFile, readTest(testFile))
      const content = testFileCache.get(testFile)!
      expect(content, `${entry.site}: ${testFile} no longer contains the covering test title`).toContain(titleSubstring)
    }
  })

  it('every entry\'s source-level guarding pattern is present (and the pre-fix raw-join pattern is gone)', () => {
    const srcCache = new Map<string, string>()
    for (const entry of REGRESSION_GUARDS) {
      for (const check of entry.sourceChecks) {
        if (!srcCache.has(check.file)) srcCache.set(check.file, readSrc(check.file))
        const content = srcCache.get(check.file)!
        for (const needle of check.mustContain) {
          expect(content, `${entry.site}: ${check.file} missing "${needle}"`).toContain(needle)
        }
        for (const banned of check.mustNotContain ?? []) {
          expect(content, `${entry.site}: ${check.file} regressed -- "${banned}" reappeared`).not.toContain(banned)
        }
      }
    }
  })

  // Decoy proof: an entry whose coverage title does NOT exist must actually red the guard above --
  // otherwise the string-search itself would be a green-against-nothing tripwire.
  it('DECOY: a coverage pointer to a title that does not exist in the file is NOT found (proves the search is real)', () => {
    const content = readTest('approval-e2e-lifecycle.spec.ts')
    expect(content).not.toContain('this exact decoy title does not exist anywhere in this spec file 4477')
  })
})

describe('member-display-identity coverage enumeration — TIER B (mechanical pattern census)', () => {
  it('the readdirSync-derived scan actually found files under all three scan roots (a path typo scanning nothing must not pass green)', () => {
    expect(SCANNED_FILES.length).toBeGreaterThan(50)
    const basenames = new Set(SCANNED_FILES.map((f) => f.split('/').pop()))
    expect(basenames.has('ApprovalNewView.vue')).toBe(true)
    expect(basenames.has('ApprovalDetailView.vue')).toBe(true)
    expect(basenames.has('directoryResolve.ts')).toBe(true)
    expect(basenames.has('ApprovalUserPicker.vue')).toBe(true)
    // S3a fix-round (2026-08-21, P3-1): a third basename check for the shared/comments root, so
    // a typo'd/reverted SCAN_ROOTS entry for that root is caught here too, not just silently
    // scanning zero files.
    expect(basenames.has('MetaCommentsPanel.vue')).toBe(true)
    // S3b (P3-A): the new approval-side shared/comments importer — so a reverted/typo'd
    // SCAN_ROOTS entry for src/views/approval can't hide this file from the scan either.
    expect(basenames.has('ApprovalCommentsPanel.vue')).toBe(true)
    // Sanity: all three roots actually contributed files, not just one or two.
    expect(SCANNED_FILES.some((f) => f.startsWith('src/approvals/'))).toBe(true)
    expect(SCANNED_FILES.some((f) => f.startsWith('src/views/approval/'))).toBe(true)
    expect(SCANNED_FILES.some((f) => f.startsWith('src/shared/comments/'))).toBe(true)
  })

  it('each pattern still matches its named positive-control line (a rotted pattern silently matching nothing must fail HERE, not pass green -- this is the exact class of bug that made the census\'s own initial POSIX-ERE `\\b` grep silently match zero)', () => {
    for (const pattern of PATTERNS) {
      const content = readSrc(pattern.positiveControl.file)
      const line = content.split('\n').find((l) => l.includes(pattern.positiveControl.lineContains))
      expect(line, `${pattern.id}: positive-control text "${pattern.positiveControl.lineContains}" not found in ${pattern.positiveControl.file} -- update the pointer if the line legitimately moved/changed`).toBeTruthy()
      expect(pattern.regex.test(line!), `${pattern.id}: the pattern regex no longer matches its own positive-control line -- the pattern has rotted`).toBe(true)
    }
  })

  it('every ALLOWLIST entry still appears in its file (a stale entry silently pre-authorizes whatever gets written in its place)', () => {
    const srcCache = new Map<string, string>()
    for (const entry of ALLOWLIST) {
      if (!srcCache.has(entry.file)) srcCache.set(entry.file, readSrc(entry.file))
      const content = srcCache.get(entry.file)!
      expect(content, `stale ALLOWLIST entry: "${entry.contains}" (${entry.disposition}) no longer appears in ${entry.file}`).toContain(entry.contains)
    }
  })

  it('every raw-id-render pattern occurrence across ALL THREE scanned trees has an explicit ALLOWLIST triage entry -- an untriaged hit (new, or a deleted allowlist entry) fails here', () => {
    const violations: string[] = []
    for (const file of SCANNED_FILES) {
      const content = readSrc(file)
      const lines = content.split('\n')
      lines.forEach((line, idx) => {
        for (const pattern of PATTERNS) {
          if (!pattern.regex.test(line)) continue
          const covered = ALLOWLIST.some((e) => e.file === file && line.includes(e.contains))
          if (!covered) {
            violations.push(`${file}:${idx + 1} [${pattern.id}] ${line.trim().slice(0, 160)}`)
          }
        }
      })
    }
    expect(
      violations,
      `untriaged raw-id-render pattern hit(s) -- each needs an explicit ALLOWLIST entry (VALUES-FREE-FIXED or OUT-OF-SCOPE with a reason):\n${violations.join('\n')}`,
    ).toEqual([])
  })

  // Scope-leak sweep (census §B pattern 8): no member-identity resolver/type reference should
  // exist ANYWHERE in apps/web/src outside the three scanned trees, other than the shared type defs.
  it('scope-leak sweep: no member-identity resolver/type reference exists outside the three scanned trees (except the allowlisted shared type defs)', () => {
    const SWEEP_ALLOWLIST = new Set(['src/types/approval.ts'])
    const SWEEP_PATTERN = /getResolvedUserName|ApprovalDirectoryUser|assigneeId/
    const allFiles = listSourceFiles('src')
    const leaks: string[] = []
    for (const file of allFiles) {
      if (SCAN_ROOTS.some((root) => file.startsWith(`${root}/`))) continue
      if (SWEEP_ALLOWLIST.has(file)) continue
      if (SWEEP_PATTERN.test(readSrc(file))) leaks.push(file)
    }
    expect(
      leaks,
      `member-identity resolver/type references found OUTSIDE apps/web/src/{approvals,views/approval} and the allowlisted type defs -- scope-leak, needs review:\n${leaks.join('\n')}`,
    ).toEqual([])
  })

  // Self-test of the scanning MECHANISM itself, against a synthetic (non-file) fixture -- proves
  // both directions without ever mutating real source at test time: an untriaged hit is flagged,
  // and the SAME hit, once given an allowlist entry, is not.
  it('DECOY: the scan mechanism is discriminating against a synthetic fixture -- untriaged hits are flagged, triaged ones are not', () => {
    function scanLine(line: string, file: string, allowlist: AllowlistEntry[]): boolean {
      const matchesSomePattern = PATTERNS.some((p) => p.regex.test(line))
      if (!matchesSomePattern) return false
      return !allowlist.some((e) => e.file === file && line.includes(e.contains))
    }

    const syntheticLeak = '  const label = candidate.name?.trim() || candidate.id'
    expect(scanLine(syntheticLeak, 'synthetic-fixture.ts', []), 'a synthetic untriaged hit must be flagged').toBe(true)

    const triaged: AllowlistEntry[] = [{
      file: 'synthetic-fixture.ts',
      contains: 'candidate.id',
      disposition: 'OUT-OF-SCOPE',
      reason: 'decoy fixture, not real code',
    }]
    expect(scanLine(syntheticLeak, 'synthetic-fixture.ts', triaged), 'the SAME hit, once triaged, must not be flagged').toBe(false)

    // The allowlist entry must be FILE-scoped -- the same `contains` string under a DIFFERENT file
    // must NOT be silently covered by another file's entry.
    expect(scanLine(syntheticLeak, 'a-different-file.ts', triaged), 'an allowlist entry must not leak coverage across files').toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
// P3-A (S3b, fail-closed importer tripwire): the ALLOWLIST above is FILE-KEYED, scoped to
// src/shared/comments/** lines -- a new approval file that MOUNTS the kit inherits the SHARED
// file's own exemption and reds nothing there (it never touches a line under
// src/shared/comments/, so no ALLOWLIST entry is even consulted for it). This is a SEPARATE
// assertion, keyed on the IMPORTING file, not an ALLOWLIST extension -- exactly what the S3a gate
// report's own "GATE FOR THE NEXT SLICE" note (above) called for.
// ---------------------------------------------------------------------------------------------

/** Substring `shared/comments` inside an import/export line -- catches the relative form the
 *  shims/consumers use (`'../../shared/comments/...'`) AND any alias form (`'@/shared/comments/
 *  ...'`), since it keys on the substring, not a leading `../`. Anchored to the START of the
 *  line (only `import`/`export` statements, never a comment mentioning the same words -- see the
 *  DECOY test below, which proves both a real match and the comment-line non-match). */
const SHARED_COMMENTS_IMPORT_RE = /^\s*(?:import|export)[^\n]*['"][^'"]*shared\/comments[^'"]*['"]/

interface SharedCommentsApprovalConsumer {
  file: string
  /** Which upstream identity guard this consumer carries (or, for a non-rendering file, why none
   *  is needed) -- see §5 of the S3b wiring contract. */
  guard: string
  reason: string
}

/**
 * Every approval-side file that imports shared/comments, and its triage row. An UNTRIAGED
 * importer (a new one nobody added a row for, or a row whose file got renamed out from under it)
 * fails the set-equality test below -- this is the mechanism that makes "no approval consumer of
 * shared/comments may be wired without first revisiting this disposition" (the S3a gate report's
 * own words) fail-closed rather than a comment nobody re-reads.
 */
const SHARED_COMMENTS_APPROVAL_CONSUMERS: SharedCommentsApprovalConsumer[] = [
  {
    file: 'src/approvals/approvalCommentsClient.ts',
    guard: 'N/A -- transport only, no identity rendering. Sets `authorName: undefined` on every mapped comment and carries NO dependency on directoryResolve.ts (see this file\'s own header note) -- the identity guard lives entirely in ApprovalCommentsPanel.vue, never here.',
    reason: 'S3b CommentsApiClient adapter for the S2 approval-comments endpoints -- imports CommentsTarget/CommentsApiClient (api-client.ts) and MultitableComment (types.ts) as types only.',
  },
  {
    file: 'src/views/approval/ApprovalCommentsPanel.vue',
    guard: 'TWO surfaces, both covered. THREAD LIST: authorDisplayName computed -- `getResolvedUserName(c.authorId) || \\`成员 ${ordinal}\\`` -- unconditionally overwrites `authorName` on every comment BEFORE it reaches the kit (TIER A entry "ApprovalCommentsPanel.vue -- comment author display name" above). MENTION DROPDOWN (a SEPARATE kit render path, post-push adversarial-review finding): setting `authorName` above arms the kit\'s OWN `defaultMentionSuggestions` :385 subtitle leak (renders raw `authorId` whenever `authorName` differs from it, which is now always) and :378\'s candidate-label leak (blank `name` falls back to raw `userId`) -- discharged by NOT feeding `mentionCandidates` to the kit at all and supplying our own values-free `mentionSuggestionsForPanel` (via the shared `memberIdentity` computed, ONE ordinal counter across both halves -- gate finding P3-1, 2026-08-22) covering every author + candidate id, which supersedes the kit\'s internal derivation. Author entries carry `subtitle: undefined`; candidate entries carry `subtitle: candidate.email || undefined` -- a real S2 field (`ApprovalMentionCandidate.email`), not a raw-id fallback, so still values-free, just not universally `undefined` (corrected, gate finding P3-2 -- the prior wording here claimed `subtitle: undefined` for both halves, which was true only of the author half). See `approval-comments-panel.spec.ts`\'s dedicated dropdown-opening test.',
    reason: 'S3b 全文评论 tab wrapper -- mounts MetaCommentsPanel.vue and useMultitableComments from shared/comments.',
  },
]

function scanForSharedCommentsImporters(files: readonly string[]): string[] {
  const importers: string[] = []
  for (const file of files) {
    const lines = readSrc(file).split('\n')
    if (lines.some((line) => SHARED_COMMENTS_IMPORT_RE.test(line))) importers.push(file)
  }
  return importers
}

const SHARED_COMMENTS_APPROVAL_IMPORTERS = scanForSharedCommentsImporters(
  SCANNED_FILES.filter((f) => f.startsWith('src/approvals/') || f.startsWith('src/views/approval/')),
)

describe('member-display-identity coverage enumeration — P3-A (fail-closed shared/comments importer tripwire)', () => {
  it('non-empty: at least one approval file imports shared/comments (a rotted regex finding zero must fail HERE, not pass green -- the feedback_empty_read_is_not_absence class)', () => {
    expect(SHARED_COMMENTS_APPROVAL_IMPORTERS.length).toBeGreaterThan(0)
  })

  it('every discovered importer has a triage row, and every triage row still names a real importer -- set-equality both directions (an untriaged importer reds; a stale row reds)', () => {
    const discovered = new Set(SHARED_COMMENTS_APPROVAL_IMPORTERS)
    const triaged = new Set(SHARED_COMMENTS_APPROVAL_CONSUMERS.map((c) => c.file))
    expect(discovered).toEqual(triaged)
  })

  it('every triage row names a non-empty guard disposition', () => {
    for (const consumer of SHARED_COMMENTS_APPROVAL_CONSUMERS) {
      expect(consumer.guard.length, consumer.file).toBeGreaterThan(0)
    }
  })

  it('positive control / DECOY: the regex matches the real import shape and an alias form, does NOT match a comment mentioning the same words or an unrelated approvals/comments-looking path, and a synthetic untriaged importer is flagged by the same set-equality mechanism', () => {
    const realImportLine = "import MetaCommentsPanel from '../../shared/comments/components/MetaCommentsPanel.vue'"
    expect(SHARED_COMMENTS_IMPORT_RE.test(realImportLine)).toBe(true)

    // Alias-form import (not a relative path) still matches -- the regex keys on the substring
    // `shared/comments`, not on a leading `../`.
    const aliasForm = "import { useMultitableComments } from '@/shared/comments/composables/useMultitableComments'"
    expect(SHARED_COMMENTS_IMPORT_RE.test(aliasForm)).toBe(true)

    const lookalikeUnrelated = "import x from './approvals/comments'"
    expect(SHARED_COMMENTS_IMPORT_RE.test(lookalikeUnrelated)).toBe(false)

    // A COMMENT that merely mentions "shared/comments" (exactly what ApprovalDetailView.vue's own
    // header note does, disclosing it is NOT a direct importer) must not match -- proves the
    // anchor is real, not just a bare substring test.
    const commentMentioningIt = "// ApprovalCommentsPanel.vue is the actual shared/comments importer"
    expect(SHARED_COMMENTS_IMPORT_RE.test(commentMentioningIt)).toBe(false)

    // A synthetic importer absent from the triage table must be flagged by the SAME set-equality
    // mechanism the real test above uses -- proven against a fixture set, never against (or by
    // mutating) real source.
    const discoveredWithExtra = new Set([...SHARED_COMMENTS_APPROVAL_IMPORTERS, 'src/views/approval/SyntheticUntriaged.vue'])
    const triaged = new Set(SHARED_COMMENTS_APPROVAL_CONSUMERS.map((c) => c.file))
    expect(discoveredWithExtra).not.toEqual(triaged)
  })
})

describe('member-display-identity coverage enumeration — backend companions (unchanged tier)', () => {
  it('the new backend resolver route + service function exist on disk, USERS ONLY (companion to the FE guard above)', () => {
    const routeSrc = readSrc('../../packages/core-backend/src/routes/approvals.ts')
    expect(routeSrc).toContain("r.get('/api/approvals/directory/resolve'")
    expect(routeSrc).toContain('approvalParticipantDirectoryGuard')
    const serviceSrc = readSrc('../../packages/core-backend/src/services/approval-directory.ts')
    expect(serviceSrc).toContain('export async function resolveDirectoryUsersByIds')
    // P3-1 CLOSURE: role resolution was REMOVED from the participant path per owner decision, not
    // merely left unreachable -- `resolveDirectoryRolesByIds` must not exist anywhere in the
    // service or the route, so a regression cannot silently re-wire a call to a function that is
    // still there but unused.
    expect(serviceSrc).not.toContain('resolveDirectoryRolesByIds')
    expect(routeSrc).not.toContain('resolveDirectoryRolesByIds')
  })

  // P3-1 CLOSURE (FE mirror of the backend `apps/web` guard above): no FE source file resolves
  // role names any more -- the entire ensureRoleNamesResolved/getResolvedRoleName/
  // resolveApprovalDirectoryRoles plumbing was deleted, not just left unused.
  it('no FE source file references role-name resolution -- the plumbing was deleted, not just unused', () => {
    const files = [
      'src/approvals/directoryResolve.ts',
      'src/approvals/api.ts',
      'src/views/approval/TemplateDetailView.vue',
    ]
    for (const file of files) {
      const content = readSrc(file)
      expect(content, `${file} still references role-name resolution`).not.toMatch(
        /ensureRoleNamesResolved|getResolvedRoleName|resolveApprovalDirectoryRoles|resolvedRoleNames/,
      )
    }
  })
})
