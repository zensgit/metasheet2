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
        <label>
          关键词
          <input
            id="plm-search-query"
            v-model.trim="searchQuery"
            name="plmSearchQuery"
            placeholder="可留空，返回最新记录"
          />
        </label>
        <label>
          Item Type
          <input
            id="plm-search-item-type"
            v-model.trim="searchItemType"
            name="plmSearchItemType"
            placeholder="Part"
          />
        </label>
        <label>
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
            <span class="auth-label">鉴权状态</span>
            <span class="auth-pill" :class="authStateClass">{{ authStateText }}</span>
            <span v-if="authExpiryText" class="auth-expiry">{{ authExpiryText }}</span>
            <button class="btn ghost" @click="refreshAuthStatus">刷新状态</button>
          </div>
          <p v-if="authHint" class="hint">{{ authHint }}</p>
          <p v-if="authError" class="status error">{{ authError }}</p>
        </div>
        <button class="btn" @click="resetAll">重置</button>
      </div>

      <div class="form-grid">
        <label>
          产品 ID
          <input
            id="plm-product-id"
            v-model.trim="productId"
            name="plmProductId"
            placeholder="输入 PLM 产品 ID"
          />
        </label>
        <label>
          Item Type
          <input
            id="plm-item-type"
            v-model.trim="itemType"
            name="plmItemType"
            placeholder="Part"
          />
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
          <strong>{{ formatTime(product.updatedAt || product.createdAt) }}</strong>
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
        <button class="btn" :disabled="!productId || documentsLoading" @click="loadDocuments">
          {{ documentsLoading ? '加载中...' : '刷新文档' }}
        </button>
      </div>
      <div class="form-grid compact">
        <label>
          文档角色
          <input
            id="plm-document-role"
            v-model.trim="documentRole"
            name="plmDocumentRole"
            placeholder="primary / secondary"
          />
        </label>
      </div>
      <p v-if="documentsError" class="status error">{{ documentsError }}</p>
      <div v-if="!documents.length" class="empty">
        暂无文档
        <span class="empty-hint">（可先在 PLM 关联文件或设置文档角色过滤）</span>
      </div>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>类型</th>
            <th>版本</th>
            <th>大小</th>
            <th>预览</th>
            <th>下载</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="doc in documents" :key="doc.id">
            <td>{{ doc.name }}</td>
            <td>{{ doc.document_type || '-' }}</td>
            <td>{{ doc.engineering_revision || '-' }}</td>
            <td>{{ formatBytes(doc.file_size) }}</td>
            <td>
              <a v-if="doc.preview_url" :href="doc.preview_url" target="_blank" rel="noopener">查看</a>
              <span v-else>-</span>
            </td>
            <td>
              <a v-if="doc.download_url" :href="doc.download_url" target="_blank" rel="noopener">下载</a>
              <span v-else>-</span>
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
        <h2>审批</h2>
        <button class="btn" :disabled="approvalsLoading" @click="loadApprovals">
          {{ approvalsLoading ? '加载中...' : '刷新审批' }}
        </button>
      </div>
      <div class="form-grid compact">
        <label>
          状态
          <select id="plm-approvals-status" v-model="approvalsStatus" name="plmApprovalsStatus">
            <option value="all">全部</option>
            <option value="pending">待处理</option>
            <option value="approved">已通过</option>
            <option value="rejected">已拒绝</option>
          </select>
        </label>
      </div>
      <p v-if="approvalsError" class="status error">{{ approvalsError }}</p>
      <div v-if="!approvals.length" class="empty">
        暂无审批数据
        <span class="empty-hint">（可调整状态筛选或创建 ECO 流程）</span>
      </div>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>标题</th>
            <th>状态</th>
            <th>类型</th>
            <th>发起人</th>
            <th>创建时间</th>
            <th>产品</th>
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
        <button class="btn" :disabled="!whereUsedItemId || whereUsedLoading" @click="loadWhereUsed">
          {{ whereUsedLoading ? '加载中...' : '查询' }}
        </button>
      </div>
      <div class="form-grid compact">
        <label>
          子件 ID
          <input
            id="plm-where-used-item-id"
            v-model.trim="whereUsedItemId"
            name="plmWhereUsedItemId"
            placeholder="输入子件 ID"
          />
        </label>
        <label>
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
        <label>
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
      </div>
      <p v-if="whereUsedError" class="status error">{{ whereUsedError }}</p>
      <div v-if="!whereUsed" class="empty">
        暂无 where-used 数据
        <span class="empty-hint">（输入子件 ID 后查询）</span>
      </div>
      <div v-else>
        <p class="status">共 {{ whereUsed.count || 0 }} 条</p>
        <table v-if="whereUsedRows.length" class="data-table">
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
            <tr v-for="entry in whereUsedRows" :key="entry._key">
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
              <td>{{ entry.relationship?.refdes ?? '-' }}</td>
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
        <button class="btn" :disabled="!compareLeftId || !compareRightId || compareLoading" @click="loadBomCompare">
          {{ compareLoading ? '加载中...' : '对比' }}
        </button>
      </div>
      <div class="form-grid">
        <label>
          左侧 ID
          <input
            id="plm-compare-left-id"
            v-model.trim="compareLeftId"
            name="plmCompareLeftId"
            placeholder="左侧 item/version ID"
          />
        </label>
        <label>
          右侧 ID
          <input
            id="plm-compare-right-id"
            v-model.trim="compareRightId"
            name="plmCompareRightId"
            placeholder="右侧 item/version ID"
          />
        </label>
        <label>
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
        <label>
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
        <label>
          Compare Mode
          <input
            id="plm-compare-mode"
            v-model.trim="compareMode"
            name="plmCompareMode"
            placeholder="only_product / summarized / num_qty"
          />
        </label>
        <label>
          关系字段
          <input
            id="plm-compare-rel-props"
            v-model.trim="compareRelationshipProps"
            name="plmCompareRelProps"
            placeholder="quantity,uom,find_num,refdes"
          />
        </label>
        <label class="checkbox-field">
          <span>包含父/子字段</span>
          <input id="plm-compare-include-child" v-model="compareIncludeChildFields" type="checkbox" />
        </label>
        <label class="checkbox-field">
          <span>包含替代件</span>
          <input id="plm-compare-include-subs" v-model="compareIncludeSubstitutes" type="checkbox" />
        </label>
        <label class="checkbox-field">
          <span>包含生效性</span>
          <input id="plm-compare-include-effectivity" v-model="compareIncludeEffectivity" type="checkbox" />
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
        </div>
        <div class="compare-section">
          <h3>新增</h3>
          <div v-if="!compareAdded.length" class="empty">无新增</div>
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
                <th>Line</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in compareAdded" :key="entry.relationship_id || entry.line_key || entry.child_id">
                <td>{{ entry.level ?? '-' }}</td>
                <td>
                  <div>{{ getItemNumber(entry.parent) }}</div>
                  <div class="muted">{{ getItemName(entry.parent) }}</div>
                </td>
                <td>
                  <div>{{ getItemNumber(entry.child) }}</div>
                  <div class="muted">{{ getItemName(entry.child) }}</div>
                </td>
                <td>{{ getCompareProp(entry, 'quantity') }}</td>
                <td>{{ getCompareProp(entry, 'uom') }}</td>
                <td>{{ getCompareProp(entry, 'find_num') }}</td>
                <td>{{ getCompareProp(entry, 'refdes') }}</td>
                <td>
                  <div class="mono">{{ entry.line_key || '-' }}</div>
                  <div class="muted">{{ entry.relationship_id || '-' }}</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="compare-section">
          <h3>删除</h3>
          <div v-if="!compareRemoved.length" class="empty">无删除</div>
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
                <th>Line</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in compareRemoved" :key="entry.relationship_id || entry.line_key || entry.child_id">
                <td>{{ entry.level ?? '-' }}</td>
                <td>
                  <div>{{ getItemNumber(entry.parent) }}</div>
                  <div class="muted">{{ getItemName(entry.parent) }}</div>
                </td>
                <td>
                  <div>{{ getItemNumber(entry.child) }}</div>
                  <div class="muted">{{ getItemName(entry.child) }}</div>
                </td>
                <td>{{ getCompareProp(entry, 'quantity') }}</td>
                <td>{{ getCompareProp(entry, 'uom') }}</td>
                <td>{{ getCompareProp(entry, 'find_num') }}</td>
                <td>{{ getCompareProp(entry, 'refdes') }}</td>
                <td>
                  <div class="mono">{{ entry.line_key || '-' }}</div>
                  <div class="muted">{{ entry.relationship_id || '-' }}</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="compare-section">
          <h3>变更</h3>
          <div v-if="!compareChanged.length" class="empty">无变更</div>
          <table v-else class="data-table">
            <thead>
              <tr>
                <th>层级</th>
                <th>父件</th>
                <th>子件</th>
                <th>严重度</th>
                <th>变更项</th>
                <th>Line</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in compareChanged" :key="entry.relationship_id || entry.line_key || entry.child_id">
                <td>{{ entry.level ?? '-' }}</td>
                <td>
                  <div>{{ getItemNumber(entry.parent) }}</div>
                  <div class="muted">{{ getItemName(entry.parent) }}</div>
                </td>
                <td>
                  <div>{{ getItemNumber(entry.child) }}</div>
                  <div class="muted">{{ getItemName(entry.child) }}</div>
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
        <button class="btn" :disabled="!bomLineId || substitutesLoading" @click="loadSubstitutes">
          {{ substitutesLoading ? '加载中...' : '查询' }}
        </button>
      </div>
      <div class="form-grid compact">
        <label>
          BOM Line ID
          <input
            id="plm-bom-line-id"
            v-model.trim="bomLineId"
            name="plmBomLineId"
            placeholder="输入 BOM 行 ID"
          />
        </label>
      </div>
      <p v-if="substitutesError" class="status error">{{ substitutesError }}</p>
      <div v-if="!substitutes" class="empty">
        暂无替代件数据
        <span class="empty-hint">（填写 BOM Line ID 后查询）</span>
      </div>
      <div v-else>
        <p class="status">共 {{ substitutes.count || 0 }} 条</p>
        <table v-if="substitutes.substitutes?.length" class="data-table">
          <thead>
            <tr>
              <th>替代件 ID</th>
              <th>名称</th>
              <th>原件 ID</th>
              <th>优先级</th>
              <th>备注</th>
              <th>关系 ID</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in substitutes.substitutes" :key="entry.id">
              <td>{{ entry.substitute_part?.id || entry.substitute_part?.item_number || entry.id }}</td>
              <td>{{ entry.substitute_part?.name || '-' }}</td>
              <td>{{ entry.part?.id || entry.part?.item_number || '-' }}</td>
              <td>{{ entry.rank ?? entry.relationship?.properties?.rank ?? '-' }}</td>
              <td>{{ entry.relationship?.properties?.note || entry.relationship?.properties?.comment || '-' }}</td>
              <td>{{ entry.relationship?.id || '-' }}</td>
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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { apiGet, apiPost } from '../utils/api'

const searchQuery = ref('')
const searchItemType = ref('Part')
const searchLimit = ref(10)
const searchResults = ref<any[]>([])
const searchTotal = ref(0)
const searchLoading = ref(false)
const searchError = ref('')

type AuthState = 'missing' | 'invalid' | 'expired' | 'expiring' | 'valid'

const authState = ref<AuthState>('missing')
const authExpiresAt = ref<number | null>(null)
const authError = ref('')
let authTimer: number | undefined

const productId = ref('')
const itemType = ref('Part')
const product = ref<any | null>(null)
const productLoading = ref(false)
const productError = ref('')

const bomItems = ref<any[]>([])
const bomLoading = ref(false)
const bomError = ref('')

const documentRole = ref('')
const documents = ref<any[]>([])
const documentsLoading = ref(false)
const documentsError = ref('')

const approvals = ref<any[]>([])
const approvalsStatus = ref<'all' | 'pending' | 'approved' | 'rejected'>('pending')
const approvalsLoading = ref(false)
const approvalsError = ref('')

const whereUsedItemId = ref('')
const whereUsedRecursive = ref(true)
const whereUsedMaxLevels = ref(5)
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

const compareLeftId = ref('')
const compareRightId = ref('')
const compareMode = ref('')
const compareMaxLevels = ref(10)
const compareLineKey = ref('child_config')
const compareIncludeChildFields = ref(true)
const compareIncludeSubstitutes = ref(false)
const compareIncludeEffectivity = ref(false)
const compareRelationshipProps = ref('quantity,uom,find_num,refdes')
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
    source: 'created_on / created_at',
    fallback: 'search hit created_at',
  },
  {
    key: 'updatedAt',
    label: '更新时间',
    source: 'modified_on / updated_at',
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
    label: '工程状态',
    source: 'file_role',
    fallback: 'unknown',
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
    source: 'eco.created_by_id',
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

const compareSummary = computed(() => bomCompare.value?.summary || {})
const compareAdded = computed(() => bomCompare.value?.added || [])
const compareRemoved = computed(() => bomCompare.value?.removed || [])
const compareChanged = computed(() => bomCompare.value?.changed || [])

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
    return '未检测到 auth_token，请在 localStorage 写入后刷新。'
  }
  if (authState.value === 'invalid') {
    return 'Token 解析失败，请重新获取并写入 auth_token。'
  }
  if (authState.value === 'expired') {
    return 'Token 已过期，请重新登录或刷新 Token。'
  }
  if (authState.value === 'expiring') {
    return 'Token 即将过期，建议提前刷新。'
  }
  return ''
})

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
  product.value = null
  productError.value = ''
  authError.value = ''
  searchQuery.value = ''
  searchResults.value = []
  searchTotal.value = 0
  searchError.value = ''
  bomItems.value = []
  bomError.value = ''
  documentRole.value = ''
  documents.value = []
  documentsError.value = ''
  approvals.value = []
  approvalsStatus.value = 'pending'
  approvalsError.value = ''
  whereUsedItemId.value = ''
  whereUsed.value = null
  whereUsedError.value = ''
  compareLeftId.value = ''
  compareRightId.value = ''
  compareMode.value = ''
  compareLineKey.value = 'child_config'
  compareIncludeChildFields.value = true
  compareIncludeSubstitutes.value = false
  compareIncludeEffectivity.value = false
  compareRelationshipProps.value = 'quantity,uom,find_num,refdes'
  bomCompare.value = null
  compareError.value = ''
  bomLineId.value = ''
  substitutes.value = null
  substitutesError.value = ''
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

function refreshAuthStatus() {
  const token = localStorage.getItem('auth_token') || localStorage.getItem('jwt') || ''
  if (!token) {
    authState.value = 'missing'
    authExpiresAt.value = null
    return
  }
  const payload = decodeJwtPayload(token)
  const expSeconds = payload?.exp
  if (!expSeconds) {
    authState.value = 'invalid'
    authExpiresAt.value = null
    return
  }
  const expMs = expSeconds * 1000
  authExpiresAt.value = expMs
  const timeLeftMs = expMs - Date.now()
  if (timeLeftMs <= 0) {
    authState.value = 'expired'
    return
  }
  if (timeLeftMs <= 10 * 60 * 1000) {
    authState.value = 'expiring'
    return
  }
  authState.value = 'valid'
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
  if (item.itemType) {
    itemType.value = item.itemType
  }
  await loadProduct()
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
  compareLoading.value = true
  compareError.value = ''
  try {
    const relProps = compareRelationshipProps.value
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
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
        includeRelationshipProps: relProps.length ? relProps : undefined
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

function getItemNumber(item?: Record<string, any> | null): string {
  if (!item) return '-'
  return item.item_number || item.itemNumber || item.code || item.id || '-'
}

function getItemName(item?: Record<string, any> | null): string {
  if (!item) return '-'
  return item.name || item.label || item.title || '-'
}

function getCompareProp(entry: Record<string, any>, key: string): string {
  const props = entry?.properties || entry?.relationship || {}
  const value = props[key]
  if (value === undefined || value === null || value === '') return '-'
  return String(value)
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
})

onBeforeUnmount(() => {
  if (authTimer) {
    window.clearInterval(authTimer)
  }
  window.removeEventListener('storage', refreshAuthStatus)
})
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

.auth-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
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
