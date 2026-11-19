// Real UserManagementView clicks, plus a synthetic subject panel that fetches the
// registered stock-prep preflight. Not the full login or workbench. The subject's
// business request for a transition runs before any test-added access/admission reread.
// The page's own refresh is its normal readback. API responses are not fulfilled.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect as expectUi, type Locator, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AuthorizationOperationImpact, AuthorizationOperationRequest } from '../../src/admin/authorization-operation-contract'
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
const operationPath = '/api/admin/authorization-operations'
const operationWrite: PermissionBrowserMutation = {
  context: 'admin', method: 'POST', pathname: operationPath, status: 200,
}

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
  await expectUi(page.getByTestId('selected-role-membership'))
    .toContainText(`当前用户${held ? '已是' : '不是'}角色 ${roleId} 的成员`)
}

type AuthorizationPreview = {
  request: AuthorizationOperationRequest
  targetName: string
  roleId: string
  roleTitle: string | null
  inheritedCodes: readonly string[]
  admission: { enabled: boolean; derived: boolean } | null
  scopeCleanupCount: number
  verifiedMessage: string
}

async function expectPendingAuthorization(page: Page, preview: AuthorizationPreview): Promise<void> {
  const dialog = page.getByTestId('admin-authorization-dialog')
  await expectUi(dialog).toBeVisible()
  const target = dialog.getByTestId('admin-authorization-target')
  await expectUi(target).toContainText('对象：')
  await expectUi(target).toContainText(preview.targetName)
  await expectUi(target).toContainText(preview.request.targetUserId)
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
  await expectUi(dialog.getByTestId('admin-authorization-server-impact')).toBeVisible()
  const admissionLabel = preview.admission ? `${preview.admission.enabled ? '开通' : '关闭'} stock-prep` : '无'
  await expectUi(dialog.getByTestId('admin-authorization-explicit-admissions'))
    .toHaveText(`显式准入：${preview.admission && !preview.admission.derived ? admissionLabel : '无'}`)
  await expectUi(dialog.getByTestId('admin-authorization-derived-admissions'))
    .toHaveText(`派生准入：${preview.admission?.derived ? admissionLabel : '无'}`)
  await expectUi(dialog.getByTestId('admin-authorization-scope-cleanup')).toHaveText(`范围清理：${preview.scopeCleanupCount}`)
  await expectUi(dialog.getByTestId('admin-authorization-confirm')).toBeEnabled()
}

function waitForApi(page: Page, method: 'GET' | 'POST', pathname: string) {
  return page.waitForResponse(response => (
    new URL(response.url()).pathname === pathname && response.request().method() === method
  ), { timeout: 15000 })
}

async function confirmPendingAuthorization(
  fx: PermissionBrowserFixture,
  page: Page,
  preview: AuthorizationPreview,
  control: Locator,
  cancelFirst: boolean,
): Promise<void> {
  const baseline = fx.mutations().length
  const initialAudits = await fx.operationAudits()
  const open = async (): Promise<{ expectedVersion: string; impact: AuthorizationOperationImpact }> => {
    const [response] = await Promise.all([
      waitForApi(page, 'POST', `${operationPath}/preview`),
      control.click(),
    ])
    expect(response.status()).toBe(200)
    expect(response.request().postDataJSON()).toEqual(preview.request)
    const body = await response.json()
    expect(body.expectedVersion).toMatch(/^\S+$/)
    const admission = preview.admission
    expect(body.impact.admissionChanges).toMatchObject(admission ? [{
      namespace: 'stock-prep',
      after: admission.enabled,
      cause: admission.derived ? 'role_revoke' : 'explicit',
    }] : [])
    expect(body.impact.scopeCleanup).toHaveLength(preview.scopeCleanupCount)
    await expectPendingAuthorization(page, preview)
    expect(fx.mutations()).toHaveLength(baseline)
    expect(await fx.operationAudits()).toEqual(initialAudits)
    return body
  }

  let reviewed = await open()
  if (cancelFirst) {
    await page.getByTestId('admin-authorization-cancel').click()
    await expectUi(page.getByTestId('admin-authorization-dialog')).toHaveCount(0)
    expect(fx.mutations()).toHaveLength(baseline)
    expect(await fx.operationAudits()).toEqual(initialAudits)
    reviewed = await open()
  }

  const userPath = `/api/admin/users/${preview.request.targetUserId}`
  const [commit, access, admission] = await Promise.all([
    waitForApi(page, 'POST', operationPath),
    waitForApi(page, 'GET', `${userPath}/access`),
    waitForApi(page, 'GET', `${userPath}/member-admission`),
    page.getByTestId('admin-authorization-confirm').click(),
  ])
  expect(commit.status()).toBe(200)
  expect(access.status()).toBe(200)
  expect(admission.status()).toBe(200)
  const body = await commit.json()
  expect(body).toMatchObject({
    status: 'committed',
    clientOperationId: expect.any(String),
    receipt: { targetUserId: preview.request.targetUserId, action: preview.request.action, impact: reviewed.impact },
  })
  expect(commit.request().postDataJSON()).toEqual({
    ...preview.request,
    expectedVersion: reviewed.expectedVersion,
    clientOperationId: body.clientOperationId,
  })
  expect(await fx.readOperation(body.clientOperationId)).toEqual(body)
  const audits = await fx.operationAudits()
  expect(audits.size).toBe(initialAudits.size + 1)
  expect(audits.get(body.clientOperationId)).toEqual({ impact: reviewed.impact, reasonOrigin: 'not_required' })
  expect(fx.mutations().slice(baseline)).toEqual([operationWrite])
  await expectUi(page.getByTestId('admin-authorization-outcome')).toHaveText(preview.verifiedMessage)
  await page.getByTestId('admin-authorization-close').click()
  await expectUi(page.getByTestId('admin-authorization-dialog')).toHaveCount(0)
  await expectUi(page.getByTestId('role-action-feedback')).toHaveText(preview.verifiedMessage)
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
  fx: PermissionBrowserFixture,
  action: 'assign' | 'unassign',
  userId: string,
  roleId: string,
  inheritedCodes: readonly string[],
  cancelFirst = false,
  scopeCleanupCount = 0,
): Promise<void> {
  const targetName = await selectedMemberName(page)
  const roleTitle = await selectedRoleTitle(page, roleId)
  const buttonId = action === 'assign' ? 'assign-role-button' : 'unassign-role-button'
  await confirmPendingAuthorization(fx, page, {
    request: { targetUserId: userId, action: { kind: action === 'assign' ? 'role.assign' : 'role.revoke', roleId }, admissionChanges: [] },
    targetName,
    roleId,
    roleTitle,
    inheritedCodes,
    admission: action === 'assign' ? null : { enabled: false, derived: true },
    scopeCleanupCount,
    verifiedMessage: action === 'assign' ? '角色已分配，准入未开' : '角色已从该成员移除。',
  }, page.getByTestId(buttonId), cancelFirst)
}

async function confirmAdmission(
  page: Page,
  fx: PermissionBrowserFixture,
  userId: string,
  roleId: string,
  inheritedCodes: readonly string[],
  enabled: boolean,
  cancelFirst = false,
): Promise<void> {
  const targetName = await selectedMemberName(page)
  const label = enabled ? '开通' : '关闭'
  await confirmPendingAuthorization(fx, page, {
    request: { targetUserId: userId, action: { kind: 'admission.set' }, admissionChanges: [{ namespace: 'stock-prep', enabled }] },
    targetName,
    roleId,
    roleTitle: null,
    inheritedCodes,
    admission: { enabled, derived: false },
    scopeCleanupCount: 0,
    verifiedMessage: `已${label} stock-prep 插件使用`,
  }, stockPrepCard(page).getByRole('button', { name: `${label}插件使用`, exact: true }), cancelFirst)
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

    await confirmAdmission(page, fx, fx.subjectId, fx.roleId, ['stock-prep:read'], true, true)
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

    await confirmAdmission(page, fx, fx.subjectId, fx.roleId, ['stock-prep:read'], true)
    preflight = await fx.readSubjectPreflight()
    expectBaselineReady(preflight)
    statuses.push(preflight.status)

    await confirmAdmission(page, fx, fx.subjectId, fx.roleId, ['stock-prep:read'], false)
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

    expect(fx.mutations()).toEqual(Array.from({ length: 6 }, () => operationWrite))
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
      auditedOperations: ['role.assign', 'admission.enable', 'role.revoke', 'role.assign', 'admission.enable', 'admission.disable'],
      repeatRereadDidNotReplayMutation: true,
    }, null, 2))
  })

  it('configures member-group scope in RoleDelegationView and does not restore it after revoke', async () => {
    const scopeFx = await createPermissionBrowserFixture('scope')
    try {
      const page = scopeFx.adminPage
      const adminRoleId = 'stock-prep_admin'
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
      await confirmAdmission(page, scopeFx, scopeFx.subjectId, adminRoleId, ['stock-prep:admin'], true)

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
      await confirmRoleMembership(page, scopeFx, 'unassign', scopeFx.subjectId, adminRoleId, ['stock-prep:admin'], false, 1)
      await expectRoleFeedback(page, adminRoleId, false)
      await page.getByTestId('user-role-select').selectOption(adminRoleId)
      await confirmRoleMembership(page, scopeFx, 'assign', scopeFx.subjectId, adminRoleId, ['stock-prep:admin'])
      await expectRoleFeedback(page, adminRoleId, true)
      writes = scopeFx.mutations().length
      await refreshAdmission(page)
      expect(scopeFx.mutations().length).toBe(writes)
      await confirmAdmission(page, scopeFx, scopeFx.subjectId, adminRoleId, ['stock-prep:admin'], true)

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
        operationWrite,
        operationWrite,
        { context: 'admin', method: 'POST', pathname: memberGroupPath, status: 200 },
        { context: 'admin', method: 'POST', pathname: scopeGroupPath, status: 200 },
        { context: 'subject', method: 'POST', pathname: delegatedPath, status: 200 },
        operationWrite,
        operationWrite,
        operationWrite,
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
          'role.assign',
          'admission.enable',
          'member-group',
          'scope-group',
          'delegated-assign',
          'role.revoke',
          'role.assign',
          'admission.enable',
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
