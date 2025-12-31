<template>
  <div class="plm-page">
    <section class="panel">
      <div class="panel-header">
        <div>
          <h1>PLM 产品详情</h1>
          <p class="subtext">联邦接口：产品详情、BOM、where-used、BOM 对比、替代件</p>
          <p class="hint">需要鉴权时请先在 localStorage 写入 auth_token，或开启后端 RBAC_BYPASS。</p>
        </div>
        <button class="btn" @click="resetAll">重置</button>
      </div>

      <div class="form-grid">
        <label>
          产品 ID
          <input v-model.trim="productId" placeholder="输入 PLM 产品 ID" />
        </label>
        <label>
          Item Type
          <input v-model.trim="itemType" placeholder="Part" />
        </label>
        <button class="btn primary" :disabled="!productId || productLoading" @click="loadProduct">
          {{ productLoading ? '加载中...' : '加载产品' }}
        </button>
      </div>

      <p v-if="productError" class="status error">{{ productError }}</p>

      <div v-if="product" class="detail-grid">
        <div>
          <span>名称</span>
          <strong>{{ product.name || '-' }}</strong>
        </div>
        <div>
          <span>料号</span>
          <strong>{{ product.partNumber || product.code || '-' }}</strong>
        </div>
        <div>
          <span>版本</span>
          <strong>{{ product.revision || product.version || '-' }}</strong>
        </div>
        <div>
          <span>状态</span>
          <strong>{{ product.status || '-' }}</strong>
        </div>
        <div>
          <span>类型</span>
          <strong>{{ product.itemType || '-' }}</strong>
        </div>
        <div>
          <span>更新时间</span>
          <strong>{{ product.updatedAt || '-' }}</strong>
        </div>
      </div>

      <p v-if="product?.description" class="description">{{ product.description }}</p>

      <details v-if="product" class="json-block">
        <summary>原始数据</summary>
        <pre>{{ formatJson(product) }}</pre>
      </details>
    </section>

    <section class="panel">
      <div class="panel-header">
        <h2>BOM 结构</h2>
        <button class="btn" :disabled="!productId || bomLoading" @click="loadBom">
          {{ bomLoading ? '加载中...' : '刷新 BOM' }}
        </button>
      </div>
      <p v-if="bomError" class="status error">{{ bomError }}</p>
      <div v-if="!bomItems.length" class="empty">暂无 BOM 数据</div>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>层级</th>
            <th>组件编码</th>
            <th>组件名称</th>
            <th>数量</th>
            <th>单位</th>
            <th>序号</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in bomItems" :key="item.id">
            <td>{{ item.level }}</td>
            <td>{{ item.component_code || item.component_id }}</td>
            <td>{{ item.component_name }}</td>
            <td>{{ item.quantity }}</td>
            <td>{{ item.unit }}</td>
            <td>{{ item.sequence }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-header">
        <h2>Where-Used</h2>
        <button class="btn" :disabled="!whereUsedItemId || whereUsedLoading" @click="loadWhereUsed">
          {{ whereUsedLoading ? '加载中...' : '查询' }}
        </button>
      </div>
      <div class="form-grid compact">
        <label>
          子件 ID
          <input v-model.trim="whereUsedItemId" placeholder="输入子件 ID" />
        </label>
        <label>
          递归
          <select v-model="whereUsedRecursive">
            <option :value="true">是</option>
            <option :value="false">否</option>
          </select>
        </label>
        <label>
          最大层级
          <input v-model.number="whereUsedMaxLevels" type="number" min="1" max="20" />
        </label>
      </div>
      <p v-if="whereUsedError" class="status error">{{ whereUsedError }}</p>
      <div v-if="!whereUsed" class="empty">暂无 where-used 数据</div>
      <div v-else>
        <p class="status">共 {{ whereUsed.count || 0 }} 条</p>
        <table v-if="whereUsed.parents?.length" class="data-table">
          <thead>
            <tr>
              <th>层级</th>
              <th>父件</th>
              <th>父件编号</th>
              <th>关系 ID</th>
              <th>数量</th>
              <th>Find #</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(entry, idx) in whereUsed.parents" :key="idx">
              <td>{{ entry.level }}</td>
              <td>{{ entry.parent?.name || '-' }}</td>
              <td>{{ entry.parent?.item_number || entry.parent?.itemNumber || '-' }}</td>
              <td>{{ entry.relationship?.id || '-' }}</td>
              <td>{{ entry.relationship?.quantity ?? '-' }}</td>
              <td>{{ entry.relationship?.find_num ?? '-' }}</td>
            </tr>
          </tbody>
        </table>
        <details class="json-block">
          <summary>原始数据</summary>
          <pre>{{ formatJson(whereUsed) }}</pre>
        </details>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <h2>BOM 对比</h2>
        <button class="btn" :disabled="!compareLeftId || !compareRightId || compareLoading" @click="loadBomCompare">
          {{ compareLoading ? '加载中...' : '对比' }}
        </button>
      </div>
      <div class="form-grid">
        <label>
          左侧 ID
          <input v-model.trim="compareLeftId" placeholder="左侧 item/version ID" />
        </label>
        <label>
          右侧 ID
          <input v-model.trim="compareRightId" placeholder="右侧 item/version ID" />
        </label>
        <label>
          最大层级
          <input v-model.number="compareMaxLevels" type="number" min="-1" max="20" />
        </label>
        <label>
          Compare Mode
          <input v-model.trim="compareMode" placeholder="only_product / summarized / num_qty" />
        </label>
      </div>
      <p v-if="compareError" class="status error">{{ compareError }}</p>
      <div v-if="!bomCompare" class="empty">暂无对比数据</div>
      <div v-else>
        <div class="summary-row">
          <span>新增: {{ bomCompare.summary?.added ?? 0 }}</span>
          <span>删除: {{ bomCompare.summary?.removed ?? 0 }}</span>
          <span>变更: {{ bomCompare.summary?.changed ?? 0 }}</span>
        </div>
        <details class="json-block">
          <summary>详细结果</summary>
          <pre>{{ formatJson(bomCompare) }}</pre>
        </details>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <h2>替代件</h2>
        <button class="btn" :disabled="!bomLineId || substitutesLoading" @click="loadSubstitutes">
          {{ substitutesLoading ? '加载中...' : '查询' }}
        </button>
      </div>
      <div class="form-grid compact">
        <label>
          BOM Line ID
          <input v-model.trim="bomLineId" placeholder="输入 BOM 行 ID" />
        </label>
      </div>
      <p v-if="substitutesError" class="status error">{{ substitutesError }}</p>
      <div v-if="!substitutes" class="empty">暂无替代件数据</div>
      <div v-else>
        <p class="status">共 {{ substitutes.count || 0 }} 条</p>
        <table v-if="substitutes.substitutes?.length" class="data-table">
          <thead>
            <tr>
              <th>替代件 ID</th>
              <th>名称</th>
              <th>原件 ID</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in substitutes.substitutes" :key="entry.id">
              <td>{{ entry.substitute_part?.id || entry.substitute_part?.item_number || entry.id }}</td>
              <td>{{ entry.substitute_part?.name || '-' }}</td>
              <td>{{ entry.part?.id || entry.part?.item_number || '-' }}</td>
              <td>{{ entry.relationship?.reason || entry.relationship?.comment || '-' }}</td>
            </tr>
          </tbody>
        </table>
        <details class="json-block">
          <summary>原始数据</summary>
          <pre>{{ formatJson(substitutes) }}</pre>
        </details>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { apiGet, apiPost } from '../utils/api'

const productId = ref('')
const itemType = ref('Part')
const product = ref<any | null>(null)
const productLoading = ref(false)
const productError = ref('')

const bomItems = ref<any[]>([])
const bomLoading = ref(false)
const bomError = ref('')

const whereUsedItemId = ref('')
const whereUsedRecursive = ref(true)
const whereUsedMaxLevels = ref(5)
const whereUsed = ref<any | null>(null)
const whereUsedLoading = ref(false)
const whereUsedError = ref('')

const compareLeftId = ref('')
const compareRightId = ref('')
const compareMode = ref('')
const compareMaxLevels = ref(10)
const bomCompare = ref<any | null>(null)
const compareLoading = ref(false)
const compareError = ref('')

const bomLineId = ref('')
const substitutes = ref<any | null>(null)
const substitutesLoading = ref(false)
const substitutesError = ref('')

function formatJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2)
}

function resetAll() {
  productId.value = ''
  product.value = null
  productError.value = ''
  bomItems.value = []
  bomError.value = ''
  whereUsedItemId.value = ''
  whereUsed.value = null
  whereUsedError.value = ''
  compareLeftId.value = ''
  compareRightId.value = ''
  compareMode.value = ''
  bomCompare.value = null
  compareError.value = ''
  bomLineId.value = ''
  substitutes.value = null
  substitutesError.value = ''
}

async function loadProduct() {
  if (!productId.value) return
  productLoading.value = true
  productError.value = ''
  try {
    const result = await apiGet<{ ok: boolean; data: any; error?: { message?: string } }>(
      `/api/federation/plm/products/${encodeURIComponent(productId.value)}?itemType=${encodeURIComponent(itemType.value)}`
    )
    if (!result.ok) {
      throw new Error(result.error?.message || '加载产品失败')
    }
    product.value = result.data
    await loadBom()
  } catch (error: any) {
    productError.value = error?.message || '加载产品失败'
  } finally {
    productLoading.value = false
  }
}

async function loadBom() {
  if (!productId.value) return
  bomLoading.value = true
  bomError.value = ''
  try {
    const result = await apiGet<{ ok: boolean; data: { items: any[] } }>(
      `/api/federation/plm/products/${encodeURIComponent(productId.value)}/bom`
    )
    if (!result.ok) {
      throw new Error('加载 BOM 失败')
    }
    bomItems.value = result.data?.items || []
  } catch (error: any) {
    bomError.value = error?.message || '加载 BOM 失败'
  } finally {
    bomLoading.value = false
  }
}

async function loadWhereUsed() {
  if (!whereUsedItemId.value) return
  whereUsedLoading.value = true
  whereUsedError.value = ''
  try {
    const result = await apiPost<{ ok: boolean; data: any; error?: { message?: string } }>(
      '/api/federation/plm/query',
      {
        operation: 'where_used',
        itemId: whereUsedItemId.value,
        recursive: whereUsedRecursive.value,
        maxLevels: whereUsedMaxLevels.value
      }
    )
    if (!result.ok) {
      throw new Error(result.error?.message || '查询 where-used 失败')
    }
    whereUsed.value = result.data
  } catch (error: any) {
    whereUsedError.value = error?.message || '查询 where-used 失败'
  } finally {
    whereUsedLoading.value = false
  }
}

async function loadBomCompare() {
  if (!compareLeftId.value || !compareRightId.value) return
  compareLoading.value = true
  compareError.value = ''
  try {
    const result = await apiPost<{ ok: boolean; data: any; error?: { message?: string } }>(
      '/api/federation/plm/query',
      {
        operation: 'bom_compare',
        leftId: compareLeftId.value,
        rightId: compareRightId.value,
        leftType: 'item',
        rightType: 'item',
        maxLevels: compareMaxLevels.value,
        compareMode: compareMode.value || undefined
      }
    )
    if (!result.ok) {
      throw new Error(result.error?.message || 'BOM 对比失败')
    }
    bomCompare.value = result.data
  } catch (error: any) {
    compareError.value = error?.message || 'BOM 对比失败'
  } finally {
    compareLoading.value = false
  }
}

async function loadSubstitutes() {
  if (!bomLineId.value) return
  substitutesLoading.value = true
  substitutesError.value = ''
  try {
    const result = await apiPost<{ ok: boolean; data: any; error?: { message?: string } }>(
      '/api/federation/plm/query',
      {
        operation: 'substitutes',
        bomLineId: bomLineId.value
      }
    )
    if (!result.ok) {
      throw new Error(result.error?.message || '查询替代件失败')
    }
    substitutes.value = result.data
  } catch (error: any) {
    substitutesError.value = error?.message || '查询替代件失败'
  } finally {
    substitutesLoading.value = false
  }
}
</script>

<style scoped>
.plm-page {
  max-width: 1200px;
  margin: 24px auto 48px;
  padding: 0 24px;
  display: grid;
  gap: 20px;
}

.panel {
  background: #fff;
  border: 1px solid #e6e8eb;
  border-radius: 10px;
  padding: 20px 24px;
  box-shadow: 0 4px 12px rgba(30, 40, 60, 0.06);
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.panel h1 {
  font-size: 20px;
  margin-bottom: 4px;
}

.panel h2 {
  font-size: 18px;
}

.subtext {
  color: #6b7280;
  font-size: 13px;
}

.hint {
  color: #9ca3af;
  font-size: 12px;
  margin-top: 4px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px 16px;
  align-items: end;
  margin-bottom: 12px;
}

.form-grid.compact {
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}

label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: #374151;
}

input, select {
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13px;
  background: #fff;
}

input:focus, select:focus {
  outline: none;
  border-color: #1976d2;
  box-shadow: 0 0 0 2px rgba(25, 118, 210, 0.15);
}

.btn {
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 8px 14px;
  background: #f9fafb;
  cursor: pointer;
  font-size: 13px;
}

.btn.primary {
  background: #1976d2;
  color: #fff;
  border-color: #1976d2;
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px 16px;
  margin-top: 12px;
}

.detail-grid span {
  display: block;
  font-size: 12px;
  color: #6b7280;
}

.description {
  margin-top: 12px;
  color: #4b5563;
}

.status {
  font-size: 13px;
  color: #374151;
  margin: 8px 0;
}

.status.error {
  color: #b91c1c;
}

.empty {
  color: #9ca3af;
  font-size: 13px;
  padding: 8px 0;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.data-table th,
.data-table td {
  border-bottom: 1px solid #eef0f2;
  padding: 8px 6px;
  text-align: left;
}

.summary-row {
  display: flex;
  gap: 16px;
  font-size: 13px;
  color: #111827;
  padding: 6px 0 10px;
}

.json-block {
  margin-top: 12px;
  background: #f8fafc;
  border-radius: 8px;
  padding: 10px 12px;
}

.json-block summary {
  cursor: pointer;
  font-weight: 600;
  margin-bottom: 6px;
}

.json-block pre {
  margin: 0;
  font-size: 12px;
  white-space: pre-wrap;
  color: #1f2937;
}

@media (max-width: 768px) {
  .panel {
    padding: 16px;
  }

  .panel-header {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
