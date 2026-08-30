<template>
  <section class="credit-wallet" aria-labelledby="credit-wallet-title">
    <header>
      <h2 id="credit-wallet-title">{{ text('My credits', '我的学分') }}</h2>
      <strong data-testid="elearning-credit-wallet-balance">{{ balancePoints }}</strong>
    </header>
    <p v-if="error" class="credit-wallet__error" data-testid="elearning-credit-wallet-error" role="status">{{ error }}</p>
    <p v-if="loading && items.length === 0" data-testid="elearning-credit-wallet-loading">{{ text('Loading credits...', '正在加载学分…') }}</p>
    <p v-else-if="items.length === 0 && !error" data-testid="elearning-credit-wallet-empty">{{ text('No credit history yet.', '暂无学分记录。') }}</p>
    <ul v-else data-testid="elearning-credit-wallet-items">
      <li v-for="item in items" :key="item.decisionId">
        <strong>{{ pointsLabel(item.awardedPoints) }}</strong>
        <span>{{ behaviorLabel(item.behavior) }}</span>
        <time :datetime="item.occurredAt">{{ formatDate(item.occurredAt) }}</time>
      </li>
    </ul>
    <button v-if="nextCursor" data-testid="elearning-credit-wallet-more" type="button" :disabled="loading" @click="void load(nextCursor)">
      {{ loading ? text('Loading...', '正在加载…') : text('Load more', '加载更多') }}
    </button>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useLocale } from '../composables/useLocale'
import { ElearningApiError } from '../services/elearning'
import {
  getMyElearningCreditWallet,
  type ElearningCreditBehavior,
  type ElearningCreditWalletItem,
} from '../services/elearningCredit'

const { isZh } = useLocale()
const balancePoints = ref(0)
const items = ref<ElearningCreditWalletItem[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const error = ref('')

function text(en: string, zh: string): string {
  return isZh.value ? zh : en
}

function behaviorLabel(value: ElearningCreditBehavior): string {
  const labels: Record<ElearningCreditBehavior, [string, string]> = {
    login: ['Login', '登录'],
    complete_course: ['Course completed', '完成课程'],
    complete_plan: ['Plan completed', '完成计划'],
    pass_exam: ['Exam passed', '考试通过'],
    submit_survey: ['Survey submitted', '提交问卷'],
    complete_map: ['Learning map completed', '完成学习地图'],
    complete_offline: ['Offline activity completed', '完成线下活动'],
    manual_adjust: ['Manual adjustment', '人工调整'],
  }
  const [en, zh] = labels[value]
  return text(en, zh)
}

function pointsLabel(value: number): string {
  return value > 0 ? `+${value}` : String(value)
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(isZh.value ? 'zh-CN' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function errorText(value: unknown): string {
  if (value instanceof ElearningApiError) {
    if (value.status === 403) return text('You cannot read this wallet.', '您无权查看该学分钱包。')
    if (value.status === 404) return text('Your wallet is unavailable.', '当前无法查看您的学分钱包。')
  }
  return text('Unable to load credits. Try again.', '无法加载学分，请重试。')
}

async function load(cursor: string | null): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const result = await getMyElearningCreditWallet(cursor)
    balancePoints.value = result.balancePoints
    items.value = cursor === null ? result.items : [...items.value, ...result.items]
    nextCursor.value = result.nextCursor
  } catch (value) {
    error.value = errorText(value)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load(null)
})
</script>

<style scoped>
.credit-wallet {
  display: grid;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid #cbd9e8;
  border-radius: 10px;
  background: #f8fbff;
}
.credit-wallet header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
.credit-wallet h2,
.credit-wallet p { margin: 0; }
.credit-wallet header strong { font-size: 1.7rem; color: #0b63ce; }
.credit-wallet ul { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.credit-wallet li { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; }
.credit-wallet__error { color: #b42318; }
.credit-wallet button { min-height: 36px; }
</style>
