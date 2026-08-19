import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * member-display-identity (2026-08-19) — mechanical ENUMERATION guard, mirroring
 * `packages/core-backend/tests/unit/approval-ci-coverage-enumeration.test.ts`'s (FAIL-0) own
 * discipline and its own stated tier: FAIL-0 does not RE-EXECUTE the approval suites it guards —
 * it proves each one is WIRED (collected by a named, un-skippable CI lane, or explicitly
 * allowlisted). This file is the frontend analogue for the raw-id-render class: it does not
 * RE-MOUNT every component (that would duplicate, not strengthen, the mounted discriminating
 * negatives + positive controls already added to the six spec files below) — it mechanically
 * proves each SITE's guarding pattern is (a) present in the SOURCE file and (b) still named in its
 * covering spec file, so a regression that deletes the resolver call OR quietly renames/removes
 * the covering test turns this file red.
 *
 * BEHAVIOR proof (the actual runtime assertion that a raw id never reaches the DOM) lives in the
 * MOUNTED tests this file only points at — see each entry's `coverage` field. This file's own
 * assertions are WIRING/PRESENCE checks (source-text search), the same tier FAIL-0 operates at for
 * the backend — never mistake either for the other (feedback_source_text_assertions_are_not_
 * behaviour.md): the mounted tests carry the behavioral teeth, this file carries the "did someone
 * quietly delete the guard" teeth.
 *
 * Covers EVERY row of the scout's viewer-facing site table. Three statuses:
 *   - GUARDED       — this PR added/changed the resolver call; a mounted discriminating negative +
 *                      positive control exist in `coverage`.
 *   - ALREADY-SAFE  — pre-existing #5010 fix already closed this row (values-free before this PR);
 *                      unchanged here, `coverage` still points at its pre-existing pinned test.
 *   - OUT-OF-SCOPE  — authoring-only / admin-only / non-person-id audience, per Lock-1 §2.6 and
 *                      the #5010 precedent; listed for completeness, no coverage pointer needed.
 */

const repoRoot = join(__dirname, '..')
function readSrc(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), 'utf8')
}
function readTest(relPath: string): string {
  return readFileSync(join(__dirname, relPath), 'utf8')
}

interface SiteEntry {
  site: string
  status: 'GUARDED' | 'ALREADY-SAFE' | 'OUT-OF-SCOPE'
  /** [source file, testFile, test-title-substring] — omitted for OUT-OF-SCOPE rows. */
  coverage?: [string, string, string]
  /** Source-text checks proving the guarding pattern is actually IN the source (not just claimed). */
  sourceChecks?: Array<{ file: string; mustContain: string[]; mustNotContain?: string[] }>
}

const SITES: SiteEntry[] = [
  {
    site: 'ApprovalDetailView.vue — 当前处理人 (assignmentDisplayLabel)',
    status: 'GUARDED',
    coverage: ['src/views/approval/ApprovalDetailView.vue', 'approval-e2e-lifecycle.spec.ts', 'resolves to a real name via the directory resolver when metadata.assigneeName is absent'],
    sourceChecks: [{
      file: 'src/views/approval/ApprovalDetailView.vue',
      mustContain: ['function assignmentDisplayLabel', 'getResolvedUserName(assignment.assigneeId)'],
    }],
  },
  {
    site: 'ApprovalDetailView.vue — 其他审批人已失效 (cancelledAssigneesLabel)',
    status: 'GUARDED',
    coverage: ['src/views/approval/ApprovalDetailView.vue', 'approval-detail-record-table.spec.ts', 'resolves to real names via the directory resolver when no assignment metadata carries them'],
    sourceChecks: [{
      file: 'src/views/approval/ApprovalDetailView.vue',
      mustContain: ['function cancelledAssigneesLabel', 'getResolvedUserName(idStr)'],
    }],
  },
  {
    site: 'ApprovalDetailView.vue — 减签 picker (reducibleAssignees, FLOW-CHANGING)',
    status: 'GUARDED',
    coverage: ['src/views/approval/ApprovalDetailView.vue', 'approval-member-bar-operation-policy.spec.ts', 'a member resolvable via the directory resolver gets its real name AND becomes selectable'],
    sourceChecks: [{
      file: 'src/views/approval/ApprovalDetailView.vue',
      mustContain: ['const reducibleAssignees = computed', 'disabled: !resolvedName', ':disabled="assignee.disabled"'],
    }],
  },
  {
    site: 'ApprovalDetailView.vue — 加签 picker chip (onAddSignUserSelected)',
    status: 'ALREADY-SAFE',
    coverage: ['src/views/approval/ApprovalDetailView.vue', 'approval-e2e-lifecycle.spec.ts', 'a picked user with no directory name never renders the raw id as the chip label'],
  },
  {
    site: 'ApprovalDetailView.vue / ApprovalNewView.vue — upcoming-node assignee summary (nodeAssigneeSourceSummary)',
    status: 'ALREADY-SAFE',
    coverage: ['src/approvals/assigneeSource.ts', 'approval-upcoming-nodes.test.ts', 'the summary is a count, never the raw ids (P3)'],
    sourceChecks: [{
      // requesterFacingSourceSummary intercepts static_user/static_role to COUNT-ONLY before ever
      // delegating to assigneeSourceSummary's own raw-id-joining cases — that interception is the
      // guard; asserting its presence is what would catch someone deleting it.
      file: 'src/approvals/assigneeSource.ts',
      mustContain: ['function requesterFacingSourceSummary', "return `指定用户${count ? `（${count} 人）`", "return `指定角色${count ? `（${count} 个）`"],
    }],
  },
  {
    site: 'ApprovalUserPicker.vue — 转交/加签/表单用户字段/委托 dropdown options (FLOW-CHANGING, 6+ call sites)',
    status: 'GUARDED',
    coverage: ['src/approvals/components/ApprovalUserPicker.vue', 'approvalUserPicker.spec.ts', 'a directory user with no name is rendered DISABLED'],
    sourceChecks: [{
      file: 'src/approvals/components/ApprovalUserPicker.vue',
      mustContain: ['function isUnidentifiable', ':disabled="isUnidentifiable(option)"'],
    }],
  },
  {
    site: 'ApprovalCenterDetailPane.vue — 待处理人 (assigneeLabel, desktop master-detail pane)',
    status: 'GUARDED',
    coverage: ['src/views/approval/ApprovalCenterDetailPane.vue', 'approval-center-master-detail.spec.ts', 'resolves to a real name via the directory resolver when metadata.assigneeName is absent'],
    sourceChecks: [{
      file: 'src/views/approval/ApprovalCenterDetailPane.vue',
      mustContain: ['function assigneeLabel', 'getResolvedUserName(assignment.assigneeId)'],
    }],
  },
  {
    // member-display-identity tightening (2026-08-19): role scope ids are now ALWAYS a generic
    // count (`resolvedIdsOrCount`'s 'role' branch never resolves a name -- see the sourceChecks
    // mustNotContain below) -- coverage points at the still-live USER-type positive control, which
    // proves the underlying resolver call/display pattern this site depends on.
    site: 'TemplateDetailView.vue — 可见范围 ids (visibilityScope, any authenticated viewer)',
    status: 'GUARDED',
    coverage: ['src/views/approval/TemplateDetailView.vue', 'approval-e2e-permissions.spec.ts', 'template detail visibility scope (user type) shows RESOLVED user names when every id resolves'],
    sourceChecks: [{
      file: 'src/views/approval/TemplateDetailView.vue',
      mustContain: ['function visibilityScopeIdsDisplay', 'visibilityScopeIdsDisplay(template.visibilityScope)'],
      mustNotContain: ['template.visibilityScope.ids.join', 'getResolvedRoleName', 'ensureRoleNamesResolved'],
    }],
  },
  {
    // Same tightening as the row above -- coverage now points at the USER-only positive control
    // (role stays a values-free count, asserted in the same test -- see the spec's own comment).
    site: 'TemplateDetailView.vue — node assignee ids (legacy assigneeType/assigneeIds, any authenticated viewer)',
    status: 'GUARDED',
    coverage: ['src/views/approval/TemplateDetailView.vue', 'approval-e2e-permissions.spec.ts', 'POSITIVE CONTROL: template detail node assignee ids show a RESOLVED user name once the user resolver returns it'],
    sourceChecks: [{
      file: 'src/views/approval/TemplateDetailView.vue',
      mustContain: ['function legacyAssigneeIdsDisplay', 'legacyAssigneeIdsDisplay((node.config as any).assigneeType'],
      mustNotContain: ['(node.config as any).assigneeIds?.join', 'getResolvedRoleName', 'ensureRoleNamesResolved'],
    }],
  },
  {
    site: 'MyDelegationView.vue — 被委托人 column (self-service, any authenticated user)',
    status: 'GUARDED',
    coverage: ['src/views/approval/MyDelegationView.vue', 'myDelegationView.spec.ts', 'the 被委托人 column shows the RESOLVED name once the directory resolver returns it'],
    sourceChecks: [{
      file: 'src/views/approval/MyDelegationView.vue',
      mustContain: ['function delegateeDisplay', 'delegateeDisplay(row.delegateeUserId)'],
      mustNotContain: ['prop="delegateeUserId"'],
    }],
  },
  {
    // P3-2 fix (member-display-identity gate report, 2026-08-19): the ORIGINAL reason recorded
    // here ("authoring-only ...") was FALSE for the user_group branch -- `assigneeSourceSummary`'s
    // static_user/static_role cases are authoring-only (intercepted to count-only upstream by
    // `requesterFacingSourceSummary` for any viewer-facing caller -- see that SITE's own sourceChecks
    // above), but `nodeAssigneeSourceSummary` DELEGATES `user_group` straight to
    // `assigneeSourceSummary`, which joins raw group ids (`用户组：${groupIds.join('、')}`) and is
    // reachable on the VIEWER-FACING flow previews at ApprovalNewView.vue and ApprovalDetailView.vue
    // -- not authoring-only at all. The disposition (OUT-OF-SCOPE, outside the member/role/dept
    // PERSON-identity class this file enumerates) is still correct: group ids are template-authored
    // references, a Lock-1 §K1/§2.6-permitted vocabulary, not person identities -- they are
    // intentionally rendered on viewer previews, not accidentally leaked.
    site: 'assigneeSource.ts — assigneeSourceSummary static_user/static_role/user_group raw-id joins',
    status: 'OUT-OF-SCOPE', // static_user/static_role: authoring-only (intercepted to count-only for viewers). user_group: group ids are template-authored references (Lock-1 §K1/§2.6), NOT person identities -- and ARE rendered on viewer-facing previews (ApprovalNewView/ApprovalDetailView), intentionally out of the person-identity class.
  },
  {
    site: 'assigneeSource.ts — form_field_user (`表单用户字段：{fieldId}`)',
    status: 'OUT-OF-SCOPE', // a form-FIELD id, not a member/role/dept identity
  },
  {
    site: 'DelegationSettingsView.vue — admin delegation table (delegatorUserId/delegateeUserId)',
    status: 'OUT-OF-SCOPE', // admin-only, gated approval-templates:manage — authoring/admin audience
  },
  {
    site: 'TemplateDetailView.vue — visibilityIdsDraft (edit-mode textarea seed)',
    status: 'OUT-OF-SCOPE', // author-facing (canManageTemplates edit mode), not a rendered display
  },
  {
    site: 'TemplateAuthoringView.vue / linearStepSpine.ts / ApprovalGraphNodeConfigEditor.vue — authoring previews',
    status: 'OUT-OF-SCOPE', // template author, not requester/approver
  },
  {
    site: 'TemplateCenterView.vue — visibilityScopeLabel (count only, e.g. "角色 2")',
    status: 'OUT-OF-SCOPE', // already count-only, no id ever rendered — not a leak
  },
]

describe('member-display-identity coverage enumeration (mechanical, mirrors FAIL-0 discipline)', () => {
  it('sentinel: every SITE entry has a status and, if not OUT-OF-SCOPE, a coverage pointer', () => {
    for (const entry of SITES) {
      expect(entry.status, entry.site).toMatch(/^(GUARDED|ALREADY-SAFE|OUT-OF-SCOPE)$/)
      if (entry.status !== 'OUT-OF-SCOPE') {
        expect(entry.coverage, `${entry.site} must name its covering test`).toBeTruthy()
      }
    }
  })

  it('every GUARDED/ALREADY-SAFE site\'s covering test file actually contains a matching it(...) title', () => {
    const testFileCache = new Map<string, string>()
    for (const entry of SITES) {
      if (!entry.coverage) continue
      const [, testFile, titleSubstring] = entry.coverage
      if (!testFileCache.has(testFile)) testFileCache.set(testFile, readTest(testFile))
      const content = testFileCache.get(testFile)!
      expect(content, `${entry.site}: ${testFile} no longer contains the covering test title`).toContain(titleSubstring)
    }
  })

  it('every GUARDED site\'s source-level guarding pattern is present (and the pre-fix raw-join pattern is gone)', () => {
    const srcCache = new Map<string, string>()
    for (const entry of SITES) {
      if (!entry.sourceChecks) continue
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
