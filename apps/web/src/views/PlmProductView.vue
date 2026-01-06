<template>
  <div class="plm-page">
    <section class="panel">
      <div class="panel-header">
        <div>
          <h1>PLM Product</h1>
          <p class="subtext">Federated endpoints for product detail, BOM, documents, approvals, and BOM tools.</p>
          <div class="auth-row">
            <span class="auth-label">Auth token</span>
            <span class="auth-pill" :class="authStatusClass">{{ authStatusText }}</span>
            <button class="btn ghost" @click="refreshAuth">Refresh</button>
          </div>
          <p v-if="authHint" class="hint">{{ authHint }}</p>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Search products</h2>
          <p class="subtext">Query PLM items via /api/federation/plm/products.</p>
        </div>
        <button class="btn primary" :disabled="searchLoading" @click="searchProducts">
          {{ searchLoading ? 'Searching...' : 'Search' }}
        </button>
      </div>

      <div class="form-grid">
        <label>
          Query
          <input v-model.trim="searchQuery" placeholder="Leave empty for latest" />
        </label>
        <label>
          Item type
          <input v-model.trim="searchItemType" placeholder="Part" />
        </label>
        <label>
          Limit
          <input v-model.number="searchLimit" type="number" min="1" max="50" />
        </label>
      </div>

      <p v-if="searchError" class="status error">{{ searchError }}</p>
      <p v-else-if="searchResults.length" class="status">Total {{ searchTotal }}, showing {{ searchResults.length }}</p>
      <div v-else class="empty">No results yet.</div>

      <table v-if="searchResults.length" class="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Code</th>
            <th>Status</th>
            <th>Type</th>
            <th>Updated</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in searchResults" :key="item.id">
            <td>{{ item.name || '-' }}</td>
            <td>{{ item.code || '-' }}</td>
            <td>{{ item.status || '-' }}</td>
            <td>{{ item.itemType || '-' }}</td>
            <td>{{ formatDate(item.updated_at || item.created_at) }}</td>
            <td>
              <button class="btn" @click="applySearchItem(item)">Use</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Product detail</h2>
          <p class="subtext">Load a single product by ID.</p>
        </div>
        <button class="btn" @click="resetDetail">Clear</button>
      </div>

      <div class="form-grid">
        <label>
          Product ID
          <input v-model.trim="productId" placeholder="PLM item id" />
        </label>
        <label>
          Item type
          <input v-model.trim="itemType" placeholder="Part" />
        </label>
      </div>

      <div class="actions">
        <button class="btn primary" :disabled="!productId || productLoading" @click="loadProduct">
          {{ productLoading ? 'Loading...' : 'Load product' }}
        </button>
        <button class="btn" :disabled="!productId || bomLoading" @click="loadBom">
          {{ bomLoading ? 'Loading BOM...' : 'Load BOM' }}
        </button>
        <button class="btn" :disabled="!productId || documentsLoading" @click="loadDocuments">
          {{ documentsLoading ? 'Loading docs...' : 'Load documents' }}
        </button>
        <button class="btn" :disabled="approvalsLoading" @click="loadApprovals">
          {{ approvalsLoading ? 'Loading approvals...' : 'Load approvals' }}
        </button>
      </div>

      <p v-if="productError" class="status error">{{ productError }}</p>

      <div v-if="product" class="detail-grid">
        <div>
          <span>Name</span>
          <strong>{{ product.name || '-' }}</strong>
        </div>
        <div>
          <span>Code</span>
          <strong>{{ product.code || '-' }}</strong>
        </div>
        <div>
          <span>Version</span>
          <strong>{{ product.version || '-' }}</strong>
        </div>
        <div>
          <span>Status</span>
          <strong>{{ product.status || '-' }}</strong>
        </div>
        <div>
          <span>Type</span>
          <strong>{{ product.itemType || '-' }}</strong>
        </div>
        <div>
          <span>Updated</span>
          <strong>{{ formatDate(product.updated_at || product.created_at) }}</strong>
        </div>
      </div>

      <p v-if="product?.description" class="description">{{ product.description }}</p>
      <details v-if="product" class="json-block">
        <summary>Raw payload</summary>
        <pre>{{ formatJson(product) }}</pre>
      </details>
    </section>

    <section class="panel">
      <div class="panel-header">
        <h2>BOM</h2>
      </div>
      <p v-if="bomError" class="status error">{{ bomError }}</p>
      <div v-if="!bomItems.length" class="empty">No BOM data.</div>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>Level</th>
            <th>Component Code</th>
            <th>Component Name</th>
            <th>Quantity</th>
            <th>Unit</th>
            <th>Sequence</th>
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
        <h2>Documents</h2>
      </div>
      <div class="form-grid compact">
        <label>
          Role
          <input v-model.trim="documentRole" placeholder="primary / secondary" />
        </label>
      </div>
      <p v-if="documentsError" class="status error">{{ documentsError }}</p>
      <div v-if="!documents.length" class="empty">No documents.</div>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Revision</th>
            <th>Size</th>
            <th>Preview</th>
            <th>Download</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="doc in documents" :key="doc.id">
            <td>{{ doc.name }}</td>
            <td>{{ doc.document_type || '-' }}</td>
            <td>{{ doc.engineering_revision || '-' }}</td>
            <td>{{ formatBytes(doc.file_size) }}</td>
            <td>
              <a v-if="doc.preview_url" :href="doc.preview_url" target="_blank" rel="noopener">Open</a>
              <span v-else>-</span>
            </td>
            <td>
              <a v-if="doc.download_url" :href="doc.download_url" target="_blank" rel="noopener">Download</a>
              <span v-else>-</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-header">
        <h2>Approvals</h2>
      </div>
      <div class="form-grid compact">
        <label>
          Status
          <select v-model="approvalsStatus">
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </label>
      </div>
      <p v-if="approvalsError" class="status error">{{ approvalsError }}</p>
      <div v-if="!approvals.length" class="empty">No approvals.</div>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Status</th>
            <th>Type</th>
            <th>Requester</th>
            <th>Created</th>
            <th>Product</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="approval in approvals" :key="approval.id">
            <td>{{ approval.title }}</td>
            <td>{{ approval.status }}</td>
            <td>{{ approval.request_type }}</td>
            <td>{{ approval.requester_name }}</td>
            <td>{{ approval.created_at }}</td>
            <td>{{ approval.product_id || '-' }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Where-used</h2>
          <p class="subtext">Find parents that reference a child item.</p>
        </div>
        <button class="btn" :disabled="!whereUsedItemId || whereUsedLoading" @click="loadWhereUsed">
          {{ whereUsedLoading ? 'Loading...' : 'Query' }}
        </button>
      </div>
      <div class="form-grid compact">
        <label>
          Item ID
          <input v-model.trim="whereUsedItemId" placeholder="Child item id" />
        </label>
        <label>
          Recursive
          <select v-model="whereUsedRecursive">
            <option :value="true">true</option>
            <option :value="false">false</option>
          </select>
        </label>
        <label>
          Max levels
          <input v-model.number="whereUsedMaxLevels" type="number" min="1" max="20" />
        </label>
      </div>
      <p v-if="whereUsedError" class="status error">{{ whereUsedError }}</p>
      <div v-if="!whereUsed" class="empty">No where-used data.</div>
      <div v-else>
        <p class="status">Total {{ whereUsed.count || 0 }}</p>
        <table v-if="whereUsed.parents?.length" class="data-table">
          <thead>
            <tr>
              <th>Level</th>
              <th>Parent</th>
              <th>Quantity</th>
              <th>Unit</th>
              <th>Relation</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in whereUsed.parents" :key="entry.relationship?.id || entry.parent?.id">
              <td>{{ entry.level }}</td>
              <td>
                <div>{{ getItemLabel(entry.parent) }}</div>
                <div class="muted">{{ entry.parent?.id || '-' }}</div>
              </td>
              <td>{{ entry.relationship?.quantity ?? '-' }}</td>
              <td>{{ entry.relationship?.uom ?? '-' }}</td>
              <td>{{ entry.relationship?.id || '-' }}</td>
            </tr>
          </tbody>
        </table>
        <details class="json-block">
          <summary>Raw payload</summary>
          <pre>{{ formatJson(whereUsed) }}</pre>
        </details>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>BOM compare</h2>
          <p class="subtext">Compare BOM structures between two items.</p>
        </div>
        <button class="btn" :disabled="!compareLeftId || !compareRightId || compareLoading" @click="loadBomCompare">
          {{ compareLoading ? 'Comparing...' : 'Compare' }}
        </button>
      </div>
      <div class="form-grid">
        <label>
          Left ID
          <input v-model.trim="compareLeftId" placeholder="Left item id" />
        </label>
        <label>
          Right ID
          <input v-model.trim="compareRightId" placeholder="Right item id" />
        </label>
        <label>
          Max levels
          <input v-model.number="compareMaxLevels" type="number" min="-1" max="20" />
        </label>
        <label>
          Line key
          <input v-model.trim="compareLineKey" placeholder="child_id" />
        </label>
        <label>
          Compare mode
          <input v-model.trim="compareMode" placeholder="only_product / summarized" />
        </label>
        <label class="checkbox-field">
          <span>Include child fields</span>
          <input v-model="compareIncludeChildFields" type="checkbox" />
        </label>
        <label class="checkbox-field">
          <span>Include substitutes</span>
          <input v-model="compareIncludeSubstitutes" type="checkbox" />
        </label>
        <label class="checkbox-field">
          <span>Include effectivity</span>
          <input v-model="compareIncludeEffectivity" type="checkbox" />
        </label>
        <label>
          Relationship props
          <input v-model.trim="compareRelationshipProps" placeholder="quantity,uom,find_num" />
        </label>
      </div>
      <p v-if="compareError" class="status error">{{ compareError }}</p>
      <div v-if="!bomCompare" class="empty">No compare data.</div>
      <div v-else>
        <div class="summary-row">
          <span>Added: {{ compareSummary.added ?? 0 }}</span>
          <span>Removed: {{ compareSummary.removed ?? 0 }}</span>
          <span>Changed: {{ compareSummary.changed ?? 0 }}</span>
        </div>
        <div class="compare-grid">
          <div>
            <h4>Added</h4>
            <div v-if="!compareAdded.length" class="empty">None</div>
            <ul v-else class="compare-list">
              <li v-for="entry in compareAdded" :key="entry.relationship_id || entry.line_key || entry.child_id">
                <span class="mono">{{ entry.child_id || '-' }}</span>
                <span class="muted">({{ entry.relationship_id || entry.line_key || '-' }})</span>
              </li>
            </ul>
          </div>
          <div>
            <h4>Removed</h4>
            <div v-if="!compareRemoved.length" class="empty">None</div>
            <ul v-else class="compare-list">
              <li v-for="entry in compareRemoved" :key="entry.relationship_id || entry.line_key || entry.child_id">
                <span class="mono">{{ entry.child_id || '-' }}</span>
                <span class="muted">({{ entry.relationship_id || entry.line_key || '-' }})</span>
              </li>
            </ul>
          </div>
          <div>
            <h4>Changed</h4>
            <div v-if="!compareChanged.length" class="empty">None</div>
            <ul v-else class="compare-list">
              <li v-for="entry in compareChanged" :key="entry.relationship_id || entry.line_key || entry.child_id">
                <span class="mono">{{ entry.child_id || '-' }}</span>
                <span class="muted">{{ entry.changes?.length || 0 }} changes</span>
              </li>
            </ul>
          </div>
        </div>
        <details class="json-block">
          <summary>Raw payload</summary>
          <pre>{{ formatJson(bomCompare) }}</pre>
        </details>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Substitutes</h2>
          <p class="subtext">Query substitute parts for a BOM line.</p>
        </div>
        <button class="btn" :disabled="!bomLineId || substitutesLoading" @click="loadSubstitutes">
          {{ substitutesLoading ? 'Loading...' : 'Query' }}
        </button>
      </div>
      <div class="form-grid compact">
        <label>
          BOM line ID
          <input v-model.trim="bomLineId" placeholder="BOM line id" />
        </label>
      </div>
      <p v-if="substitutesError" class="status error">{{ substitutesError }}</p>
      <div v-if="!substitutes" class="empty">No substitutes data.</div>
      <table v-else-if="substitutes.substitutes?.length" class="data-table">
        <thead>
          <tr>
            <th>Substitute</th>
            <th>Part</th>
            <th>Rank</th>
            <th>Relation</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in substitutes.substitutes" :key="entry.id">
            <td>{{ entry.substitute_part?.id || entry.substitute_part?.item_number || entry.id }}</td>
            <td>{{ entry.part?.id || entry.part?.item_number || '-' }}</td>
            <td>{{ entry.rank ?? entry.relationship?.properties?.rank ?? '-' }}</td>
            <td>{{ entry.relationship?.id || '-' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">No substitutes found.</div>
      <details v-if="substitutes" class="json-block">
        <summary>Raw payload</summary>
        <pre>{{ formatJson(substitutes) }}</pre>
      </details>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { apiGet, apiPost } from '../utils/api'

interface PlmProduct {
  id: string
  name?: string
  code?: string
  version?: string
  status?: string
  description?: string
  itemType?: string
  created_at?: string
  updated_at?: string
  properties?: Record<string, unknown>
}

interface BomItem {
  id: string
  component_id?: string
  component_code?: string
  component_name?: string
  quantity?: number
  unit?: string
  level?: number
  sequence?: number
}

interface PlmDocument {
  id: string
  name: string
  document_type?: string
  engineering_revision?: string
  file_size?: number
  preview_url?: string
  download_url?: string
}

interface PlmApproval {
  id: string
  title: string
  status: string
  request_type: string
  requester_name: string
  created_at: string
  product_id?: string
}

const searchQuery = ref('')
const searchItemType = ref('Part')
const searchLimit = ref(10)
const searchResults = ref<PlmProduct[]>([])
const searchTotal = ref(0)
const searchLoading = ref(false)
const searchError = ref('')

const productId = ref('')
const itemType = ref('Part')
const product = ref<PlmProduct | null>(null)
const productLoading = ref(false)
const productError = ref('')

const bomItems = ref<BomItem[]>([])
const bomLoading = ref(false)
const bomError = ref('')

const documentRole = ref('')
const documents = ref<PlmDocument[]>([])
const documentsLoading = ref(false)
const documentsError = ref('')

const approvals = ref<PlmApproval[]>([])
const approvalsStatus = ref<'all' | 'pending' | 'approved' | 'rejected'>('pending')
const approvalsLoading = ref(false)
const approvalsError = ref('')

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
const compareLineKey = ref('child_id')
const compareIncludeChildFields = ref(true)
const compareIncludeSubstitutes = ref(false)
const compareIncludeEffectivity = ref(false)
const compareRelationshipProps = ref('quantity,uom,find_num')
const bomCompare = ref<any | null>(null)
const compareLoading = ref(false)
const compareError = ref('')

const bomLineId = ref('')
const substitutes = ref<any | null>(null)
const substitutesLoading = ref(false)
const substitutesError = ref('')

const compareSummary = computed(() => bomCompare.value?.summary || {})
const compareAdded = computed(() => bomCompare.value?.added || [])
const compareRemoved = computed(() => bomCompare.value?.removed || [])
const compareChanged = computed(() => bomCompare.value?.changed || [])

const authStatus = ref<'missing' | 'set'>('missing')

const authStatusClass = computed(() => (authStatus.value === 'set' ? 'ok' : 'warn'))
const authStatusText = computed(() => (authStatus.value === 'set' ? 'Token set' : 'Missing'))
const authHint = computed(() =>
  authStatus.value === 'missing'
    ? 'Set localStorage auth_token to access /api/federation endpoints.'
    : ''
)

const refreshAuth = () => {
  authStatus.value = localStorage.getItem('auth_token') ? 'set' : 'missing'
}

const formatDate = (value?: string) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toISOString()
}

const formatBytes = (value?: number) => {
  if (!value && value !== 0) return '-'
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB']
  let size = value / 1024
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`
}

const formatJson = (payload: unknown) => JSON.stringify(payload, null, 2)

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const getItemLabel = (item?: Record<string, any>) => {
  if (!item) return '-'
  return item.item_number || item.itemNumber || item.code || item.name || item.id || '-'
}

const searchProducts = async () => {
  searchError.value = ''
  searchLoading.value = true
  try {
    const params = new URLSearchParams()
    if (searchQuery.value) params.set('search', searchQuery.value)
    if (searchItemType.value) params.set('itemType', searchItemType.value)
    params.set('limit', String(searchLimit.value || 10))
    const response = await apiGet<{ data: PlmProduct[]; total?: number }>(
      `/api/federation/plm/products?${params.toString()}`
    )
    searchResults.value = response.data || []
    searchTotal.value = response.total ?? searchResults.value.length
  } catch (error) {
    searchError.value = getErrorMessage(error)
  } finally {
    searchLoading.value = false
  }
}

const applySearchItem = (item: PlmProduct) => {
  productId.value = item.id
  if (item.itemType) {
    itemType.value = item.itemType
  }
  if (!whereUsedItemId.value) {
    whereUsedItemId.value = item.id
  }
  loadProduct()
}

const loadProduct = async () => {
  productError.value = ''
  productLoading.value = true
  try {
    const params = itemType.value ? `?itemType=${encodeURIComponent(itemType.value)}` : ''
    const response = await apiGet<{ data: PlmProduct }>(
      `/api/federation/plm/products/${encodeURIComponent(productId.value)}${params}`
    )
    product.value = response.data
  } catch (error) {
    productError.value = getErrorMessage(error)
  } finally {
    productLoading.value = false
  }
}

const loadBom = async () => {
  bomError.value = ''
  bomLoading.value = true
  try {
    const response = await apiGet<{ data: BomItem[] }>(
      `/api/federation/plm/products/${encodeURIComponent(productId.value)}/bom`
    )
    bomItems.value = response.data || []
  } catch (error) {
    bomError.value = getErrorMessage(error)
  } finally {
    bomLoading.value = false
  }
}

const loadDocuments = async () => {
  documentsError.value = ''
  documentsLoading.value = true
  try {
    const payload = {
      operation: 'documents',
      productId: productId.value,
      role: documentRole.value || undefined,
      limit: 100,
    }
    const response = await apiPost<{ data: PlmDocument[] }>(
      '/api/federation/plm/query',
      payload
    )
    documents.value = response.data || []
  } catch (error) {
    documentsError.value = getErrorMessage(error)
  } finally {
    documentsLoading.value = false
  }
}

const loadApprovals = async () => {
  approvalsError.value = ''
  approvalsLoading.value = true
  try {
    const payload = {
      operation: 'approvals',
      status: approvalsStatus.value === 'all' ? undefined : approvalsStatus.value,
      productId: productId.value || undefined,
      limit: 100,
    }
    const response = await apiPost<{ data: PlmApproval[] }>(
      '/api/federation/plm/query',
      payload
    )
    approvals.value = response.data || []
  } catch (error) {
    approvalsError.value = getErrorMessage(error)
  } finally {
    approvalsLoading.value = false
  }
}

const loadWhereUsed = async () => {
  whereUsedError.value = ''
  whereUsedLoading.value = true
  try {
    const payload = {
      operation: 'where_used',
      itemId: whereUsedItemId.value,
      recursive: whereUsedRecursive.value,
      maxLevels: whereUsedMaxLevels.value,
    }
    const response = await apiPost<{ data: any }>(
      '/api/federation/plm/query',
      payload
    )
    whereUsed.value = response.data
  } catch (error) {
    whereUsedError.value = getErrorMessage(error)
  } finally {
    whereUsedLoading.value = false
  }
}

const loadBomCompare = async () => {
  compareError.value = ''
  compareLoading.value = true
  try {
    const payload = {
      operation: 'bom_compare',
      leftId: compareLeftId.value,
      rightId: compareRightId.value,
      maxLevels: compareMaxLevels.value,
      lineKey: compareLineKey.value || undefined,
      compareMode: compareMode.value || undefined,
      includeChildFields: compareIncludeChildFields.value,
      includeSubstitutes: compareIncludeSubstitutes.value,
      includeEffectivity: compareIncludeEffectivity.value,
      includeRelationshipProps: compareRelationshipProps.value || undefined,
    }
    const response = await apiPost<{ data: any }>(
      '/api/federation/plm/query',
      payload
    )
    bomCompare.value = response.data
  } catch (error) {
    compareError.value = getErrorMessage(error)
  } finally {
    compareLoading.value = false
  }
}

const loadSubstitutes = async () => {
  substitutesError.value = ''
  substitutesLoading.value = true
  try {
    const payload = {
      operation: 'substitutes',
      bomLineId: bomLineId.value,
    }
    const response = await apiPost<{ data: any }>(
      '/api/federation/plm/query',
      payload
    )
    substitutes.value = response.data
  } catch (error) {
    substitutesError.value = getErrorMessage(error)
  } finally {
    substitutesLoading.value = false
  }
}

const resetDetail = () => {
  product.value = null
  productError.value = ''
  bomItems.value = []
  bomError.value = ''
  documents.value = []
  documentsError.value = ''
  approvals.value = []
  approvalsError.value = ''
  whereUsed.value = null
  whereUsedError.value = ''
  bomCompare.value = null
  compareError.value = ''
  substitutes.value = null
  substitutesError.value = ''
}

onMounted(() => {
  refreshAuth()
})
</script>

<style scoped>
.plm-page {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 20px;
}

.panel {
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.subtext {
  color: #666;
  font-size: 13px;
  margin-top: 4px;
}

.auth-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.auth-label {
  font-size: 12px;
  color: #666;
}

.auth-pill {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  background: #f1f1f1;
  color: #666;
}

.auth-pill.ok {
  background: #e3f2fd;
  color: #1976d2;
}

.auth-pill.warn {
  background: #fff3cd;
  color: #8a6d3b;
}

.hint {
  font-size: 12px;
  color: #999;
  margin-top: 6px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-bottom: 12px;
}

.form-grid.compact {
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
}

label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #555;
}

input,
select {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #d0d0d0;
  font-size: 13px;
}

.checkbox-field {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.btn {
  padding: 6px 12px;
  border: 1px solid #cfd8dc;
  border-radius: 6px;
  background: #fff;
  color: #333;
  cursor: pointer;
  font-size: 13px;
}

.btn.primary {
  background: #1976d2;
  border-color: #1976d2;
  color: #fff;
}

.btn.ghost {
  background: transparent;
  border-color: transparent;
  color: #1976d2;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.status {
  font-size: 13px;
  margin-bottom: 8px;
}

.status.error {
  color: #c62828;
}

.empty {
  font-size: 13px;
  color: #888;
  padding: 8px 0;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.data-table th,
.data-table td {
  border-bottom: 1px solid #eee;
  padding: 8px;
  text-align: left;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-bottom: 12px;
}

.detail-grid span {
  display: block;
  font-size: 12px;
  color: #666;
}

.description {
  margin-bottom: 12px;
  color: #555;
}

.json-block {
  margin-top: 12px;
}

.json-block pre {
  background: #f8f8f8;
  padding: 12px;
  border-radius: 6px;
  overflow: auto;
  font-size: 12px;
}

.summary-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 10px;
  font-size: 13px;
}

.compare-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

.compare-list {
  list-style: none;
  padding-left: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}

.mono {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
}

.muted {
  color: #777;
  font-size: 12px;
}

@media (max-width: 720px) {
  .panel-header {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
