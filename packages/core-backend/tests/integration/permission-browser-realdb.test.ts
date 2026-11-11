// Real UserManagementView clicks, plus a synthetic subject panel that fetches the
// registered stock-prep preflight. Not the full login or workbench. The subject's
// business request for a transition runs before any test-added access/admission reread.
// The page's own refresh is its normal readback. API responses are not fulfilled.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect as expectUi, type Locator, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { restorePermissionBrowserEnv } from '../utils/permission-browser-setup'
import {
  createPermissionBrowserFixture,
  type PermissionBrowserAdmission,
  type PermissionBrowserFixture,
  type PermissionBrowserMutation,
  type PermissionBrowserReread,
  type SubjectPreflightReading,
} from '../utils/permission-browser-fixture'

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..')
const evidenceDir = path.join(repoRoot, 'artifacts', 'permission-browser-grok')

if (process.env.RBAC_BYPASS !== 'false' || process.env.RBAC_TOKEN_TRUST !== 'false') {
  throw new Error('permission browser suite requires RBAC_BYPASS=false and RBAC_TOKEN_TRUST=false')
}
if (process.env.PRODUCT_MODE !== 'plm-workbench') {
  throw new Error('permission browser suite requires PRODUCT_MODE=plm-workbench')
}
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required; refusing a skip-shaped green')
}

function stockPrepCard(page: Page): Locator {
  return page.locator('article.user-admin__role-card--namespace').filter({ hasText: 'stock-prep' }).first()
}

async function openSubject(fx: PermissionBrowserFixture): Promise<void> {
  const page = fx.adminPage
  // The harness URL pins ?userId=, and the list API returns that member. The
  // detail drawer then covers the list search control, so the role action is
  // taken on the already opened member.
  const detail = page.locator('.user-admin__panel--detail')
  await expectUi(detail).toContainText(fx.subjectEmail, { timeout: 60000 })
  await expectUi(page.getByTestId('selected-user-heading')).toBeVisible()
  await page.getByTestId('user-role-select').selectOption(fx.roleId)
  await expectUi(page.getByTestId('assign-role-button')).toBeEnabled()
}

async function permissionCodes(page: Page): Promise<string[]> {
  const section = page.locator('.user-admin__section', { has: page.getByRole('heading', { name: '权限来源' }) })
  return section.locator('.user-admin__chip--permission .user-admin__code').allInnerTexts()
}

function chipState(admission: PermissionBrowserAdmission | null): { hasRole: string; enabled: string; effective: string } {
  return {
    hasRole: admission?.hasRole ? '已分配角色' : '未分配角色',
    enabled: admission?.enabled ? '插件使用已开通' : '插件使用未开通',
    effective: admission?.effective ? '当前实际可用' : '当前不可用',
  }
}

async function refreshAdmission(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: '刷新插件准入', exact: true })
  await button.click()
  await expectUi(button).toBeEnabled()
}

async function expectCardAgrees(
  page: Page,
  read: PermissionBrowserReread,
  sourceMatchesReread = true,
): Promise<void> {
  const card = stockPrepCard(page)
  const chips = chipState(read.admission)
  if (!read.admission) {
    await expectUi(card).toHaveCount(0)
  } else {
    await expectUi(card).toContainText(chips.hasRole)
    await expectUi(card).toContainText(chips.enabled)
    await expectUi(card).toContainText(chips.effective)
  }
  if (!sourceMatchesReread) return
  const shown = (await permissionCodes(page)).map((item) => item.trim()).filter(Boolean).sort()
  expect(shown).toEqual([...read.permissions].sort())
}

async function expectRoleFeedback(page: Page, roleId: string, held: boolean): Promise<void> {
  const feedback = page.getByTestId('role-action-feedback')
  if (held) {
    await expectUi(feedback).toContainText(`已分配角色 ${roleId}`)
    await expectUi(page.getByTestId('selected-role-membership')).toContainText(`当前用户已是角色 ${roleId} 的成员`)
  } else {
    await expectUi(feedback).toContainText(`已撤销角色 ${roleId}`)
    await expectUi(page.getByTestId('selected-role-membership')).toContainText(`当前用户不是角色 ${roleId} 的成员`)
  }
}

type AuthorizationPreview = {
  targetUserId: string
  targetName: string
  roleId: string
  roleTitle: string | null
  inheritedCodes: readonly string[]
  admissionEffect: string
  notes: readonly string[]
}

async function expectPendingAuthorization(page: Page, preview: AuthorizationPreview): Promise<void> {
  const dialog = page.getByTestId('admin-authorization-dialog')
  await expectUi(dialog).toBeVisible()
  const target = dialog.getByTestId('admin-authorization-target')
  await expectUi(target).toContainText('对象：')
  await expectUi(target).toContainText(preview.targetName)
  await expectUi(target).toContainText(preview.targetUserId)
  const role = dialog.getByTestId('admin-authorization-role')
  await expectUi(role).toContainText('角色：')
  await expectUi(role).toContainText(preview.roleId)
  if (preview.roleTitle && preview.roleTitle !== preview.roleId) {
    await expectUi(role).toContainText(preview.roleTitle)
  }
  const inherited = dialog.getByTestId('admin-authorization-inherited-permissions')
  for (const code of preview.inheritedCodes) {
    await expectUi(inherited).toContainText(code)
  }
  await expectUi(dialog.getByTestId('admin-authorization-direct-permissions')).toContainText('无')
  await expectUi(dialog.getByTestId('admin-authorization-admissions')).toContainText(preview.admissionEffect)
  for (const note of preview.notes) {
    await expectUi(dialog).toContainText(note)
  }
  await expectUi(dialog.getByTestId('admin-authorization-confirm')).toBeEnabled()
}

async function confirmPendingAuthorization(
  page: Page,
  source: { mutations: () => PermissionBrowserMutation[] },
  preview: AuthorizationPreview,
  reopen: () => Promise<void>,
  baseline: number,
  cancelFirst = false,
): Promise<void> {
  await expectPendingAuthorization(page, preview)
  expect(source.mutations().length).toBe(baseline)
  if (cancelFirst) {
    await page.getByTestId('admin-authorization-cancel').click()
    await expectUi(page.getByTestId('admin-authorization-dialog')).toHaveCount(0)
    expect(source.mutations().length).toBe(baseline)
    await reopen()
    await expectPendingAuthorization(page, preview)
    expect(source.mutations().length).toBe(baseline)
  }
  await expectUi(page.getByTestId('admin-authorization-confirm')).toBeEnabled()
  await page.getByTestId('admin-authorization-confirm').click()
  await expectUi(page.getByTestId('admin-authorization-dialog')).toHaveCount(0)
}

async function selectedMemberName(page: Page): Promise<string> {
  const heading = (await page.getByTestId('selected-user-heading').innerText()).trim()
  if (!heading) throw new Error('selected user heading is empty')
  return heading
}

async function selectedRoleTitle(page: Page, roleId: string): Promise<string> {
  const label = (await page.getByTestId('user-role-select').locator('option:checked').innerText()).trim()
  const suffix = ` (${roleId})`
  if (!label.endsWith(suffix)) throw new Error(`selected role option did not identify ${roleId}`)
  const title = label.slice(0, -suffix.length).trim()
  if (!title) throw new Error(`selected role option has no title for ${roleId}`)
  return title
}

async function confirmRoleMembership(
  page: Page,
  source: { mutations: () => PermissionBrowserMutation[] },
  action: 'assign' | 'unassign',
  userId: string,
  roleId: string,
  inheritedCodes: readonly string[],
  cancelFirst = false,
): Promise<void> {
  const targetName = await selectedMemberName(page)
  const roleTitle = await selectedRoleTitle(page, roleId)
  const buttonId = action === 'assign' ? 'assign-role-button' : 'unassign-role-button'
  const open = async () => {
    await page.getByTestId(buttonId).click()
  }
  const baseline = source.mutations().length
  await open()
  await confirmPendingAuthorization(page, source, {
    targetUserId: userId,
    targetName,
    roleId,
    roleTitle,
    inheritedCodes,
    admissionEffect: action === 'assign'
      ? '不会改变插件使用。'
      : '如果没有其他角色仍覆盖该范围，可能会关闭插件使用：stock-prep',
    notes: action === 'assign'
      ? [
        '只把该用户加入这个角色的成员，不写入直接权限，也不开通插件使用。',
        '下列权限码是这个角色会继承的权限。',
      ]
      : [
        '只移除这个角色的成员关系，不改直接权限。',
        '如果该用户不再持有这些范围的其他角色，可能会关闭对应的插件使用。',
      ],
  }, open, baseline, cancelFirst)
}

async function confirmAdmissionEnable(
  page: Page,
  source: { mutations: () => PermissionBrowserMutation[] },
  userId: string,
  roleId: string,
  inheritedCodes: readonly string[],
  cancelFirst = false,
): Promise<void> {
  const targetName = await selectedMemberName(page)
  const open = async () => {
    await stockPrepCard(page).getByRole('button', { name: '开通插件使用', exact: true }).click()
  }
  const baseline = source.mutations().length
  await open()
  await confirmPendingAuthorization(page, source, {
    targetUserId: userId,
    targetName,
    roleId,
    roleTitle: null,
    inheritedCodes,
    admissionEffect: '将开通插件使用：stock-prep',
    notes: [
      '只开通「stock-prep」的插件使用。',
      '不分配角色，也不写入直接权限。',
      '下列权限码来自这些角色在角色目录中的清单。',
    ],
  }, open, baseline, cancelFirst)
}

function expectDenied(preflight: SubjectPreflightReading): void {
  expect(preflight.status).toBe(403)
  expect(preflight.code).toBe('FORBIDDEN')
}

function expectBaselineReady(preflight: SubjectPreflightReading): void {
  expect(preflight).toMatchObject({
    status: 200,
    code: 'ok',
    ready: false,
    ledgerPresent: false,
    ledgerMode: 'confirmation_decision_missing',
  })
}

describe('permission browser real database', () => {
  let fx: PermissionBrowserFixture | undefined

  beforeAll(async () => {
    expect(process.env.EXPECT_DB).toBe('1')
    fx = await createPermissionBrowserFixture()
  })

  afterAll(async () => {
    try {
      await fx?.cleanup()
    } finally {
      restorePermissionBrowserEnv()
    }
  })

  it('admin clicks assign, admission, revoke, and regrant while the subject JWT stays fixed', async () => {
    if (!fx) throw new Error('fixture missing')
    const page = fx.adminPage
    const statuses: number[] = []
    const assignPath = `/api/admin/users/${fx.subjectId}/roles/assign`
    const unassignPath = `/api/admin/users/${fx.subjectId}/roles/unassign`
    const admissionPath = `/api/admin/users/${fx.subjectId}/namespaces/stock-prep/admission`
    await expectUi(page.getByTestId('permission-browser-harness-label')).toHaveText('隔离的真实 Vue 权限页骨架，不是完整登录或工作台。')
    await expectUi(fx.subjectPage.getByTestId('permission-browser-harness-label')).toHaveText('隔离的真实 Vue 权限页骨架，不是完整登录或工作台。')

    await openSubject(fx)
    await confirmRoleMembership(page, fx, 'assign', fx.subjectId, fx.roleId, ['stock-prep:read'], true)
    await expectRoleFeedback(page, fx.roleId, true)
    let writes = fx.mutations().length
    await refreshAdmission(page)
    await expectUi(stockPrepCard(page)).toBeVisible()
    expect(fx.mutations().length).toBe(writes)
    let preflight = await fx.readSubjectPreflight()
    expectDenied(preflight)
    statuses.push(preflight.status)
    let read = await fx.reread()
    expect(read.roles).toContain(fx.roleId)
    expect(read.admission).toMatchObject({ hasRole: true, enabled: false, effective: false })
    expect(read.permissions).not.toContain('stock-prep:read')
    await expectCardAgrees(page, read)
    await expectUi(page.getByTestId('member-authorization-outline')).toContainText('不是最终业务访问结论')

    await confirmAdmissionEnable(page, fx, fx.subjectId, fx.roleId, ['stock-prep:read'], true)
    await expectUi(page.getByText('已开通 stock-prep 插件使用')).toBeVisible()
    writes = fx.mutations().length
    await refreshAdmission(page)
    expect(fx.mutations().length).toBe(writes)
    preflight = await fx.readSubjectPreflight()
    expectBaselineReady(preflight)
    statuses.push(preflight.status)
    preflight = await fx.readSubjectPreflight()
    expectBaselineReady(preflight)
    statuses.push(preflight.status)
    read = await fx.reread()
    expect(read.admission).toMatchObject({ hasRole: true, enabled: true, effective: true })
    expect(read.permissions).toContain('stock-prep:read')
    await expectCardAgrees(page, read)
    await expectUi(page.locator('article.user-admin__role-card').filter({ hasText: fx.roleId })).toContainText('stock-prep:read')

    await confirmRoleMembership(page, fx, 'unassign', fx.subjectId, fx.roleId, ['stock-prep:read'], true)
    await expectRoleFeedback(page, fx.roleId, false)
    preflight = await fx.readSubjectPreflight()
    expectDenied(preflight)
    statuses.push(preflight.status)

    await page.getByTestId('user-role-select').selectOption(fx.roleId)
    await confirmRoleMembership(page, fx, 'assign', fx.subjectId, fx.roleId, ['stock-prep:read'])
    await expectRoleFeedback(page, fx.roleId, true)
    preflight = await fx.readSubjectPreflight()
    expectDenied(preflight)
    statuses.push(preflight.status)
    read = await fx.reread()
    expect(read.roles).toContain(fx.roleId)
    expect(read.admission).toMatchObject({ hasRole: true, enabled: false, effective: false })
    expect(read.permissions).not.toContain('stock-prep:read')
    await expectCardAgrees(page, read)

    await confirmAdmissionEnable(page, fx, fx.subjectId, fx.roleId, ['stock-prep:read'])
    await expectUi(page.getByText('已开通 stock-prep 插件使用')).toBeVisible()
    preflight = await fx.readSubjectPreflight()
    expectBaselineReady(preflight)
    statuses.push(preflight.status)

    await stockPrepCard(page).getByRole('button', { name: '关闭插件使用', exact: true }).click()
    await expectUi(page.getByText('已关闭 stock-prep 插件使用')).toBeVisible()
    preflight = await fx.readSubjectPreflight()
    expectDenied(preflight)
    statuses.push(preflight.status)
    read = await fx.reread()
    expect(read.roles).toContain(fx.roleId)
    expect(read.admission).toMatchObject({ hasRole: true, enabled: false, effective: false })
    await expectCardAgrees(page, read)

    writes = fx.mutations().length
    await refreshAdmission(page)
    await refreshAdmission(page)
    expect(fx.mutations().length).toBe(writes)
    const rereadAgain = await fx.reread()
    expect(rereadAgain).toEqual(read)
    await expectCardAgrees(page, rereadAgain)

    const expectedMutations: PermissionBrowserMutation[] = [
      { context: 'admin', method: 'POST', pathname: assignPath, status: 200 },
      { context: 'admin', method: 'PATCH', pathname: admissionPath, status: 200 },
      { context: 'admin', method: 'POST', pathname: unassignPath, status: 200 },
      { context: 'admin', method: 'POST', pathname: assignPath, status: 200 },
      { context: 'admin', method: 'PATCH', pathname: admissionPath, status: 200 },
      { context: 'admin', method: 'PATCH', pathname: admissionPath, status: 200 },
    ]
    expect(fx.mutations()).toEqual(expectedMutations)
    expect(statuses).toEqual([403, 200, 200, 403, 403, 200, 403])
    expect(await fx.subjectTokenUnchanged()).toBe(true)
    expect(fx.violations).toEqual([])
    expect(fx.pageErrors).toEqual([])

    await mkdir(evidenceDir, { recursive: true })
    const screenshot = path.join(evidenceDir, 'lifecycle-success.png')
    await page.locator('.user-admin__panel--detail').screenshot({ path: screenshot })
    await writeFile(path.join(evidenceDir, 'lifecycle-success.json'), JSON.stringify({
      harness: 'real UserManagementView plus synthetic subject request panel, not full login or workbench',
      browserFiltering: 'Chromium origin allowlist only; not OS or native egress isolation',
      subjectStatuses: statuses,
      subjectTokenUnchanged: true,
      roleHeldAfterAdmissionDisable: rereadAgain.roles.includes(fx.roleId),
      admission: rereadAgain.admission,
      permissions: rereadAgain.permissions,
      mutations: expectedMutations.map((item) => ({
        context: item.context,
        method: item.method,
        action: item.pathname.endsWith('/assign')
          ? 'assign'
          : item.pathname.endsWith('/unassign')
            ? 'unassign'
            : 'admission',
        status: item.status,
      })),
      repeatRereadDidNotReplayMutation: true,
    }, null, 2))
  })

  it('configures member-group scope in RoleDelegationView and does not restore it after revoke', async () => {
    const scopeFx = await createPermissionBrowserFixture('scope')
    try {
      const page = scopeFx.adminPage
      const adminRoleId = 'stock-prep_admin'
      const assignPath = `/api/admin/users/${scopeFx.subjectId}/roles/assign`
      const unassignPath = `/api/admin/users/${scopeFx.subjectId}/roles/unassign`
      const admissionPath = `/api/admin/users/${scopeFx.subjectId}/namespaces/stock-prep/admission`
      const memberGroupPath = `/api/admin/role-delegation/users/${scopeFx.targetId}/member-groups/assign`
      const scopeGroupPath = `/api/admin/role-delegation/users/${scopeFx.subjectId}/scope-groups/assign`
      const delegatedPath = `/api/admin/role-delegation/users/${scopeFx.targetId}/roles/assign`
      await expectUi(page.getByTestId('permission-browser-harness-label')).toHaveText('隔离的真实 Vue 权限页骨架，不是完整登录或工作台。')
      await expectUi(scopeFx.subjectPage.getByTestId('subject-delegation')).toBeVisible()

      await openPinnedMember(page, scopeFx.subjectEmail, adminRoleId)
      await confirmRoleMembership(page, scopeFx, 'assign', scopeFx.subjectId, adminRoleId, ['stock-prep:admin'], true)
      await expectRoleFeedback(page, adminRoleId, true)
      let writes = scopeFx.mutations().length
      await refreshAdmission(page)
      expect(scopeFx.mutations().length).toBe(writes)
      await confirmAdmissionEnable(page, scopeFx, scopeFx.subjectId, adminRoleId, ['stock-prep:admin'])
      await expectUi(page.getByText('已开通 stock-prep 插件使用')).toBeVisible()

      await scopeFx.openDelegation(scopeFx.targetId)
      await expectUi(page.getByText('平台管理员模式')).toBeVisible()
      await expectUi(page.locator('.delegation-page__panel--detail')).toContainText(scopeFx.targetEmail, { timeout: 60000 })
      const membership = selectByExactOption(page, '请选择成员集')
      await expectUi(membership.locator('option', { hasText: scopeFx.groupName })).toHaveCount(1, { timeout: 60000 })
      await membership.selectOption(scopeFx.groupId)
      const addMember = page.getByRole('button', { name: '将当前成员加入成员集', exact: true })
      await expectUi(addMember).toBeEnabled()
      await addMember.click()
      await expectUi(page.locator('.delegation-page__status')).toHaveText('成员已加入平台成员集')

      await scopeFx.openDelegation(scopeFx.subjectId)
      await expectUi(page.locator('.delegation-page__panel--detail')).toContainText(scopeFx.subjectEmail, { timeout: 60000 })
      await expectUi(page.getByRole('heading', { name: '插件管理员范围配置' })).toBeVisible()
      await expectUi(page.getByText('该成员尚未持有任何插件管理员角色。')).toHaveCount(0)
      const namespace = selectByExactOption(page, '请选择管理员命名空间')
      await expectUi(namespace.locator('option[value="stock-prep"]')).toHaveCount(1)
      await namespace.selectOption('stock-prep')
      const audience = selectByExactOption(page, '请选择平台成员集')
      await expectUi(audience.locator('option', { hasText: scopeFx.groupName })).toHaveCount(1)
      await audience.selectOption(scopeFx.groupId)
      const addScope = page.getByRole('button', { name: '添加成员集范围', exact: true })
      await expectUi(addScope).toBeEnabled()
      await addScope.click()
      await expectUi(page.locator('.delegation-page__status')).toHaveText('插件管理员成员集范围已添加')
      await expectUi(page.locator('.delegation-page__scope-card').filter({ hasText: scopeFx.groupName })).toBeVisible()

      const granted = await scopeFx.readSubjectDelegation()
      expect(granted).toEqual({ status: 200, code: 'ok' })

      await scopeFx.openUserAdmin()
      await openPinnedMember(page, scopeFx.subjectEmail, adminRoleId)
      await confirmRoleMembership(page, scopeFx, 'unassign', scopeFx.subjectId, adminRoleId, ['stock-prep:admin'])
      await expectRoleFeedback(page, adminRoleId, false)
      await page.getByTestId('user-role-select').selectOption(adminRoleId)
      await confirmRoleMembership(page, scopeFx, 'assign', scopeFx.subjectId, adminRoleId, ['stock-prep:admin'])
      await expectRoleFeedback(page, adminRoleId, true)
      writes = scopeFx.mutations().length
      await refreshAdmission(page)
      expect(scopeFx.mutations().length).toBe(writes)
      await confirmAdmissionEnable(page, scopeFx, scopeFx.subjectId, adminRoleId, ['stock-prep:admin'])
      await expectUi(page.getByText('已开通 stock-prep 插件使用')).toBeVisible()

      const denied = await scopeFx.readSubjectDelegation()
      expect(denied).toEqual({ status: 403, code: 'ROLE_DELEGATION_SCOPE_REQUIRED' })
      const scopes = await scopeFx.readScopes()
      expect(scopes.adminNamespaces).toContain('stock-prep')
      expect(scopes.groupIds).toEqual([])
      writes = scopeFx.mutations().length
      const scopesAgain = await scopeFx.readScopes()
      expect(scopesAgain).toEqual(scopes)
      expect(scopeFx.mutations().length).toBe(writes)

      await scopeFx.openDelegation(scopeFx.subjectId)
      await expectUi(page.locator('.delegation-page__panel--detail')).toContainText(scopeFx.subjectEmail, { timeout: 60000 })
      await expectUi(page.getByText('该成员尚未持有任何插件管理员角色。')).toHaveCount(0)
      await expectUi(page.getByText('该成员尚未配置任何插件管理员范围。')).toBeVisible()
      await expectUi(page.locator('.delegation-page__scope-card').filter({ hasText: scopeFx.groupName })).toHaveCount(0)
      expect(scopeFx.mutations().length).toBe(writes)

      expect(scopeFx.mutations()).toEqual([
        { context: 'admin', method: 'POST', pathname: assignPath, status: 200 },
        { context: 'admin', method: 'PATCH', pathname: admissionPath, status: 200 },
        { context: 'admin', method: 'POST', pathname: memberGroupPath, status: 200 },
        { context: 'admin', method: 'POST', pathname: scopeGroupPath, status: 200 },
        { context: 'subject', method: 'POST', pathname: delegatedPath, status: 200 },
        { context: 'admin', method: 'POST', pathname: unassignPath, status: 200 },
        { context: 'admin', method: 'POST', pathname: assignPath, status: 200 },
        { context: 'admin', method: 'PATCH', pathname: admissionPath, status: 200 },
        { context: 'subject', method: 'POST', pathname: delegatedPath, status: 403 },
      ])
      expect(await scopeFx.subjectTokenUnchanged()).toBe(true)
      expect(scopeFx.violations).toEqual([])
      expect(scopeFx.pageErrors).toEqual([])

      await mkdir(evidenceDir, { recursive: true })
      await page.locator('.delegation-page__panel--detail').screenshot({
        path: path.join(evidenceDir, 'scope-success.png'),
      })
      await writeFile(path.join(evidenceDir, 'scope-success.json'), JSON.stringify({
        harness: 'real UserManagementView and RoleDelegationView plus synthetic subject delegation panel, not full login or workbench',
        browserFiltering: 'Chromium origin allowlist only; not OS or native egress isolation',
        positiveStatus: granted.status,
        denialStatus: denied.status,
        denialCode: denied.code,
        scopeRestored: scopes.groupIds.length > 0,
        adminNamespacesIncludeStockPrep: scopes.adminNamespaces.includes('stock-prep'),
        subjectTokenUnchanged: true,
        repeatScopeReadDidNotReplayMutation: true,
        mutations: [
          'assign',
          'admission',
          'member-group',
          'scope-group',
          'delegated-assign',
          'unassign',
          'assign',
          'admission',
          'delegated-assign',
        ],
      }, null, 2))
    } finally {
      await scopeFx.cleanup()
    }
  })
})

function selectByExactOption(page: Page, placeholder: string): Locator {
  return page.locator('select').filter({
    has: page.locator('option', { hasText: new RegExp(`^${placeholder}$`) }),
  })
}

async function openPinnedMember(page: Page, email: string, roleId: string): Promise<void> {
  const detail = page.locator('.user-admin__panel--detail')
  await expectUi(detail).toContainText(email, { timeout: 60000 })
  await expectUi(page.getByTestId('selected-user-heading')).toBeVisible()
  await page.getByTestId('user-role-select').selectOption(roleId)
  await expectUi(page.getByTestId('assign-role-button')).toBeEnabled()
}
