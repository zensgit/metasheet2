<template>
  <div class="plm-page">
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>产品搜索</h2>
          <p class="subtext">基于联邦接口快速定位可用的 PLM 产品 ID</p>
        </div>
        <button class="btn primary" :disabled="searchLoading" @click="searchProducts">
          {{ searchLoading ? '搜索中...' : '搜索' }}
        </button>
      </div>

      <div class="form-grid">
        <label for="plm-search-query">
          关键词
          <input
            id="plm-search-query"
            v-model.trim="searchQuery"
            name="plmSearchQuery"
            placeholder="可留空，返回最新记录"
          />
        </label>
        <label for="plm-search-item-type">
          Item Type
          <input
            id="plm-search-item-type"
            v-model.trim="searchItemType"
            name="plmSearchItemType"
            placeholder="Part"
          />
        </label>
        <label for="plm-search-limit">
          Limit
          <input
            id="plm-search-limit"
            v-model.number="searchLimit"
            name="plmSearchLimit"
            type="number"
            min="1"
            max="50"
          />
        </label>
      </div>

      <p v-if="searchError" class="status error">{{ searchError }}</p>
      <p v-else-if="searchResults.length" class="status">
        共 {{ searchTotal }} 条，当前展示 {{ searchResults.length }} 条
      </p>
      <div v-if="!searchResults.length" class="empty">暂无搜索结果</div>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>料号</th>
            <th>状态</th>
            <th>类型</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in searchResults" :key="item.id">
            <td>{{ item.name || '-' }}</td>
            <td>{{ item.partNumber || item.code || '-' }}</td>
            <td>{{ item.status || '-' }}</td>
            <td>{{ item.itemType || '-' }}</td>
            <td>{{ item.updatedAt || item.updated_at || '-' }}</td>
            <td>
              <button class="btn" @click="applySearchItem(item)">使用</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <h1>PLM 产品详情</h1>
          <p class="subtext">联邦接口：产品详情、BOM、where-used、BOM 对比、替代件</p>
          <div class="auth-status">
            <span class="auth-label">MetaSheet</span>
            <span class="auth-pill" :class="authStateClass">{{ authStateText }}</span>
            <span v-if="authExpiryText" class="auth-expiry">{{ authExpiryText }}</span>
            <button class="btn ghost" @click="refreshAuthStatus">刷新状态</button>
          </div>
          <div class="auth-status secondary">
            <span class="auth-label">PLM Token</span>
            <span class="auth-pill" :class="plmAuthStateClass">{{ plmAuthStateText }}</span>
            <span v-if="plmAuthExpiryText" class="auth-expiry">{{ plmAuthExpiryText }}</span>
          </div>
          <p v-if="authHint" class="hint">{{ authHint }}</p>
          <p v-if="plmAuthHint" class="hint">{{ plmAuthHint }}</p>
          <p v-if="authError" class="status error">{{ authError }}</p>
          <p v-if="deepLinkStatus" class="status">{{ deepLinkStatus }}</p>
          <p v-if="deepLinkError" class="status error">{{ deepLinkError }}</p>
        </div>
        <div class="panel-actions">
          <button class="btn ghost" @click="copyDeepLink()">复制深链接</button>
          <button class="btn" @click="resetAll">重置</button>
        </div>
      </div>

      <div class="deep-link-scope">
        <span class="deep-link-label">深链接范围</span>
        <label class="deep-link-option" for="plm-deeplink-preset">
          <span>预设</span>
          <select
            id="plm-deeplink-preset"
            name="plmDeepLinkPreset"
            class="deep-link-select"
            v-model="deepLinkPreset"
            @change="applyDeepLinkPreset"
          >
            <option value="">自动</option>
            <option v-for="preset in deepLinkPresets" :key="preset.key" :value="preset.key">
              {{ preset.label }}
            </option>
          </select>
        </label>
        <button
          class="btn ghost"
          :disabled="!deepLinkPreset.startsWith('custom:')"
          @click="movePreset('up')"
        >
          上移
        </button>
        <button
          class="btn ghost"
          :disabled="!deepLinkPreset.startsWith('custom:')"
          @click="movePreset('down')"
        >
          下移
        </button>
        <label
          v-for="option in deepLinkPanelOptions"
          :key="option.key"
          class="deep-link-option"
          :for="`plm-deeplink-scope-${option.key}`"
        >
          <input
            :id="`plm-deeplink-scope-${option.key}`"
            name="plmDeepLinkScope"
            type="checkbox"
            :value="option.key"
            v-model="deepLinkScope"
          />
          <span>{{ option.label }}</span>
        </label>
        <button class="btn ghost" @click="clearDeepLinkScope">自动</button>
        <label class="deep-link-option" for="plm-deeplink-preset-name">
          <span>保存为</span>
          <input
            id="plm-deeplink-preset-name"
            name="plmDeepLinkPresetName"
            class="deep-link-input"
            v-model.trim="customPresetName"
            placeholder="输入名称"
          />
          <button
            class="btn ghost"
            :disabled="!customPresetName || !deepLinkScope.length"
            @click="saveDeepLinkPreset"
          >
            保存
          </button>
        </label>
        <button
          class="btn ghost"
          :disabled="!deepLinkPreset.startsWith('custom:')"
          @click="deleteDeepLinkPreset"
        >
          删除预设
        </button>
        <label class="deep-link-option" for="plm-deeplink-preset-rename">
          <span>重命名</span>
          <input
            id="plm-deeplink-preset-rename"
            name="plmDeepLinkPresetRename"
            class="deep-link-input"
            v-model.trim="editingPresetLabel"
            :disabled="!deepLinkPreset.startsWith('custom:')"
            placeholder="新名称"
          />
          <button
            class="btn ghost"
            :disabled="!deepLinkPreset.startsWith('custom:') || !editingPresetLabel"
            @click="applyPresetRename"
          >
            保存
          </button>
        </label>
        <button class="btn ghost" @click="exportCustomPresets">导出预设</button>
        <label class="deep-link-option" for="plm-deeplink-preset-import">
          <span>导入</span>
          <input
            id="plm-deeplink-preset-import"
            name="plmDeepLinkPresetImport"
            class="deep-link-input"
            v-model.trim="importPresetText"
            placeholder="粘贴 JSON"
          />
          <button class="btn ghost" :disabled="!importPresetText" @click="importCustomPresets">
            导入
          </button>
        </label>
        <button class="btn ghost" @click="triggerPresetFileImport">选择文件</button>
        <input
          ref="importFileInput"
          id="plm-deeplink-preset-file"
          name="plmDeepLinkPresetFile"
          class="deep-link-file"
          type="file"
          accept=".json,application/json"
          @change="handlePresetFileImport"
        />
        <div
          class="deep-link-drop"
          :class="{ active: isPresetDropActive }"
          @dragenter="handlePresetDragEnter"
          @dragover="handlePresetDragOver"
          @dragleave="handlePresetDragLeave"
          @drop="handlePresetDrop"
        >
          <span>拖拽 JSON 预设文件到这里</span>
        </div>
      </div>

      <div class="form-grid">
        <label for="plm-product-id">
          产品 ID
          <input
            id="plm-product-id"
            v-model.trim="productId"
            name="plmProductId"
            placeholder="输入 PLM 产品 ID"
          />
        </label>
        <label for="plm-item-number">
          Item Number
          <input
            id="plm-item-number"
            v-model.trim="productItemNumber"
            name="plmItemNumber"
            placeholder="输入 item_number（可选）"
          />
        </label>
        <label for="plm-item-type">
          Item Type
          <input
            id="plm-item-type"
            v-model.trim="itemType"
            name="plmItemType"
            placeholder="Part"
          />
        </label>
        <button class="btn primary" :disabled="(!productId && !productItemNumber) || productLoading" @click="loadProduct">
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
          <strong>{{ formatTime(product.updatedAt || product.updated_at || product.createdAt || product.created_at) }}</strong>
        </div>
        <div>
          <span>创建时间</span>
          <strong>{{ formatTime(product.createdAt || product.created_at) }}</strong>
        </div>
      </div>

      <p v-if="product?.description" class="description">{{ product.description }}</p>

      <details v-if="product" class="field-map">
        <summary>字段对照清单</summary>
        <table class="data-table">
          <thead>
            <tr>
              <th>字段</th>
              <th>Key</th>
              <th>来源</th>
              <th>回退</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="field in productFieldCatalog" :key="field.key">
              <td>{{ field.label }}</td>
              <td class="mono">{{ field.key }}</td>
              <td>{{ field.source }}</td>
              <td class="muted">{{ field.fallback }}</td>
            </tr>
          </tbody>
        </table>
      </details>

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
      <div v-if="!bomItems.length" class="empty">
        暂无 BOM 数据
        <span class="empty-hint">（可在 PLM 关联 BOM 行后刷新）</span>
      </div>
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
        <h2>关联文档</h2>
        <div class="panel-actions">
          <button class="btn ghost" :disabled="!documentsFiltered.length" @click="exportDocumentsCsv">
            导出 CSV
          </button>
          <button class="btn" :disabled="!productId || documentsLoading" @click="loadDocuments">
            {{ documentsLoading ? '加载中...' : '刷新文档' }}
          </button>
        </div>
      </div>
      <div class="form-grid compact">
        <label for="plm-document-role">
          文档角色
          <input
            id="plm-document-role"
            v-model.trim="documentRole"
            name="plmDocumentRole"
            placeholder="primary / secondary"
          />
        </label>
        <label for="plm-document-filter">
          过滤
          <input
            id="plm-document-filter"
            v-model.trim="documentFilter"
            name="plmDocumentFilter"
            placeholder="名称/类型/MIME"
          />
        </label>
        <label for="plm-document-sort">
          排序
          <select id="plm-document-sort" v-model="documentSortKey" name="plmDocumentSort">
            <option value="updated">更新时间</option>
            <option value="name">名称</option>
            <option value="type">类型</option>
            <option value="revision">版本</option>
            <option value="role">角色</option>
            <option value="mime">MIME</option>
            <option value="size">大小</option>
          </select>
        </label>
        <label for="plm-document-sort-dir">
          顺序
          <select id="plm-document-sort-dir" v-model="documentSortDir" name="plmDocumentSortDir">
            <option value="desc">降序</option>
            <option value="asc">升序</option>
          </select>
        </label>
      </div>
      <div class="toggle-grid">
        <span class="toggle-label">显示列</span>
        <label v-for="col in documentColumnOptions" :key="col.key" class="checkbox-field" :for="`plm-document-column-${col.key}`">
          <input
            :id="`plm-document-column-${col.key}`"
            :name="`plmDocumentColumn-${col.key}`"
            type="checkbox"
            v-model="documentColumns[col.key]"
          />
          <span>{{ col.label }}</span>
        </label>
      </div>
      <p v-if="documentsError" class="status error">{{ documentsError }}</p>
      <div v-if="!documents.length" class="empty">
        暂无文档
        <span class="empty-hint">（可先在 PLM 关联文件或设置文档角色过滤）</span>
      </div>
      <p v-else class="status">共 {{ documents.length }} 条，展示 {{ documentsSorted.length }} 条</p>
      <div v-if="documents.length && !documentsSorted.length" class="empty">
        暂无匹配项
        <span class="empty-hint">（可清空过滤条件）</span>
      </div>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>名称</th>
            <th v-if="documentColumns.type">类型</th>
            <th v-if="documentColumns.revision">版本</th>
            <th v-if="documentColumns.role">角色</th>
            <th v-if="documentColumns.mime">MIME</th>
            <th v-if="documentColumns.size">大小</th>
            <th v-if="documentColumns.updated">更新时间</th>
            <th v-if="documentColumns.preview">预览</th>
            <th v-if="documentColumns.download">下载</th>
            <th v-if="documentColumns.cad">CAD</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="doc in documentsSorted" :key="doc.id">
            <td>{{ doc.name }}</td>
            <td v-if="documentColumns.type">{{ doc.document_type || '-' }}</td>
            <td v-if="documentColumns.revision">{{ doc.engineering_revision || '-' }}</td>
            <td v-if="documentColumns.role">
              <span class="tag status-neutral">{{ doc.engineering_state || '-' }}</span>
            </td>
            <td v-if="documentColumns.mime">{{ doc.mime_type || '-' }}</td>
            <td v-if="documentColumns.size">{{ formatBytes(doc.file_size) }}</td>
            <td v-if="documentColumns.updated">{{ formatTime(doc.updated_at || doc.created_at) }}</td>
            <td v-if="documentColumns.preview">
              <a v-if="doc.preview_url" :href="doc.preview_url" target="_blank" rel="noopener">查看</a>
              <span v-else>-</span>
            </td>
            <td v-if="documentColumns.download">
              <a v-if="doc.download_url" :href="doc.download_url" target="_blank" rel="noopener">下载</a>
              <span v-else>-</span>
            </td>
            <td v-if="documentColumns.cad">
              <div class="inline-actions">
                <button class="btn ghost mini" @click="selectCadFile(doc, 'primary')">主</button>
                <button class="btn ghost mini" @click="selectCadFile(doc, 'other')">对比</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <details class="field-map">
        <summary>字段对照清单</summary>
        <table class="data-table">
          <thead>
            <tr>
              <th>字段</th>
              <th>Key</th>
              <th>来源</th>
              <th>回退</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="field in documentFieldCatalog" :key="field.key">
              <td>{{ field.label }}</td>
              <td class="mono">{{ field.key }}</td>
              <td>{{ field.source }}</td>
              <td class="muted">{{ field.fallback }}</td>
            </tr>
          </tbody>
        </table>
      </details>
    </section>

    <section class="panel">
      <div class="panel-header">
        <h2>CAD 元数据</h2>
        <div class="panel-actions">
          <button class="btn ghost" @click="copyDeepLink('cad')">复制深链接</button>
          <button class="btn" :disabled="!cadFileId || cadLoading" @click="loadCadMetadata">
            {{ cadLoading ? '加载中...' : '刷新 CAD' }}
          </button>
        </div>
      </div>
      <div class="form-grid compact">
        <label for="plm-cad-file-id">
          CAD File ID
          <input
            id="plm-cad-file-id"
            v-model.trim="cadFileId"
            name="plmCadFileId"
            placeholder="从文档选择或输入 file_id"
          />
        </label>
        <label for="plm-cad-other-file-id">
          对比 File ID
          <input
            id="plm-cad-other-file-id"
            v-model.trim="cadOtherFileId"
            name="plmCadOtherFileId"
            placeholder="可选，用于差异对比"
          />
        </label>
      </div>
      <p v-if="cadStatus" class="status">{{ cadStatus }}</p>
      <p v-if="cadError" class="status error">{{ cadError }}</p>
      <p v-if="cadActionStatus" class="status">{{ cadActionStatus }}</p>
      <p v-if="cadActionError" class="status error">{{ cadActionError }}</p>
      <div class="cad-grid">
        <div class="cad-card">
          <div class="cad-card-header">
            <h3>属性</h3>
            <button class="btn ghost mini" :disabled="!cadFileId || cadUpdating" @click="updateCadProperties">
              {{ cadUpdating ? '处理中...' : '更新' }}
            </button>
          </div>
          <textarea
            v-model="cadPropertiesDraft"
            class="cad-textarea"
            rows="6"
            placeholder='{"properties": {"material": "AL-6061"}, "source": "metasheet"}'
          ></textarea>
          <details class="json-block">
            <summary>原始数据</summary>
            <pre>{{ formatJson(cadProperties) }}</pre>
          </details>
        </div>
        <div class="cad-card">
          <div class="cad-card-header">
            <h3>视图状态</h3>
            <button class="btn ghost mini" :disabled="!cadFileId || cadUpdating" @click="updateCadViewState">
              {{ cadUpdating ? '处理中...' : '更新' }}
            </button>
          </div>
          <textarea
            v-model="cadViewStateDraft"
            class="cad-textarea"
            rows="6"
            placeholder='{"hidden_entity_ids": [12, 15], "notes": [{"entity_id": 12, "note": "check hole"}]}'
          ></textarea>
          <details class="json-block">
            <summary>原始数据</summary>
            <pre>{{ formatJson(cadViewState) }}</pre>
          </details>
        </div>
        <div class="cad-card">
          <div class="cad-card-header">
            <h3>评审</h3>
            <button class="btn ghost mini" :disabled="!cadFileId || cadUpdating" @click="updateCadReview">
              {{ cadUpdating ? '处理中...' : '提交' }}
            </button>
          </div>
          <div class="form-grid compact cad-review-form">
            <label for="plm-cad-review-state">
              状态
              <input
                id="plm-cad-review-state"
                v-model.trim="cadReviewState"
                name="plmCadReviewState"
                placeholder="approved / rejected"
              />
            </label>
            <label for="plm-cad-review-note">
              备注
              <input
                id="plm-cad-review-note"
                v-model.trim="cadReviewNote"
                name="plmCadReviewNote"
                placeholder="可选"
              />
            </label>
          </div>
          <details class="json-block">
            <summary>原始数据</summary>
            <pre>{{ formatJson(cadReview) }}</pre>
          </details>
        </div>
        <div class="cad-card cad-span">
          <div class="cad-card-header">
            <h3>变更历史</h3>
          </div>
          <div v-if="!cadHistoryEntries.length" class="empty">暂无历史</div>
          <table v-else class="data-table">
            <thead>
              <tr>
                <th>动作</th>
                <th>时间</th>
                <th>用户</th>
                <th>Payload</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in cadHistoryEntries" :key="entry.id">
                <td>{{ entry.action }}</td>
                <td>{{ formatTime(entry.created_at) }}</td>
                <td>{{ entry.user_id ?? '-' }}</td>
                <td>
                  <details class="inline-details">
                    <summary>查看</summary>
                    <pre class="inline-pre">{{ formatJson(entry.payload) }}</pre>
                  </details>
                </td>
              </tr>
            </tbody>
          </table>
          <details class="json-block">
            <summary>原始数据</summary>
            <pre>{{ formatJson(cadHistory) }}</pre>
          </details>
        </div>
        <div class="cad-card">
          <div class="cad-card-header">
            <h3>差异</h3>
            <button
              class="btn ghost mini"
              :disabled="!cadFileId || !cadOtherFileId || cadDiffLoading"
              @click="loadCadDiff"
            >
              {{ cadDiffLoading ? '对比中...' : '加载' }}
            </button>
          </div>
          <div v-if="!cadDiff" class="empty">暂无差异数据</div>
          <details v-else class="json-block">
            <summary>原始数据</summary>
            <pre>{{ formatJson(cadDiff) }}</pre>
          </details>
        </div>
        <div class="cad-card">
          <div class="cad-card-header">
            <h3>网格统计</h3>
          </div>
          <div v-if="!cadMeshStats" class="empty">暂无网格统计</div>
          <details v-else class="json-block">
            <summary>原始数据</summary>
            <pre>{{ formatJson(cadMeshStats) }}</pre>
          </details>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <h2>审批</h2>
        <div class="panel-actions">
          <button class="btn ghost" :disabled="!approvalsFiltered.length" @click="exportApprovalsCsv">
            导出 CSV
          </button>
          <button class="btn" :disabled="approvalsLoading" @click="loadApprovals">
            {{ approvalsLoading ? '加载中...' : '刷新审批' }}
          </button>
        </div>
      </div>
      <div class="form-grid compact">
        <label for="plm-approvals-status">
          状态
          <select id="plm-approvals-status" v-model="approvalsStatus" name="plmApprovalsStatus">
            <option value="all">全部</option>
            <option value="pending">待处理</option>
            <option value="approved">已通过</option>
            <option value="rejected">已拒绝</option>
          </select>
        </label>
        <label for="plm-approvals-filter">
          过滤
          <input
            id="plm-approvals-filter"
            v-model.trim="approvalsFilter"
            name="plmApprovalsFilter"
            placeholder="标题/发起人/产品"
          />
        </label>
        <label for="plm-approvals-sort">
          排序
          <select id="plm-approvals-sort" v-model="approvalSortKey" name="plmApprovalsSort">
            <option value="created">创建时间</option>
            <option value="title">标题</option>
            <option value="status">状态</option>
            <option value="requester">发起人</option>
            <option value="product">产品</option>
          </select>
        </label>
        <label for="plm-approvals-sort-dir">
          顺序
          <select id="plm-approvals-sort-dir" v-model="approvalSortDir" name="plmApprovalsSortDir">
            <option value="desc">降序</option>
            <option value="asc">升序</option>
          </select>
        </label>
      </div>
      <div class="toggle-grid">
        <span class="toggle-label">显示列</span>
        <label v-for="col in approvalColumnOptions" :key="col.key" class="checkbox-field" :for="`plm-approval-column-${col.key}`">
          <input
            :id="`plm-approval-column-${col.key}`"
            :name="`plmApprovalColumn-${col.key}`"
            type="checkbox"
            v-model="approvalColumns[col.key]"
          />
          <span>{{ col.label }}</span>
        </label>
      </div>
      <p v-if="approvalsError" class="status error">{{ approvalsError }}</p>
      <div v-if="!approvals.length" class="empty">
        暂无审批数据
        <span class="empty-hint">（可调整状态筛选或创建 ECO 流程）</span>
      </div>
      <p v-else class="status">共 {{ approvals.length }} 条，展示 {{ approvalsSorted.length }} 条</p>
      <div v-if="approvals.length && !approvalsSorted.length" class="empty">
        暂无匹配项
        <span class="empty-hint">（可清空过滤条件）</span>
      </div>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>标题</th>
            <th v-if="approvalColumns.status">状态</th>
            <th v-if="approvalColumns.type">类型</th>
            <th v-if="approvalColumns.requester">发起人</th>
            <th v-if="approvalColumns.created">创建时间</th>
            <th v-if="approvalColumns.product">产品</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="approval in approvalsSorted" :key="approval.id">
            <td>{{ approval.title }}</td>
            <td v-if="approvalColumns.status">
              <span class="tag" :class="approvalStatusClass(approval.status)">{{ approval.status }}</span>
            </td>
            <td v-if="approvalColumns.type">{{ approval.request_type }}</td>
            <td v-if="approvalColumns.requester">{{ approval.requester_name || approval.requester_id || '-' }}</td>
            <td v-if="approvalColumns.created">{{ formatTime(approval.created_at) }}</td>
            <td v-if="approvalColumns.product">
              <div>{{ approval.product_number || approval.product_id || '-' }}</div>
              <div class="muted">{{ approval.product_name || '-' }}</div>
            </td>
          </tr>
        </tbody>
      </table>
      <details class="field-map">
        <summary>字段对照清单</summary>
        <table class="data-table">
          <thead>
            <tr>
              <th>字段</th>
              <th>Key</th>
              <th>来源</th>
              <th>回退</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="field in approvalFieldCatalog" :key="field.key">
              <td>{{ field.label }}</td>
              <td class="mono">{{ field.key }}</td>
              <td>{{ field.source }}</td>
              <td class="muted">{{ field.fallback }}</td>
            </tr>
          </tbody>
        </table>
      </details>
    </section>

    <section class="panel">
      <div class="panel-header">
        <h2>Where-Used</h2>
        <div class="panel-actions">
          <button class="btn ghost" @click="copyDeepLink('where-used')">复制深链接</button>
          <button class="btn ghost" :disabled="!whereUsedFilteredRows.length" @click="exportWhereUsedCsv">
            导出 CSV
          </button>
          <button class="btn" :disabled="!whereUsedItemId || whereUsedLoading" @click="loadWhereUsed">
            {{ whereUsedLoading ? '加载中...' : '查询' }}
          </button>
        </div>
      </div>
      <div class="form-grid compact">
        <label for="plm-where-used-item-id">
          子件 ID
          <input
            id="plm-where-used-item-id"
            v-model.trim="whereUsedItemId"
            name="plmWhereUsedItemId"
            placeholder="输入子件 ID"
          />
        </label>
        <label for="plm-where-used-recursive">
          递归
          <select
            id="plm-where-used-recursive"
            v-model="whereUsedRecursive"
            name="plmWhereUsedRecursive"
          >
            <option :value="true">是</option>
            <option :value="false">否</option>
          </select>
        </label>
        <label for="plm-where-used-max-levels">
          最大层级
          <input
            id="plm-where-used-max-levels"
            v-model.number="whereUsedMaxLevels"
            name="plmWhereUsedMaxLevels"
            type="number"
            min="1"
            max="20"
          />
        </label>
        <label for="plm-where-used-filter">
          过滤
          <input
            id="plm-where-used-filter"
            v-model.trim="whereUsedFilter"
            name="plmWhereUsedFilter"
            placeholder="父件编号/名称/关系ID"
          />
        </label>
      </div>
      <p v-if="whereUsedError" class="status error">{{ whereUsedError }}</p>
      <div v-if="!whereUsed" class="empty">
        暂无 where-used 数据
        <span class="empty-hint">（输入子件 ID 后查询）</span>
      </div>
      <div v-else>
        <p class="status">共 {{ whereUsed.count || 0 }} 条，展示 {{ whereUsedFilteredRows.length }} 条</p>
        <div v-if="!whereUsedFilteredRows.length" class="empty">
          暂无匹配项
          <span class="empty-hint">（可清空过滤条件）</span>
        </div>
        <table v-else class="data-table">
          <thead>
            <tr>
              <th>层级</th>
              <th>父件编号</th>
              <th>父件名称</th>
              <th>路径</th>
              <th>数量</th>
              <th>单位</th>
              <th>Find #</th>
              <th>Refdes</th>
              <th>关系 ID</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in whereUsedFilteredRows" :key="entry._key">
              <td>{{ entry.level }}</td>
              <td>{{ getItemNumber(entry.parent) }}</td>
              <td>{{ getItemName(entry.parent) }}</td>
              <td>
                <details class="inline-details" v-if="entry.pathLabel">
                  <summary>{{ entry.pathLabel }}</summary>
                  <div class="path-list">
                    <div v-for="(node, idx) in entry.pathNodes" :key="`${entry._key}-path-${idx}`" class="path-node">
                      <span class="path-index">{{ idx }}</span>
                      <span class="mono">{{ node.label }}</span>
                      <span v-if="node.name && node.name !== node.label" class="muted">{{ node.name }}</span>
                      <span class="muted">{{ node.id }}</span>
                    </div>
                  </div>
                </details>
                <span v-else>-</span>
              </td>
              <td>{{ entry.relationship?.quantity ?? '-' }}</td>
              <td>{{ entry.relationship?.uom ?? '-' }}</td>
              <td>{{ entry.relationship?.find_num ?? '-' }}</td>
              <td>{{ getWhereUsedRefdes(entry) }}</td>
              <td>{{ entry.relationship?.id || '-' }}</td>
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
        <div class="panel-actions">
          <button class="btn ghost" @click="copyDeepLink('compare')">复制深链接</button>
          <button class="btn ghost" :disabled="compareTotalFiltered === 0" @click="exportBomCompareCsv">
            导出 CSV
          </button>
          <button class="btn" :disabled="!compareLeftId || !compareRightId || compareLoading" @click="loadBomCompare">
            {{ compareLoading ? '加载中...' : '对比' }}
          </button>
        </div>
      </div>
      <div class="form-grid">
        <label for="plm-compare-left-id">
          左侧 ID
          <input
            id="plm-compare-left-id"
            v-model.trim="compareLeftId"
            name="plmCompareLeftId"
            placeholder="左侧 item/version ID"
          />
        </label>
        <label for="plm-compare-right-id">
          右侧 ID
          <input
            id="plm-compare-right-id"
            v-model.trim="compareRightId"
            name="plmCompareRightId"
            placeholder="右侧 item/version ID"
          />
        </label>
        <label for="plm-compare-max-levels">
          最大层级
          <input
            id="plm-compare-max-levels"
            v-model.number="compareMaxLevels"
            name="plmCompareMaxLevels"
            type="number"
            min="-1"
            max="20"
          />
        </label>
        <label for="plm-compare-line-key">
          Line Key
          <select id="plm-compare-line-key" v-model="compareLineKey" name="plmCompareLineKey">
            <option value="child_config">child_config</option>
            <option value="child_id">child_id</option>
            <option value="relationship_id">relationship_id</option>
            <option value="child_config_find_num">child_config_find_num</option>
            <option value="child_id_find_num">child_id_find_num</option>
            <option value="line_full">line_full</option>
          </select>
        </label>
        <label for="plm-compare-mode">
          Compare Mode
          <input
            id="plm-compare-mode"
            v-model.trim="compareMode"
            name="plmCompareMode"
            placeholder="only_product / summarized / num_qty"
          />
        </label>
        <label for="plm-compare-effective-at">
          生效时间
          <input
            id="plm-compare-effective-at"
            v-model="compareEffectiveAt"
            name="plmCompareEffectiveAt"
            type="datetime-local"
          />
        </label>
        <label for="plm-compare-rel-props">
          关系字段
          <input
            id="plm-compare-rel-props"
            v-model.trim="compareRelationshipProps"
            name="plmCompareRelProps"
            placeholder="quantity,uom,find_num,refdes"
          />
        </label>
        <label for="plm-compare-filter">
          过滤
          <input
            id="plm-compare-filter"
            v-model.trim="compareFilter"
            name="plmCompareFilter"
            placeholder="编号/名称/Line ID"
          />
        </label>
        <label class="checkbox-field" for="plm-compare-include-child">
          <span>包含父/子字段</span>
          <input
            id="plm-compare-include-child"
            name="plmCompareIncludeChild"
            v-model="compareIncludeChildFields"
            type="checkbox"
          />
        </label>
        <label class="checkbox-field" for="plm-compare-include-subs">
          <span>包含替代件</span>
          <input
            id="plm-compare-include-subs"
            name="plmCompareIncludeSubs"
            v-model="compareIncludeSubstitutes"
            type="checkbox"
          />
        </label>
        <label class="checkbox-field" for="plm-compare-include-effectivity">
          <span>包含生效性</span>
          <input
            id="plm-compare-include-effectivity"
            name="plmCompareIncludeEffectivity"
            v-model="compareIncludeEffectivity"
            type="checkbox"
          />
        </label>
      </div>
      <p v-if="compareError" class="status error">{{ compareError }}</p>
      <div v-if="!bomCompare" class="empty">
        暂无对比数据
        <span class="empty-hint">（填写左右 ID 后对比）</span>
      </div>
      <div v-else>
        <div class="summary-row">
          <span>新增: {{ compareSummary.added ?? 0 }}</span>
          <span>删除: {{ compareSummary.removed ?? 0 }}</span>
          <span>变更: {{ compareSummary.changed ?? 0 }}</span>
          <span>重大: {{ compareSummary.changed_major ?? 0 }}</span>
          <span>轻微: {{ compareSummary.changed_minor ?? 0 }}</span>
          <span>提示: {{ compareSummary.changed_info ?? 0 }}</span>
          <span class="muted">展示: {{ compareTotalFiltered }}</span>
        </div>
        <div class="compare-section">
          <h3>新增 ({{ compareAddedFiltered.length }}/{{ compareAdded.length }})</h3>
          <div v-if="!compareAddedFiltered.length" class="empty">无新增</div>
          <table v-else class="data-table">
            <thead>
              <tr>
                <th>层级</th>
                <th>父件</th>
                <th>子件</th>
                <th>数量</th>
                <th>单位</th>
                <th>Find #</th>
                <th>Refdes</th>
                <th>生效</th>
                <th>替代件</th>
                <th>Line</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in compareAddedFiltered" :key="entry.relationship_id || entry.line_key || entry.child_id">
                <td>{{ entry.level ?? '-' }}</td>
                <td>
                  <div>{{ getItemNumber(getCompareParent(entry)) }}</div>
                  <div class="muted">{{ getItemName(getCompareParent(entry)) }}</div>
                </td>
                <td>
                  <div>{{ getItemNumber(getCompareChild(entry)) }}</div>
                  <div class="muted">{{ getItemName(getCompareChild(entry)) }}</div>
                </td>
                <td>{{ getCompareProp(entry, 'quantity') }}</td>
                <td>{{ getCompareProp(entry, 'uom') }}</td>
                <td>{{ getCompareProp(entry, 'find_num') }}</td>
                <td>{{ getCompareProp(entry, 'refdes') }}</td>
                <td>{{ formatEffectivity(entry) }}</td>
                <td>{{ formatSubstituteCount(entry) }}</td>
                <td>
                  <div class="mono">{{ entry.line_key || '-' }}</div>
                  <div class="muted">{{ entry.relationship_id || '-' }}</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="compare-section">
          <h3>删除 ({{ compareRemovedFiltered.length }}/{{ compareRemoved.length }})</h3>
          <div v-if="!compareRemovedFiltered.length" class="empty">无删除</div>
          <table v-else class="data-table">
            <thead>
              <tr>
                <th>层级</th>
                <th>父件</th>
                <th>子件</th>
                <th>数量</th>
                <th>单位</th>
                <th>Find #</th>
                <th>Refdes</th>
                <th>生效</th>
                <th>替代件</th>
                <th>Line</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in compareRemovedFiltered" :key="entry.relationship_id || entry.line_key || entry.child_id">
                <td>{{ entry.level ?? '-' }}</td>
                <td>
                  <div>{{ getItemNumber(getCompareParent(entry)) }}</div>
                  <div class="muted">{{ getItemName(getCompareParent(entry)) }}</div>
                </td>
                <td>
                  <div>{{ getItemNumber(getCompareChild(entry)) }}</div>
                  <div class="muted">{{ getItemName(getCompareChild(entry)) }}</div>
                </td>
                <td>{{ getCompareProp(entry, 'quantity') }}</td>
                <td>{{ getCompareProp(entry, 'uom') }}</td>
                <td>{{ getCompareProp(entry, 'find_num') }}</td>
                <td>{{ getCompareProp(entry, 'refdes') }}</td>
                <td>{{ formatEffectivity(entry) }}</td>
                <td>{{ formatSubstituteCount(entry) }}</td>
                <td>
                  <div class="mono">{{ entry.line_key || '-' }}</div>
                  <div class="muted">{{ entry.relationship_id || '-' }}</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="compare-section">
          <h3>变更 ({{ compareChangedFiltered.length }}/{{ compareChanged.length }})</h3>
          <div v-if="!compareChangedFiltered.length" class="empty">无变更</div>
          <table v-else class="data-table">
            <thead>
              <tr>
                <th>层级</th>
                <th>父件</th>
                <th>子件</th>
                <th>严重度</th>
                <th>变更项</th>
                <th>生效</th>
                <th>替代件</th>
                <th>Line</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in compareChangedFiltered" :key="entry.relationship_id || entry.line_key || entry.child_id">
                <td>{{ entry.level ?? '-' }}</td>
                <td>
                  <div>{{ getItemNumber(getCompareParent(entry)) }}</div>
                  <div class="muted">{{ getItemName(getCompareParent(entry)) }}</div>
                </td>
                <td>
                  <div>{{ getItemNumber(getCompareChild(entry)) }}</div>
                  <div class="muted">{{ getItemName(getCompareChild(entry)) }}</div>
                </td>
                <td>
                  <span class="tag" :class="severityClass(entry.severity)">{{ entry.severity || 'info' }}</span>
                </td>
                <td>
                  <div v-if="entry.changes?.length" class="diff-list">
                    <div v-for="change in entry.changes" :key="change.field" class="diff-row">
                      <span class="tag" :class="severityClass(change.severity)">{{ change.severity || 'info' }}</span>
                      <span class="diff-field">
                        {{ getCompareFieldLabel(change.field) }}
                        <span v-if="compareFieldLabelMap.has(change.field)" class="diff-field-code">
                          ({{ change.field }})
                        </span>
                      </span>
                      <span class="diff-value">{{ formatDiffValue(change.left) }} → {{ formatDiffValue(change.right) }}</span>
                    </div>
                  </div>
                  <span v-else class="muted">-</span>
                </td>
                <td>{{ formatEffectivity(entry) }}</td>
                <td>{{ formatSubstituteCount(entry) }}</td>
                <td>
                  <div class="mono">{{ entry.line_key || '-' }}</div>
                  <div class="muted">{{ entry.relationship_id || '-' }}</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <details class="field-map">
          <summary>字段对照清单</summary>
          <table class="data-table">
            <thead>
              <tr>
                <th>字段</th>
                <th>Key</th>
                <th>来源</th>
                <th>默认严重度</th>
                <th>归一化</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="field in compareFieldCatalog" :key="field.key">
                <td>{{ field.label }}</td>
                <td class="mono">{{ field.key }}</td>
                <td>{{ field.source }}</td>
                <td>
                  <span class="tag" :class="severityClass(field.severity)">{{ field.severity }}</span>
                </td>
                <td class="muted">{{ field.normalized }}</td>
              </tr>
            </tbody>
          </table>
        </details>
        <details class="json-block">
          <summary>详细结果</summary>
          <pre>{{ formatJson(bomCompare) }}</pre>
        </details>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <h2>替代件</h2>
        <div class="panel-actions">
          <button class="btn ghost" @click="copyDeepLink('substitutes')">复制深链接</button>
          <button class="btn ghost" :disabled="!substitutesRows.length" @click="exportSubstitutesCsv">
            导出 CSV
          </button>
          <button class="btn" :disabled="!bomLineId || substitutesLoading" @click="loadSubstitutes">
            {{ substitutesLoading ? '加载中...' : '查询' }}
          </button>
        </div>
      </div>
      <div class="form-grid compact">
        <label for="plm-bom-line-id">
          BOM Line ID
          <input
            id="plm-bom-line-id"
            v-model.trim="bomLineId"
            name="plmBomLineId"
            placeholder="输入 BOM 行 ID"
          />
        </label>
        <label for="plm-substitutes-filter">
          过滤
          <input
            id="plm-substitutes-filter"
            v-model.trim="substitutesFilter"
            name="plmSubstitutesFilter"
            placeholder="替代件/原件编号"
          />
        </label>
      </div>
      <div class="form-grid compact">
        <label for="plm-substitute-item-id">
          替代件 ID
          <input
            id="plm-substitute-item-id"
            v-model.trim="substituteItemId"
            name="plmSubstituteItemId"
            placeholder="输入替代件 Item ID"
          />
        </label>
        <label for="plm-substitute-rank">
          优先级
          <input
            id="plm-substitute-rank"
            v-model.trim="substituteRank"
            name="plmSubstituteRank"
            placeholder="可选"
          />
        </label>
        <label for="plm-substitute-note">
          备注
          <input
            id="plm-substitute-note"
            v-model.trim="substituteNote"
            name="plmSubstituteNote"
            placeholder="可选"
          />
        </label>
      </div>
      <div class="panel-actions">
        <button
          class="btn"
          :disabled="!bomLineId || !substituteItemId || substitutesMutating"
          @click="addSubstitute"
        >
          {{ substitutesMutating ? '处理中...' : '新增替代件' }}
        </button>
      </div>
      <p v-if="substitutesActionStatus" class="status">{{ substitutesActionStatus }}</p>
      <p v-if="substitutesActionError" class="status error">{{ substitutesActionError }}</p>
      <p v-if="substitutesError" class="status error">{{ substitutesError }}</p>
      <div v-if="!substitutes" class="empty">
        暂无替代件数据
        <span class="empty-hint">（填写 BOM Line ID 后查询）</span>
      </div>
      <div v-else>
        <p class="status">共 {{ substitutes.count || 0 }} 条，展示 {{ substitutesRows.length }} 条</p>
        <div v-if="!substitutesRows.length" class="empty">
          暂无匹配项
          <span class="empty-hint">（可清空过滤条件）</span>
        </div>
        <table v-else class="data-table">
          <thead>
            <tr>
              <th>替代件 ID</th>
              <th>名称</th>
              <th>原件 ID</th>
              <th>优先级</th>
              <th>备注</th>
              <th>关系 ID</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in substitutesRows" :key="entry.id">
              <td>{{ entry.substitute_part?.id || entry.substitute_part?.item_number || entry.id }}</td>
              <td>{{ entry.substitute_part?.name || '-' }}</td>
              <td>{{ entry.part?.id || entry.part?.item_number || '-' }}</td>
              <td>{{ entry.rank ?? entry.relationship?.properties?.rank ?? '-' }}</td>
              <td>{{ entry.relationship?.properties?.note || entry.relationship?.properties?.comment || '-' }}</td>
              <td>{{ entry.relationship?.id || '-' }}</td>
              <td>
                <button class="btn ghost" :disabled="substitutesMutating" @click="removeSubstitute(entry)">
                  删除
                </button>
              </td>
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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { type LocationQueryValue, useRoute, useRouter } from 'vue-router'
import { apiGet, apiPost } from '../utils/api'

const route = useRoute()
const router = useRouter()

const DEFAULT_ITEM_TYPE = 'Part'
const DEFAULT_SEARCH_LIMIT = 10
const DEFAULT_WHERE_USED_MAX_LEVELS = 5
const DEFAULT_COMPARE_MAX_LEVELS = 10
const DEFAULT_COMPARE_LINE_KEY = 'child_config'
const DEFAULT_COMPARE_REL_PROPS = 'quantity,uom,find_num,refdes'
const DEFAULT_APPROVAL_STATUS = 'pending'

const searchQuery = ref('')
const searchItemType = ref(DEFAULT_ITEM_TYPE)
const searchLimit = ref(DEFAULT_SEARCH_LIMIT)
const searchResults = ref<any[]>([])
const searchTotal = ref(0)
const searchLoading = ref(false)
const searchError = ref('')

type AuthState = 'missing' | 'invalid' | 'expired' | 'expiring' | 'valid'

const authState = ref<AuthState>('missing')
const authExpiresAt = ref<number | null>(null)
const plmAuthState = ref<AuthState>('missing')
const plmAuthExpiresAt = ref<number | null>(null)
const plmAuthLegacy = ref(false)
const authError = ref('')
let authTimer: number | undefined
const deepLinkStatus = ref('')
const deepLinkError = ref('')
let deepLinkTimer: number | undefined
let querySyncTimer: number | undefined
let querySyncPending: Record<string, string | number | boolean | undefined> = {}
const deepLinkScope = ref<string[]>([])
const deepLinkPreset = ref('')
const customPresetName = ref('')
const editingPresetLabel = ref('')
const importPresetText = ref('')
const importFileInput = ref<HTMLInputElement | null>(null)
const isPresetDropActive = ref(false)
let presetDropDepth = 0
const customDeepLinkPresets = ref<Array<{ key: string; label: string; panels: string[] }>>([])

const productId = ref('')
const productItemNumber = ref('')
const itemType = ref(DEFAULT_ITEM_TYPE)
const product = ref<any | null>(null)
const productLoading = ref(false)
const productError = ref('')

const bomItems = ref<any[]>([])
const bomLoading = ref(false)
const bomError = ref('')

const documentRole = ref('')
const documentFilter = ref('')
const documentSortKey = ref<'updated' | 'name' | 'type' | 'revision' | 'role' | 'mime' | 'size'>('updated')
const documentSortDir = ref<'asc' | 'desc'>('desc')
const defaultDocumentColumns: Record<string, boolean> = {
  type: true,
  revision: true,
  role: true,
  mime: true,
  size: true,
  updated: true,
  preview: true,
  download: true,
  cad: true,
}
const documentColumns = ref<Record<string, boolean>>({ ...defaultDocumentColumns })
const documentColumnOptions = [
  { key: 'type', label: '类型' },
  { key: 'revision', label: '版本' },
  { key: 'role', label: '角色' },
  { key: 'mime', label: 'MIME' },
  { key: 'size', label: '大小' },
  { key: 'updated', label: '更新时间' },
  { key: 'preview', label: '预览' },
  { key: 'download', label: '下载' },
  { key: 'cad', label: 'CAD' },
]
const documents = ref<any[]>([])
const documentsLoading = ref(false)
const documentsError = ref('')

const cadFileId = ref('')
const cadOtherFileId = ref('')
const cadProperties = ref<any | null>(null)
const cadViewState = ref<any | null>(null)
const cadReview = ref<any | null>(null)
const cadHistory = ref<any | null>(null)
const cadDiff = ref<any | null>(null)
const cadMeshStats = ref<any | null>(null)
const cadPropertiesDraft = ref('')
const cadViewStateDraft = ref('')
const cadReviewState = ref('')
const cadReviewNote = ref('')
const cadLoading = ref(false)
const cadDiffLoading = ref(false)
const cadUpdating = ref(false)
const cadStatus = ref('')
const cadError = ref('')
const cadActionStatus = ref('')
const cadActionError = ref('')

const approvals = ref<any[]>([])
const approvalsStatus = ref<'all' | 'pending' | 'approved' | 'rejected'>(DEFAULT_APPROVAL_STATUS)
const approvalsLoading = ref(false)
const approvalsError = ref('')
const approvalsFilter = ref('')
const approvalSortKey = ref<'created' | 'title' | 'status' | 'requester' | 'product'>('created')
const approvalSortDir = ref<'asc' | 'desc'>('desc')
const defaultApprovalColumns: Record<string, boolean> = {
  status: true,
  type: true,
  requester: true,
  created: true,
  product: true,
}
const approvalColumns = ref<Record<string, boolean>>({ ...defaultApprovalColumns })
const approvalColumnOptions = [
  { key: 'status', label: '状态' },
  { key: 'type', label: '类型' },
  { key: 'requester', label: '发起人' },
  { key: 'created', label: '创建时间' },
  { key: 'product', label: '产品' },
]

const whereUsedItemId = ref('')
const whereUsedRecursive = ref(true)
const whereUsedMaxLevels = ref(DEFAULT_WHERE_USED_MAX_LEVELS)
const whereUsedFilter = ref('')
const whereUsed = ref<any | null>(null)
const whereUsedLoading = ref(false)
const whereUsedError = ref('')

const whereUsedRows = computed(() => {
  const payload = whereUsed.value
  const parents = payload?.parents || []
  const rootId = payload?.item_id || ''
  if (!parents.length) return []

  const levelIndex = new Map<number, Map<string, any>>()
  for (const entry of parents) {
    const level = Number(entry?.level || 1)
    const parentId = entry?.parent?.id || entry?.relationship?.source_id
    if (!parentId) continue
    if (!levelIndex.has(level)) {
      levelIndex.set(level, new Map())
    }
    levelIndex.get(level)?.set(parentId, entry)
  }

  const buildNode = (item: any, fallbackId?: string) => {
    const id = item?.id || fallbackId || ''
    const label = item?.item_number || item?.itemNumber || item?.code || item?.name || id
    return { id, label, name: item?.name || '' }
  }

  const buildPath = (entry: any) => {
    const nodes = []
    const parentNode = buildNode(entry.parent, entry?.relationship?.source_id)
    if (parentNode.id) nodes.unshift(parentNode)

    let currentLevel = Number(entry?.level || 1)
    let childId = entry?.relationship?.related_id
    while (currentLevel > 1 && childId) {
      const prevEntry = levelIndex.get(currentLevel - 1)?.get(childId)
      if (!prevEntry) break
      const node = buildNode(prevEntry.parent, prevEntry?.relationship?.source_id)
      if (node.id) nodes.unshift(node)
      childId = prevEntry?.relationship?.related_id
      currentLevel = Number(prevEntry?.level || (currentLevel - 1))
    }

    if (rootId) {
      nodes.unshift({ id: rootId, label: rootId, name: '' })
    }
    return nodes
  }

  return parents.map((entry: any, idx: number) => {
    const nodes = buildPath(entry)
    const pathLabel = nodes.map((node) => node.label).filter(Boolean).join(' → ')
    const key = entry?.relationship?.id || `${entry?.parent?.id || 'row'}-${idx}`
    return { ...entry, _key: key, pathNodes: nodes, pathLabel }
  })
})

const whereUsedFilteredRows = computed(() => {
  const needle = whereUsedFilter.value.trim().toLowerCase()
  if (!needle) return whereUsedRows.value
  return whereUsedRows.value.filter((entry: any) => {
    const tokens = [
      getItemNumber(entry.parent),
      getItemName(entry.parent),
      entry?.relationship?.id,
      entry?.pathLabel,
    ]
    return tokens.some((token) => String(token || '').toLowerCase().includes(needle))
  })
})

const compareLeftId = ref('')
const compareRightId = ref('')
const compareMode = ref('')
const compareMaxLevels = ref(DEFAULT_COMPARE_MAX_LEVELS)
const compareLineKey = ref(DEFAULT_COMPARE_LINE_KEY)
const compareIncludeChildFields = ref(true)
const compareIncludeSubstitutes = ref(false)
const compareIncludeEffectivity = ref(false)
const compareEffectiveAt = ref('')
const compareFilter = ref('')
const compareRelationshipProps = ref(DEFAULT_COMPARE_REL_PROPS)
const bomCompare = ref<any | null>(null)
const compareLoading = ref(false)
const compareError = ref('')
const productFieldCatalog = [
  {
    key: 'name',
    label: '名称',
    source: 'properties.name / item.name',
    fallback: 'item.id',
  },
  {
    key: 'partNumber',
    label: '料号',
    source: 'item_number / code',
    fallback: 'product.code',
  },
  {
    key: 'revision',
    label: '版本',
    source: 'properties.version / revision',
    fallback: 'product.version',
  },
  {
    key: 'status',
    label: '状态',
    source: 'item.state / properties.state',
    fallback: '-',
  },
  {
    key: 'itemType',
    label: '类型',
    source: 'item.type / item_type_id',
    fallback: 'Part',
  },
  {
    key: 'createdAt',
    label: '创建时间',
    source: 'created_on / properties.created_on / created_at',
    fallback: 'search hit created_at',
  },
  {
    key: 'updatedAt',
    label: '更新时间',
    source: 'modified_on / properties.modified_on / updated_at',
    fallback: 'search hit updated_at',
  },
]
const documentFieldCatalog = [
  {
    key: 'name',
    label: '名称',
    source: 'file metadata filename',
    fallback: 'file_id',
  },
  {
    key: 'document_type',
    label: '类型',
    source: 'metadata.document_type / entry.document_type',
    fallback: 'other',
  },
  {
    key: 'engineering_revision',
    label: '版本',
    source: 'metadata.document_version / entry.document_version',
    fallback: '-',
  },
  {
    key: 'file_size',
    label: '大小',
    source: 'metadata.file_size / entry.file_size',
    fallback: '0',
  },
  {
    key: 'mime_type',
    label: 'MIME',
    source: 'metadata.mime_type / entry.file_type',
    fallback: '-',
  },
  {
    key: 'preview_url',
    label: '预览链接',
    source: 'file preview url',
    fallback: '-',
  },
  {
    key: 'download_url',
    label: '下载链接',
    source: 'file download url',
    fallback: '-',
  },
  {
    key: 'engineering_state',
    label: '文档角色',
    source: 'file_role / entry.engineering_state',
    fallback: 'unknown',
  },
  {
    key: 'created_at',
    label: '创建时间',
    source: 'metadata.created_at',
    fallback: '-',
  },
  {
    key: 'updated_at',
    label: '更新时间',
    source: 'metadata.updated_at',
    fallback: '-',
  },
]
const approvalFieldCatalog = [
  {
    key: 'title',
    label: '标题',
    source: 'eco.name',
    fallback: 'eco.id',
  },
  {
    key: 'status',
    label: '状态',
    source: 'eco.state',
    fallback: 'pending',
  },
  {
    key: 'request_type',
    label: '类型',
    source: 'eco.eco_type',
    fallback: 'eco',
  },
  {
    key: 'requester_name',
    label: '发起人',
    source: 'eco.created_by_name / created_by_id',
    fallback: 'unknown',
  },
  {
    key: 'created_at',
    label: '创建时间',
    source: 'eco.created_at',
    fallback: '-',
  },
  {
    key: 'product_id',
    label: '产品',
    source: 'eco.product_id',
    fallback: '-',
  },
  {
    key: 'product_number',
    label: '产品编号',
    source: 'eco.product_number',
    fallback: '-',
  },
  {
    key: 'product_name',
    label: '产品名称',
    source: 'eco.product_name',
    fallback: '-',
  },
]
const compareFieldCatalog = [
  {
    key: 'quantity',
    label: '数量',
    source: 'relationship.properties.quantity',
    severity: 'major',
    normalized: 'float',
  },
  {
    key: 'uom',
    label: '单位',
    source: 'relationship.properties.uom',
    severity: 'major',
    normalized: 'uppercase',
  },
  {
    key: 'find_num',
    label: 'Find #',
    source: 'relationship.properties.find_num',
    severity: 'minor',
    normalized: 'trim',
  },
  {
    key: 'refdes',
    label: 'Refdes',
    source: 'relationship.properties.refdes',
    severity: 'minor',
    normalized: 'list/uppercase',
  },
  {
    key: 'effectivity_from',
    label: '生效起',
    source: 'relationship.properties.effectivity_from',
    severity: 'major',
    normalized: 'iso datetime',
  },
  {
    key: 'effectivity_to',
    label: '生效止',
    source: 'relationship.properties.effectivity_to',
    severity: 'major',
    normalized: 'iso datetime',
  },
  {
    key: 'effectivities',
    label: '生效性',
    source: 'effectivity records (includeEffectivity)',
    severity: 'major',
    normalized: 'sorted tuples',
  },
  {
    key: 'substitutes',
    label: '替代件',
    source: 'substitutes (includeSubstitutes)',
    severity: 'minor',
    normalized: 'sorted tuples',
  },
]
const compareFieldLabelMap = new Map(compareFieldCatalog.map((entry) => [entry.key, entry.label]))

const bomLineId = ref('')
const substitutes = ref<any | null>(null)
const substitutesLoading = ref(false)
const substitutesError = ref('')
const substitutesFilter = ref('')
const substituteItemId = ref('')
const substituteRank = ref('')
const substituteNote = ref('')
const substitutesActionStatus = ref('')
const substitutesActionError = ref('')
const substitutesMutating = ref(false)

const documentsFiltered = computed(() => {
  const needle = documentFilter.value.trim().toLowerCase()
  if (!needle) return documents.value
  return documents.value.filter((doc: any) => {
    const tokens = [
      doc.name,
      doc.document_type,
      doc.engineering_revision,
      doc.engineering_state,
      doc.mime_type,
      doc.id,
    ]
    return tokens.some((token) => String(token || '').toLowerCase().includes(needle))
  })
})

const documentSortConfig: SortConfig = {
  name: { type: 'string', accessor: (doc: any) => doc.name },
  type: { type: 'string', accessor: (doc: any) => doc.document_type },
  revision: { type: 'string', accessor: (doc: any) => doc.engineering_revision },
  role: { type: 'string', accessor: (doc: any) => doc.engineering_state },
  mime: { type: 'string', accessor: (doc: any) => doc.mime_type },
  size: { type: 'number', accessor: (doc: any) => doc.file_size },
  updated: { type: 'date', accessor: (doc: any) => doc.updated_at || doc.created_at },
}

const documentsSorted = computed(() =>
  sortRows(documentsFiltered.value, documentSortKey.value, documentSortDir.value, documentSortConfig)
)

const cadHistoryEntries = computed(() => cadHistory.value?.entries || [])

const approvalsFiltered = computed(() => {
  const needle = approvalsFilter.value.trim().toLowerCase()
  if (!needle) return approvals.value
  return approvals.value.filter((entry: any) => {
    const tokens = [
      entry.title,
      entry.requester_name,
      entry.requester_id,
      entry.product_name,
      entry.product_number,
      entry.product_id,
    ]
    return tokens.some((token) => String(token || '').toLowerCase().includes(needle))
  })
})

const approvalSortConfig: SortConfig = {
  created: { type: 'date', accessor: (entry: any) => entry.created_at },
  title: { type: 'string', accessor: (entry: any) => entry.title },
  status: { type: 'string', accessor: (entry: any) => entry.status },
  requester: { type: 'string', accessor: (entry: any) => entry.requester_name || entry.requester_id },
  product: { type: 'string', accessor: (entry: any) => entry.product_number || entry.product_id },
}

const approvalsSorted = computed(() =>
  sortRows(approvalsFiltered.value, approvalSortKey.value, approvalSortDir.value, approvalSortConfig)
)

const compareSummary = computed(() => bomCompare.value?.summary || {})
const compareAdded = computed(() => bomCompare.value?.added || [])
const compareRemoved = computed(() => bomCompare.value?.removed || [])
const compareChanged = computed(() => bomCompare.value?.changed || [])
const compareAddedFiltered = computed(() => filterCompareEntries(compareAdded.value))
const compareRemovedFiltered = computed(() => filterCompareEntries(compareRemoved.value))
const compareChangedFiltered = computed(() => filterCompareEntries(compareChanged.value))
const compareTotalFiltered = computed(
  () => compareAddedFiltered.value.length + compareRemovedFiltered.value.length + compareChangedFiltered.value.length
)

const substitutesRows = computed(() => {
  const list = substitutes.value?.substitutes || []
  const needle = substitutesFilter.value.trim().toLowerCase()
  if (!needle) return list
  return list.filter((entry: any) => {
    const tokens = [
      entry?.substitute_part?.item_number,
      entry?.substitute_part?.name,
      entry?.part?.item_number,
      entry?.part?.name,
      entry?.id,
      entry?.relationship?.id,
    ]
    return tokens.some((token) => String(token || '').toLowerCase().includes(needle))
  })
})

const authStateText = computed(() => {
  switch (authState.value) {
    case 'valid':
      return '已登录'
    case 'expiring':
      return '即将过期'
    case 'expired':
      return '已过期'
    case 'invalid':
      return '无效 Token'
    default:
      return '未登录'
  }
})

const authStateClass = computed(() => `auth-${authState.value}`)

const authExpiryText = computed(() => {
  if (!authExpiresAt.value) return ''
  const date = new Date(authExpiresAt.value)
  if (Number.isNaN(date.getTime())) return ''
  return `有效至 ${date.toLocaleString()}`
})

const authHint = computed(() => {
  if (authState.value === 'missing') {
    return '未检测到 auth_token（MetaSheet token），请在 localStorage 写入后刷新。'
  }
  if (authState.value === 'invalid') {
    return 'MetaSheet Token 解析失败，请重新获取并写入 auth_token。'
  }
  if (authState.value === 'expired') {
    return 'MetaSheet Token 已过期，请重新登录或刷新 Token。'
  }
  if (authState.value === 'expiring') {
    return 'MetaSheet Token 即将过期，建议提前刷新。'
  }
  return ''
})

const plmAuthStateText = computed(() => {
  switch (plmAuthState.value) {
    case 'valid':
      return '已登录'
    case 'expiring':
      return '即将过期'
    case 'expired':
      return '已过期'
    case 'invalid':
      return '无效 Token'
    default:
      return '未设置'
  }
})

const plmAuthStateClass = computed(() => `auth-${plmAuthState.value}`)

const plmAuthExpiryText = computed(() => {
  if (!plmAuthExpiresAt.value) return ''
  const date = new Date(plmAuthExpiresAt.value)
  if (Number.isNaN(date.getTime())) return ''
  return `有效至 ${date.toLocaleString()}`
})

const plmAuthHint = computed(() => {
  if (plmAuthLegacy.value) {
    return '检测到旧字段 jwt，建议迁移为 plm_token。'
  }
  if (plmAuthState.value === 'missing') {
    return '未检测到 plm_token（可选，仅用于显示 PLM Token 状态）。'
  }
  if (plmAuthState.value === 'invalid') {
    return 'PLM Token 解析失败，请重新获取并写入 plm_token。'
  }
  if (plmAuthState.value === 'expired') {
    return 'PLM Token 已过期，请重新登录或刷新 Token。'
  }
  if (plmAuthState.value === 'expiring') {
    return 'PLM Token 即将过期，建议提前刷新。'
  }
  return ''
})

const DOCUMENT_COLUMNS_STORAGE_KEY = 'plm_document_columns'
const APPROVAL_COLUMNS_STORAGE_KEY = 'plm_approval_columns'
const DEEP_LINK_PRESETS_STORAGE_KEY = 'plm_deep_link_presets'
const deepLinkPanelOptions = [
  { key: 'search', label: '搜索' },
  { key: 'product', label: '产品' },
  { key: 'cad', label: 'CAD 元数据' },
  { key: 'where-used', label: 'Where-Used' },
  { key: 'compare', label: 'BOM 对比' },
  { key: 'substitutes', label: '替代件' },
]
const builtInDeepLinkPresets = [
  { key: 'cad-meta', label: 'CAD 元数据', panels: ['cad'] },
  { key: 'product-where-used', label: '产品 + Where-Used', panels: ['product', 'where-used'] },
  { key: 'compare-substitutes', label: 'BOM 对比 + 替代件', panels: ['compare', 'substitutes'] },
  { key: 'full-bom', label: '产品 + BOM 全链路', panels: ['product', 'where-used', 'compare', 'substitutes'] },
]
const deepLinkPresets = computed(() => [...builtInDeepLinkPresets, ...customDeepLinkPresets.value])

function formatJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2)
}

function formatTime(value?: string): string {
  if (!value) return '-'
  return value
}

function formatBytes(value?: number): string {
  if (!value && value !== 0) return '-'
  if (value < 1024) return `${value} B`
  const kb = value / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  const gb = mb / 1024
  return `${gb.toFixed(1)} GB`
}

function resetAll() {
  productId.value = ''
  productItemNumber.value = ''
  product.value = null
  productError.value = ''
  authError.value = ''
  deepLinkStatus.value = ''
  deepLinkError.value = ''
  deepLinkScope.value = []
  deepLinkPreset.value = ''
  customPresetName.value = ''
  editingPresetLabel.value = ''
  importPresetText.value = ''
  isPresetDropActive.value = false
  presetDropDepth = 0
  searchQuery.value = ''
  searchItemType.value = DEFAULT_ITEM_TYPE
  searchLimit.value = DEFAULT_SEARCH_LIMIT
  searchResults.value = []
  searchTotal.value = 0
  searchError.value = ''
  bomItems.value = []
  bomError.value = ''
  documentRole.value = ''
  documentSortKey.value = 'updated'
  documentSortDir.value = 'desc'
  documents.value = []
  documentsError.value = ''
  documentFilter.value = ''
  documentColumns.value = { ...defaultDocumentColumns }
  cadFileId.value = ''
  cadOtherFileId.value = ''
  cadProperties.value = null
  cadViewState.value = null
  cadReview.value = null
  cadHistory.value = null
  cadDiff.value = null
  cadMeshStats.value = null
  cadPropertiesDraft.value = ''
  cadViewStateDraft.value = ''
  cadReviewState.value = ''
  cadReviewNote.value = ''
  cadLoading.value = false
  cadDiffLoading.value = false
  cadUpdating.value = false
  cadStatus.value = ''
  cadError.value = ''
  cadActionStatus.value = ''
  cadActionError.value = ''
  approvals.value = []
  approvalsStatus.value = DEFAULT_APPROVAL_STATUS
  approvalSortKey.value = 'created'
  approvalSortDir.value = 'desc'
  approvalsError.value = ''
  approvalsFilter.value = ''
  approvalColumns.value = { ...defaultApprovalColumns }
  whereUsedItemId.value = ''
  whereUsedRecursive.value = true
  whereUsedMaxLevels.value = DEFAULT_WHERE_USED_MAX_LEVELS
  whereUsed.value = null
  whereUsedError.value = ''
  compareLeftId.value = ''
  compareRightId.value = ''
  compareMode.value = ''
  compareMaxLevels.value = DEFAULT_COMPARE_MAX_LEVELS
  compareLineKey.value = DEFAULT_COMPARE_LINE_KEY
  compareIncludeChildFields.value = true
  compareIncludeSubstitutes.value = false
  compareIncludeEffectivity.value = false
  compareEffectiveAt.value = ''
  compareFilter.value = ''
  compareRelationshipProps.value = DEFAULT_COMPARE_REL_PROPS
  bomCompare.value = null
  compareError.value = ''
  bomLineId.value = ''
  substitutes.value = null
  substitutesError.value = ''
  substitutesFilter.value = ''
  substituteItemId.value = ''
  substituteRank.value = ''
  substituteNote.value = ''
  substitutesActionStatus.value = ''
  substitutesActionError.value = ''
  substitutesMutating.value = false
  whereUsedFilter.value = ''
  syncQueryParams({
    searchQuery: '',
    searchItemType: '',
    searchLimit: undefined,
    productId: '',
    itemNumber: '',
    itemType: '',
    cadFileId: '',
    cadOtherFileId: '',
    documentRole: '',
    documentFilter: '',
    approvalsStatus: '',
    approvalsFilter: '',
    whereUsedItemId: '',
    whereUsedRecursive: undefined,
    whereUsedMaxLevels: undefined,
    whereUsedFilter: '',
    compareLeftId: '',
    compareRightId: '',
    compareMode: '',
    compareLineKey: '',
    compareMaxLevels: undefined,
    compareIncludeChildFields: undefined,
    compareIncludeSubstitutes: undefined,
    compareIncludeEffectivity: undefined,
    compareEffectiveAt: '',
    compareRelationshipProps: '',
    compareFilter: '',
    bomLineId: '',
    substitutesFilter: '',
    panel: '',
    autoload: undefined,
  })
}

function decodeJwtPayload(token: string): { exp?: number } | null {
  const segments = token.split('.')
  if (segments.length < 2) return null
  const payload = segments[1]
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    return JSON.parse(atob(padded))
  } catch (_err) {
    return null
  }
}

function resolveTokenStatus(token: string): { state: AuthState; expiresAt: number | null } {
  if (!token) {
    return { state: 'missing', expiresAt: null }
  }
  const payload = decodeJwtPayload(token)
  const expSeconds = payload?.exp
  if (!expSeconds) {
    return { state: 'invalid', expiresAt: null }
  }
  const expMs = expSeconds * 1000
  const timeLeftMs = expMs - Date.now()
  if (timeLeftMs <= 0) {
    return { state: 'expired', expiresAt: expMs }
  }
  if (timeLeftMs <= 10 * 60 * 1000) {
    return { state: 'expiring', expiresAt: expMs }
  }
  return { state: 'valid', expiresAt: expMs }
}

function refreshAuthStatus() {
  const metaToken = localStorage.getItem('auth_token') || ''
  const metaStatus = resolveTokenStatus(metaToken)
  authState.value = metaStatus.state
  authExpiresAt.value = metaStatus.expiresAt

  const plmToken = localStorage.getItem('plm_token') || ''
  const legacyToken = localStorage.getItem('jwt') || ''
  plmAuthLegacy.value = !plmToken && Boolean(legacyToken)
  const plmStatus = resolveTokenStatus(plmToken || legacyToken)
  plmAuthState.value = plmStatus.state
  plmAuthExpiresAt.value = plmStatus.expiresAt
}

function handleAuthError(error: any) {
  const message = error?.message || ''
  if (!message.includes('401')) return
  refreshAuthStatus()
  if (authState.value === 'valid' || authState.value === 'expiring') {
    authState.value = 'invalid'
  }
  authError.value = `鉴权失败（${message.replace('API error: ', '')}）。请刷新 Token。`
}

async function searchProducts() {
  searchLoading.value = true
  searchError.value = ''
  try {
    const filters: Record<string, unknown> = {}
    if (searchQuery.value) filters.query = searchQuery.value
    if (searchItemType.value) filters.itemType = searchItemType.value
    const result = await apiPost<{
      ok: boolean
      data: { items: any[]; total: number }
      error?: { message?: string }
    }>('/api/federation/plm/query', {
      operation: 'products',
      pagination: { limit: searchLimit.value || 10, offset: 0 },
      filters: Object.keys(filters).length ? filters : undefined,
    })
    if (!result.ok) {
      throw new Error(result.error?.message || '搜索失败')
    }
    searchResults.value = result.data?.items || []
    searchTotal.value = result.data?.total ?? searchResults.value.length
  } catch (error: any) {
    handleAuthError(error)
    searchError.value = error?.message || '搜索失败'
  } finally {
    searchLoading.value = false
  }
}

async function applySearchItem(item: any) {
  if (!item?.id) return
  productId.value = item.id
  productItemNumber.value = item.partNumber || item.code || ''
  if (item.itemType) {
    itemType.value = item.itemType
  }
  await loadProduct()
}

async function loadProduct() {
  const resolvedId = productId.value || productItemNumber.value
  if (!resolvedId) return
  syncQueryParams({ productId: productId.value, itemNumber: productItemNumber.value, itemType: itemType.value })
  productLoading.value = true
  productError.value = ''
  try {
    const params = new URLSearchParams()
    if (itemType.value) {
      params.set('itemType', itemType.value)
    }
    if (productItemNumber.value) {
      params.set('itemNumber', productItemNumber.value)
    }
    const result = await apiGet<{ ok: boolean; data: any; error?: { message?: string } }>(
      `/api/federation/plm/products/${encodeURIComponent(resolvedId)}?${params.toString()}`
    )
    if (!result.ok) {
      throw new Error(result.error?.message || '加载产品失败')
    }
    product.value = result.data
    if (result.data?.id && result.data.id !== productId.value) {
      productId.value = String(result.data.id)
      syncQueryParams({ productId: productId.value })
    }
    await Promise.all([loadBom(), loadDocuments(), loadApprovals()])
  } catch (error: any) {
    handleAuthError(error)
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
    handleAuthError(error)
    bomError.value = error?.message || '加载 BOM 失败'
  } finally {
    bomLoading.value = false
  }
}

async function loadDocuments() {
  if (!productId.value) return
  documentsLoading.value = true
  documentsError.value = ''
  try {
    const filters: Record<string, unknown> = {}
    if (documentRole.value) filters.role = documentRole.value
    const result = await apiPost<{ ok: boolean; data: { items: any[] }; error?: { message?: string } }>(
      '/api/federation/plm/query',
      {
        operation: 'documents',
        productId: productId.value,
        pagination: { limit: 100, offset: 0 },
        filters: Object.keys(filters).length ? filters : undefined
      }
    )
    if (!result.ok) {
      throw new Error(result.error?.message || '加载文档失败')
    }
    documents.value = result.data?.items || []
  } catch (error: any) {
    handleAuthError(error)
    documentsError.value = error?.message || '加载文档失败'
  } finally {
    documentsLoading.value = false
  }
}

function resolveCadFileId(doc: any): string {
  const fileId = doc?.id || doc?.file_id
  return fileId ? String(fileId) : ''
}

function selectCadFile(doc: any, target: 'primary' | 'other' = 'primary') {
  const fileId = resolveCadFileId(doc)
  if (!fileId) return
  if (target === 'other') {
    cadOtherFileId.value = fileId
    cadStatus.value = '已设置对比 CAD 文件'
  } else {
    cadFileId.value = fileId
    cadStatus.value = '已设置 CAD 文件'
  }
  scheduleQuerySync({
    cadFileId: cadFileId.value || undefined,
    cadOtherFileId: cadOtherFileId.value || undefined,
  })
}

function resolveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

async function queryCad<T>(operation: string, payload: Record<string, unknown>, fallback: string): Promise<T> {
  const result = await apiPost<{ ok: boolean; data: T; error?: { message?: string } }>(
    '/api/federation/plm/query',
    { operation, ...payload }
  )
  if (!result.ok) {
    throw new Error(result.error?.message || fallback)
  }
  return result.data
}

async function loadCadMetadata() {
  if (!cadFileId.value) return
  syncQueryParams({ cadFileId: cadFileId.value, cadOtherFileId: cadOtherFileId.value })
  cadLoading.value = true
  cadError.value = ''
  cadStatus.value = ''
  const payload = { fileId: cadFileId.value }
  const tasks = [
    {
      label: '属性',
      run: () => queryCad<any>('cad_properties', payload, '加载属性失败'),
      apply: (data: any) => {
        cadProperties.value = data
        cadPropertiesDraft.value = JSON.stringify({ properties: data?.properties ?? {} }, null, 2)
      },
    },
    {
      label: '视图状态',
      run: () => queryCad<any>('cad_view_state', payload, '加载视图状态失败'),
      apply: (data: any) => {
        cadViewState.value = data
        cadViewStateDraft.value = JSON.stringify({
          hidden_entity_ids: data?.hidden_entity_ids ?? [],
          notes: data?.notes ?? [],
        }, null, 2)
      },
    },
    {
      label: '评审',
      run: () => queryCad<any>('cad_review', payload, '加载评审失败'),
      apply: (data: any) => {
        cadReview.value = data
        cadReviewState.value = data?.state || ''
        cadReviewNote.value = data?.note || ''
      },
    },
    {
      label: '历史',
      run: () => queryCad<any>('cad_history', payload, '加载历史失败'),
      apply: (data: any) => {
        cadHistory.value = data
      },
    },
    {
      label: '网格统计',
      run: () => queryCad<any>('cad_mesh_stats', payload, '加载网格统计失败'),
      apply: (data: any) => {
        cadMeshStats.value = data
      },
    },
  ]
  const results = await Promise.allSettled(tasks.map((task) => task.run()))
  const errors: string[] = []
  results.forEach((result, index) => {
    const task = tasks[index]
    if (result.status === 'fulfilled') {
      task.apply(result.value)
      return
    }
    handleAuthError(result.reason)
    errors.push(`${task.label}: ${resolveErrorMessage(result.reason, '请求失败')}`)
  })
  cadError.value = errors.join('；')
  if (!errors.length) {
    cadStatus.value = 'CAD 元数据已加载'
  }
  cadLoading.value = false
}

async function loadCadDiff() {
  if (!cadFileId.value || !cadOtherFileId.value) return
  syncQueryParams({ cadFileId: cadFileId.value, cadOtherFileId: cadOtherFileId.value })
  cadDiffLoading.value = true
  cadError.value = ''
  try {
    cadDiff.value = await queryCad<any>(
      'cad_diff',
      { fileId: cadFileId.value, otherFileId: cadOtherFileId.value },
      '加载差异失败'
    )
    cadStatus.value = 'CAD 差异已加载'
  } catch (error: any) {
    handleAuthError(error)
    cadError.value = error?.message || '加载差异失败'
  } finally {
    cadDiffLoading.value = false
  }
}

function parseJsonObject(value: string, label: string): Record<string, unknown> | null {
  const trimmed = value.trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} 需要是 JSON 对象`)
    }
    return parsed as Record<string, unknown>
  } catch (error: any) {
    cadActionError.value = error?.message || `${label} JSON 解析失败`
    return null
  }
}

async function updateCadProperties() {
  if (!cadFileId.value) return
  cadUpdating.value = true
  cadActionError.value = ''
  cadActionStatus.value = ''
  try {
    const payload = parseJsonObject(cadPropertiesDraft.value, '属性')
    if (!payload) return
    const result = await apiPost<{ ok: boolean; data: any; error?: { message?: string } }>(
      '/api/federation/plm/mutate',
      {
        operation: 'cad_properties_update',
        fileId: cadFileId.value,
        payload,
      }
    )
    if (!result.ok) {
      throw new Error(result.error?.message || '更新属性失败')
    }
    cadProperties.value = result.data
    cadPropertiesDraft.value = JSON.stringify({ properties: result.data?.properties ?? {} }, null, 2)
    cadActionStatus.value = '已更新属性'
  } catch (error: any) {
    handleAuthError(error)
    cadActionError.value = error?.message || '更新属性失败'
  } finally {
    cadUpdating.value = false
  }
}

async function updateCadViewState() {
  if (!cadFileId.value) return
  cadUpdating.value = true
  cadActionError.value = ''
  cadActionStatus.value = ''
  try {
    const payload = parseJsonObject(cadViewStateDraft.value, '视图状态')
    if (!payload) return
    const result = await apiPost<{ ok: boolean; data: any; error?: { message?: string } }>(
      '/api/federation/plm/mutate',
      {
        operation: 'cad_view_state_update',
        fileId: cadFileId.value,
        payload,
      }
    )
    if (!result.ok) {
      throw new Error(result.error?.message || '更新视图状态失败')
    }
    cadViewState.value = result.data
    cadViewStateDraft.value = JSON.stringify({
      hidden_entity_ids: result.data?.hidden_entity_ids ?? [],
      notes: result.data?.notes ?? [],
    }, null, 2)
    cadActionStatus.value = '已更新视图状态'
  } catch (error: any) {
    handleAuthError(error)
    cadActionError.value = error?.message || '更新视图状态失败'
  } finally {
    cadUpdating.value = false
  }
}

async function updateCadReview() {
  if (!cadFileId.value) return
  const state = cadReviewState.value.trim()
  if (!state) {
    cadActionError.value = '请填写评审状态'
    return
  }
  cadUpdating.value = true
  cadActionError.value = ''
  cadActionStatus.value = ''
  try {
    const payload: Record<string, unknown> = { state }
    if (cadReviewNote.value.trim()) {
      payload.note = cadReviewNote.value.trim()
    }
    const result = await apiPost<{ ok: boolean; data: any; error?: { message?: string } }>(
      '/api/federation/plm/mutate',
      {
        operation: 'cad_review_update',
        fileId: cadFileId.value,
        payload,
      }
    )
    if (!result.ok) {
      throw new Error(result.error?.message || '提交评审失败')
    }
    cadReview.value = result.data
    cadReviewState.value = result.data?.state || state
    cadReviewNote.value = result.data?.note || cadReviewNote.value
    cadActionStatus.value = '评审已提交'
  } catch (error: any) {
    handleAuthError(error)
    cadActionError.value = error?.message || '提交评审失败'
  } finally {
    cadUpdating.value = false
  }
}

async function loadApprovals() {
  approvalsLoading.value = true
  approvalsError.value = ''
  try {
    const filters: Record<string, unknown> = {}
    if (approvalsStatus.value !== 'all') {
      filters.status = approvalsStatus.value
    }
    const result = await apiPost<{ ok: boolean; data: { items: any[] }; error?: { message?: string } }>(
      '/api/federation/plm/query',
      {
        operation: 'approvals',
        productId: productId.value || undefined,
        pagination: { limit: 100, offset: 0 },
        filters: Object.keys(filters).length ? filters : undefined
      }
    )
    if (!result.ok) {
      throw new Error(result.error?.message || '加载审批失败')
    }
    approvals.value = result.data?.items || []
  } catch (error: any) {
    handleAuthError(error)
    approvalsError.value = error?.message || '加载审批失败'
  } finally {
    approvalsLoading.value = false
  }
}

async function loadWhereUsed() {
  if (!whereUsedItemId.value) return
  syncQueryParams({
    whereUsedItemId: whereUsedItemId.value,
    whereUsedRecursive: whereUsedRecursive.value,
    whereUsedMaxLevels: whereUsedMaxLevels.value,
  })
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
    handleAuthError(error)
    whereUsedError.value = error?.message || '查询 where-used 失败'
  } finally {
    whereUsedLoading.value = false
  }
}

async function loadBomCompare() {
  if (!compareLeftId.value || !compareRightId.value) return
  syncQueryParams({
    compareLeftId: compareLeftId.value,
    compareRightId: compareRightId.value,
    compareMode: compareMode.value || undefined,
    compareLineKey: compareLineKey.value || undefined,
    compareMaxLevels: compareMaxLevels.value,
    compareIncludeChildFields: compareIncludeChildFields.value,
    compareIncludeSubstitutes: compareIncludeSubstitutes.value,
    compareIncludeEffectivity: compareIncludeEffectivity.value,
    compareEffectiveAt: compareEffectiveAt.value || undefined,
    compareRelationshipProps: compareRelationshipProps.value || undefined,
  })
  compareLoading.value = true
  compareError.value = ''
  try {
    const relProps = compareRelationshipProps.value
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    const effectiveAt = normalizeEffectiveAt(compareEffectiveAt.value)
    const result = await apiPost<{ ok: boolean; data: any; error?: { message?: string } }>(
      '/api/federation/plm/query',
      {
        operation: 'bom_compare',
        leftId: compareLeftId.value,
        rightId: compareRightId.value,
        leftType: 'item',
        rightType: 'item',
        maxLevels: compareMaxLevels.value,
        compareMode: compareMode.value || undefined,
        lineKey: compareLineKey.value || undefined,
        includeChildFields: compareIncludeChildFields.value,
        includeSubstitutes: compareIncludeSubstitutes.value,
        includeEffectivity: compareIncludeEffectivity.value,
        includeRelationshipProps: relProps.length ? relProps : undefined,
        effectiveAt
      }
    )
    if (!result.ok) {
      throw new Error(result.error?.message || 'BOM 对比失败')
    }
    bomCompare.value = result.data
  } catch (error: any) {
    handleAuthError(error)
    compareError.value = error?.message || 'BOM 对比失败'
  } finally {
    compareLoading.value = false
  }
}

async function loadSubstitutes() {
  if (!bomLineId.value) return
  syncQueryParams({ bomLineId: bomLineId.value })
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
    handleAuthError(error)
    substitutesError.value = error?.message || '查询替代件失败'
  } finally {
    substitutesLoading.value = false
  }
}

function buildSubstituteProperties(): Record<string, unknown> | undefined {
  const props: Record<string, unknown> = {}
  const rankValue = substituteRank.value.trim()
  if (rankValue) {
    const numeric = Number(rankValue)
    props.rank = Number.isNaN(numeric) ? rankValue : numeric
  }
  const noteValue = substituteNote.value.trim()
  if (noteValue) {
    props.note = noteValue
  }
  return Object.keys(props).length ? props : undefined
}

async function addSubstitute() {
  if (!bomLineId.value || !substituteItemId.value) return
  substitutesMutating.value = true
  substitutesActionError.value = ''
  substitutesActionStatus.value = ''
  try {
    const result = await apiPost<{ ok: boolean; data?: any; error?: { message?: string } }>(
      '/api/federation/plm/mutate',
      {
        operation: 'substitutes_add',
        bomLineId: bomLineId.value,
        substituteItemId: substituteItemId.value,
        properties: buildSubstituteProperties(),
      }
    )
    if (!result.ok) {
      throw new Error(result.error?.message || '新增替代件失败')
    }
    substitutesActionStatus.value = '已新增替代件'
    substituteItemId.value = ''
    substituteRank.value = ''
    substituteNote.value = ''
    await loadSubstitutes()
  } catch (error: any) {
    handleAuthError(error)
    substitutesActionError.value = error?.message || '新增替代件失败'
  } finally {
    substitutesMutating.value = false
  }
}

async function removeSubstitute(entry: any) {
  if (!bomLineId.value) return
  const substituteId = entry?.id || entry?.relationship?.id
  if (!substituteId) {
    substitutesActionError.value = '缺少替代关系 ID'
    return
  }
  if (!window.confirm('确认删除该替代件？')) {
    return
  }
  substitutesMutating.value = true
  substitutesActionError.value = ''
  substitutesActionStatus.value = ''
  try {
    const result = await apiPost<{ ok: boolean; data?: any; error?: { message?: string } }>(
      '/api/federation/plm/mutate',
      {
        operation: 'substitutes_remove',
        bomLineId: bomLineId.value,
        substituteId,
      }
    )
    if (!result.ok) {
      throw new Error(result.error?.message || '删除替代件失败')
    }
    substitutesActionStatus.value = '已删除替代件'
    await loadSubstitutes()
  } catch (error: any) {
    handleAuthError(error)
    substitutesActionError.value = error?.message || '删除替代件失败'
  } finally {
    substitutesMutating.value = false
  }
}

function getItemNumber(item?: Record<string, any> | null): string {
  if (!item) return '-'
  return item.item_number || item.itemNumber || item.code || item.id || '-'
}

function getItemName(item?: Record<string, any> | null): string {
  if (!item) return '-'
  return item.name || item.label || item.title || '-'
}

function getCompareParent(entry?: Record<string, any> | null): Record<string, any> | null {
  if (!entry) return null
  if (entry.parent) return entry.parent
  const path = entry.path
  if (Array.isArray(path) && path.length) {
    return path[0] || null
  }
  return null
}

function getCompareChild(entry?: Record<string, any> | null): Record<string, any> | null {
  if (!entry) return null
  if (entry.child) return entry.child
  const path = entry.path
  if (Array.isArray(path) && path.length > 1) {
    return path[path.length - 1] || null
  }
  return null
}

function getCompareProp(entry: Record<string, any>, key: string): string {
  const props = entry?.properties || entry?.relationship || {}
  const value = props[key]
  if (value === undefined || value === null || value === '') return '-'
  return String(value)
}

function getWhereUsedRefdes(entry: Record<string, any>): string {
  const rel = entry?.relationship || {}
  const value = rel.refdes ?? rel.properties?.refdes ?? rel.properties?.ref_des
  if (value === undefined || value === null || value === '') return '-'
  return String(value)
}

function normalizeEffectiveAt(value: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString()
}

function readQueryParam(key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(route.query, key)) {
    return undefined
  }
  const raw = route.query[key]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined || value === null) return ''
  return String(value)
}

function parseQueryBoolean(value?: string): boolean | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return undefined
}

function parseQueryNumber(value?: string): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return undefined
  return parsed
}

function syncQueryParams(patch: Record<string, string | number | boolean | undefined>) {
  const nextQuery: Record<string, LocationQueryValue | LocationQueryValue[] | undefined> = { ...route.query }
  let changed = false
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null || value === '') {
      if (key in nextQuery) {
        delete nextQuery[key]
        changed = true
      }
      continue
    }
    const nextValue = String(value)
    const currentValue = nextQuery[key]
    const currentResolved = Array.isArray(currentValue) ? currentValue[0] : currentValue
    if (currentResolved !== nextValue) {
      nextQuery[key] = nextValue
      changed = true
    }
  }
  if (!changed) return
  router.replace({ query: nextQuery }).catch(() => null)
}

function scheduleQuerySync(patch: Record<string, string | number | boolean | undefined>) {
  querySyncPending = { ...querySyncPending, ...patch }
  if (querySyncTimer) {
    window.clearTimeout(querySyncTimer)
  }
  querySyncTimer = window.setTimeout(() => {
    syncQueryParams(querySyncPending)
    querySyncPending = {}
    querySyncTimer = undefined
  }, 250)
}

function setDeepLinkMessage(message: string, isError = false) {
  if (deepLinkTimer) {
    window.clearTimeout(deepLinkTimer)
  }
  deepLinkStatus.value = isError ? '' : message
  deepLinkError.value = isError ? message : ''
  deepLinkTimer = window.setTimeout(() => {
    deepLinkStatus.value = ''
    deepLinkError.value = ''
  }, 4000)
}

let applyingPreset = false

const deepLinkPanelLabels: Record<string, string> = {
  all: '全部',
  search: '搜索',
  product: '产品',
  cad: 'CAD 元数据',
  'where-used': 'Where-Used',
  compare: 'BOM 对比',
  substitutes: '替代件',
}

function clearDeepLinkScope() {
  deepLinkScope.value = []
  deepLinkPreset.value = ''
  customPresetName.value = ''
}

function applyDeepLinkPreset() {
  if (!deepLinkPreset.value) {
    deepLinkScope.value = []
    return
  }
  const preset = deepLinkPresets.value.find((entry) => entry.key === deepLinkPreset.value)
  applyingPreset = true
  deepLinkScope.value = preset ? [...preset.panels] : []
  window.setTimeout(() => {
    applyingPreset = false
  }, 0)
}

function sanitizePresetPanels(panels: unknown): string[] {
  if (!Array.isArray(panels)) return []
  const allowed = new Set(Object.keys(deepLinkPanelLabels).filter((entry) => entry !== 'all'))
  const normalized = panels
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter((entry) => entry && allowed.has(entry))
  return Array.from(new Set(normalized))
}

function saveDeepLinkPreset() {
  const name = customPresetName.value.trim()
  if (!name) {
    setDeepLinkMessage('请输入预设名称。', true)
    return
  }
  const panels = sanitizePresetPanels(deepLinkScope.value)
  if (!panels.length) {
    setDeepLinkMessage('请选择范围后再保存。', true)
    return
  }
  const preset = { key: `custom:${Date.now()}`, label: name, panels }
  customDeepLinkPresets.value = [...customDeepLinkPresets.value, preset]
  deepLinkPreset.value = preset.key
  applyDeepLinkPreset()
  customPresetName.value = ''
  editingPresetLabel.value = ''
  setDeepLinkMessage('已保存预设。')
}

function deleteDeepLinkPreset() {
  if (!deepLinkPreset.value.startsWith('custom:')) return
  customDeepLinkPresets.value = customDeepLinkPresets.value.filter(
    (preset) => preset.key !== deepLinkPreset.value
  )
  deepLinkPreset.value = ''
  editingPresetLabel.value = ''
  setDeepLinkMessage('已删除预设。')
}

function selectedPreset() {
  return deepLinkPresets.value.find((entry) => entry.key === deepLinkPreset.value)
}

function startPresetRename() {
  const preset = selectedPreset()
  if (!preset || !preset.key.startsWith('custom:')) return
  editingPresetLabel.value = preset.label
}

function applyPresetRename() {
  if (!deepLinkPreset.value.startsWith('custom:')) return
  const name = editingPresetLabel.value.trim()
  if (!name) {
    setDeepLinkMessage('预设名称不能为空。', true)
    return
  }
  customDeepLinkPresets.value = customDeepLinkPresets.value.map((preset) =>
    preset.key === deepLinkPreset.value ? { ...preset, label: name } : preset
  )
  setDeepLinkMessage('已更新预设名称。')
}

function cancelPresetRename() {
  editingPresetLabel.value = ''
}

function movePreset(direction: 'up' | 'down') {
  if (!deepLinkPreset.value.startsWith('custom:')) return
  const index = customDeepLinkPresets.value.findIndex((preset) => preset.key === deepLinkPreset.value)
  if (index < 0) return
  const nextIndex = direction === 'up' ? index - 1 : index + 1
  if (nextIndex < 0 || nextIndex >= customDeepLinkPresets.value.length) return
  const next = [...customDeepLinkPresets.value]
  const [current] = next.splice(index, 1)
  next.splice(nextIndex, 0, current)
  customDeepLinkPresets.value = next
}

function exportCustomPresets() {
  if (!customDeepLinkPresets.value.length) {
    setDeepLinkMessage('暂无可导出的自定义预设。', true)
    return
  }
  const payload = JSON.stringify(customDeepLinkPresets.value, null, 2)
  const blob = new Blob([payload], { type: 'application/json;charset=utf-8;' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `plm-deep-link-presets-${Date.now()}.json`
  link.click()
  URL.revokeObjectURL(link.href)
  setDeepLinkMessage('已导出自定义预设。')
}

function mergeImportedPresets(entries: unknown[]): number {
  const existing = new Map(customDeepLinkPresets.value.map((entry) => [entry.key, entry]))
  let importedCount = 0
  for (const entry of entries) {
    const record = entry && typeof entry === 'object'
      ? (entry as Record<string, unknown>)
      : {}
    const label = String(record.label ?? '').trim()
    const panels = sanitizePresetPanels(record.panels)
    if (!label || !panels.length) continue
    const key = String(record.key ?? '').trim() || `custom:${Date.now()}-${Math.random().toString(16).slice(2)}`
    if (existing.has(key)) continue
    existing.set(key, { key, label, panels })
    importedCount += 1
  }
  customDeepLinkPresets.value = Array.from(existing.values())
  return importedCount
}

function importCustomPresetsFromText(raw: string) {
  const trimmed = raw.trim()
  if (!trimmed) {
    setDeepLinkMessage('请粘贴预设 JSON。', true)
    return
  }
  try {
    const parsed = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) {
      setDeepLinkMessage('预设 JSON 需要是数组。', true)
      return
    }
    const importedCount = mergeImportedPresets(parsed)
    importPresetText.value = ''
    if (importedCount) {
      setDeepLinkMessage(`已导入 ${importedCount} 条预设。`)
    } else {
      setDeepLinkMessage('未发现可导入的预设。', true)
    }
  } catch (_err) {
    setDeepLinkMessage('预设 JSON 解析失败。', true)
  }
}

function importCustomPresets() {
  importCustomPresetsFromText(importPresetText.value)
}

function triggerPresetFileImport() {
  importFileInput.value?.click()
}

async function importPresetFile(file: File) {
  if (!file) return
  if (file.type && !file.type.includes('json') && !file.name.endsWith('.json')) {
    setDeepLinkMessage('仅支持 JSON 预设文件。', true)
    return
  }
  try {
    const text = await file.text()
    importCustomPresetsFromText(text)
  } catch (_err) {
    setDeepLinkMessage('读取预设文件失败。', true)
  }
}

async function handlePresetFileImport(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  await importPresetFile(file)
  target.value = ''
}

function handlePresetDragEnter(event: DragEvent) {
  event.preventDefault()
  presetDropDepth += 1
  isPresetDropActive.value = true
}

function handlePresetDragOver(event: DragEvent) {
  event.preventDefault()
}

function handlePresetDragLeave(event: DragEvent) {
  event.preventDefault()
  presetDropDepth = Math.max(0, presetDropDepth - 1)
  if (presetDropDepth === 0) {
    isPresetDropActive.value = false
  }
}

async function handlePresetDrop(event: DragEvent) {
  event.preventDefault()
  presetDropDepth = 0
  isPresetDropActive.value = false
  const file = event.dataTransfer?.files?.[0]
  if (!file) return
  await importPresetFile(file)
}

function parseDeepLinkPanels(value?: string): Set<string> {
  const allowed = new Set(Object.keys(deepLinkPanelLabels))
  if (!value) return new Set(['all'])
  const raw = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  const filtered = raw.filter((entry) => allowed.has(entry))
  return filtered.length ? new Set(filtered) : new Set(['all'])
}

function resolvePanelOverride(panel?: string): string | undefined {
  if (panel) return panel
  if (!deepLinkScope.value.length) return undefined
  const allowed = new Set(Object.keys(deepLinkPanelLabels))
  const selected = Array.from(new Set(deepLinkScope.value))
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry && entry !== 'all' && allowed.has(entry))
  return selected.length ? selected.join(',') : undefined
}

function formatDeepLinkTargets(panel?: string): string {
  if (panel) {
    const selected = Array.from(parseDeepLinkPanels(panel)).filter((entry) => entry !== 'all')
    if (selected.length) {
      return selected.map((entry) => deepLinkPanelLabels[entry] || entry).join(' / ')
    }
  }
  const targets = []
  if (searchQuery.value) targets.push(deepLinkPanelLabels.search)
  if (productId.value || productItemNumber.value) targets.push(deepLinkPanelLabels.product)
  if (cadFileId.value) targets.push(deepLinkPanelLabels.cad)
  if (whereUsedItemId.value) targets.push(deepLinkPanelLabels['where-used'])
  if (compareLeftId.value && compareRightId.value) targets.push(deepLinkPanelLabels.compare)
  if (bomLineId.value) targets.push(deepLinkPanelLabels.substitutes)
  return targets.length ? targets.join(' / ') : deepLinkPanelLabels.all
}

function buildDeepLinkParams(includeAutoload: boolean, panelOverride?: string): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {}
  const append = (key: string, value: string | number | boolean | undefined | null) => {
    if (value === undefined || value === null || value === '') return
    params[key] = value
  }

  append('searchQuery', searchQuery.value)
  append('searchItemType', searchItemType.value !== DEFAULT_ITEM_TYPE ? searchItemType.value : undefined)
  append('searchLimit', searchLimit.value !== DEFAULT_SEARCH_LIMIT ? searchLimit.value : undefined)
  append('productId', productId.value)
  append('itemNumber', productItemNumber.value)
  append('itemType', itemType.value !== DEFAULT_ITEM_TYPE ? itemType.value : undefined)
  append('cadFileId', cadFileId.value)
  append('cadOtherFileId', cadOtherFileId.value)
  append('documentRole', documentRole.value)
  append('documentFilter', documentFilter.value)
  append('approvalsStatus', approvalsStatus.value !== DEFAULT_APPROVAL_STATUS ? approvalsStatus.value : undefined)
  append('approvalsFilter', approvalsFilter.value)
  append('whereUsedItemId', whereUsedItemId.value)
  append('whereUsedRecursive', whereUsedRecursive.value !== true ? whereUsedRecursive.value : undefined)
  append('whereUsedMaxLevels', whereUsedMaxLevels.value !== DEFAULT_WHERE_USED_MAX_LEVELS ? whereUsedMaxLevels.value : undefined)
  append('whereUsedFilter', whereUsedFilter.value)
  append('compareLeftId', compareLeftId.value)
  append('compareRightId', compareRightId.value)
  append('compareMode', compareMode.value)
  append('compareLineKey', compareLineKey.value !== DEFAULT_COMPARE_LINE_KEY ? compareLineKey.value : undefined)
  append('compareMaxLevels', compareMaxLevels.value !== DEFAULT_COMPARE_MAX_LEVELS ? compareMaxLevels.value : undefined)
  append('compareIncludeChildFields', compareIncludeChildFields.value !== true ? compareIncludeChildFields.value : undefined)
  append('compareIncludeSubstitutes', compareIncludeSubstitutes.value !== false ? compareIncludeSubstitutes.value : undefined)
  append('compareIncludeEffectivity', compareIncludeEffectivity.value !== false ? compareIncludeEffectivity.value : undefined)
  append('compareEffectiveAt', compareEffectiveAt.value)
  append('compareRelationshipProps', compareRelationshipProps.value !== DEFAULT_COMPARE_REL_PROPS ? compareRelationshipProps.value : undefined)
  append('compareFilter', compareFilter.value)
  append('bomLineId', bomLineId.value)
  append('substitutesFilter', substitutesFilter.value)
  if (panelOverride && panelOverride !== 'all') {
    append('panel', panelOverride)
  }

  if (includeAutoload) {
    const shouldAutoload =
      Boolean(productId.value || productItemNumber.value) ||
      Boolean(cadFileId.value) ||
      Boolean(whereUsedItemId.value) ||
      Boolean(compareLeftId.value && compareRightId.value) ||
      Boolean(bomLineId.value) ||
      Boolean(searchQuery.value)
    if (shouldAutoload) {
      params.autoload = true
    }
  }

  return params
}

function buildDeepLinkUrl(panelOverride?: string): string {
  if (typeof window === 'undefined') return ''
  const base = `${window.location.origin}${route.path}`
  const resolvedPanel = resolvePanelOverride(panelOverride)
  const params = buildDeepLinkParams(true, resolvedPanel)
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    search.set(key, String(value))
  }
  const query = search.toString()
  return query ? `${base}?${query}` : base
}

async function copyDeepLink(panel?: string) {
  const resolvedPanel = resolvePanelOverride(panel)
  const url = buildDeepLinkUrl(resolvedPanel)
  if (!url) {
    setDeepLinkMessage('当前页面无法生成深链接。', true)
    return
  }
  try {
    await navigator.clipboard.writeText(url)
    setDeepLinkMessage(`已复制深链接（包含：${formatDeepLinkTargets(resolvedPanel)}）。`)
  } catch (_err) {
    try {
      const textarea = document.createElement('textarea')
      textarea.value = url
      textarea.style.position = 'fixed'
      textarea.style.top = '-1000px'
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setDeepLinkMessage(`已复制深链接（包含：${formatDeepLinkTargets(resolvedPanel)}）。`)
    } catch (_fallbackErr) {
      setDeepLinkMessage('复制失败，请手动复制地址栏链接。', true)
    }
  }
}

async function applyQueryState() {
  const productParam = readQueryParam('productId')
  if (productParam !== undefined) {
    productId.value = productParam
  }
  const itemNumberParam = readQueryParam('itemNumber')
  if (itemNumberParam !== undefined) {
    productItemNumber.value = itemNumberParam
  }
  const itemTypeParam = readQueryParam('itemType')
  if (itemTypeParam !== undefined) {
    itemType.value = itemTypeParam || DEFAULT_ITEM_TYPE
  }
  const searchQueryParam = readQueryParam('searchQuery')
  if (searchQueryParam !== undefined) {
    searchQuery.value = searchQueryParam
  }
  const searchItemTypeParam = readQueryParam('searchItemType')
  if (searchItemTypeParam !== undefined) {
    searchItemType.value = searchItemTypeParam || DEFAULT_ITEM_TYPE
  }
  const searchLimitParam = parseQueryNumber(readQueryParam('searchLimit'))
  if (searchLimitParam !== undefined) {
    const clamped = Math.min(50, Math.max(1, Math.floor(searchLimitParam)))
    searchLimit.value = clamped
  }
  const documentRoleParam = readQueryParam('documentRole')
  if (documentRoleParam !== undefined) {
    documentRole.value = documentRoleParam
  }
  const documentFilterParam = readQueryParam('documentFilter')
  if (documentFilterParam !== undefined) {
    documentFilter.value = documentFilterParam
  }
  const cadFileParam = readQueryParam('cadFileId')
  if (cadFileParam !== undefined) {
    cadFileId.value = cadFileParam
  }
  const cadOtherParam = readQueryParam('cadOtherFileId')
  if (cadOtherParam !== undefined) {
    cadOtherFileId.value = cadOtherParam
  }
  const approvalsStatusParam = readQueryParam('approvalsStatus')
  if (approvalsStatusParam !== undefined) {
    const normalized = approvalsStatusParam.trim().toLowerCase()
    if (['all', 'pending', 'approved', 'rejected'].includes(normalized)) {
      approvalsStatus.value = normalized as typeof approvalsStatus.value
    }
  }
  const approvalsFilterParam = readQueryParam('approvalsFilter')
  if (approvalsFilterParam !== undefined) {
    approvalsFilter.value = approvalsFilterParam
  }
  const whereUsedParam = readQueryParam('whereUsedItemId')
  if (whereUsedParam !== undefined) {
    whereUsedItemId.value = whereUsedParam
  }
  const whereUsedRecursiveParam = parseQueryBoolean(readQueryParam('whereUsedRecursive'))
  if (whereUsedRecursiveParam !== undefined) {
    whereUsedRecursive.value = whereUsedRecursiveParam
  }
  const whereUsedMaxLevelsParam = parseQueryNumber(readQueryParam('whereUsedMaxLevels'))
  if (whereUsedMaxLevelsParam !== undefined) {
    whereUsedMaxLevels.value = Math.max(1, Math.floor(whereUsedMaxLevelsParam))
  }
  const whereUsedFilterParam = readQueryParam('whereUsedFilter')
  if (whereUsedFilterParam !== undefined) {
    whereUsedFilter.value = whereUsedFilterParam
  }
  const compareLeftParam = readQueryParam('compareLeftId')
  if (compareLeftParam !== undefined) {
    compareLeftId.value = compareLeftParam
  }
  const compareRightParam = readQueryParam('compareRightId')
  if (compareRightParam !== undefined) {
    compareRightId.value = compareRightParam
  }
  const compareModeParam = readQueryParam('compareMode')
  if (compareModeParam !== undefined) {
    compareMode.value = compareModeParam
  }
  const compareLineKeyParam = readQueryParam('compareLineKey')
  if (compareLineKeyParam !== undefined) {
    compareLineKey.value = compareLineKeyParam
  }
  const compareMaxLevelsParam = parseQueryNumber(readQueryParam('compareMaxLevels'))
  if (compareMaxLevelsParam !== undefined) {
    compareMaxLevels.value = Math.max(1, Math.floor(compareMaxLevelsParam))
  }
  const compareEffectiveAtParam = readQueryParam('compareEffectiveAt')
  if (compareEffectiveAtParam !== undefined) {
    compareEffectiveAt.value = compareEffectiveAtParam
  }
  const compareRelPropsParam = readQueryParam('compareRelationshipProps')
  if (compareRelPropsParam !== undefined) {
    compareRelationshipProps.value = compareRelPropsParam
  }
  const compareFilterParam = readQueryParam('compareFilter')
  if (compareFilterParam !== undefined) {
    compareFilter.value = compareFilterParam
  }
  const includeChildFieldsParam = parseQueryBoolean(readQueryParam('compareIncludeChildFields'))
  if (includeChildFieldsParam !== undefined) {
    compareIncludeChildFields.value = includeChildFieldsParam
  }
  const includeSubstitutesParam = parseQueryBoolean(readQueryParam('compareIncludeSubstitutes'))
  if (includeSubstitutesParam !== undefined) {
    compareIncludeSubstitutes.value = includeSubstitutesParam
  }
  const includeEffectivityParam = parseQueryBoolean(readQueryParam('compareIncludeEffectivity'))
  if (includeEffectivityParam !== undefined) {
    compareIncludeEffectivity.value = includeEffectivityParam
  }
  const bomLineParam = readQueryParam('bomLineId')
  if (bomLineParam !== undefined) {
    bomLineId.value = bomLineParam
  }
  const substitutesFilterParam = readQueryParam('substitutesFilter')
  if (substitutesFilterParam !== undefined) {
    substitutesFilter.value = substitutesFilterParam
  }

  const panelParam = readQueryParam('panel')
  if (panelParam !== undefined) {
    const selectedPanels = Array.from(parseDeepLinkPanels(panelParam)).filter((entry) => entry !== 'all')
    deepLinkScope.value = selectedPanels
    deepLinkPreset.value = ''
    editingPresetLabel.value = ''
  }
  const panelTargets = parseDeepLinkPanels(panelParam)
  const allowAllPanels = panelTargets.has('all')
  const allowsPanel = (key: string) => allowAllPanels || panelTargets.has(key)

  const autoLoad = parseQueryBoolean(readQueryParam('autoload')) ?? false
  if (!autoLoad) return
  const tasks: Array<Promise<void>> = []
  if (allowsPanel('search') && searchQuery.value) tasks.push(searchProducts())
  if (allowsPanel('product') && productId.value) tasks.push(loadProduct())
  if (allowsPanel('cad') && cadFileId.value) tasks.push(loadCadMetadata())
  if (allowsPanel('where-used') && whereUsedItemId.value) tasks.push(loadWhereUsed())
  if (allowsPanel('compare') && compareLeftId.value && compareRightId.value) tasks.push(loadBomCompare())
  if (allowsPanel('substitutes') && bomLineId.value) tasks.push(loadSubstitutes())
  if (allowsPanel('cad') && cadFileId.value && cadOtherFileId.value) tasks.push(loadCadDiff())
  if (tasks.length) {
    await Promise.all(tasks)
  }
}

type SortDirection = 'asc' | 'desc'
type SortType = 'string' | 'number' | 'date'
type SortConfig = Record<string, { type: SortType; accessor: (row: any) => unknown }>

function loadStoredColumns<T extends Record<string, boolean>>(key: string, defaults: T): T {
  if (typeof localStorage === 'undefined') {
    return { ...defaults }
  }
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { ...defaults }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...defaults }
    const merged = { ...defaults } as T
    const mergedRecord = merged as Record<string, boolean>
    for (const [column, enabled] of Object.entries(parsed as Record<string, unknown>)) {
      if (column in defaults) {
        mergedRecord[column] = Boolean(enabled)
      }
    }
    return merged
  } catch (_err) {
    return { ...defaults }
  }
}

function loadStoredPresets(): Array<{ key: string; label: string; panels: string[] }> {
  if (typeof localStorage === 'undefined') {
    return []
  }
  try {
    const raw = localStorage.getItem(DEEP_LINK_PRESETS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((entry) => {
        const key = String(entry?.key || '').trim()
        const label = String(entry?.label || '').trim()
        const panels = sanitizePresetPanels(entry?.panels)
        if (!key || !label || !panels.length) return null
        return { key, label, panels }
      })
      .filter(Boolean) as Array<{ key: string; label: string; panels: string[] }>
  } catch (_err) {
    return []
  }
}

function persistPresets(presets: Array<{ key: string; label: string; panels: string[] }>) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(DEEP_LINK_PRESETS_STORAGE_KEY, JSON.stringify(presets))
  } catch (_err) {
    // ignore storage errors
  }
}

function persistColumns(key: string, value: Record<string, boolean>) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (_err) {
    // ignore storage errors
  }
}

function sortRows<T>(rows: T[], key: string, dir: SortDirection, config: SortConfig): T[] {
  const entry = config[key]
  if (!entry) return rows
  const multiplier = dir === 'desc' ? -1 : 1
  const sorted = [...rows].sort((left, right) => {
    const leftValue = normalizeSortValue(entry.accessor(left), entry.type)
    const rightValue = normalizeSortValue(entry.accessor(right), entry.type)
    if (entry.type === 'number' || entry.type === 'date') {
      return (leftValue as number - (rightValue as number)) * multiplier
    }
    return String(leftValue).localeCompare(String(rightValue)) * multiplier
  })
  return sorted
}

function normalizeSortValue(value: unknown, type: SortType): string | number {
  if (type === 'number') {
    return Number(value ?? 0) || 0
  }
  if (type === 'date') {
    if (!value) return 0
    const date = new Date(String(value))
    return Number.isNaN(date.getTime()) ? 0 : date.getTime()
  }
  return String(value ?? '').toLowerCase()
}

function formatEffectivity(entry: Record<string, any>): string {
  const props = entry?.properties || entry?.relationship || {}
  const from = props.effectivity_from || props.effectivityFrom
  const to = props.effectivity_to || props.effectivityTo
  if (from || to) {
    return `${from || '-'} → ${to || '-'}`
  }
  const effectivities = props.effectivities
  if (Array.isArray(effectivities) && effectivities.length) {
    return effectivities
      .map((eff: any) => {
        const start = eff?.start_date || eff?.start || ''
        const end = eff?.end_date || eff?.end || ''
        const range = start || end ? `${start || '-'}~${end || '-'}` : ''
        return eff?.type ? `${eff.type}:${range}` : range
      })
      .filter(Boolean)
      .join('; ')
  }
  return '-'
}

function formatSubstituteCount(entry: Record<string, any>): string {
  const props = entry?.properties || entry?.relationship || {}
  const subs = props.substitutes || entry?.substitutes
  if (Array.isArray(subs)) {
    return subs.length ? String(subs.length) : '-'
  }
  return '-'
}

function filterCompareEntries(entries: any[]): any[] {
  const needle = compareFilter.value.trim().toLowerCase()
  if (!needle) return entries
  return entries.filter((entry) => {
    const tokens = [
      getItemNumber(entry.parent),
      getItemName(entry.parent),
      getItemNumber(entry.child),
      getItemName(entry.child),
      entry.relationship_id,
      entry.line_key,
    ]
    return tokens.some((token) => String(token || '').toLowerCase().includes(needle))
  })
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function downloadCsv(filename: string, headers: string[], rows: Array<string[]>): void {
  const lines = [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => row.map(csvEscape).join(',')),
  ]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
  URL.revokeObjectURL(link.href)
}

function exportWhereUsedCsv() {
  const headers = ['level', 'parent_id', 'parent_number', 'parent_name', 'path', 'quantity', 'uom', 'find_num', 'refdes', 'relationship_id']
  const rows = whereUsedFilteredRows.value.map((entry: any) => [
    String(entry.level ?? ''),
    String(entry.parent?.id || entry.relationship?.source_id || ''),
    getItemNumber(entry.parent),
    getItemName(entry.parent),
    entry.pathLabel || '',
    String(entry.relationship?.quantity ?? ''),
    String(entry.relationship?.uom ?? ''),
    String(entry.relationship?.find_num ?? ''),
    (() => {
      const refdes = getWhereUsedRefdes(entry)
      return refdes === '-' ? '' : refdes
    })(),
    String(entry.relationship?.id || ''),
  ])
  downloadCsv(`plm-where-used-${Date.now()}.csv`, headers, rows)
}

function exportBomCompareCsv() {
  const headers = [
    'change_type',
    'severity',
    'parent_id',
    'parent_number',
    'parent_name',
    'child_id',
    'child_number',
    'child_name',
    'quantity',
    'uom',
    'find_num',
    'refdes',
    'effectivity',
    'substitutes',
    'line_key',
    'relationship_id',
    'changes',
  ]
  const buildRow = (entry: any, type: string) => [
    type,
    String(entry.severity || ''),
    String(entry.parent?.id || entry.parent_id || ''),
    getItemNumber(entry.parent),
    getItemName(entry.parent),
    String(entry.child?.id || entry.child_id || ''),
    getItemNumber(entry.child),
    getItemName(entry.child),
    getCompareProp(entry, 'quantity'),
    getCompareProp(entry, 'uom'),
    getCompareProp(entry, 'find_num'),
    getCompareProp(entry, 'refdes'),
    formatEffectivity(entry),
    formatSubstituteCount(entry),
    String(entry.line_key || ''),
    String(entry.relationship_id || ''),
    Array.isArray(entry.changes)
      ? entry.changes.map((change: any) => `${change.field}:${change.left ?? ''}->${change.right ?? ''}`).join('; ')
      : '',
  ]
  const rows = [
    ...compareAddedFiltered.value.map((entry) => buildRow(entry, 'added')),
    ...compareRemovedFiltered.value.map((entry) => buildRow(entry, 'removed')),
    ...compareChangedFiltered.value.map((entry) => buildRow(entry, 'changed')),
  ]
  downloadCsv(`plm-bom-compare-${Date.now()}.csv`, headers, rows)
}

function exportSubstitutesCsv() {
  const headers = ['bom_line_id', 'substitute_id', 'substitute_number', 'substitute_name', 'part_id', 'part_number', 'part_name', 'rank', 'note', 'relationship_id']
  const rows = substitutesRows.value.map((entry: any) => [
    String(substitutes.value?.bom_line_id || ''),
    String(entry.substitute_part?.id || entry.id || ''),
    String(entry.substitute_part?.item_number || ''),
    String(entry.substitute_part?.name || ''),
    String(entry.part?.id || ''),
    String(entry.part?.item_number || ''),
    String(entry.part?.name || ''),
    String(entry.rank ?? entry.relationship?.properties?.rank ?? ''),
    String(entry.relationship?.properties?.note || entry.relationship?.properties?.comment || ''),
    String(entry.relationship?.id || ''),
  ])
  downloadCsv(`plm-substitutes-${Date.now()}.csv`, headers, rows)
}

function exportDocumentsCsv() {
  const headers = ['id', 'name', 'document_type', 'revision', 'role', 'mime_type', 'file_size', 'updated_at', 'preview_url', 'download_url']
  const rows = documentsSorted.value.map((doc: any) => [
    String(doc.id || ''),
    String(doc.name || ''),
    String(doc.document_type || ''),
    String(doc.engineering_revision || ''),
    String(doc.engineering_state || ''),
    String(doc.mime_type || ''),
    String(doc.file_size ?? ''),
    String(doc.updated_at || doc.created_at || ''),
    String(doc.preview_url || ''),
    String(doc.download_url || ''),
  ])
  downloadCsv(`plm-documents-${Date.now()}.csv`, headers, rows)
}

function exportApprovalsCsv() {
  const headers = ['id', 'title', 'status', 'type', 'requester', 'created_at', 'product_number', 'product_name', 'product_id']
  const rows = approvalsSorted.value.map((entry: any) => [
    String(entry.id || ''),
    String(entry.title || ''),
    String(entry.status || ''),
    String(entry.request_type || ''),
    String(entry.requester_name || entry.requester_id || ''),
    String(entry.created_at || ''),
    String(entry.product_number || ''),
    String(entry.product_name || ''),
    String(entry.product_id || ''),
  ])
  downloadCsv(`plm-approvals-${Date.now()}.csv`, headers, rows)
}

function approvalStatusClass(value?: string): string {
  const normalized = (value || '').toLowerCase()
  if (normalized === 'approved') return 'status-approved'
  if (normalized === 'rejected') return 'status-rejected'
  return 'status-pending'
}

function getCompareFieldLabel(field: string): string {
  return compareFieldLabelMap.get(field) || field
}

function formatDiffValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '-'
  return String(value)
}

function severityClass(value?: string): string {
  const normalized = (value || 'info').toLowerCase()
  if (normalized === 'major') return 'severity-major'
  if (normalized === 'minor') return 'severity-minor'
  return 'severity-info'
}

onMounted(() => {
  refreshAuthStatus()
  authTimer = window.setInterval(refreshAuthStatus, 30000)
  window.addEventListener('storage', refreshAuthStatus)
  documentColumns.value = loadStoredColumns(DOCUMENT_COLUMNS_STORAGE_KEY, defaultDocumentColumns)
  approvalColumns.value = loadStoredColumns(APPROVAL_COLUMNS_STORAGE_KEY, defaultApprovalColumns)
  customDeepLinkPresets.value = loadStoredPresets()
  void applyQueryState()
})

onBeforeUnmount(() => {
  if (authTimer) {
    window.clearInterval(authTimer)
  }
  if (deepLinkTimer) {
    window.clearTimeout(deepLinkTimer)
  }
  if (querySyncTimer) {
    window.clearTimeout(querySyncTimer)
  }
  window.removeEventListener('storage', refreshAuthStatus)
})

watch(
  documentColumns,
  (value) => {
    persistColumns(DOCUMENT_COLUMNS_STORAGE_KEY, value)
  },
  { deep: true }
)

watch(
  approvalColumns,
  (value) => {
    persistColumns(APPROVAL_COLUMNS_STORAGE_KEY, value)
  },
  { deep: true }
)

watch(
  customDeepLinkPresets,
  (value) => {
    persistPresets(value)
  },
  { deep: true }
)

watch(
  deepLinkScope,
  () => {
    if (applyingPreset) return
    if (deepLinkPreset.value) {
      deepLinkPreset.value = ''
    }
  },
  { deep: true }
)

watch(
  () => [searchQuery.value, searchItemType.value, searchLimit.value],
  ([query, type, limit]) => {
    scheduleQuerySync({
      searchQuery: query || undefined,
      searchItemType: type !== DEFAULT_ITEM_TYPE ? type : undefined,
      searchLimit: limit !== DEFAULT_SEARCH_LIMIT ? limit : undefined,
    })
  }
)

watch(
  () => [documentRole.value, documentFilter.value],
  ([role, filter]) => {
    scheduleQuerySync({
      documentRole: role || undefined,
      documentFilter: filter || undefined,
    })
  }
)

watch(
  () => [approvalsStatus.value, approvalsFilter.value],
  ([status, filter]) => {
    scheduleQuerySync({
      approvalsStatus: status !== DEFAULT_APPROVAL_STATUS ? status : undefined,
      approvalsFilter: filter || undefined,
    })
  }
)

watch(
  () => [whereUsedFilter.value, compareFilter.value, substitutesFilter.value],
  ([whereUsed, compareValue, substituteValue]) => {
    scheduleQuerySync({
      whereUsedFilter: whereUsed || undefined,
      compareFilter: compareValue || undefined,
      substitutesFilter: substituteValue || undefined,
    })
  }
)

watch(
  () => [
    productId.value,
    itemType.value,
    cadFileId.value,
    cadOtherFileId.value,
    whereUsedItemId.value,
    whereUsedRecursive.value,
    whereUsedMaxLevels.value,
    compareLeftId.value,
    compareRightId.value,
    compareMode.value,
    compareLineKey.value,
    compareMaxLevels.value,
    compareIncludeChildFields.value,
    compareIncludeSubstitutes.value,
    compareIncludeEffectivity.value,
    compareEffectiveAt.value,
    compareRelationshipProps.value,
    bomLineId.value,
  ],
  ([
    productValue,
    itemTypeValue,
    cadFileValue,
    cadOtherValue,
    whereUsedValue,
    whereUsedRecursiveValue,
    whereUsedLevelsValue,
    compareLeftValue,
    compareRightValue,
    compareModeValue,
    compareLineValue,
    compareMaxValue,
    compareChildValue,
    compareSubsValue,
    compareEffectValue,
    compareEffectiveValue,
    comparePropsValue,
    bomLineValue,
  ]) => {
    scheduleQuerySync({
      productId: productValue || undefined,
      itemType: itemTypeValue !== DEFAULT_ITEM_TYPE ? itemTypeValue : undefined,
      cadFileId: cadFileValue || undefined,
      cadOtherFileId: cadOtherValue || undefined,
      whereUsedItemId: whereUsedValue || undefined,
      whereUsedRecursive: whereUsedRecursiveValue !== true ? whereUsedRecursiveValue : undefined,
      whereUsedMaxLevels:
        whereUsedLevelsValue !== DEFAULT_WHERE_USED_MAX_LEVELS ? whereUsedLevelsValue : undefined,
      compareLeftId: compareLeftValue || undefined,
      compareRightId: compareRightValue || undefined,
      compareMode: compareModeValue || undefined,
      compareLineKey: compareLineValue !== DEFAULT_COMPARE_LINE_KEY ? compareLineValue : undefined,
      compareMaxLevels:
        compareMaxValue !== DEFAULT_COMPARE_MAX_LEVELS ? compareMaxValue : undefined,
      compareIncludeChildFields:
        compareChildValue !== true ? compareChildValue : undefined,
      compareIncludeSubstitutes:
        compareSubsValue !== false ? compareSubsValue : undefined,
      compareIncludeEffectivity:
        compareEffectValue !== false ? compareEffectValue : undefined,
      compareEffectiveAt: compareEffectiveValue || undefined,
      compareRelationshipProps:
        comparePropsValue !== DEFAULT_COMPARE_REL_PROPS ? comparePropsValue : undefined,
      bomLineId: bomLineValue || undefined,
    })
  }
)
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

.panel-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.deep-link-scope {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 8px 0 4px;
}

.deep-link-label {
  font-size: 12px;
  color: #6b7280;
}

.deep-link-option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #374151;
}

.deep-link-option input {
  accent-color: #2563eb;
}

.deep-link-input {
  font-size: 12px;
  padding: 4px 8px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #fff;
  color: #111827;
  min-width: 120px;
}

.deep-link-file {
  display: none;
}

.deep-link-drop {
  border: 1px dashed #cbd5f5;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  color: #4b5563;
  background: #f8fafc;
}

.deep-link-drop.active {
  border-color: #3b82f6;
  background: #eff6ff;
  color: #1d4ed8;
}

.deep-link-select {
  font-size: 12px;
  padding: 4px 8px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #fff;
  color: #111827;
}

.toggle-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  align-items: center;
  margin: 6px 0 14px;
}

.toggle-label {
  font-size: 12px;
  color: #6b7280;
  margin-right: 4px;
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

.auth-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.auth-status.secondary {
  margin-top: 4px;
}

.auth-label {
  font-size: 12px;
  color: #6b7280;
}

.auth-pill {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid transparent;
}

.auth-expiry {
  font-size: 12px;
  color: #6b7280;
}

.auth-valid {
  color: #14532d;
  background: #dcfce7;
  border-color: #bbf7d0;
}

.auth-expiring {
  color: #7c2d12;
  background: #ffedd5;
  border-color: #fed7aa;
}

.auth-expired,
.auth-invalid {
  color: #7f1d1d;
  background: #fee2e2;
  border-color: #fecaca;
}

.auth-missing {
  color: #1f2937;
  background: #f3f4f6;
  border-color: #e5e7eb;
}

.btn.ghost {
  background: transparent;
  border-color: #e5e7eb;
  color: #374151;
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

.checkbox-field {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.checkbox-field input {
  width: auto;
}

label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: #374151;
}

input, select, textarea {
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13px;
  background: #fff;
}

input:focus, select:focus, textarea:focus {
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

.btn.mini {
  padding: 4px 8px;
  font-size: 12px;
}

.inline-actions {
  display: inline-flex;
  gap: 6px;
  align-items: center;
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

.empty-hint {
  margin-left: 6px;
  font-size: 12px;
  color: #9ca3af;
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
  flex-wrap: wrap;
}

.compare-section {
  margin-top: 12px;
}

.compare-section h3 {
  font-size: 14px;
  margin-bottom: 6px;
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

.muted {
  color: #6b7280;
  font-size: 12px;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 12px;
}

.tag {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid transparent;
}

.severity-major {
  color: #7f1d1d;
  background: #fee2e2;
  border-color: #fecaca;
}

.severity-minor {
  color: #78350f;
  background: #ffedd5;
  border-color: #fed7aa;
}

.severity-info {
  color: #1e3a8a;
  background: #dbeafe;
  border-color: #bfdbfe;
}

.status-neutral {
  color: #1f2937;
  background: #f3f4f6;
  border-color: #e5e7eb;
}

.status-approved {
  color: #14532d;
  background: #dcfce7;
  border-color: #bbf7d0;
}

.status-pending {
  color: #92400e;
  background: #fef3c7;
  border-color: #fde68a;
}

.status-rejected {
  color: #7f1d1d;
  background: #fee2e2;
  border-color: #fecaca;
}

.diff-list {
  display: grid;
  gap: 6px;
}

.diff-row {
  display: grid;
  grid-template-columns: auto auto 1fr;
  gap: 8px;
  align-items: center;
}

.diff-field {
  font-weight: 600;
  font-size: 12px;
}

.diff-field-code {
  color: #6b7280;
  font-weight: 500;
  font-size: 11px;
  margin-left: 4px;
}

.diff-value {
  font-size: 12px;
  color: #111827;
}

.field-map {
  margin-top: 12px;
  background: #f8fafc;
  border-radius: 8px;
  padding: 10px 12px;
}

.field-map summary {
  cursor: pointer;
  font-weight: 600;
  margin-bottom: 6px;
}

.inline-details {
  width: 100%;
}

.inline-details summary {
  cursor: pointer;
  font-size: 12px;
  color: #1f2937;
}

.inline-pre {
  margin: 6px 0 0;
  font-size: 12px;
  white-space: pre-wrap;
  color: #1f2937;
}

.cad-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  margin-top: 12px;
}

.cad-card {
  border: 1px solid #eef0f2;
  border-radius: 10px;
  padding: 12px;
  background: #fdfdfd;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cad-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.cad-textarea {
  min-height: 120px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}

.cad-span {
  grid-column: 1 / -1;
}

.path-list {
  margin-top: 6px;
  display: grid;
  gap: 6px;
}

.path-node {
  display: grid;
  grid-template-columns: auto auto 1fr;
  gap: 8px;
  align-items: center;
}

.path-index {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #e5e7eb;
  color: #111827;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
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
