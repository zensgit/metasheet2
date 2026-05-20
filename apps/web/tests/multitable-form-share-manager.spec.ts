import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

async function flushPromises() {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

import MetaFormShareManager from '../src/multitable/components/MetaFormShareManager.vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import { useLocale } from '../src/composables/useLocale'

function fakeConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    publicToken: 'tok_abc123',
    expiresAt: null,
    status: 'active',
    accessMode: 'public',
    allowedUserIds: [],
    allowedUsers: [],
    allowedMemberGroupIds: [],
    allowedMemberGroups: [],
    ...overrides,
  }
}

function mockClient(config = fakeConfig()) {
  const ok = (body: unknown) =>
    new Response(JSON.stringify({ data: body }), { status: 200, headers: { 'Content-Type': 'application/json' } })

  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.includes('/form-share-candidates')) {
      return ok({
        items: [
          { subjectType: 'user', subjectId: 'user_1', label: 'Alice', subtitle: 'alice@test.local', isActive: true, accessLevel: 'write', dingtalkBound: true, dingtalkGrantEnabled: true, dingtalkPersonDeliveryAvailable: true },
          { subjectType: 'member-group', subjectId: 'group_ops', label: 'Ops', subtitle: 'Operations', isActive: true, accessLevel: 'write' },
          { subjectType: 'user', subjectId: 'user_inactive', label: 'Inactive User', subtitle: 'inactive@test.local', isActive: false, accessLevel: 'write', dingtalkBound: false, dingtalkGrantEnabled: false, dingtalkPersonDeliveryAvailable: false },
        ],
        total: 3,
        limit: 20,
        query: '',
      })
    }
    if (method === 'GET' && url.includes('/form-share')) {
      return ok(config)
    }
    if (method === 'PATCH' && url.includes('/form-share')) {
      const body = JSON.parse(init?.body as string)
      return ok({ ...config, ...body })
    }
    if (method === 'POST' && url.includes('/regenerate')) {
      return ok({ publicToken: 'tok_new456' })
    }
    return ok({})
  })
  return { client: new MultitableApiClient({ fetchFn }), fetchFn }
}

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaFormShareManager, props) })
  app.mount(container)
  return { container, app }
}

describe('MetaFormShareManager', () => {
  beforeEach(() => {
    useLocale().setLocale('en')
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    useLocale().setLocale('en')
  })

  it('renders share config when visible', async () => {
    const { client } = mockClient()
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const toggle = document.querySelector('[data-form-share-toggle]') as HTMLInputElement
    expect(toggle).toBeTruthy()
    expect(toggle.checked).toBe(true)
  })

  it('shows public link when enabled', async () => {
    const { client } = mockClient()
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const linkInput = document.querySelector('[data-form-share-link]') as HTMLInputElement
    expect(linkInput).toBeTruthy()
    expect(linkInput.value).toContain('tok_abc123')
    expect(linkInput.value).toContain('/multitable/public-form/sh_1/v_1')
  })

  it('hides link section when disabled', async () => {
    const { client } = mockClient(fakeConfig({ enabled: false, publicToken: null, status: 'disabled' }))
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const linkInput = document.querySelector('[data-form-share-link]')
    expect(linkInput).toBeNull()
  })

  it('shows copy button', async () => {
    const { client } = mockClient()
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const copyBtn = document.querySelector('[data-form-share-copy]')
    expect(copyBtn).toBeTruthy()
    expect(copyBtn?.textContent?.trim()).toBe('Copy')
    const audience = document.querySelector('[data-form-share-audience-rule]') as HTMLElement
    expect(audience).toBeTruthy()
    expect(audience.getAttribute('data-access-mode')).toBe('public')
    expect(audience.textContent).toContain('Fully public anonymous form')
  })

  it('shows regenerate button', async () => {
    const { client } = mockClient()
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const regenBtn = document.querySelector('[data-form-share-regenerate]')
    expect(regenBtn).toBeTruthy()
  })

  it('calls regenerate API on click', async () => {
    const { client, fetchFn } = mockClient()
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const regenBtn = document.querySelector('[data-form-share-regenerate]') as HTMLButtonElement
    regenBtn.click()
    await flushPromises()

    const regenerateCalls = fetchFn.mock.calls.filter(
      (c: [string, RequestInit?]) => c[1]?.method === 'POST' && c[0].includes('/regenerate'),
    )
    expect(regenerateCalls.length).toBe(1)
  })

  it('shows expiry date picker', async () => {
    const { client } = mockClient()
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const expiryInput = document.querySelector('[data-form-share-expiry]')
    expect(expiryInput).toBeTruthy()
  })

  it('shows status indicator', async () => {
    const { client } = mockClient()
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const status = document.querySelector('[data-status="active"]')
    expect(status).toBeTruthy()
    expect(status?.textContent?.trim()).toBe('Active')
  })

  it('toggles enabled calls API', async () => {
    const { client, fetchFn } = mockClient()
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const toggle = document.querySelector('[data-form-share-toggle]') as HTMLInputElement
    toggle.click()
    await flushPromises()

    const patchCalls = fetchFn.mock.calls.filter(
      (c: [string, RequestInit?]) => c[1]?.method === 'PATCH' && c[0].includes('/form-share'),
    )
    expect(patchCalls.length).toBe(1)
    const body = JSON.parse(patchCalls[0][1].body as string)
    expect(body.enabled).toBe(false)
  })

  it('updates access mode', async () => {
    const { client, fetchFn } = mockClient()
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const select = document.querySelector('[data-form-share-access-mode]') as HTMLSelectElement
    expect(select).toBeTruthy()
    select.value = 'dingtalk_granted'
    select.dispatchEvent(new Event('change'))
    await flushPromises()

    const patchCalls = fetchFn.mock.calls.filter(
      (c: [string, RequestInit?]) => c[1]?.method === 'PATCH' && c[0].includes('/form-share'),
    )
    expect(patchCalls.length).toBeGreaterThan(0)
    const body = JSON.parse(String(patchCalls.at(-1)?.[1]?.body ?? '{}'))
    expect(body.accessMode).toBe('dingtalk_granted')
  })

  it('shows allowlist controls for DingTalk-protected forms', async () => {
    const { client } = mockClient(fakeConfig({ accessMode: 'dingtalk' }))
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const search = document.querySelector('[data-form-share-allowlist-search]') as HTMLInputElement
    const summary = document.querySelector('[data-form-share-allowlist-summary]') as HTMLElement
    expect(search).toBeTruthy()
    expect(search.placeholder).toBe('Search local users or member groups')
    expect(summary).toBeTruthy()
    expect(summary.getAttribute('data-user-count')).toBe('0')
    expect(summary.getAttribute('data-member-group-count')).toBe('0')
    expect(summary.textContent).toContain('No local allowlist limits are set; all users allowed by the selected DingTalk mode can fill this form.')
    expect(document.body.textContent).toContain('The form opens only after DingTalk sign-in, and the user must already be bound to a local account.')
    expect(document.body.textContent).toContain('Allowed system users and member groups')
    expect(document.body.textContent).toContain('DingTalk is only the sign-in and delivery channel. The allowlist still targets your local users and member groups.')
    expect(document.body.textContent).toContain('No local user allowlist configured. Access is still gated by the selected DingTalk mode; add local users or member groups to narrow who can fill this form.')
    expect(document.body.textContent).toContain('No local member-group allowlist configured. Add a local member group to let its members fill this form.')
    expect(document.querySelector('[data-form-share-add-subject="user:user_1"]')).toBeTruthy()
    expect(document.querySelector('[data-form-share-add-subject="member-group:group_ops"]')).toBeTruthy()
    const audience = document.querySelector('[data-form-share-audience-rule]') as HTMLElement
    expect(audience.getAttribute('data-access-mode')).toBe('dingtalk')
    expect(audience.getAttribute('data-has-local-allowlist')).toBe('false')
    expect(audience.textContent).toContain('All DingTalk-bound users')
    expect(document.body.textContent).toContain('DingTalk not bound')
    expect(document.body.textContent).toContain('Members are checked individually')
  })

  it('explains DingTalk delivery still uses local allowlists for granted mode', async () => {
    const { client } = mockClient(fakeConfig({ accessMode: 'dingtalk_granted' }))
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const summary = document.querySelector('[data-form-share-allowlist-summary]') as HTMLElement
    expect(document.querySelector('[data-form-share-allowlist-search]')).toBeTruthy()
    expect(summary).toBeTruthy()
    expect(summary.textContent).toContain('No local allowlist limits are set; all users allowed by the selected DingTalk mode can fill this form.')
    expect(document.body.textContent).toContain('The form opens only for DingTalk-bound users whose DingTalk grant is enabled by an administrator.')
    expect(document.querySelector('[data-form-share-audience-rule]')?.textContent).toContain('All authorized DingTalk users')
    expect(document.body.textContent).toContain('DingTalk is only the sign-in and delivery channel. The allowlist still targets your local users and member groups.')
    expect(document.body.textContent).toContain('No local user allowlist configured. Access is still gated by the selected DingTalk mode; add local users or member groups to narrow who can fill this form.')
    expect(document.body.textContent).toContain('DingTalk bound and authorized')
    expect(document.body.textContent).toContain('DingTalk not bound')
    expect(document.body.textContent).toContain('Members are checked individually')
  })

  it('summarizes the configured local allowlist audience', async () => {
    const { client } = mockClient(fakeConfig({
      accessMode: 'dingtalk',
      allowedUserIds: ['user_1'],
      allowedUsers: [{ subjectType: 'user', subjectId: 'user_1', label: 'Alice', subtitle: 'alice@test.local', isActive: true, dingtalkBound: true, dingtalkGrantEnabled: false, dingtalkPersonDeliveryAvailable: true }],
      allowedMemberGroupIds: ['group_ops'],
      allowedMemberGroups: [{ subjectType: 'member-group', subjectId: 'group_ops', label: 'Ops', subtitle: 'Operations', isActive: true }],
    }))
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const summary = document.querySelector('[data-form-share-allowlist-summary]') as HTMLElement
    expect(summary).toBeTruthy()
    expect(summary.getAttribute('data-user-count')).toBe('1')
    expect(summary.getAttribute('data-member-group-count')).toBe('1')
    expect(summary.textContent).toContain('Local allowlist limits: 1 local user and 1 local member group can fill after passing the selected DingTalk mode.')
    expect(document.querySelector('[data-form-share-audience-rule]')?.textContent).toContain('Selected DingTalk-bound users')
    expect(document.body.textContent).toContain('DingTalk bound')
    expect(document.body.textContent).toContain('Members are checked individually')
  })

  it('renders the full DingTalk access matrix for operators', async () => {
    const cases = [
      {
        config: fakeConfig({ accessMode: 'public' }),
        expected: {
          mode: 'public',
          hasLocalAllowlist: 'false',
          title: 'Fully public anonymous form',
          description: 'Anyone with the link can open and submit without local login or DingTalk binding.',
          allowlistVisible: false,
        },
      },
      {
        config: fakeConfig({ accessMode: 'dingtalk' }),
        expected: {
          mode: 'dingtalk',
          hasLocalAllowlist: 'false',
          title: 'All DingTalk-bound users',
          description: 'Any local user can fill after DingTalk sign-in when their account is bound to DingTalk.',
          allowlistVisible: true,
        },
      },
      {
        config: fakeConfig({
          accessMode: 'dingtalk',
          allowedUserIds: ['user_1'],
          allowedUsers: [{ subjectType: 'user', subjectId: 'user_1', label: 'Alice', subtitle: 'alice@test.local', isActive: true, dingtalkBound: true, dingtalkGrantEnabled: true, dingtalkPersonDeliveryAvailable: true }],
        }),
        expected: {
          mode: 'dingtalk',
          hasLocalAllowlist: 'true',
          title: 'Selected DingTalk-bound users',
          description: 'Only selected local users or group members can fill, and each user must be bound to DingTalk.',
          allowlistVisible: true,
        },
      },
      {
        config: fakeConfig({ accessMode: 'dingtalk_granted' }),
        expected: {
          mode: 'dingtalk_granted',
          hasLocalAllowlist: 'false',
          title: 'All authorized DingTalk users',
          description: 'Any DingTalk-bound local user can fill after an administrator enables their DingTalk form authorization.',
          allowlistVisible: true,
        },
      },
      {
        config: fakeConfig({
          accessMode: 'dingtalk_granted',
          allowedUserIds: ['user_authorized', 'user_needs_grant', 'user_unbound'],
          allowedUsers: [
            { subjectType: 'user', subjectId: 'user_authorized', label: 'Authorized User', subtitle: 'authorized@test.local', isActive: true, dingtalkBound: true, dingtalkGrantEnabled: true, dingtalkPersonDeliveryAvailable: true },
            { subjectType: 'user', subjectId: 'user_needs_grant', label: 'Needs Grant', subtitle: 'needs-grant@test.local', isActive: true, dingtalkBound: true, dingtalkGrantEnabled: false, dingtalkPersonDeliveryAvailable: true },
            { subjectType: 'user', subjectId: 'user_unbound', label: 'Unbound User', subtitle: 'unbound@test.local', isActive: true, dingtalkBound: false, dingtalkGrantEnabled: false, dingtalkPersonDeliveryAvailable: false },
          ],
          allowedMemberGroupIds: ['group_ops'],
          allowedMemberGroups: [{ subjectType: 'member-group', subjectId: 'group_ops', label: 'Ops', subtitle: 'Operations', isActive: true }],
        }),
        expected: {
          mode: 'dingtalk_granted',
          hasLocalAllowlist: 'true',
          title: 'Selected authorized DingTalk users',
          description: 'Only selected local users or group members can fill, and each user must be DingTalk-bound with form authorization enabled.',
          allowlistVisible: true,
        },
      },
    ]

    for (const item of cases) {
      document.body.innerHTML = ''
      const { client } = mockClient(item.config)
      const { app } = mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
      await flushPromises()

      const audience = document.querySelector('[data-form-share-audience-rule]') as HTMLElement
      expect(audience).toBeTruthy()
      expect(audience.getAttribute('data-access-mode')).toBe(item.expected.mode)
      expect(audience.getAttribute('data-has-local-allowlist')).toBe(item.expected.hasLocalAllowlist)
      expect(audience.textContent).toContain(item.expected.title)
      expect(audience.textContent).toContain(item.expected.description)
      expect(Boolean(document.querySelector('[data-form-share-allowlist-summary]'))).toBe(item.expected.allowlistVisible)

      app.unmount()
    }
  })

  it('shows DingTalk grant and member-group statuses for selected allowlist subjects', async () => {
    const { client } = mockClient(fakeConfig({
      accessMode: 'dingtalk_granted',
      allowedUserIds: ['user_authorized', 'user_needs_grant', 'user_unbound'],
      allowedUsers: [
        { subjectType: 'user', subjectId: 'user_authorized', label: 'Authorized User', subtitle: 'authorized@test.local', isActive: true, dingtalkBound: true, dingtalkGrantEnabled: true, dingtalkPersonDeliveryAvailable: true },
        { subjectType: 'user', subjectId: 'user_needs_grant', label: 'Needs Grant', subtitle: 'needs-grant@test.local', isActive: true, dingtalkBound: true, dingtalkGrantEnabled: false, dingtalkPersonDeliveryAvailable: true },
        { subjectType: 'user', subjectId: 'user_unbound', label: 'Unbound User', subtitle: 'unbound@test.local', isActive: true, dingtalkBound: false, dingtalkGrantEnabled: false, dingtalkPersonDeliveryAvailable: false },
      ],
      allowedMemberGroupIds: ['group_ops'],
      allowedMemberGroups: [{ subjectType: 'member-group', subjectId: 'group_ops', label: 'Ops', subtitle: 'Operations', isActive: true }],
    }))
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const statuses = Array.from(document.querySelectorAll('[data-form-share-dingtalk-status]'))
      .map((el) => el.textContent?.trim())

    expect(statuses).toContain('DingTalk bound and authorized')
    expect(statuses).toContain('DingTalk authorization not enabled')
    expect(statuses).toContain('DingTalk not bound')
    expect(statuses).toContain('Members are checked individually')
  })

  it('localizes form-share chrome to zh-CN without translating raw subjects', async () => {
    useLocale().setLocale('zh-CN')
    const { client } = mockClient(fakeConfig({
      accessMode: 'dingtalk_granted',
      allowedUserIds: ['user_authorized', 'user_needs_grant'],
      allowedUsers: [
        { subjectType: 'user', subjectId: 'user_authorized', label: 'Authorized User', subtitle: 'authorized@test.local', isActive: true, dingtalkBound: true, dingtalkGrantEnabled: true, dingtalkPersonDeliveryAvailable: true },
        { subjectType: 'user', subjectId: 'user_needs_grant', label: 'Needs Grant', subtitle: 'needs-grant@test.local', isActive: true, dingtalkBound: true, dingtalkGrantEnabled: false, dingtalkPersonDeliveryAvailable: true },
      ],
      allowedMemberGroupIds: ['group_ops'],
      allowedMemberGroups: [{ subjectType: 'member-group', subjectId: 'group_ops', label: 'Ops', subtitle: 'Operations', isActive: true }],
    }))
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const search = document.querySelector('[data-form-share-allowlist-search]') as HTMLInputElement
    const audience = document.querySelector('[data-form-share-audience-rule]') as HTMLElement
    const removeButtons = Array.from(document.querySelectorAll('[data-form-share-remove-user], [data-form-share-remove-group]'))

    expect(document.body.textContent).toContain('公开表单分享')
    expect(document.body.textContent).toContain('分享已启用')
    expect(document.body.textContent).toContain('有效')
    expect(document.body.textContent).toContain('访问模式')
    expect(document.body.textContent).toContain('仅已授权钉钉用户')
    expect(document.body.textContent).toContain('仅允许已绑定钉钉且管理员已启用钉钉授权的用户打开此表单。')
    expect(audience.textContent).toContain('已选授权钉钉用户')
    expect(audience.textContent).toContain('只有已选本地用户或组成员可以填写，且每个用户必须已绑定钉钉并启用表单授权。')
    expect(document.body.textContent).toContain('钉钉仅用于登录和投递通道；允许名单仍以本地用户和成员组为准。')
    expect(document.body.textContent).toContain('本地允许名单限制：2 个本地用户和 1 个本地成员组通过当前钉钉模式后可以填写此表单。')
    expect(search.placeholder).toBe('搜索本地用户或成员组')
    expect(document.body.textContent).toContain('允许的用户')
    expect(document.body.textContent).toContain('允许的成员组')
    expect(document.body.textContent).toContain('已绑定钉钉并已授权')
    expect(document.body.textContent).toContain('未启用钉钉授权')
    expect(document.body.textContent).toContain('成员会逐个校验')
    expect(document.body.textContent).toContain('公开链接')
    expect(document.body.textContent).toContain('复制')
    expect(document.body.textContent).toContain('重新生成令牌')
    expect(document.body.textContent).toContain('预览')
    expect(document.body.textContent).toContain('过期时间')
    expect(removeButtons.every((button) => button.textContent?.trim() === '移除')).toBe(true)
    expect(document.body.textContent).toContain('Authorized User')
    expect(document.body.textContent).toContain('Ops')
  })

  it('adds an allowed user through the allowlist controls', async () => {
    const { client, fetchFn } = mockClient(fakeConfig({ accessMode: 'dingtalk' }))
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const addUserBtn = document.querySelector('[data-form-share-add-subject="user:user_1"]') as HTMLButtonElement
    addUserBtn.click()
    await flushPromises()

    const patchCalls = fetchFn.mock.calls.filter(
      (c: [string, RequestInit?]) => c[1]?.method === 'PATCH' && c[0].includes('/form-share'),
    )
    const body = JSON.parse(String(patchCalls.at(-1)?.[1]?.body ?? '{}'))
    expect(body.allowedUserIds).toEqual(['user_1'])
  })

  it('blocks switching back to public while an allowlist is configured', async () => {
    const { client, fetchFn } = mockClient(fakeConfig({
      accessMode: 'dingtalk',
      allowedUserIds: ['user_1'],
      allowedUsers: [{ subjectType: 'user', subjectId: 'user_1', label: 'Alice', subtitle: 'alice@test.local', isActive: true }],
    }))
    mount({ visible: true, sheetId: 'sh_1', viewId: 'v_1', client })
    await flushPromises()

    const select = document.querySelector('[data-form-share-access-mode]') as HTMLSelectElement
    select.value = 'public'
    select.dispatchEvent(new Event('change'))
    await flushPromises()

    const patchCalls = fetchFn.mock.calls.filter(
      (c: [string, RequestInit?]) => c[1]?.method === 'PATCH' && c[0].includes('/form-share'),
    )
    expect(JSON.stringify(patchCalls)).not.toContain('"accessMode":"public"')
    expect(document.body.textContent).toContain('Clear the allowed users and member groups before switching back to a fully public form.')
  })
})
