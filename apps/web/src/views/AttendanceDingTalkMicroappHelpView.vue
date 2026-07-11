<template>
  <PageShell width="default">
    <PageHeader
      title="钉钉 H5 微应用配置帮助"
      subtitle="用于考勤手机端免登、通知深链和真机验收的后台配置说明"
      back-to="/admin/directory"
      back-label="返回目录同步"
    />

    <section class="dingtalk-help__notice" data-testid="dingtalk-help-notice">
      <strong>填写前先确认一个公网 HTTPS 地址。</strong>
      下文统一用 <code>&lt;HTTPS_APP_URL&gt;</code> 表示，例如
      <code>https://example.com</code>；只填域名的地方用
      <code>&lt;DOMAIN_ONLY&gt;</code>，不要带 <code>https://</code>。
      本页配置路径已按 2026-07-09 的钉钉后台真机登录验证整理。
    </section>

    <section class="dingtalk-help__grid" data-testid="dingtalk-help-checklist">
      <article
        v-for="item in checklist"
        :key="item.title"
        class="dingtalk-help__card"
      >
        <span class="dingtalk-help__eyebrow">{{ item.area }}</span>
        <h2>{{ item.title }}</h2>
        <p>{{ item.description }}</p>
        <dl>
          <template v-for="field in item.fields" :key="field.label">
            <dt>{{ field.label }}</dt>
            <dd><code>{{ field.value }}</code></dd>
          </template>
        </dl>
      </article>
    </section>

    <section class="dingtalk-help__section" data-testid="dingtalk-help-steps">
      <h2>操作顺序</h2>
      <ol class="dingtalk-help__steps">
        <li v-for="step in steps" :key="step.title">
          <strong>{{ step.title }}</strong>
          <span>{{ step.body }}</span>
        </li>
      </ol>
    </section>

    <section class="dingtalk-help__section" data-testid="dingtalk-help-permissions">
      <h2>权限管理清单</h2>
      <p>
        登录链路最低要保证通讯录读权限和免登基础权限可用；通知深链只有在需要发送工作通知卡片时才要求开通。
      </p>
      <div class="dingtalk-help__table-wrap">
        <table class="dingtalk-help__table">
          <thead>
            <tr>
              <th>用途</th>
              <th>后台权限 / 控制项</th>
              <th>系统调用</th>
              <th>要求</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="permission in permissions" :key="permission.api">
              <td>{{ permission.purpose }}</td>
              <td>{{ permission.consoleLabel }}</td>
              <td><code>{{ permission.api }}</code></td>
              <td>{{ permission.requirement }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="dingtalk-help__section" data-testid="dingtalk-help-screenshots">
      <h2>后台位置截图（已脱敏）</h2>
      <p>
        截图只保留字段位置和填写形态；应用 ID、AgentId、发布人、真实域名均已遮罩。
      </p>
      <div class="dingtalk-help__screenshots">
        <figure v-for="shot in screenshots" :key="shot.caption">
          <img :src="shot.src" :alt="shot.caption" loading="lazy" />
          <figcaption>{{ shot.caption }}</figcaption>
        </figure>
      </div>
    </section>

    <section class="dingtalk-help__section" data-testid="dingtalk-help-troubleshooting">
      <h2>常见错误</h2>
      <details
        v-for="item in troubleshooting"
        :key="item.title"
        class="dingtalk-help__faq"
      >
        <summary>{{ item.title }}</summary>
        <p>{{ item.body }}</p>
      </details>
    </section>
  </PageShell>
</template>

<script setup lang="ts">
import PageHeader from '../components/layout/PageHeader.vue'
import PageShell from '../components/layout/PageShell.vue'
import h5HomeScreenshot from '../assets/help/dingtalk/dingtalk-h5-home-redacted.png'
import securityScreenshot from '../assets/help/dingtalk/dingtalk-security-saved-redacted.png'
import permissionsScreenshot from '../assets/help/dingtalk/dingtalk-contact-user-read-opened-redacted.png'
import publishedScreenshot from '../assets/help/dingtalk/dingtalk-version-published-redacted.png'

type ChecklistItem = {
  area: string
  title: string
  description: string
  fields: Array<{ label: string; value: string }>
}

const checklist: ChecklistItem[] = [
  {
    area: '应用能力 → 网页应用',
    title: 'H5 首页',
    description: '移动端和 PC 端首页都指向考勤入口；企业内部应用 AgentId 可同步填入本系统目录集成的工作通知 Agent ID。',
    fields: [
      { label: '移动端首页地址', value: '<HTTPS_APP_URL>/attendance' },
      { label: 'PC端首页地址', value: '<HTTPS_APP_URL>/attendance' },
    ],
  },
  {
    area: '开发配置 → 安全设置',
    title: '回调与可信域名',
    description: '当前钉钉后台不一定直接叫“H5 安全域名 / JSAPI 安全域名”；按页面实际字段填写下面四项。',
    fields: [
      { label: '重定向URL（回调域名）', value: '<HTTPS_APP_URL>,<HTTPS_APP_URL>/login/dingtalk/callback' },
      { label: '端内免登地址', value: '<HTTPS_APP_URL>/attendance' },
      { label: 'HTTP 可信域名', value: '<DOMAIN_ONLY>' },
      { label: 'Webview 可信域名', value: '<DOMAIN_ONLY>' },
    ],
  },
  {
    area: '开发配置 → 权限管理',
    title: 'API 权限',
    description: '钉钉登录和端内免登至少需要通讯录个人信息读权限；通知卡片还需要工作通知发送权限。',
    fields: [
      { label: '通讯录个人信息读权限', value: 'Contact.User.Read → 已开通' },
      { label: 'SNS 基础权限', value: 'snsapi_base → 默认开通' },
    ],
  },
  {
    area: '应用发布 → 版本管理与发布',
    title: '发布版本',
    description: '保存配置后必须创建并发布新版本，否则钉钉手机端仍使用旧配置。',
    fields: [
      { label: '版本状态', value: '已上线' },
      { label: '可见范围', value: '全部员工（或按企业策略选择）' },
    ],
  },
]

const permissions = [
  {
    purpose: '网页 OAuth 登录',
    consoleLabel: '通讯录个人信息读权限 / Contact.User.Read',
    api: '/v1.0/contact/users/me',
    requirement: '必开。未开通时通常表现为“没有调用该接口的权限”。',
  },
  {
    purpose: '钉钉端内免登',
    consoleLabel: 'SNS 基础权限 / snsapi_base；若权限页出现“免登授权码获取用户身份”也一并开通',
    api: '/topapi/v2/user/getuserinfo',
    requirement: '必需可用。当前后台通常默认开通 snsapi_base。',
  },
  {
    purpose: '免登后补齐用户详情',
    consoleLabel: '通讯录个人信息读权限 / Contact.User.Read',
    api: '/topapi/v2/user/get',
    requirement: '必开。用于从 userid 回查 unionId、姓名、手机号等稳定身份信息。',
  },
  {
    purpose: '权限范围',
    consoleLabel: '通讯录接口权限范围',
    api: '全部员工 / 部分员工',
    requirement: '测试用户必须落在可访问范围内；不确定时先选“全部员工”完成 E4 验证。',
  },
  {
    purpose: '通知深链 / actionCard',
    consoleLabel: '工作通知 / 企业会话消息发送权限（按权限页搜索“工作通知”或“消息”）',
    api: '/topapi/message/corpconversation/asyncsend_v2',
    requirement: '需要发送考勤工作通知时开通；只验证手机登录时不是硬前置。',
  },
]

const steps = [
  {
    title: '1. 配网页应用首页',
    body: '进入“应用能力 → 网页应用”，把移动端首页地址和 PC 端首页地址都填成 <HTTPS_APP_URL>/attendance。',
  },
  {
    title: '2. 配安全设置',
    body: '进入“开发配置 → 安全设置”，填写重定向URL、端内免登地址、HTTP 可信域名和 Webview 可信域名，然后保存。',
  },
  {
    title: '3. 开 API 权限',
    body: '进入“开发配置 → 权限管理”，搜索或定位“通讯录个人信息读权限 / Contact.User.Read”，点“立即开通”。',
  },
  {
    title: '4. 发布新版本',
    body: '进入“应用发布 → 版本管理与发布”，创建新版本，保存后确认发布；看到最新版本“已上线”才算生效。',
  },
  {
    title: '5. 手机真机验证',
    body: '在钉钉手机端打开微应用，确认能免登进入考勤页；若仍失败，先核对回调地址和 Contact.User.Read 权限。',
  },
]

const screenshots = [
  { caption: '网页应用：移动端 / PC 端首页地址', src: h5HomeScreenshot },
  { caption: '安全设置：回调、端内免登、HTTP/Webview 可信域名', src: securityScreenshot },
  { caption: '权限管理：Contact.User.Read 已开通', src: permissionsScreenshot },
  { caption: '版本管理与发布：新版本已上线', src: publishedScreenshot },
]

const troubleshooting = [
  {
    title: '手机端提示 redirect_uri 参数错误',
    body: '优先检查“重定向URL（回调域名）”是否包含 <HTTPS_APP_URL>/login/dingtalk/callback，并确认保存后已经发布新版本。',
  },
  {
    title: '页面只显示“钉钉登录失败，请稍后再试”',
    body: '优先检查“权限管理”里的 Contact.User.Read 是否已开通；后端日志通常会出现“没有调用该接口的权限”。',
  },
  {
    title: '后台字段名和旧文档里的 H5/JSAPI 安全域名不一样',
    body: '按当前后台实际字段填：端内免登地址、HTTP 可信域名、Webview 可信域名；域名字段只填主机名，不带协议。',
  },
]
</script>

<style scoped>
.dingtalk-help__notice,
.dingtalk-help__card,
.dingtalk-help__section {
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-surface);
}

.dingtalk-help__notice {
  margin-bottom: var(--ms-space-4);
  padding: var(--ms-space-3) var(--ms-space-4);
  color: var(--ms-text-2);
  line-height: 1.7;
}

.dingtalk-help__notice strong {
  color: var(--ms-text-1);
}

.dingtalk-help__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--ms-space-4);
  margin-bottom: var(--ms-space-4);
}

.dingtalk-help__card {
  padding: var(--ms-space-4);
}

.dingtalk-help__eyebrow {
  display: block;
  margin-bottom: var(--ms-space-2);
  color: var(--ms-text-3);
  font-size: 12px;
}

.dingtalk-help__card h2,
.dingtalk-help__section h2 {
  margin: 0 0 var(--ms-space-3);
  color: var(--ms-text-1);
  font-size: var(--ms-font-size-section-title);
}

.dingtalk-help__card p,
.dingtalk-help__section p,
.dingtalk-help__steps span,
.dingtalk-help__faq p {
  color: var(--ms-text-2);
  line-height: 1.65;
}

.dingtalk-help__card p {
  margin: 0 0 var(--ms-space-3);
}

.dingtalk-help__card dl {
  margin: 0;
  display: grid;
  gap: var(--ms-space-2);
}

.dingtalk-help__card dt {
  color: var(--ms-text-3);
  font-size: 12px;
}

.dingtalk-help__card dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.dingtalk-help__section {
  margin-bottom: var(--ms-space-4);
  padding: var(--ms-space-4);
}

.dingtalk-help__steps {
  margin: 0;
  padding-left: var(--ms-space-5);
}

.dingtalk-help__steps li {
  margin-bottom: var(--ms-space-3);
}

.dingtalk-help__steps strong {
  display: block;
  color: var(--ms-text-1);
}

.dingtalk-help__screenshots {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--ms-space-4);
}

.dingtalk-help__screenshots figure {
  margin: 0;
}

.dingtalk-help__screenshots img {
  display: block;
  width: 100%;
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
}

.dingtalk-help__screenshots figcaption {
  margin-top: var(--ms-space-2);
  color: var(--ms-text-3);
  font-size: 12px;
}

.dingtalk-help__faq {
  padding: var(--ms-space-2) 0;
  border-bottom: 1px solid var(--ms-border-light);
}

.dingtalk-help__faq:last-child {
  border-bottom: 0;
}

.dingtalk-help__faq summary {
  cursor: pointer;
  color: var(--ms-text-1);
  font-weight: var(--ms-font-weight-title);
}

.dingtalk-help__faq p {
  margin: var(--ms-space-2) 0 0;
}

@media (max-width: 900px) {
  .dingtalk-help__grid,
  .dingtalk-help__screenshots {
    grid-template-columns: 1fr;
  }
}
</style>
