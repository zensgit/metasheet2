<template>
  <section
    v-if="manualAdmissionResult || autoAdmissionOnboardingPackets.length > 0 || batchAdmissionOnboardingPackets.length > 0"
    class="directory-admin__operation-results"
    data-testid="directory-operation-results"
    aria-label="本次操作结果"
  >
    <header class="directory-admin__section-head directory-admin__operation-results-head">
      <div>
        <h2>本次操作结果</h2>
        <p class="directory-admin__hint">临时凭据仅保留在本次页面中，关闭或刷新后不再显示。请通过安全渠道交付。</p>
      </div>
      <button class="directory-admin__button directory-admin__button--secondary" type="button" @click="dismissResults()">
        关闭全部结果
      </button>
    </header>
    <article v-if="manualAdmissionResult" class="directory-admin__progress-card">
      <div class="directory-admin__section-head">
        <div>
          <h2>最近创建并绑定结果</h2>
          <p
            v-if="manualAdmissionResult.integrationName && manualAdmissionResult.integrationName.trim()"
            class="directory-admin__hint"
            data-testid="directory-operation-result-manual-integration"
          >所属集成：{{ manualAdmissionResult.integrationName }}</p>
          <p class="directory-admin__hint">
            {{
              manualAdmissionResult.bound
                ? `已为目录成员 ${manualAdmissionResult.accountName} 创建本地用户并完成绑定。`
                : `已为目录成员 ${manualAdmissionResult.accountName} 创建本地用户，但目录绑定仍需继续处理。`
            }}
          </p>
        </div>
        <div class="directory-admin__actions">
          <router-link
            class="directory-admin__button directory-admin__button--secondary"
            :to="buildUserManagementLocation(manualAdmissionResult.userId, { id: manualAdmissionResult.accountId, integrationId: manualAdmissionResult.integrationId })"
          >
            查看本地用户
          </router-link>
          <button class="directory-admin__button directory-admin__button--secondary" type="button" @click="clearManualAdmissionResult()">
            关闭结果
          </button>
        </div>
      </div>
      <div class="directory-admin__account-grid">
        <div>
          <strong>本地用户</strong>
          <div>{{ manualAdmissionResult.userName || manualAdmissionResult.email || manualAdmissionResult.username || manualAdmissionResult.mobile || manualAdmissionResult.userId }}</div>
        </div>
        <div>
          <strong>登录账号</strong>
          <div>{{ manualAdmissionResult.email || manualAdmissionResult.username || manualAdmissionResult.mobile || manualAdmissionResult.userId }}</div>
        </div>
        <div>
          <strong>用户 ID</strong>
          <div>{{ manualAdmissionResult.userId }}</div>
        </div>
        <div>
          <strong>手机号</strong>
          <div>{{ manualAdmissionResult.mobile || '未填写' }}</div>
        </div>
      </div>
      <p v-if="manualAdmissionResult.temporaryPassword" class="directory-admin__status">
        新用户临时密码：{{ manualAdmissionResult.temporaryPassword }}
      </p>
      <p v-if="manualAdmissionResult.mobileBackfillError" class="directory-admin__status directory-admin__status--error">
        手机号未自动回填：{{ manualAdmissionResult.mobileBackfillError }}
      </p>
      <p v-else-if="manualAdmissionResult.mobile" class="directory-admin__hint">
        {{ manualAdmissionResult.mobileBackfilled ? '目录手机号已回填到新用户资料。' : '目录手机号未回填到新用户资料。' }}
      </p>
      <p v-if="manualAdmissionResult.bindError" class="directory-admin__status directory-admin__status--error">
        目录绑定未完成：{{ manualAdmissionResult.bindError }}
      </p>
      <p v-if="manualAdmissionResult.onboarding?.acceptInviteUrl" class="directory-admin__hint">
        邀请链接：
        <a :href="manualAdmissionResult.onboarding.acceptInviteUrl" target="_blank" rel="noreferrer">
          {{ manualAdmissionResult.onboarding.acceptInviteUrl }}
        </a>
      </p>
      <pre v-if="manualAdmissionResult.onboarding?.inviteMessage" class="directory-admin__invite">
{{ manualAdmissionResult.onboarding.inviteMessage }}
      </pre>
    </article>

    <article v-if="autoAdmissionOnboardingPackets.length > 0" class="directory-admin__progress-card">
      <div class="directory-admin__section-head">
        <div>
          <h2>本次自动准入临时凭据</h2>
          <p class="directory-admin__hint">以下无邮箱目录成员已自动创建本地用户，请通过安全渠道下发登录账号与临时密码。</p>
        </div>
        <div class="directory-admin__actions">
          <button class="directory-admin__button directory-admin__button--secondary" type="button" @click="clearAutoAdmissionOnboardingPackets()">
            关闭结果
          </button>
        </div>
      </div>

      <article
        v-for="packet in autoAdmissionOnboardingPackets"
        :key="packet.userId"
        class="directory-admin__review-admission"
      >
        <p
          v-if="packet.integrationName && packet.integrationName.trim()"
          class="directory-admin__hint"
          data-testid="directory-operation-result-auto-integration"
        >所属集成：{{ packet.integrationName }}</p>
        <div class="directory-admin__account-grid">
          <div>
            <strong>本地用户</strong>
            <div>{{ packet.name || packet.email || packet.username || packet.mobile || packet.userId }}</div>
          </div>
          <div>
            <strong>登录账号</strong>
            <div>{{ packet.email || packet.username || packet.mobile || packet.userId }}</div>
          </div>
          <div>
            <strong>用户 ID</strong>
            <div>{{ packet.userId }}</div>
          </div>
          <div>
            <strong>手机号</strong>
            <div>{{ packet.mobile || '未填写' }}</div>
          </div>
        </div>
        <p class="directory-admin__status">
          临时密码：{{ packet.temporaryPassword }}
        </p>
        <p v-if="packet.onboarding?.acceptInviteUrl" class="directory-admin__hint">
          邀请链接：
          <a :href="packet.onboarding.acceptInviteUrl" target="_blank" rel="noreferrer">
            {{ packet.onboarding.acceptInviteUrl }}
          </a>
        </p>
        <p v-else class="directory-admin__hint">
          该账号未生成邀请链接，请直接分发登录账号和临时密码。
        </p>
        <pre v-if="packet.onboarding?.inviteMessage" class="directory-admin__invite">
{{ packet.onboarding.inviteMessage }}
        </pre>
      </article>
    </article>

    <article v-if="batchAdmissionOnboardingPackets.length > 0" class="directory-admin__progress-card">
      <div class="directory-admin__section-head">
        <div>
          <h2>批量创建临时凭据</h2>
          <p class="directory-admin__hint">以下目录成员已批量创建本地用户并完成绑定。扫码登录授权默认未开启，请先通过安全渠道下发登录账号与临时密码。</p>
        </div>
        <div class="directory-admin__actions">
          <button class="directory-admin__button directory-admin__button--secondary" type="button" @click="clearBatchAdmissionOnboardingPackets()">
            关闭结果
          </button>
        </div>
      </div>

      <article
        v-for="packet in batchAdmissionOnboardingPackets"
        :key="packet.userId"
        class="directory-admin__review-admission"
      >
        <p
          v-if="packet.integrationName && packet.integrationName.trim()"
          class="directory-admin__hint"
          data-testid="directory-operation-result-batch-integration"
        >所属集成：{{ packet.integrationName }}</p>
        <div class="directory-admin__account-grid">
          <div>
            <strong>本地用户</strong>
            <div>{{ packet.name || packet.email || packet.username || packet.mobile || packet.userId }}</div>
          </div>
          <div>
            <strong>登录账号</strong>
            <div>{{ packet.email || packet.username || packet.mobile || packet.userId }}</div>
          </div>
          <div>
            <strong>用户 ID</strong>
            <div>{{ packet.userId }}</div>
          </div>
          <div>
            <strong>手机号</strong>
            <div>{{ packet.mobile || '未填写' }}</div>
          </div>
        </div>
        <p class="directory-admin__status">
          临时密码：{{ packet.temporaryPassword }}
        </p>
        <p v-if="packet.onboarding?.acceptInviteUrl" class="directory-admin__hint">
          邀请链接：
          <a :href="packet.onboarding.acceptInviteUrl" target="_blank" rel="noreferrer">
            {{ packet.onboarding.acceptInviteUrl }}
          </a>
        </p>
        <p v-else class="directory-admin__hint">
          该账号未生成邀请链接，请直接分发登录账号和临时密码。
        </p>
        <pre v-if="packet.onboarding?.inviteMessage" class="directory-admin__invite">
{{ packet.onboarding.inviteMessage }}
        </pre>
      </article>
    </article>

  </section>
</template>

<script setup lang="ts">
import { inject } from 'vue'
import { directoryManagementKey } from './useDirectoryManagement'

const {
  autoAdmissionOnboardingPackets,
  batchAdmissionOnboardingPackets,
  buildUserManagementLocation,
  clearAutoAdmissionOnboardingPackets,
  clearBatchAdmissionOnboardingPackets,
  clearManualAdmissionResult,
  manualAdmissionResult,
} = inject(directoryManagementKey)!

function dismissResults() {
  clearManualAdmissionResult()
  clearAutoAdmissionOnboardingPackets()
  clearBatchAdmissionOnboardingPackets()
}
</script>

<style scoped src="./directory-admin.css"></style>
