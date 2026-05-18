<template>
  <section class="multitable-home">
    <header class="multitable-home__hero">
      <div>
        <p class="multitable-home__eyebrow">Multitable</p>
        <h1>多维表</h1>
        <p class="multitable-home__subtitle">
          打开 Base、继续清洗表或从模板开始。Grid 和 Spreadsheets 仍保留旧链接，但默认工作入口收敛到多维表。
        </p>
      </div>
      <button class="multitable-home__refresh" :disabled="loading" @click="loadBases">
        {{ loading ? '刷新中...' : '刷新' }}
      </button>
    </header>

    <section class="multitable-home__create" aria-label="Create multitable base">
      <div>
        <strong>新建 Base</strong>
        <span>创建一个带默认 Sheet 和 Grid 视图的多维表工作区。</span>
      </div>
      <form class="multitable-home__create-form" @submit.prevent="createBaseAndOpen">
        <input
          v-model="newBaseName"
          class="multitable-home__input"
          maxlength="255"
          placeholder="例如：项目跟进"
          aria-label="Base name"
        />
        <button class="multitable-home__primary" :disabled="creating">
          {{ creating ? '创建中...' : '创建并打开' }}
        </button>
      </form>
    </section>

    <p v-if="errorMessage" class="multitable-home__error" role="alert">{{ errorMessage }}</p>

    <section class="multitable-home__panel">
      <div class="multitable-home__panel-head">
        <h2>可访问的 Base</h2>
        <span>{{ bases.length }} 个</span>
      </div>

      <div v-if="loading" class="multitable-home__state">正在加载多维表...</div>
      <div v-else-if="!bases.length" class="multitable-home__empty">
        暂无可访问的 Base。你可以新建一个，或从数据工厂/考勤等业务入口生成多维表。
      </div>
      <div v-else class="multitable-home__grid">
        <article v-for="base in bases" :key="base.id" class="multitable-home__card">
          <div class="multitable-home__card-icon" :style="{ background: base.color || '#2563eb' }">
            {{ base.icon || base.name.slice(0, 1).toUpperCase() }}
          </div>
          <div class="multitable-home__card-body">
            <h3>{{ base.name }}</h3>
            <small>{{ base.id }}</small>
          </div>
          <button
            class="multitable-home__open"
            :disabled="openingBaseId === base.id"
            @click="openBase(base)"
          >
            {{ openingBaseId === base.id ? '打开中...' : '打开' }}
          </button>
        </article>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { multitableClient } from '../multitable/api/client'
import type { MetaBase, MetaContext, MetaSheet, MetaView } from '../multitable/types'
import { AppRouteNames } from '../router/types'

const router = useRouter()

const bases = ref<MetaBase[]>([])
const loading = ref(false)
const creating = ref(false)
const openingBaseId = ref<string | null>(null)
const errorMessage = ref('')
const newBaseName = ref('')

function resolveOpenTarget(context: MetaContext): { sheet: MetaSheet; view: MetaView } | null {
  const sheet = context.sheet ?? context.sheets[0] ?? null
  if (!sheet) return null
  const view = context.views.find((candidate) => candidate.sheetId === sheet.id) ?? context.views[0] ?? null
  return view ? { sheet, view } : null
}

async function loadBases(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    const data = await multitableClient.listBases()
    bases.value = data.bases ?? []
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '加载多维表失败'
  } finally {
    loading.value = false
  }
}

async function openBase(base: MetaBase): Promise<void> {
  openingBaseId.value = base.id
  errorMessage.value = ''
  try {
    const context = await multitableClient.loadContext({ baseId: base.id })
    const target = resolveOpenTarget(context)
    if (!target) {
      errorMessage.value = '这个 Base 还没有可打开的 Sheet 或 View。'
      return
    }
    await router.push({
      name: AppRouteNames.MULTITABLE,
      params: { sheetId: target.sheet.id, viewId: target.view.id },
      query: { baseId: base.id },
    })
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '打开多维表失败'
  } finally {
    openingBaseId.value = null
  }
}

async function createBaseAndOpen(): Promise<void> {
  if (creating.value) return
  creating.value = true
  errorMessage.value = ''
  try {
    const name = newBaseName.value.trim() || 'Untitled Base'
    const { base } = await multitableClient.createBase({ name })
    const { sheet } = await multitableClient.createSheet({ baseId: base.id, name: 'Sheet 1', seed: true })
    const context = await multitableClient.loadContext({ baseId: base.id, sheetId: sheet.id })
    const target = resolveOpenTarget(context)
    if (!target) {
      errorMessage.value = 'Base 已创建，但默认视图尚未就绪。请刷新后重试。'
      await loadBases()
      return
    }
    await router.push({
      name: AppRouteNames.MULTITABLE,
      params: { sheetId: target.sheet.id, viewId: target.view.id },
      query: { baseId: base.id },
    })
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '创建多维表失败'
  } finally {
    creating.value = false
  }
}

onMounted(loadBases)
</script>

<style scoped>
.multitable-home {
  min-height: calc(100vh - 64px);
  padding: 32px;
  background:
    radial-gradient(circle at 12% 8%, rgba(37, 99, 235, 0.12), transparent 28%),
    linear-gradient(135deg, #f8fafc 0%, #eef2ff 48%, #f8fafc 100%);
  color: #0f172a;
}

.multitable-home__hero,
.multitable-home__create,
.multitable-home__panel {
  max-width: 1120px;
  margin: 0 auto;
}

.multitable-home__hero {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  align-items: flex-start;
}

.multitable-home__eyebrow {
  margin: 0 0 8px;
  color: #2563eb;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.multitable-home h1 {
  margin: 0;
  font-size: clamp(32px, 5vw, 58px);
  line-height: 0.95;
}

.multitable-home__subtitle {
  max-width: 720px;
  margin: 16px 0 0;
  color: #475569;
  font-size: 16px;
  line-height: 1.7;
}

.multitable-home__refresh,
.multitable-home__primary,
.multitable-home__open {
  border: 0;
  border-radius: 999px;
  padding: 10px 16px;
  font-weight: 700;
  cursor: pointer;
}

.multitable-home__refresh {
  background: #fff;
  color: #1e293b;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
}

.multitable-home__create {
  margin-top: 28px;
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: center;
  border: 1px solid rgba(148, 163, 184, 0.4);
  border-radius: 24px;
  padding: 18px;
  background: rgba(255, 255, 255, 0.76);
  backdrop-filter: blur(14px);
}

.multitable-home__create strong,
.multitable-home__create span {
  display: block;
}

.multitable-home__create span {
  margin-top: 4px;
  color: #64748b;
  font-size: 13px;
}

.multitable-home__create-form {
  display: flex;
  gap: 10px;
  min-width: min(460px, 100%);
}

.multitable-home__input {
  flex: 1;
  min-width: 0;
  border: 1px solid #cbd5e1;
  border-radius: 999px;
  padding: 10px 14px;
  font-size: 14px;
}

.multitable-home__primary,
.multitable-home__open {
  background: #2563eb;
  color: #fff;
}

.multitable-home__panel {
  margin-top: 24px;
  border: 1px solid rgba(148, 163, 184, 0.36);
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.82);
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.08);
  overflow: hidden;
}

.multitable-home__panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 22px 24px;
  border-bottom: 1px solid #e2e8f0;
}

.multitable-home__panel-head h2 {
  margin: 0;
  font-size: 18px;
}

.multitable-home__state,
.multitable-home__empty {
  padding: 32px 24px;
  color: #64748b;
}

.multitable-home__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 14px;
  padding: 18px;
}

.multitable-home__card {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 12px;
  align-items: center;
  border: 1px solid #e2e8f0;
  border-radius: 18px;
  padding: 14px;
  background: #fff;
}

.multitable-home__card-icon {
  width: 42px;
  height: 42px;
  border-radius: 14px;
  display: grid;
  place-items: center;
  color: #fff;
  font-weight: 800;
}

.multitable-home__card-body h3 {
  margin: 0;
  font-size: 15px;
}

.multitable-home__card-body small {
  color: #64748b;
}

.multitable-home__error {
  max-width: 1120px;
  margin: 18px auto 0;
  border: 1px solid #fecaca;
  border-radius: 16px;
  padding: 12px 14px;
  background: #fef2f2;
  color: #b91c1c;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.62;
}

@media (max-width: 760px) {
  .multitable-home {
    padding: 20px;
  }

  .multitable-home__hero,
  .multitable-home__create {
    display: grid;
  }

  .multitable-home__create-form {
    min-width: 0;
    display: grid;
  }
}
</style>
