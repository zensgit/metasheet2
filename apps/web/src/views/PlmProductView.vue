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
            <td>{{ item.partNumber || item.item_number || item.itemNumber || item.code || '-' }}</td>
            <td>{{ item.status || '-' }}</td>
            <td>{{ item.itemType || '-' }}</td>
            <td>{{ item.updatedAt || item.updated_at || '-' }}</td>
            <td>
              <div class="inline-actions">
                <button class="btn" @click="applySearchItem(item)">使用</button>
                <button class="btn ghost mini" @click="applyCompareFromSearch(item, 'left')">
                  左对比
                </button>
                <button class="btn ghost mini" @click="applyCompareFromSearch(item, 'right')">
                  右对比
                </button>
                <button class="btn ghost mini" @click="copySearchValue(item, 'id')">
                  复制 ID
                </button>
                <button class="btn ghost mini" @click="copySearchValue(item, 'number')">
                  复制料号
                </button>
              </div>
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
      <p v-else-if="productLoading" class="status">产品加载中...</p>

      <div v-if="product" class="detail-grid">
        <div>
          <span>ID</span>
          <strong class="mono">{{ productView.id || '-' }}</strong>
        </div>
        <div>
          <span>名称</span>
          <strong>{{ productView.name }}</strong>
        </div>
        <div>
          <span>料号</span>
          <strong>{{ productView.partNumber }}</strong>
        </div>
        <div>
          <span>版本</span>
          <strong>{{ productView.revision }}</strong>
        </div>
        <div>
          <span>状态</span>
          <strong>{{ productView.status }}</strong>
        </div>
        <div>
          <span>类型</span>
          <strong>{{ productView.itemType }}</strong>
        </div>
        <div>
          <span>更新时间</span>
          <strong>{{ formatTime(productView.updatedAt) }}</strong>
        </div>
        <div>
          <span>创建时间</span>
          <strong>{{ formatTime(productView.createdAt) }}</strong>
        </div>
      </div>
      <div v-if="product" class="inline-actions">
        <button class="btn ghost mini" :disabled="!hasProductCopyValue('id')" @click="copyProductField('id')">
          复制 ID
        </button>
        <button class="btn ghost mini" :disabled="!hasProductCopyValue('number')" @click="copyProductField('number')">
          复制料号
        </button>
        <button
          class="btn ghost mini"
          :disabled="!hasProductCopyValue('revision')"
          @click="copyProductField('revision')"
        >
          复制版本
        </button>
        <button class="btn ghost mini" :disabled="!hasProductCopyValue('type')" @click="copyProductField('type')">
          复制类型
        </button>
        <button class="btn ghost mini" :disabled="!hasProductCopyValue('status')" @click="copyProductField('status')">
          复制状态
        </button>
      </div>
      <div v-else class="empty">
        暂无产品详情
        <span class="empty-hint">（输入产品 ID 或 item number 后加载）</span>
      </div>

      <p v-if="productView.description" class="description">{{ productView.description }}</p>
      <p v-else-if="product" class="muted">暂无描述</p>

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
        <div class="panel-actions">
          <button class="btn ghost" :disabled="bomView !== 'tree' || !bomHasTree" @click="expandAllBom">
            展开全部
          </button>
          <button class="btn ghost" :disabled="bomView !== 'tree' || !bomHasTree" @click="collapseAllBom">
            折叠全部
          </button>
          <button
            class="btn ghost"
            :disabled="bomView !== 'tree' || !bomHasTree"
            @click="expandBomToDepth(bomDepth)"
          >
            展开到深度
          </button>
          <button
            class="btn ghost"
            :disabled="bomView !== 'table' || !bomTablePathIdsCount"
            @click="copyBomTablePathIdsBulk"
          >
            复制所有路径 ID
          </button>
          <button
            class="btn ghost"
            :disabled="bomView !== 'tree' || !bomTreePathIdsCount"
            @click="copyBomTreePathIdsBulk"
          >
            复制树形路径 ID
          </button>
          <button class="btn ghost" :disabled="!bomSelectedCount" @click="copyBomSelectedChildIds">
            复制选中子件
          </button>
          <button class="btn ghost" :disabled="!bomSelectedCount" @click="clearBomSelection">
            清空选择
          </button>
          <span v-if="bomSelectedCount" class="muted">已选 {{ bomSelectedCount }}</span>
          <button class="btn ghost" :disabled="!bomExportCount" @click="exportBomCsv">
            导出 CSV
          </button>
          <button class="btn" :disabled="!productId || bomLoading" @click="loadBom">
            {{ bomLoading ? '加载中...' : '刷新 BOM' }}
          </button>
        </div>
      </div>
      <div class="form-grid compact">
        <label for="plm-bom-depth">
          深度
          <div class="field-inline">
            <input
              id="plm-bom-depth"
              v-model.number="bomDepth"
              name="plmBomDepth"
              type="number"
              min="1"
              max="10"
            />
            <div class="field-actions">
              <button
                v-for="depth in BOM_DEPTH_QUICK_OPTIONS"
                :key="`bom-depth-${depth}`"
                class="btn ghost mini"
                type="button"
                :disabled="bomDepth === depth"
                @click="setBomDepthQuick(depth)"
              >
                {{ depth }}
              </button>
            </div>
          </div>
        </label>
        <label for="plm-bom-effective-at">
          生效时间
          <input
            id="plm-bom-effective-at"
            v-model="bomEffectiveAt"
            name="plmBomEffectiveAt"
            type="datetime-local"
          />
        </label>
        <label for="plm-bom-view">
          视图
          <select id="plm-bom-view" v-model="bomView" name="plmBomView">
            <option value="table">表格</option>
            <option value="tree">树形</option>
          </select>
        </label>
        <label for="plm-bom-filter">
          过滤
          <div class="field-inline">
            <select id="plm-bom-filter-field" v-model="bomFilterField" name="plmBomFilterField">
              <option v-for="option in bomFilterFieldOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
            <input
              id="plm-bom-filter"
              v-model.trim="bomFilter"
              name="plmBomFilter"
              :placeholder="bomFilterPlaceholder"
            />
          </div>
        </label>
        <label for="plm-bom-filter-preset">
          预设
          <div class="field-inline">
            <select
              id="plm-bom-filter-preset-group-filter"
              v-model="bomFilterPresetGroupFilter"
              name="plmBomFilterPresetGroupFilter"
            >
              <option value="all">全部分组</option>
              <option value="ungrouped">未分组</option>
              <option v-for="group in bomFilterPresetGroups" :key="group" :value="group">
                {{ group }}
              </option>
            </select>
            <select id="plm-bom-filter-preset" v-model="bomFilterPresetKey" name="plmBomFilterPreset">
              <option value="">选择预设</option>
              <option v-for="preset in bomFilteredPresets" :key="preset.key" :value="preset.key">
                {{ preset.label }}{{ preset.group ? ` (${preset.group})` : '' }}
              </option>
            </select>
            <button class="btn ghost mini" :disabled="!bomFilterPresetKey" @click="applyBomFilterPreset">
              应用
            </button>
            <button class="btn ghost mini" :disabled="!bomFilterPresetKey" @click="deleteBomFilterPreset">
              删除
            </button>
            <button class="btn ghost mini" :disabled="!bomFilterPresetKey" @click="shareBomFilterPreset">
              分享
            </button>
            <button
              class="btn ghost mini"
              :disabled="!bomFilterPresetKey"
              @click="assignBomPresetGroup"
            >
              设为分组
            </button>
          </div>
          <div class="field-inline">
            <input
              id="plm-bom-filter-preset-name"
              v-model.trim="bomFilterPresetName"
              name="plmBomFilterPresetName"
              placeholder="新预设名称"
            />
            <input
              id="plm-bom-filter-preset-group"
              v-model.trim="bomFilterPresetGroup"
              name="plmBomFilterPresetGroup"
              class="deep-link-input"
              placeholder="分组（可选）"
            />
            <button class="btn ghost mini" :disabled="!canSaveBomFilterPreset" @click="saveBomFilterPreset">
              保存
            </button>
          </div>
          <div class="field-inline field-actions">
            <button
              class="btn ghost mini"
              :disabled="!bomFilterPresets.length"
              @click="exportBomFilterPresets"
            >
              导出
            </button>
            <input
              id="plm-bom-filter-preset-import"
              v-model.trim="bomFilterPresetImportText"
              name="plmBomFilterPresetImport"
              class="deep-link-input"
              placeholder="粘贴 JSON"
            />
            <select
              id="plm-bom-filter-preset-import-mode"
              v-model="bomFilterPresetImportMode"
              name="plmBomFilterPresetImportMode"
              class="deep-link-select"
            >
              <option value="merge">合并</option>
              <option value="replace">覆盖</option>
            </select>
            <button
              class="btn ghost mini"
              :disabled="!bomFilterPresetImportText"
              @click="importBomFilterPresets"
            >
              导入
            </button>
            <button class="btn ghost mini" @click="triggerBomFilterPresetFileImport">文件</button>
            <input
              ref="bomFilterPresetFileInput"
              id="plm-bom-filter-preset-file"
              name="plmBomFilterPresetFile"
              class="deep-link-file"
              type="file"
              accept=".json,application/json"
              @change="handleBomFilterPresetFileImport"
            />
            <button
              id="plm-bom-filter-preset-clear"
              class="btn ghost mini"
              :disabled="!bomFilterPresets.length"
              @click="clearBomFilterPresets"
            >
              清空
            </button>
            <button class="btn ghost mini" @click="showBomPresetManager = !showBomPresetManager">
              {{ showBomPresetManager ? '收起' : '管理' }}
            </button>
          </div>
          <div v-if="showBomPresetManager" class="preset-manager">
            <div class="field-inline field-actions">
              <button class="btn ghost mini" :disabled="!bomFilteredPresets.length" @click="selectAllBomPresets">
                全选
              </button>
              <button class="btn ghost mini" :disabled="!bomPresetSelectionCount" @click="clearBomPresetSelection">
                清空选择
              </button>
              <span class="muted">已选 {{ bomPresetSelectionCount }}/{{ bomFilteredPresets.length }}</span>
            </div>
            <div class="field-inline field-actions">
              <input
                id="plm-bom-filter-preset-batch-group"
                v-model.trim="bomPresetBatchGroup"
                name="plmBomFilterPresetBatchGroup"
                class="deep-link-input"
                placeholder="批量分组（留空清除）"
              />
              <button class="btn ghost mini" :disabled="!bomPresetSelectionCount" @click="applyBomPresetBatchGroup">
                应用分组
              </button>
              <button class="btn ghost mini danger" :disabled="!bomPresetSelectionCount" @click="deleteBomPresetSelection">
                批量删除
              </button>
            </div>
            <div class="preset-list">
              <label v-for="preset in bomFilteredPresets" :key="preset.key" class="preset-item">
                <input type="checkbox" :value="preset.key" v-model="bomPresetSelection" />
                <span>{{ preset.label }}{{ preset.group ? ` (${preset.group})` : '' }}</span>
              </label>
            </div>
          </div>
        </label>
      </div>
      <p v-if="bomError" class="status error">{{ bomError }}</p>
      <p v-if="bomItems.length" class="status">共 {{ bomItems.length }} 条，展示 {{ bomDisplayCount }} 条</p>
      <div v-if="!bomItems.length" class="empty">
        暂无 BOM 数据
        <span class="empty-hint">（可在 PLM 关联 BOM 行后刷新）</span>
      </div>
      <div v-else-if="bomView === 'tree' && !bomTreeVisibleCount" class="empty">
        暂无匹配项
        <span class="empty-hint">（可清空过滤条件）</span>
      </div>
      <div v-else-if="bomView === 'table' && !bomFilteredItems.length" class="empty">
        暂无匹配项
        <span class="empty-hint">（可清空过滤条件）</span>
      </div>
      <div v-else-if="bomView === 'tree'" class="bom-tree">
        <div class="tree-row tree-header bom-tree-header">
          <div class="tree-cell">组件</div>
          <div class="tree-cell">名称</div>
          <div class="tree-cell">数量</div>
          <div class="tree-cell">单位</div>
          <div class="tree-cell">Find #</div>
          <div class="tree-cell">Refdes</div>
          <div class="tree-cell">BOM 行 ID</div>
          <div class="tree-cell">操作</div>
        </div>
        <div
          v-for="row in bomTreeVisibleRows"
          :key="row.key"
          class="tree-row"
          :class="{ 'tree-root': row.depth === 0, selected: isBomTreeSelected(row) }"
          @click="selectBomTreeRow(row)"
          :data-line-id="row.line ? resolveBomLineId(row.line) : ''"
        >
          <div class="tree-cell tree-node" :style="{ paddingLeft: `${row.depth * 16}px` }">
            <button class="tree-toggle" :disabled="!row.hasChildren" @click.stop="toggleBomNode(row.key)">
              {{ row.hasChildren ? (isBomCollapsed(row.key) ? '▸' : '▾') : '•' }}
            </button>
            <div class="tree-node-meta">
              <span class="mono">{{ row.label }}</span>
              <span v-if="row.componentId && row.componentId !== row.label" class="muted mono">
                {{ row.componentId }}
              </span>
            </div>
          </div>
          <div class="tree-cell">{{ row.name || '-' }}</div>
          <div class="tree-cell">{{ row.line?.quantity ?? '-' }}</div>
          <div class="tree-cell">{{ row.line?.unit ?? row.line?.uom ?? '-' }}</div>
          <div class="tree-cell">{{ row.line ? formatBomFindNum(row.line) : '-' }}</div>
          <div class="tree-cell">{{ row.line ? formatBomRefdes(row.line) : '-' }}</div>
          <div class="tree-cell">
            <div class="tree-bom-meta">
              <span class="mono">{{ row.line ? resolveBomLineId(row.line) || '-' : '-' }}</span>
              <button
                class="btn ghost mini"
                :disabled="!formatBomPathIds(row)"
                :title="formatBomPathIds(row)"
                @click="copyBomPathIds(row)"
              >
                路径 ID
              </button>
            </div>
          </div>
            <div class="tree-cell">
              <div class="inline-actions">
                <button
                  class="btn ghost mini"
                  :disabled="!row.line || (!resolveBomChildId(row.line) && !resolveBomChildNumber(row.line)) || productLoading"
                  @click.stop="row.line && applyProductFromBom(row.line)"
                >
                  产品
                </button>
                <button
                  class="btn ghost mini"
                  :disabled="!row.line || !resolveBomChildId(row.line) || whereUsedLoading"
                  @click.stop="row.line && applyWhereUsedFromBom(row.line)"
                >
                  Where-Used
                </button>
                <button
                  class="btn ghost mini"
                  :disabled="!row.line || !resolveBomLineId(row.line) || substitutesLoading"
                  @click.stop="row.line && applySubstitutesFromBom(row.line)"
                >
                  替代件
                </button>
                <button
                  class="btn ghost mini"
                  :disabled="!row.line || (!resolveBomChildId(row.line) && !resolveBomChildNumber(row.line))"
                  @click.stop="row.line && copyBomChildId(row.line)"
                >
                  复制子件
                </button>
              </div>
          </div>
        </div>
      </div>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>层级</th>
            <th>组件编码</th>
            <th>组件名称</th>
            <th>数量</th>
            <th>单位</th>
            <th>Find #</th>
            <th>Refdes</th>
            <th>路径 ID</th>
            <th>BOM 行 ID</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in bomFilteredItems"
            :key="item.id"
            :class="{ 'row-selected': isBomItemSelected(item) }"
            @click="selectBomTableRow(item)"
          >
            <td>{{ item.level }}</td>
            <td>
              <div>{{ item.component_code || item.component_id }}</div>
              <div v-if="item.component_id" class="muted mono">{{ item.component_id }}</div>
            </td>
            <td>{{ item.component_name }}</td>
            <td>{{ item.quantity }}</td>
            <td>{{ item.unit }}</td>
            <td>{{ formatBomFindNum(item) }}</td>
            <td>{{ formatBomRefdes(item) }}</td>
            <td>
              <div class="tree-bom-meta">
                <span class="mono">{{ formatBomTablePathIds(item) || '-' }}</span>
                <button
                  class="btn ghost mini"
                  :disabled="!formatBomTablePathIds(item)"
                  :title="formatBomTablePathIds(item)"
                  @click="copyBomTablePathIds(item)"
                >
                  路径 ID
                </button>
              </div>
            </td>
            <td :data-bom-line-id="item.id || ''">
              <div class="mono">{{ item.id || '-' }}</div>
              <div v-if="item.parent_item_id" class="muted">父: {{ item.parent_item_id }}</div>
            </td>
            <td>
              <div class="inline-actions">
                <button
                  class="btn ghost mini"
                  :disabled="(!resolveBomChildId(item) && !resolveBomChildNumber(item)) || productLoading"
                  @click="applyProductFromBom(item)"
                >
                  切换产品
                </button>
              <button
                class="btn ghost mini"
                :disabled="!resolveBomChildId(item) || whereUsedLoading"
                @click.stop="applyWhereUsedFromBom(item)"
              >
                Where-Used
              </button>
              <button
                class="btn ghost mini"
                :disabled="!resolveBomLineId(item) || substitutesLoading"
                @click.stop="applySubstitutesFromBom(item)"
              >
                替代件
              </button>
              <button
                class="btn ghost mini"
                :disabled="!resolveBomChildId(item) && !resolveBomChildNumber(item)"
                @click.stop="copyBomChildId(item)"
              >
                复制子件
              </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <div class="panel-header">
        <h2>关联文档</h2>
        <div class="panel-actions">
          <button class="btn ghost" @click="copyDeepLink('documents')">复制深链接</button>
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
            placeholder="名称/类型/作者/MIME"
          />
        </label>
        <label for="plm-document-sort">
          排序
          <select id="plm-document-sort" v-model="documentSortKey" name="plmDocumentSort">
            <option value="updated">更新时间</option>
            <option value="created">创建时间</option>
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
            <th v-if="documentColumns.fileId">File ID</th>
            <th v-if="documentColumns.type">类型</th>
            <th v-if="documentColumns.revision">版本</th>
            <th v-if="documentColumns.role">角色</th>
            <th v-if="documentColumns.author">作者</th>
            <th v-if="documentColumns.sourceSystem">来源系统</th>
            <th v-if="documentColumns.sourceVersion">来源版本</th>
            <th v-if="documentColumns.mime">MIME</th>
            <th v-if="documentColumns.size">大小</th>
            <th v-if="documentColumns.created">创建时间</th>
            <th v-if="documentColumns.updated">更新时间</th>
            <th v-if="documentColumns.preview">预览</th>
            <th v-if="documentColumns.download">下载</th>
            <th v-if="documentColumns.cad">CAD</th>
            <th v-if="documentColumns.actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="doc in documentsSorted" :key="doc.id">
            <td>{{ getDocumentName(doc) }}</td>
            <td v-if="documentColumns.fileId" class="mono">{{ getDocumentId(doc) }}</td>
            <td v-if="documentColumns.type">{{ getDocumentType(doc) }}</td>
            <td v-if="documentColumns.revision">{{ getDocumentRevision(doc) }}</td>
            <td v-if="documentColumns.role">
              <span class="tag status-neutral">{{ getDocumentRole(doc) }}</span>
            </td>
            <td v-if="documentColumns.author">{{ getDocumentAuthor(doc) }}</td>
            <td v-if="documentColumns.sourceSystem">{{ getDocumentSourceSystem(doc) }}</td>
            <td v-if="documentColumns.sourceVersion">{{ getDocumentSourceVersion(doc) }}</td>
            <td v-if="documentColumns.mime">{{ getDocumentMime(doc) }}</td>
            <td v-if="documentColumns.size">{{ formatBytes(getDocumentSize(doc)) }}</td>
            <td v-if="documentColumns.created">{{ formatTime(getDocumentCreatedAt(doc)) }}</td>
            <td v-if="documentColumns.updated">{{ formatTime(getDocumentUpdatedAt(doc)) }}</td>
            <td v-if="documentColumns.preview">
              <a
                v-if="getDocumentPreviewUrl(doc)"
                :href="getDocumentPreviewUrl(doc)"
                target="_blank"
                rel="noopener"
              >查看</a>
              <span v-else>-</span>
            </td>
            <td v-if="documentColumns.download">
              <a
                v-if="getDocumentDownloadUrl(doc)"
                :href="getDocumentDownloadUrl(doc)"
                target="_blank"
                rel="noopener"
              >下载</a>
              <span v-else>-</span>
            </td>
            <td v-if="documentColumns.cad">
              <div class="inline-actions">
                <button class="btn ghost mini" @click="selectCadFile(doc, 'primary')">主</button>
                <button class="btn ghost mini" @click="selectCadFile(doc, 'other')">对比</button>
              </div>
            </td>
            <td v-if="documentColumns.actions">
              <div class="inline-actions">
                <button class="btn ghost mini" @click="copyDocumentId(doc)">复制 ID</button>
                <button
                  class="btn ghost mini"
                  :disabled="!getDocumentDownloadUrl(doc)"
                  @click="copyDocumentUrl(doc, 'download')"
                >
                  复制下载
                </button>
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
          <button class="btn ghost" @click="copyDeepLink('approvals')">复制深链接</button>
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
            <th v-if="approvalColumns.id">审批 ID</th>
            <th>标题</th>
            <th v-if="approvalColumns.status">状态</th>
            <th v-if="approvalColumns.type">类型</th>
            <th v-if="approvalColumns.requester">发起人</th>
            <th v-if="approvalColumns.requesterId">发起人 ID</th>
            <th v-if="approvalColumns.created">创建时间</th>
            <th v-if="approvalColumns.product">产品</th>
            <th v-if="approvalColumns.productId">产品 ID</th>
            <th v-if="approvalColumns.actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="approval in approvalsSorted" :key="approval.id">
            <td v-if="approvalColumns.id" class="mono">{{ getApprovalId(approval) }}</td>
            <td>{{ getApprovalTitle(approval) }}</td>
            <td v-if="approvalColumns.status">
              <span class="tag" :class="approvalStatusClass(getApprovalStatus(approval))">
                {{ getApprovalStatus(approval) }}
              </span>
            </td>
            <td v-if="approvalColumns.type">{{ getApprovalType(approval) }}</td>
            <td v-if="approvalColumns.requester">{{ getApprovalRequester(approval) }}</td>
            <td v-if="approvalColumns.requesterId" class="mono">{{ getApprovalRequesterId(approval) }}</td>
            <td v-if="approvalColumns.created">{{ formatTime(getApprovalCreatedAt(approval)) }}</td>
            <td v-if="approvalColumns.product">
              <div>{{ getApprovalProductNumber(approval) }}</div>
              <div class="muted">{{ getApprovalProductName(approval) }}</div>
            </td>
            <td v-if="approvalColumns.productId" class="mono">{{ getApprovalProductId(approval) }}</td>
            <td v-if="approvalColumns.actions">
              <div class="inline-actions">
                <button class="btn ghost mini" @click="applyProductFromApproval(approval)">切换产品</button>
                <button class="btn ghost mini" @click="copyApprovalId(approval)">复制 ID</button>
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
          <button
            class="btn ghost"
            :disabled="whereUsedView !== 'tree' || !whereUsedHasTree"
            @click="expandAllWhereUsed"
          >
            展开全部
          </button>
          <button
            class="btn ghost"
            :disabled="whereUsedView !== 'tree' || !whereUsedHasTree"
            @click="collapseAllWhereUsed"
          >
            折叠全部
          </button>
          <button
            class="btn ghost"
            :disabled="whereUsedView !== 'table' || !whereUsedPathIdsCount"
            @click="copyWhereUsedTablePathIdsBulk"
          >
            复制所有路径 ID
          </button>
          <button
            class="btn ghost"
            :disabled="whereUsedView !== 'tree' || !whereUsedTreePathIdsCount"
            @click="copyWhereUsedTreePathIdsBulk"
          >
            复制树形路径 ID
          </button>
          <button class="btn ghost" :disabled="!whereUsedSelectedCount" @click="copyWhereUsedSelectedParents">
            复制选中父件
          </button>
          <button class="btn ghost" :disabled="!whereUsedSelectedCount" @click="clearWhereUsedSelection">
            清空选择
          </button>
          <span v-if="whereUsedSelectedCount" class="muted">已选 {{ whereUsedSelectedCount }}</span>
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
        <label for="plm-where-used-quick-pick">
          快速选择
          <select
            id="plm-where-used-quick-pick"
            v-model="whereUsedQuickPick"
            name="plmWhereUsedQuickPick"
            :disabled="!whereUsedQuickOptions.length"
            @change="applyWhereUsedQuickPick"
          >
            <option value="">从 BOM / 搜索结果选择</option>
            <option v-for="option in whereUsedQuickOptions" :key="option.key" :value="option.value">
              {{ option.label }}
            </option>
          </select>
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
        <label for="plm-where-used-view">
          视图
          <select id="plm-where-used-view" v-model="whereUsedView" name="plmWhereUsedView">
            <option value="table">表格</option>
            <option value="tree">树形</option>
          </select>
        </label>
        <label for="plm-where-used-filter">
          过滤
          <div class="field-inline">
            <select id="plm-where-used-filter-field" v-model="whereUsedFilterField" name="plmWhereUsedFilterField">
              <option v-for="option in whereUsedFilterFieldOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
            <input
              id="plm-where-used-filter"
              v-model.trim="whereUsedFilter"
              name="plmWhereUsedFilter"
              :placeholder="whereUsedFilterPlaceholder"
            />
          </div>
        </label>
        <label for="plm-where-used-filter-preset">
          预设
          <div class="field-inline">
            <select
              id="plm-where-used-filter-preset-group-filter"
              v-model="whereUsedFilterPresetGroupFilter"
              name="plmWhereUsedFilterPresetGroupFilter"
            >
              <option value="all">全部分组</option>
              <option value="ungrouped">未分组</option>
              <option v-for="group in whereUsedFilterPresetGroups" :key="group" :value="group">
                {{ group }}
              </option>
            </select>
            <select
              id="plm-where-used-filter-preset"
              v-model="whereUsedFilterPresetKey"
              name="plmWhereUsedFilterPreset"
            >
              <option value="">选择预设</option>
              <option v-for="preset in whereUsedFilteredPresets" :key="preset.key" :value="preset.key">
                {{ preset.label }}{{ preset.group ? ` (${preset.group})` : '' }}
              </option>
            </select>
            <button
              class="btn ghost mini"
              :disabled="!whereUsedFilterPresetKey"
              @click="applyWhereUsedFilterPreset"
            >
              应用
            </button>
            <button
              class="btn ghost mini"
              :disabled="!whereUsedFilterPresetKey"
              @click="deleteWhereUsedFilterPreset"
            >
              删除
            </button>
            <button
              class="btn ghost mini"
              :disabled="!whereUsedFilterPresetKey"
              @click="shareWhereUsedFilterPreset"
            >
              分享
            </button>
            <button
              class="btn ghost mini"
              :disabled="!whereUsedFilterPresetKey"
              @click="assignWhereUsedPresetGroup"
            >
              设为分组
            </button>
          </div>
          <div class="field-inline">
            <input
              id="plm-where-used-filter-preset-name"
              v-model.trim="whereUsedFilterPresetName"
              name="plmWhereUsedFilterPresetName"
              placeholder="新预设名称"
            />
            <input
              id="plm-where-used-filter-preset-group"
              v-model.trim="whereUsedFilterPresetGroup"
              name="plmWhereUsedFilterPresetGroup"
              class="deep-link-input"
              placeholder="分组（可选）"
            />
            <button
              class="btn ghost mini"
              :disabled="!canSaveWhereUsedFilterPreset"
              @click="saveWhereUsedFilterPreset"
            >
              保存
            </button>
          </div>
          <div class="field-inline field-actions">
            <button
              class="btn ghost mini"
              :disabled="!whereUsedFilterPresets.length"
              @click="exportWhereUsedFilterPresets"
            >
              导出
            </button>
            <input
              id="plm-where-used-filter-preset-import"
              v-model.trim="whereUsedFilterPresetImportText"
              name="plmWhereUsedFilterPresetImport"
              class="deep-link-input"
              placeholder="粘贴 JSON"
            />
            <select
              id="plm-where-used-filter-preset-import-mode"
              v-model="whereUsedFilterPresetImportMode"
              name="plmWhereUsedFilterPresetImportMode"
              class="deep-link-select"
            >
              <option value="merge">合并</option>
              <option value="replace">覆盖</option>
            </select>
            <button
              class="btn ghost mini"
              :disabled="!whereUsedFilterPresetImportText"
              @click="importWhereUsedFilterPresets"
            >
              导入
            </button>
            <button class="btn ghost mini" @click="triggerWhereUsedFilterPresetFileImport">文件</button>
            <input
              ref="whereUsedFilterPresetFileInput"
              id="plm-where-used-filter-preset-file"
              name="plmWhereUsedFilterPresetFile"
              class="deep-link-file"
              type="file"
              accept=".json,application/json"
              @change="handleWhereUsedFilterPresetFileImport"
            />
            <button
              id="plm-where-used-filter-preset-clear"
              class="btn ghost mini"
              :disabled="!whereUsedFilterPresets.length"
              @click="clearWhereUsedFilterPresets"
            >
              清空
            </button>
            <button class="btn ghost mini" @click="showWhereUsedPresetManager = !showWhereUsedPresetManager">
              {{ showWhereUsedPresetManager ? '收起' : '管理' }}
            </button>
          </div>
          <div v-if="showWhereUsedPresetManager" class="preset-manager">
            <div class="field-inline field-actions">
              <button
                class="btn ghost mini"
                :disabled="!whereUsedFilteredPresets.length"
                @click="selectAllWhereUsedPresets"
              >
                全选
              </button>
              <button
                class="btn ghost mini"
                :disabled="!whereUsedPresetSelectionCount"
                @click="clearWhereUsedPresetSelection"
              >
                清空选择
              </button>
              <span class="muted">已选 {{ whereUsedPresetSelectionCount }}/{{ whereUsedFilteredPresets.length }}</span>
            </div>
            <div class="field-inline field-actions">
              <input
                id="plm-where-used-filter-preset-batch-group"
                v-model.trim="whereUsedPresetBatchGroup"
                name="plmWhereUsedFilterPresetBatchGroup"
                class="deep-link-input"
                placeholder="批量分组（留空清除）"
              />
              <button
                class="btn ghost mini"
                :disabled="!whereUsedPresetSelectionCount"
                @click="applyWhereUsedPresetBatchGroup"
              >
                应用分组
              </button>
              <button
                class="btn ghost mini danger"
                :disabled="!whereUsedPresetSelectionCount"
                @click="deleteWhereUsedPresetSelection"
              >
                批量删除
              </button>
            </div>
            <div class="preset-list">
              <label v-for="preset in whereUsedFilteredPresets" :key="preset.key" class="preset-item">
                <input type="checkbox" :value="preset.key" v-model="whereUsedPresetSelection" />
                <span>{{ preset.label }}{{ preset.group ? ` (${preset.group})` : '' }}</span>
              </label>
            </div>
          </div>
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
        <div v-else-if="whereUsedView === 'tree'" class="where-used-tree">
          <div class="tree-row tree-header">
            <div class="tree-cell">节点</div>
            <div class="tree-cell">名称</div>
            <div class="tree-cell">数量</div>
            <div class="tree-cell">单位</div>
            <div class="tree-cell">Find #</div>
            <div class="tree-cell">Refdes</div>
            <div class="tree-cell">关系 ID</div>
            <div class="tree-cell">操作</div>
          </div>
          <div
            v-for="row in whereUsedTreeVisibleRows"
            :key="row.key"
            class="tree-row"
            :class="{ 'tree-root': row.depth === 0, selected: isWhereUsedTreeSelected(row) }"
            @click="selectWhereUsedTreeRow(row)"
            :data-entry-count="row.entryCount"
          >
            <div class="tree-cell tree-node" :style="{ paddingLeft: `${row.depth * 16}px` }">
              <button
                class="tree-toggle"
                :disabled="!row.hasChildren"
                @click.stop="toggleWhereUsedNode(row.key)"
              >
                {{ row.hasChildren ? (isWhereUsedCollapsed(row.key) ? '▸' : '▾') : '•' }}
              </button>
              <span class="mono">{{ row.label || row.id }}</span>
              <span v-if="row.entryCount > 1" class="tree-multi">×{{ row.entryCount }}</span>
            </div>
            <div class="tree-cell">{{ row.name || '-' }}</div>
            <div class="tree-cell">{{ getWhereUsedTreeLineValue(row, 'quantity') }}</div>
            <div class="tree-cell">{{ getWhereUsedTreeLineValue(row, 'uom') }}</div>
            <div class="tree-cell">{{ getWhereUsedTreeLineValue(row, 'find_num') }}</div>
            <div class="tree-cell">{{ getWhereUsedTreeRefdes(row) }}</div>
            <div class="tree-cell">
              <div class="tree-bom-meta">
                <span class="mono">{{ getWhereUsedTreeRelationship(row) }}</span>
                <button
                  class="btn ghost mini"
                  :disabled="!formatWhereUsedPathIds(row)"
                  :title="formatWhereUsedPathIds(row)"
                  @click="copyWhereUsedPathIds(row)"
                >
                  路径 ID
                </button>
              </div>
            </div>
            <div class="tree-cell">
              <button
                class="btn ghost mini"
                :disabled="!row.id || productLoading"
                @click.stop="applyProductFromWhereUsedRow(row)"
              >
                产品
              </button>
            </div>
          </div>
        </div>
        <table v-else class="data-table">
          <thead>
            <tr>
              <th>层级</th>
              <th>父件编号</th>
              <th>父件名称</th>
              <th>路径</th>
              <th>路径 ID</th>
              <th>数量</th>
              <th>单位</th>
              <th>Find #</th>
              <th>Refdes</th>
              <th>关系 ID</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in whereUsedFilteredRows"
              :key="entry._key"
              :class="{ 'row-selected': isWhereUsedEntrySelected(entry) }"
              @click="selectWhereUsedTableRow(entry)"
            >
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
              <td>
                <div class="tree-bom-meta">
                  <span class="mono">{{ formatWhereUsedEntryPathIds(entry) || '-' }}</span>
                  <button
                    class="btn ghost mini"
                    :disabled="!formatWhereUsedEntryPathIds(entry)"
                    :title="formatWhereUsedEntryPathIds(entry)"
                    @click="copyWhereUsedEntryPathIds(entry)"
                  >
                    路径 ID
                  </button>
                </div>
              </td>
              <td>{{ getWhereUsedLineValue(entry, 'quantity') }}</td>
              <td>{{ getWhereUsedLineValue(entry, 'uom') }}</td>
              <td>{{ getWhereUsedLineValue(entry, 'find_num') }}</td>
              <td>{{ getWhereUsedRefdes(entry) }}</td>
              <td>{{ entry.relationship?.id || '-' }}</td>
              <td>
                <button
                  class="btn ghost mini"
                  :disabled="!resolveWhereUsedParentId(entry) || productLoading"
                  @click.stop="applyProductFromWhereUsed(entry)"
                >
                  产品
                </button>
              </td>
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
          <button class="btn ghost" :disabled="!productId" @click="applyCompareFromProduct('left')">
            左=当前产品
          </button>
          <button class="btn ghost" :disabled="!productId" @click="applyCompareFromProduct('right')">
            右=当前产品
          </button>
          <button
            class="btn ghost"
            :disabled="!compareLeftId || !compareRightId"
            @click="swapCompareSides"
          >
            交换左右
          </button>
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
        <label for="plm-compare-left-quick-pick">
          左侧快选
          <select
            id="plm-compare-left-quick-pick"
            v-model="compareLeftQuickPick"
            name="plmCompareLeftQuickPick"
            :disabled="!compareQuickOptions.length"
            @change="applyCompareQuickPick('left')"
          >
            <option value="">从搜索结果选择</option>
            <option v-for="option in compareQuickOptions" :key="`left-${option.key}`" :value="option.value">
              {{ option.label }}
            </option>
          </select>
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
        <label for="plm-compare-right-quick-pick">
          右侧快选
          <select
            id="plm-compare-right-quick-pick"
            v-model="compareRightQuickPick"
            name="plmCompareRightQuickPick"
            :disabled="!compareQuickOptions.length"
            @change="applyCompareQuickPick('right')"
          >
            <option value="">从搜索结果选择</option>
            <option v-for="option in compareQuickOptions" :key="`right-${option.key}`" :value="option.value">
              {{ option.label }}
            </option>
          </select>
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
            <option v-for="option in compareLineKeyOptions" :key="option" :value="option">
              {{ option }}
            </option>
          </select>
        </label>
        <label for="plm-compare-mode">
          Compare Mode
          <input
            id="plm-compare-mode"
            v-model.trim="compareMode"
            name="plmCompareMode"
            list="plm-compare-mode-options"
            placeholder="only_product / summarized / num_qty"
          />
          <datalist id="plm-compare-mode-options">
            <option v-for="mode in compareModeOptions" :key="mode.mode" :value="mode.mode">
              {{ mode.description || mode.mode }}
            </option>
          </datalist>
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
        <label class="checkbox-field" for="plm-compare-sync">
          <span>联动 Where-Used / 替代件</span>
          <input
            id="plm-compare-sync"
            name="plmCompareSync"
            v-model="compareSyncEnabled"
            type="checkbox"
          />
        </label>
      </div>
      <p v-if="compareSchemaLoading" class="status">对比字段加载中...</p>
      <p v-else-if="compareSchemaError" class="status error">{{ compareSchemaError }}（已回退默认字段）</p>
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
              <tr
                v-for="entry in compareAddedFiltered"
                :key="entry.relationship_id || entry.line_key || entry.child_id"
                :class="{ 'row-selected': isCompareEntrySelected(entry, 'added') }"
                :data-compare-child="resolveCompareChildKey(entry)"
                :data-compare-line="resolveCompareLineId(entry)"
                @click="selectCompareEntry(entry, 'added')"
              >
                <td>{{ entry.level ?? '-' }}</td>
                <td>
                  <div>{{ getItemNumber(getCompareParent(entry)) }}</div>
                  <div class="muted">{{ getItemName(getCompareParent(entry)) }}</div>
                  <div class="inline-actions">
                    <button
                      class="btn ghost mini"
                      :disabled="!resolveCompareParentKey(entry) || productLoading"
                      @click="applyProductFromCompareParent(entry)"
                    >
                      产品
                    </button>
                  </div>
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
                  <div class="inline-actions">
                    <button
                      class="btn ghost mini"
                      :disabled="!resolveCompareChildKey(entry) || whereUsedLoading"
                      @click="applyWhereUsedFromCompare(entry)"
                    >
                      Where-Used
                    </button>
                    <button
                      class="btn ghost mini"
                      :disabled="!resolveCompareLineId(entry) || substitutesLoading"
                      @click="applySubstitutesFromCompare(entry)"
                    >
                      替代件
                    </button>
                    <button
                      class="btn ghost mini"
                      :disabled="!resolveCompareLineId(entry)"
                      @click="copyCompareLineId(entry)"
                    >
                      复制 Line
                    </button>
                  </div>
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
              <tr
                v-for="entry in compareRemovedFiltered"
                :key="entry.relationship_id || entry.line_key || entry.child_id"
                :class="{ 'row-selected': isCompareEntrySelected(entry, 'removed') }"
                :data-compare-child="resolveCompareChildKey(entry)"
                :data-compare-line="resolveCompareLineId(entry)"
                @click="selectCompareEntry(entry, 'removed')"
              >
                <td>{{ entry.level ?? '-' }}</td>
                <td>
                  <div>{{ getItemNumber(getCompareParent(entry)) }}</div>
                  <div class="muted">{{ getItemName(getCompareParent(entry)) }}</div>
                  <div class="inline-actions">
                    <button
                      class="btn ghost mini"
                      :disabled="!resolveCompareParentKey(entry) || productLoading"
                      @click="applyProductFromCompareParent(entry)"
                    >
                      产品
                    </button>
                  </div>
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
                  <div class="inline-actions">
                    <button
                      class="btn ghost mini"
                      :disabled="!resolveCompareChildKey(entry) || whereUsedLoading"
                      @click="applyWhereUsedFromCompare(entry)"
                    >
                      Where-Used
                    </button>
                    <button
                      class="btn ghost mini"
                      :disabled="!resolveCompareLineId(entry) || substitutesLoading"
                      @click="applySubstitutesFromCompare(entry)"
                    >
                      替代件
                    </button>
                    <button
                      class="btn ghost mini"
                      :disabled="!resolveCompareLineId(entry)"
                      @click="copyCompareLineId(entry)"
                    >
                      复制 Line
                    </button>
                  </div>
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
              <tr
                v-for="entry in compareChangedFiltered"
                :key="entry.relationship_id || entry.line_key || entry.child_id"
                :class="[compareRowClass(entry), { 'row-selected': isCompareEntrySelected(entry, 'changed') }]"
                :data-compare-child="resolveCompareChildKey(entry)"
                :data-compare-line="resolveCompareLineId(entry)"
                @click="selectCompareEntry(entry, 'changed')"
              >
                <td>{{ entry.level ?? '-' }}</td>
                <td>
                  <div>{{ getItemNumber(getCompareParent(entry)) }}</div>
                  <div class="muted">{{ getItemName(getCompareParent(entry)) }}</div>
                  <div class="inline-actions">
                    <button
                      class="btn ghost mini"
                      :disabled="!resolveCompareParentKey(entry) || productLoading"
                      @click="applyProductFromCompareParent(entry)"
                    >
                      产品
                    </button>
                  </div>
                </td>
                <td>
                  <div>{{ getItemNumber(getCompareChild(entry)) }}</div>
                  <div class="muted">{{ getItemName(getCompareChild(entry)) }}</div>
                </td>
                <td>
                  <span class="tag" :class="severityClass(getCompareEntrySeverity(entry))">
                    {{ getCompareEntrySeverity(entry) }}
                  </span>
                </td>
                <td>
                  <div v-if="entry.changes?.length" class="diff-list">
                    <div v-for="change in getCompareChangeRows(entry)" :key="change.key" class="diff-row">
                      <span class="tag" :class="severityClass(change.severity)">{{ change.severity }}</span>
                      <span class="diff-field" :title="change.description || ''">
                        {{ change.label }}
                        <span v-if="compareFieldLabelMap.has(change.field)" class="diff-field-code">
                          ({{ change.field }})
                        </span>
                        <span v-if="change.normalized && change.normalized !== '-'" class="diff-field-meta">
                          {{ change.normalized }}
                        </span>
                      </span>
                      <span class="diff-value">
                        <span class="diff-value-left">{{ formatDiffValue(change.left) }}</span>
                        <span class="diff-arrow">→</span>
                        <span class="diff-value-right">{{ formatDiffValue(change.right) }}</span>
                      </span>
                    </div>
                  </div>
                  <span v-else class="muted">-</span>
                </td>
                <td>{{ formatEffectivity(entry) }}</td>
                <td>{{ formatSubstituteCount(entry) }}</td>
                <td>
                  <div class="mono">{{ entry.line_key || '-' }}</div>
                  <div class="muted">{{ entry.relationship_id || '-' }}</div>
                  <div class="inline-actions">
                    <button
                      class="btn ghost mini"
                      :disabled="!resolveCompareChildKey(entry) || whereUsedLoading"
                      @click="applyWhereUsedFromCompare(entry)"
                    >
                      Where-Used
                    </button>
                    <button
                      class="btn ghost mini"
                      :disabled="!resolveCompareLineId(entry) || substitutesLoading"
                      @click="applySubstitutesFromCompare(entry)"
                    >
                      替代件
                    </button>
                    <button
                      class="btn ghost mini"
                      :disabled="!resolveCompareLineId(entry)"
                      @click="copyCompareLineId(entry)"
                    >
                      复制 Line
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="compare-detail" data-compare-detail="true">
          <div class="compare-detail-header">
            <h3>字段级对照</h3>
            <div class="compare-detail-actions">
              <template v-if="compareSelectedMeta">
                <span class="tag" :class="compareSelectedMeta.tagClass">{{ compareSelectedMeta.kindLabel }}</span>
                <span v-if="compareSelectedMeta.lineKey" class="mono">Line: {{ compareSelectedMeta.lineKey }}</span>
                <span v-if="compareSelectedMeta.relationshipId" class="muted mono">
                  {{ compareSelectedMeta.relationshipId }}
                </span>
                <span v-if="compareSelectedMeta.pathLabel" class="muted">
                  {{ compareSelectedMeta.pathLabel }}
                </span>
              </template>
              <button class="btn ghost mini" :disabled="!compareDetailRows.length" @click="copyCompareDetailRows">
                复制字段对照
              </button>
              <button class="btn ghost mini" :disabled="!compareDetailRows.length" @click="exportCompareDetailCsv">
                导出字段对照
              </button>
              <button class="btn ghost mini" :disabled="!compareSelectedEntry" @click="clearCompareSelection">
                清空选择
              </button>
            </div>
          </div>
          <div v-if="!compareSelectedEntry" class="empty">点击上方条目查看字段级对照</div>
          <table v-else class="data-table compact">
            <thead>
              <tr>
                <th>字段</th>
                <th>左侧</th>
                <th>右侧</th>
                <th>严重度</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in compareDetailRows"
                :key="row.key"
                :class="{ 'compare-field-row': true, changed: row.changed }"
                :data-field-key="row.key"
              >
                <td>
                  <div class="diff-field" :title="row.description || ''">{{ row.label }}</div>
                  <div class="muted mono">{{ row.key }}</div>
                </td>
                <td>
                  <div class="diff-value-left">{{ row.left }}</div>
                  <div v-if="row.normalizedLeft" class="muted">规范化: {{ row.normalizedLeft }}</div>
                </td>
                <td>
                  <div class="diff-value-right">{{ row.right }}</div>
                  <div v-if="row.normalizedRight" class="muted">规范化: {{ row.normalizedRight }}</div>
                </td>
                <td>
                  <span v-if="row.severity" class="tag" :class="severityClass(row.severity)">{{ row.severity }}</span>
                  <span v-else class="muted">-</span>
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
        <label for="plm-bom-line-quick-pick">
          BOM 行快选
          <select
            id="plm-bom-line-quick-pick"
            v-model="bomLineQuickPick"
            name="plmBomLineQuickPick"
            :disabled="!bomLineOptions.length"
            @change="applyBomLineQuickPick"
          >
            <option value="">从 BOM 选择</option>
            <option v-for="option in bomLineOptions" :key="option.key" :value="option.value">
              {{ option.label }}
            </option>
          </select>
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
      <div v-if="bomLineId" class="context-row">
        <span class="context-title">BOM 行</span>
        <span class="mono">{{ bomLineId }}</span>
        <button class="btn ghost mini" @click="copyBomLineId()">复制 BOM 行</button>
        <template v-if="bomLineContext">
          <span class="context-divider"></span>
          <span>
            子件:
            <strong>{{ bomLineContext.component_code || bomLineContext.component_id || '-' }}</strong>
          </span>
          <span v-if="bomLineContext.component_name" class="muted">{{ bomLineContext.component_name }}</span>
          <span class="muted">数量: {{ bomLineContext.quantity ?? '-' }} {{ bomLineContext.unit || '' }}</span>
          <span class="muted">Find: {{ bomLineContext.sequence ?? '-' }}</span>
          <button
            class="btn ghost mini"
            :disabled="whereUsedLoading"
            @click="applyWhereUsedFromBom(bomLineContext)"
          >
            Where-Used
          </button>
        </template>
        <span v-else class="muted">未在当前 BOM 中找到</span>
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
        <label for="plm-substitute-quick-pick">
          替代件快选
          <select
            id="plm-substitute-quick-pick"
            v-model="substituteQuickPick"
            name="plmSubstituteQuickPick"
            :disabled="!substituteQuickOptions.length"
            @change="applySubstituteQuickPick"
          >
            <option value="">从 BOM / 搜索结果选择</option>
            <option v-for="option in substituteQuickOptions" :key="option.key" :value="option.value">
              {{ option.label }}
            </option>
          </select>
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
              <th>替代件编号</th>
              <th>替代件名称</th>
              <th>状态</th>
              <th>原件编号</th>
              <th>原件名称</th>
              <th>优先级</th>
              <th>备注</th>
              <th>关系 ID</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in substitutesRows" :key="entry.relationship?.id || entry.id">
              <td>
                <div>{{ getSubstituteNumber(entry) }}</div>
                <div class="muted">{{ getSubstituteId(entry) }}</div>
              </td>
              <td>{{ getSubstituteName(entry) }}</td>
              <td>
                <span class="tag" :class="itemStatusClass(getSubstituteStatus(entry))">
                  {{ getSubstituteStatus(entry) }}
                </span>
              </td>
              <td>
                <div>{{ getItemNumber(entry.part) }}</div>
                <div class="muted">{{ entry.part?.id || '-' }}</div>
              </td>
              <td>{{ getItemName(entry.part) }}</td>
              <td>{{ formatSubstituteRank(entry) }}</td>
              <td>{{ formatSubstituteNote(entry) }}</td>
              <td>{{ entry.relationship?.id || '-' }}</td>
              <td>
                <div class="inline-actions">
                  <button
                    class="btn ghost mini"
                    :disabled="!resolveSubstituteTargetKey(entry, 'substitute') || productLoading"
                    @click="applyProductFromSubstitute(entry, 'substitute')"
                  >
                    替代件
                  </button>
                  <button
                    class="btn ghost mini"
                    :disabled="!resolveSubstituteTargetKey(entry, 'part') || productLoading"
                    @click="applyProductFromSubstitute(entry, 'part')"
                  >
                    原件
                  </button>
                  <button
                    class="btn ghost"
                    :disabled="substitutesMutating || substitutesDeletingId === (entry.relationship?.id || entry.id)"
                    @click="removeSubstitute(entry)"
                  >
                    {{ substitutesDeletingId === (entry.relationship?.id || entry.id) ? '删除中...' : '删除' }}
                  </button>
                </div>
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
const DEFAULT_BOM_DEPTH = 2
const BOM_DEPTH_QUICK_OPTIONS = [1, 2, 3]
const DEFAULT_COMPARE_MAX_LEVELS = 10
const DEFAULT_COMPARE_LINE_KEY = 'child_config'
const DEFAULT_COMPARE_REL_PROPS = 'quantity,uom,find_num,refdes'
const DEFAULT_APPROVAL_STATUS = 'pending'
const DEFAULT_COMPARE_LINE_KEYS = [
  'child_config',
  'child_id',
  'relationship_id',
  'child_config_find_num',
  'child_config_refdes',
  'child_config_find_refdes',
  'child_id_find_num',
  'child_id_refdes',
  'child_id_find_refdes',
  'child_config_find_num_qty',
  'child_id_find_num_qty',
  'line_full',
]

const searchQuery = ref('')
const searchItemType = ref(DEFAULT_ITEM_TYPE)
const searchLimit = ref(DEFAULT_SEARCH_LIMIT)
const searchResults = ref<any[]>([])
const searchTotal = ref(0)
const searchLoading = ref(false)
const searchError = ref('')

type AuthState = 'missing' | 'invalid' | 'expired' | 'expiring' | 'valid'

type CompareSchemaField = {
  field: string
  severity: string
  normalized: string
  description?: string
}

type CompareSchemaMode = {
  mode: string
  line_key?: string
  include_relationship_props?: string[]
  aggregate_quantities?: boolean
  aliases?: string[]
  description?: string
}

type CompareSchemaPayload = {
  line_fields: CompareSchemaField[]
  compare_modes: CompareSchemaMode[]
  line_key_options: string[]
  defaults?: Record<string, unknown>
}

type WhereUsedTreeNode = {
  id: string
  label: string
  name: string
  children: WhereUsedTreeNode[]
  entries: any[]
}

type WhereUsedTreeRow = {
  key: string
  parentKey?: string
  id: string
  label: string
  name: string
  depth: number
  hasChildren: boolean
  entries: any[]
  entryCount: number
  pathLabels: string[]
  pathIds: string[]
}

type DeepLinkPreset = {
  key: string
  label: string
  panels: string[]
  params?: Record<string, string | number | boolean>
}

type QuickPickOption = {
  key: string
  value: string
  label: string
}

type FilterPreset = {
  key: string
  label: string
  field: string
  value: string
  group?: string
}

type FilterPresetImportEntry = {
  key: string
  label: string
  field: string
  value: string
  group?: string
}

type BomTreeRow = {
  key: string
  parentKey?: string
  depth: number
  line?: any
  label: string
  name: string
  componentId: string
  lineId: string
  hasChildren: boolean
  pathLabels: string[]
  pathIds: string[]
}

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
const customDeepLinkPresets = ref<DeepLinkPreset[]>([])

const productId = ref('')
const productItemNumber = ref('')
const itemType = ref(DEFAULT_ITEM_TYPE)
const product = ref<any | null>(null)
const productLoading = ref(false)
const productError = ref('')
const productView = computed(() => {
  const data = product.value || {}
  const props = data.properties || {}
  const name =
    data.name ||
    data.item_name ||
    data.title ||
    props.name ||
    props.item_name ||
    props.title ||
    props.label ||
    data.id ||
    '-'
  const partNumber =
    data.partNumber ||
    data.item_number ||
    data.itemNumber ||
    data.code ||
    props.item_number ||
    props.part_number ||
    props.number ||
    props.code ||
    props.internal_reference ||
    '-'
  const revision =
    data.revision ||
    data.version ||
    data.version_label ||
    props.revision ||
    props.version ||
    props.rev ||
    props.version_label ||
    '-'
  const status =
    data.status ||
    data.state ||
    data.current_state ||
    props.state ||
    props.current_state ||
    props.status ||
    props.lifecycle_state ||
    '-'
  const itemType =
    data.itemType ||
    data.item_type_id ||
    data.item_type ||
    data.type ||
    props.item_type ||
    props.itemType ||
    props.item_type_id ||
    props.type ||
    DEFAULT_ITEM_TYPE
  const description = data.description || props.description || props.desc || ''
  const createdAt =
    data.createdAt ||
    data.created_at ||
    data.created_on ||
    props.created_at ||
    props.created_on ||
    props.create_date ||
    ''
  const updatedAt =
    data.updatedAt ||
    data.updated_at ||
    data.modified_on ||
    props.updated_at ||
    props.modified_on ||
    props.write_date ||
    createdAt ||
    ''
  return {
    id: String(data.id || ''),
    name,
    partNumber,
    revision,
    status,
    itemType,
    description,
    createdAt,
    updatedAt,
  }
})

const bomItems = ref<any[]>([])
const bomLoading = ref(false)
const bomError = ref('')
const bomDepth = ref(DEFAULT_BOM_DEPTH)
const bomEffectiveAt = ref('')
const bomView = ref<'table' | 'tree'>('table')
const bomCollapsed = ref<Set<string>>(new Set())

const documentRole = ref('')
const documentFilter = ref('')
const documentSortKey = ref<'updated' | 'created' | 'name' | 'type' | 'revision' | 'role' | 'mime' | 'size'>('updated')
const documentSortDir = ref<'asc' | 'desc'>('desc')
const defaultDocumentColumns: Record<string, boolean> = {
  fileId: false,
  type: true,
  revision: true,
  role: true,
  author: false,
  sourceSystem: false,
  sourceVersion: false,
  mime: true,
  size: true,
  created: false,
  updated: true,
  preview: true,
  download: true,
  cad: true,
  actions: true,
}
const documentColumns = ref<Record<string, boolean>>({ ...defaultDocumentColumns })
const documentColumnOptions = [
  { key: 'fileId', label: 'File ID' },
  { key: 'type', label: '类型' },
  { key: 'revision', label: '版本' },
  { key: 'role', label: '角色' },
  { key: 'author', label: '作者' },
  { key: 'sourceSystem', label: '来源系统' },
  { key: 'sourceVersion', label: '来源版本' },
  { key: 'mime', label: 'MIME' },
  { key: 'size', label: '大小' },
  { key: 'created', label: '创建时间' },
  { key: 'updated', label: '更新时间' },
  { key: 'preview', label: '预览' },
  { key: 'download', label: '下载' },
  { key: 'cad', label: 'CAD' },
  { key: 'actions', label: '操作' },
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
  id: false,
  status: true,
  type: true,
  requester: true,
  requesterId: false,
  created: true,
  product: true,
  productId: false,
  actions: true,
}
const approvalColumns = ref<Record<string, boolean>>({ ...defaultApprovalColumns })
const approvalColumnOptions = [
  { key: 'id', label: '审批 ID' },
  { key: 'status', label: '状态' },
  { key: 'type', label: '类型' },
  { key: 'requester', label: '发起人' },
  { key: 'requesterId', label: '发起人 ID' },
  { key: 'created', label: '创建时间' },
  { key: 'product', label: '产品' },
  { key: 'productId', label: '产品 ID' },
  { key: 'actions', label: '操作' },
]

const whereUsedItemId = ref('')
const whereUsedQuickPick = ref('')
const whereUsedRecursive = ref(true)
const whereUsedMaxLevels = ref(DEFAULT_WHERE_USED_MAX_LEVELS)
const whereUsedView = ref<'table' | 'tree'>('table')
const whereUsedFilterFieldOptions = [
  { value: 'all', label: '全部', placeholder: '父件/路径/关系 ID' },
  { value: 'parent_number', label: '父件编号', placeholder: '父件编号' },
  { value: 'parent_name', label: '父件名称', placeholder: '父件名称' },
  { value: 'relationship_id', label: '关系 ID', placeholder: '关系 ID' },
  { value: 'path', label: '路径 ID', placeholder: '路径 ID' },
  { value: 'find_num', label: 'Find #', placeholder: 'Find #' },
  { value: 'refdes', label: 'Refdes', placeholder: 'Refdes' },
  { value: 'quantity', label: '数量', placeholder: '数量' },
  { value: 'uom', label: '单位', placeholder: '单位' },
]
const whereUsedFilterField = ref('all')
const whereUsedFilter = ref('')
const whereUsedFilterPresetKey = ref('')
const whereUsedFilterPresetName = ref('')
const whereUsedFilterPresets = ref<FilterPreset[]>([])
const whereUsedFilterPresetImportText = ref('')
const whereUsedFilterPresetImportMode = ref<'merge' | 'replace'>('merge')
const whereUsedFilterPresetGroup = ref('')
const whereUsedFilterPresetGroupFilter = ref('all')
const whereUsedFilterPresetFileInput = ref<HTMLInputElement | null>(null)
const showWhereUsedPresetManager = ref(false)
const whereUsedPresetSelection = ref<string[]>([])
const whereUsedPresetBatchGroup = ref('')
const whereUsed = ref<any | null>(null)
const whereUsedLoading = ref(false)
const whereUsedError = ref('')
const whereUsedCollapsed = ref<Set<string>>(new Set())
const whereUsedSelectedEntryKeys = ref<Set<string>>(new Set())
const whereUsedFilterPlaceholder = computed(() => {
  const option = whereUsedFilterFieldOptions.find((entry) => entry.value === whereUsedFilterField.value)
  return option?.placeholder || '父件/路径/关系 ID'
})
const canSaveWhereUsedFilterPreset = computed(
  () => Boolean(whereUsedFilter.value.trim() && whereUsedFilterPresetName.value.trim())
)
const whereUsedFilterPresetGroups = computed(() => {
  const groups = new Set<string>()
  for (const preset of whereUsedFilterPresets.value) {
    const group = String(preset.group || '').trim()
    if (group) groups.add(group)
  }
  return Array.from(groups).sort((left, right) => left.localeCompare(right))
})
const whereUsedFilteredPresets = computed(() => {
  const filter = whereUsedFilterPresetGroupFilter.value
  if (filter === 'all') return whereUsedFilterPresets.value
  if (filter === 'ungrouped') {
    return whereUsedFilterPresets.value.filter((preset) => !String(preset.group || '').trim())
  }
  return whereUsedFilterPresets.value.filter(
    (preset) => String(preset.group || '').trim() === filter
  )
})
const whereUsedPresetSelectionCount = computed(() => whereUsedPresetSelection.value.length)

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
  const needle = normalizeFilterNeedle(whereUsedFilter.value)
  if (!needle) return whereUsedRows.value
  return whereUsedRows.value.filter((entry: any) => {
    const tokens = getWhereUsedFilterTokens(entry, whereUsedFilterField.value)
    return matchesFilter(needle, tokens)
  })
})

const whereUsedPathIdsList = computed(() => {
  const seen = new Set<string>()
  const list: string[] = []
  for (const entry of whereUsedFilteredRows.value) {
    const pathIds = formatWhereUsedEntryPathIds(entry)
    if (!pathIds || seen.has(pathIds)) continue
    seen.add(pathIds)
    list.push(pathIds)
  }
  return list
})

const whereUsedPathIdsCount = computed(() => whereUsedPathIdsList.value.length)

const whereUsedSelectedEntries = computed(() => {
  const selected = whereUsedSelectedEntryKeys.value
  if (!selected.size) return []
  return whereUsedRows.value.filter((entry: any) => {
    const key = resolveWhereUsedEntryKey(entry)
    return key && selected.has(key)
  })
})

const whereUsedSelectedParents = computed(() => {
  const seen = new Set<string>()
  const list: string[] = []
  for (const entry of whereUsedSelectedEntries.value) {
    const parentId = resolveWhereUsedParentId(entry)
    const fallback = parentId || getItemNumber(entry.parent)
    if (!fallback || seen.has(fallback)) continue
    seen.add(fallback)
    list.push(fallback)
  }
  return list
})

const whereUsedSelectedCount = computed(() => whereUsedSelectedEntryKeys.value.size)

const whereUsedTree = computed<WhereUsedTreeNode | null>(() => {
  const rows = whereUsedFilteredRows.value
  if (!rows.length) return null

  const firstPathNode = rows[0]?.pathNodes?.[0] || {}
  const fallbackRootId = whereUsed.value?.item_id || whereUsedItemId.value || ''
  const rootId = firstPathNode.id || fallbackRootId || firstPathNode.label || 'root'
  const rootLabel = firstPathNode.label || rootId
  const rootName = firstPathNode.name || ''
  const root: WhereUsedTreeNode = {
    id: rootId,
    label: rootLabel,
    name: rootName,
    children: [],
    entries: [],
  }

  const isRootNode = (node: any) => {
    const nodeId = node?.id || ''
    const nodeLabel = node?.label || ''
    return (nodeId && nodeId === root.id) || (nodeLabel && nodeLabel === root.label)
  }

  const getNodeId = (node: any) => {
    const nodeId = node?.id || node?.label || ''
    return nodeId || 'unknown'
  }

  const getNodeLabel = (node: any, id: string) => node?.label || node?.id || id

  for (const entry of rows) {
    const pathNodes = Array.isArray(entry.pathNodes) ? entry.pathNodes : []
    if (!pathNodes.length) {
      root.entries.push(entry)
      continue
    }
    let current = root
    const startIndex = isRootNode(pathNodes[0]) ? 1 : 0
    for (let i = startIndex; i < pathNodes.length; i += 1) {
      const info = pathNodes[i]
      const nodeId = getNodeId(info)
      const nodeLabel = getNodeLabel(info, nodeId)
      const nodeName = info?.name || ''
      let child = current.children.find((item) => item.id === nodeId && item.label === nodeLabel)
      if (!child) {
        child = { id: nodeId, label: nodeLabel, name: nodeName, children: [], entries: [] }
        current.children.push(child)
      }
      current = child
    }
    current.entries.push(entry)
  }

  return root
})

const whereUsedTreeRows = computed<WhereUsedTreeRow[]>(() => {
  const root = whereUsedTree.value
  if (!root) return []
  const rows: WhereUsedTreeRow[] = []
  const walk = (
    node: WhereUsedTreeNode,
    depth: number,
    path: string,
    parentKey: string | undefined,
    pathLabels: string[],
    pathIds: string[]
  ) => {
    const key = path ? `${path}/${node.id}` : node.id
    const labelToken = String(node.label || node.id || key)
    const idToken = String(node.id || node.label || key)
    const nextLabels = [...pathLabels, labelToken]
    const nextIds = [...pathIds, idToken]
    rows.push({
      key,
      parentKey,
      id: node.id,
      label: node.label,
      name: node.name,
      depth,
      hasChildren: node.children.length > 0,
      entries: node.entries,
      entryCount: node.entries.length,
      pathLabels: nextLabels,
      pathIds: nextIds,
    })
    for (const child of node.children) {
      walk(child, depth + 1, key, key, nextLabels, nextIds)
    }
  }
  walk(root, 0, '', undefined, [], [])
  return rows
})

const whereUsedTreeVisibleRows = computed<WhereUsedTreeRow[]>(() => {
  const rows = whereUsedTreeRows.value
  if (!rows.length) return []
  const parentMap = new Map(rows.map((row) => [row.key, row.parentKey || '']))
  const collapsed = whereUsedCollapsed.value
  const isHidden = (row: WhereUsedTreeRow) => {
    let parentKey = row.parentKey
    while (parentKey) {
      if (collapsed.has(parentKey)) return true
      parentKey = parentMap.get(parentKey) || ''
    }
    return false
  }
  return rows.filter((row) => !isHidden(row))
})

const whereUsedHasTree = computed(() => whereUsedTreeRows.value.some((row) => row.hasChildren))

const whereUsedTreePathIdsList = computed(() => {
  const seen = new Set<string>()
  const list: string[] = []
  for (const row of whereUsedTreeVisibleRows.value) {
    const pathIds = formatWhereUsedPathIds(row)
    if (!pathIds || seen.has(pathIds)) continue
    seen.add(pathIds)
    list.push(pathIds)
  }
  return list
})

const whereUsedTreePathIdsCount = computed(() => whereUsedTreePathIdsList.value.length)

const compareLeftId = ref('')
const compareRightId = ref('')
const compareLeftQuickPick = ref('')
const compareRightQuickPick = ref('')
const compareMode = ref('')
const compareMaxLevels = ref(DEFAULT_COMPARE_MAX_LEVELS)
const compareLineKey = ref(DEFAULT_COMPARE_LINE_KEY)
const compareIncludeChildFields = ref(true)
const compareIncludeSubstitutes = ref(false)
const compareIncludeEffectivity = ref(false)
const compareSyncEnabled = ref(true)
const compareEffectiveAt = ref('')
const compareFilter = ref('')
const compareRelationshipProps = ref(DEFAULT_COMPARE_REL_PROPS)
const bomCompare = ref<any | null>(null)
const compareLoading = ref(false)
const compareError = ref('')
const compareSchema = ref<CompareSchemaPayload | null>(null)
const compareSchemaLoading = ref(false)
const compareSchemaError = ref('')
type CompareSelectionKind = 'added' | 'removed' | 'changed'
type CompareSelection = {
  kind: CompareSelectionKind
  key: string
  entry: Record<string, any>
}
const compareSelected = ref<CompareSelection | null>(null)
const productFieldCatalog = [
  {
    key: 'name',
    label: '名称',
    source: 'name / item_name / title / properties.name / properties.item_name / properties.title / properties.label',
    fallback: 'id',
  },
  {
    key: 'partNumber',
    label: '料号',
    source: 'partNumber / item_number / itemNumber / part_number / number / code / properties.item_number',
    fallback: 'properties.internal_reference',
  },
  {
    key: 'revision',
    label: '版本',
    source: 'revision / version / version_label / properties.revision / properties.version / properties.version_label',
    fallback: '-',
  },
  {
    key: 'status',
    label: '状态',
    source: 'status / state / current_state / properties.state / properties.current_state / properties.status',
    fallback: '-',
  },
  {
    key: 'itemType',
    label: '类型',
    source: 'itemType / item_type_id / item_type / type / properties.item_type / properties.itemType / properties.item_type_id',
    fallback: 'Part',
  },
  {
    key: 'createdAt',
    label: '创建时间',
    source: 'createdAt / created_at / created_on / properties.created_at / properties.created_on / properties.create_date',
    fallback: 'search hit created_at',
  },
  {
    key: 'updatedAt',
    label: '更新时间',
    source: 'updatedAt / updated_at / modified_on / properties.updated_at / properties.modified_on',
    fallback: 'search hit updated_at',
  },
]
const documentFieldCatalog = [
  {
    key: 'file_id',
    label: 'File ID',
    source: 'id / file_id / metadata.file_id',
    fallback: 'id',
  },
  {
    key: 'name',
    label: '名称',
    source: 'name / metadata.filename / filename',
    fallback: 'id',
  },
  {
    key: 'document_type',
    label: '类型',
    source: 'document_type / metadata.document_type / file_type',
    fallback: 'other',
  },
  {
    key: 'engineering_revision',
    label: '版本',
    source: 'engineering_revision / document_version / metadata.document_version',
    fallback: '-',
  },
  {
    key: 'author',
    label: '作者',
    source: 'author / metadata.author',
    fallback: '-',
  },
  {
    key: 'source_system',
    label: '来源系统',
    source: 'source_system / metadata.source_system',
    fallback: '-',
  },
  {
    key: 'source_version',
    label: '来源版本',
    source: 'source_version / metadata.source_version',
    fallback: '-',
  },
  {
    key: 'file_size',
    label: '大小',
    source: 'file_size / metadata.file_size',
    fallback: '0',
  },
  {
    key: 'mime_type',
    label: 'MIME',
    source: 'mime_type / metadata.mime_type / file_type',
    fallback: '-',
  },
  {
    key: 'preview_url',
    label: '预览链接',
    source: 'preview_url / metadata.preview_url',
    fallback: '-',
  },
  {
    key: 'download_url',
    label: '下载链接',
    source: 'download_url / metadata.download_url',
    fallback: '-',
  },
  {
    key: 'engineering_state',
    label: '文档角色',
    source: 'engineering_state / file_role / metadata.file_role',
    fallback: 'unknown',
  },
  {
    key: 'created_at',
    label: '创建时间',
    source: 'created_at / metadata.created_at',
    fallback: '-',
  },
  {
    key: 'updated_at',
    label: '更新时间',
    source: 'updated_at / metadata.updated_at / metadata.created_at',
    fallback: '-',
  },
]
const approvalFieldCatalog = [
  {
    key: 'id',
    label: '审批 ID',
    source: 'id / eco.id',
    fallback: '-',
  },
  {
    key: 'title',
    label: '标题',
    source: 'title / eco.name',
    fallback: 'id',
  },
  {
    key: 'status',
    label: '状态',
    source: 'status / eco.state',
    fallback: 'pending',
  },
  {
    key: 'request_type',
    label: '类型',
    source: 'request_type / eco.eco_type',
    fallback: 'eco',
  },
  {
    key: 'requester_name',
    label: '发起人',
    source: 'requester_name / created_by_name / created_by_id',
    fallback: 'unknown',
  },
  {
    key: 'requester_id',
    label: '发起人 ID',
    source: 'requester_id / created_by_id',
    fallback: '-',
  },
  {
    key: 'created_at',
    label: '创建时间',
    source: 'created_at / updated_at',
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
    source: 'product_number / product.partNumber / product.code',
    fallback: '-',
  },
  {
    key: 'product_name',
    label: '产品名称',
    source: 'product_name / product.name',
    fallback: '-',
  },
]
const compareFieldLabels: Record<string, string> = {
  quantity: '数量',
  uom: '单位',
  find_num: 'Find #',
  refdes: 'Refdes',
  effectivity_from: '生效起',
  effectivity_to: '生效止',
  effectivities: '生效性',
  substitutes: '替代件',
}
const defaultCompareFieldCatalog = [
  {
    key: 'quantity',
    label: compareFieldLabels.quantity,
    source: 'relationship.properties.quantity',
    severity: 'major',
    normalized: 'float',
  },
  {
    key: 'uom',
    label: compareFieldLabels.uom,
    source: 'relationship.properties.uom',
    severity: 'major',
    normalized: 'uppercase',
  },
  {
    key: 'find_num',
    label: compareFieldLabels.find_num,
    source: 'relationship.properties.find_num',
    severity: 'minor',
    normalized: 'trim',
  },
  {
    key: 'refdes',
    label: compareFieldLabels.refdes,
    source: 'relationship.properties.refdes',
    severity: 'minor',
    normalized: 'list/uppercase',
  },
  {
    key: 'effectivity_from',
    label: compareFieldLabels.effectivity_from,
    source: 'relationship.properties.effectivity_from',
    severity: 'major',
    normalized: 'iso datetime',
  },
  {
    key: 'effectivity_to',
    label: compareFieldLabels.effectivity_to,
    source: 'relationship.properties.effectivity_to',
    severity: 'major',
    normalized: 'iso datetime',
  },
  {
    key: 'effectivities',
    label: compareFieldLabels.effectivities,
    source: 'effectivity records (includeEffectivity)',
    severity: 'major',
    normalized: 'sorted tuples',
  },
  {
    key: 'substitutes',
    label: compareFieldLabels.substitutes,
    source: 'substitutes (includeSubstitutes)',
    severity: 'minor',
    normalized: 'sorted tuples',
  },
]
const compareFieldCatalog = computed(() => {
  const fields = compareSchema.value?.line_fields || []
  if (!fields.length) return defaultCompareFieldCatalog
  return fields.map((entry) => ({
    key: entry.field,
    label: compareFieldLabels[entry.field] || entry.field,
    source: entry.description || '-',
    severity: entry.severity || 'info',
    normalized: entry.normalized || '-',
  }))
})
const compareFieldLabelMap = computed(
  () => new Map(compareFieldCatalog.value.map((entry) => [entry.key, entry.label]))
)
const compareFieldMetaMap = computed(
  () => new Map(compareFieldCatalog.value.map((entry) => [entry.key, entry]))
)
const compareSelectedEntry = computed(() => compareSelected.value?.entry || null)
const compareSelectedMeta = computed(() => {
  const selection = compareSelected.value
  if (!selection) return null
  const { entry, kind } = selection
  const parent = getCompareParent(entry)
  const child = getCompareChild(entry)
  const parentNumber = getItemNumber(parent)
  const parentName = getItemName(parent)
  const parentLabel = parentNumber !== '-' ? parentNumber : parentName !== '-' ? parentName : ''
  const childNumber = getItemNumber(child)
  const childName = getItemName(child)
  const childLabel = childNumber !== '-' ? childNumber : childName !== '-' ? childName : ''
  const pathLabel = [parentLabel, childLabel].filter(Boolean).join(' → ')
  return {
    kindLabel: kind === 'added' ? '新增' : kind === 'removed' ? '删除' : '变更',
    tagClass: `compare-kind-${kind}`,
    lineKey: entry?.line_key || '',
    relationshipId: entry?.relationship_id || '',
    pathLabel,
  }
})
const compareDetailRows = computed(() => {
  const selection = compareSelected.value
  if (!selection) return []
  const { entry, kind } = selection
  const changeMap = new Map<string, Record<string, any>>()
  const changes = Array.isArray(entry?.changes) ? entry.changes : []
  for (const change of changes) {
    if (change?.field) {
      changeMap.set(change.field, change)
    }
  }
  return compareFieldCatalog.value.map((field) => {
    const change = changeMap.get(field.key)
    const left = resolveCompareFieldValue(entry, kind, 'left', field.key)
    const right = resolveCompareFieldValue(entry, kind, 'right', field.key)
    const normalizedLeft = resolveCompareNormalizedValue(entry, kind, 'left', field.key, change)
    const normalizedRight = resolveCompareNormalizedValue(entry, kind, 'right', field.key, change)
    return {
      key: field.key,
      label: field.label,
      description: field.source && field.source !== '-' ? field.source : '',
      left,
      right,
      normalizedLeft,
      normalizedRight,
      severity: change?.severity || '',
      changed: Boolean(change),
    }
  })
})
const compareLineKeyOptions = computed(() => {
  const options = compareSchema.value?.line_key_options
  return options && options.length ? options : DEFAULT_COMPARE_LINE_KEYS
})
const compareModeOptions = computed(() => compareSchema.value?.compare_modes || [])

const bomLineId = ref('')
const bomLineQuickPick = ref('')
const substitutes = ref<any | null>(null)
const substitutesLoading = ref(false)
const substitutesError = ref('')
const substitutesFilter = ref('')
const substituteItemId = ref('')
const substituteQuickPick = ref('')
const substituteRank = ref('')
const substituteNote = ref('')
const substitutesActionStatus = ref('')
const substitutesActionError = ref('')
const substitutesMutating = ref(false)
const substitutesDeletingId = ref<string | null>(null)
const bomSelectedLineIds = ref<Set<string>>(new Set())
const bomFilterFieldOptions = [
  { value: 'all', label: '全部', placeholder: '编号/名称/行 ID' },
  { value: 'component', label: '组件编码/ID', placeholder: '组件编码/ID' },
  { value: 'name', label: '组件名称', placeholder: '组件名称' },
  { value: 'line_id', label: 'BOM 行 ID', placeholder: 'BOM 行 ID' },
  { value: 'parent_id', label: '父件 ID', placeholder: '父件 ID' },
  { value: 'find_num', label: 'Find #', placeholder: 'Find #' },
  { value: 'refdes', label: 'Refdes', placeholder: 'Refdes' },
  { value: 'path', label: '路径 ID', placeholder: '路径 ID' },
  { value: 'quantity', label: '数量', placeholder: '数量' },
  { value: 'unit', label: '单位', placeholder: '单位' },
]
const bomFilterField = ref('all')
const bomFilter = ref('')
const bomFilterPresetKey = ref('')
const bomFilterPresetName = ref('')
const bomFilterPresets = ref<FilterPreset[]>([])
const bomFilterPresetImportText = ref('')
const bomFilterPresetImportMode = ref<'merge' | 'replace'>('merge')
const bomFilterPresetGroup = ref('')
const bomFilterPresetGroupFilter = ref('all')
const bomFilterPresetFileInput = ref<HTMLInputElement | null>(null)
const showBomPresetManager = ref(false)
const bomPresetSelection = ref<string[]>([])
const bomPresetBatchGroup = ref('')
const bomFilterPlaceholder = computed(() => {
  const option = bomFilterFieldOptions.find((entry) => entry.value === bomFilterField.value)
  return option?.placeholder || '编号/名称/行 ID'
})
const canSaveBomFilterPreset = computed(
  () => Boolean(bomFilter.value.trim() && bomFilterPresetName.value.trim())
)
const bomFilterPresetGroups = computed(() => {
  const groups = new Set<string>()
  for (const preset of bomFilterPresets.value) {
    const group = String(preset.group || '').trim()
    if (group) groups.add(group)
  }
  return Array.from(groups).sort((left, right) => left.localeCompare(right))
})
const bomFilteredPresets = computed(() => {
  const filter = bomFilterPresetGroupFilter.value
  if (filter === 'all') return bomFilterPresets.value
  if (filter === 'ungrouped') {
    return bomFilterPresets.value.filter((preset) => !String(preset.group || '').trim())
  }
  return bomFilterPresets.value.filter((preset) => String(preset.group || '').trim() === filter)
})
const bomPresetSelectionCount = computed(() => bomPresetSelection.value.length)

function normalizeFilterNeedle(value: string): string {
  return value.trim().toLowerCase()
}

function matchesFilter(needle: string, tokens: unknown[]): boolean {
  if (!needle) return true
  return tokens.some((token) => String(token || '').toLowerCase().includes(needle))
}

function getBomFilterTokens(item: Record<string, any>, field: string): unknown[] {
  const lineId = resolveBomLineId(item)
  const tokens = {
    component: [item.component_code, item.component_id],
    name: [item.component_name],
    line_id: [lineId, item.id],
    parent_id: [item.parent_item_id],
    find_num: [formatBomFindNum(item)],
    refdes: [formatBomRefdes(item)],
    path: [formatBomTablePathIds(item)],
    quantity: [item.quantity],
    unit: [item.unit],
  }
  if (field === 'all') {
    return [
      ...tokens.component,
      ...tokens.name,
      ...tokens.line_id,
      ...tokens.parent_id,
      ...tokens.find_num,
      ...tokens.refdes,
      ...tokens.path,
      ...tokens.quantity,
      ...tokens.unit,
    ]
  }
  return tokens[field as keyof typeof tokens] || []
}

function getBomTreeFilterTokens(row: BomTreeRow, field: string): unknown[] {
  const line = row.line || {}
  const lineId = row.lineId || (row.line ? resolveBomLineId(row.line) : '')
  const tokens = {
    component: [row.label, row.componentId],
    name: [row.name],
    line_id: [lineId],
    parent_id: [line?.parent_item_id ?? line?.parentItemId],
    find_num: [row.line ? formatBomFindNum(row.line) : ''],
    refdes: [row.line ? formatBomRefdes(row.line) : ''],
    path: [formatBomPathIds(row)],
    quantity: [row.line?.quantity],
    unit: [row.line?.unit ?? row.line?.uom],
  }
  if (field === 'all') {
    return [
      ...tokens.component,
      ...tokens.name,
      ...tokens.line_id,
      ...tokens.parent_id,
      ...tokens.find_num,
      ...tokens.refdes,
      ...tokens.path,
      ...tokens.quantity,
      ...tokens.unit,
    ]
  }
  return tokens[field as keyof typeof tokens] || []
}

function getWhereUsedFilterTokens(entry: Record<string, any>, field: string): unknown[] {
  const tokens = {
    parent_number: [getItemNumber(entry.parent)],
    parent_name: [getItemName(entry.parent)],
    relationship_id: [entry?.relationship?.id],
    path: [entry?.pathLabel, formatWhereUsedEntryPathIds(entry)],
    find_num: [getWhereUsedLineValue(entry, 'find_num')],
    refdes: [getWhereUsedRefdes(entry)],
    quantity: [getWhereUsedLineValue(entry, 'quantity')],
    uom: [getWhereUsedLineValue(entry, 'uom')],
  }
  if (field === 'all') {
    return [
      ...tokens.parent_number,
      ...tokens.parent_name,
      ...tokens.relationship_id,
      ...tokens.path,
      ...tokens.find_num,
      ...tokens.refdes,
      ...tokens.quantity,
      ...tokens.uom,
    ]
  }
  return tokens[field as keyof typeof tokens] || []
}

const bomFilteredItems = computed(() => {
  const needle = normalizeFilterNeedle(bomFilter.value)
  if (!needle) return bomItems.value
  return bomItems.value.filter((item: any) => {
    const tokens = getBomFilterTokens(item, bomFilterField.value)
    return matchesFilter(needle, tokens)
  })
})

const bomFilteredLineIds = computed(() => {
  const ids = new Set<string>()
  for (const item of bomFilteredItems.value) {
    const lineId = resolveBomLineId(item)
    if (lineId) ids.add(lineId)
  }
  return ids
})

const bomSelectedItems = computed(() => {
  const selected = bomSelectedLineIds.value
  if (!selected.size) return []
  return bomItems.value.filter((item: any) => {
    const lineId = resolveBomLineId(item)
    return lineId && selected.has(lineId)
  })
})

const bomSelectedChildIds = computed(() => {
  const seen = new Set<string>()
  const list: string[] = []
  for (const item of bomSelectedItems.value) {
    const target = resolveBomChildId(item) || resolveBomChildNumber(item)
    if (!target || seen.has(target)) continue
    seen.add(target)
    list.push(target)
  }
  return list
})

function buildQuickPickLabel(source: string, main: string, name: string, id: string): string {
  const mainLabel = main && main !== '-' ? main : id
  const nameLabel = name && name !== '-' ? name : ''
  const base = [mainLabel, nameLabel].filter(Boolean).join(' · ')
  const suffix = id && id !== mainLabel ? ` (${id})` : ''
  return `${source}: ${base || id}${suffix}`
}

function mergeQuickPickOptions(options: QuickPickOption[]): QuickPickOption[] {
  const seen = new Set<string>()
  const merged: QuickPickOption[] = []
  for (const option of options) {
    if (!option?.value || seen.has(option.value)) continue
    seen.add(option.value)
    merged.push(option)
  }
  return merged
}

const searchResultOptions = computed<QuickPickOption[]>(() => {
  const options: QuickPickOption[] = []
  const seen = new Set<string>()
  for (const item of searchResults.value) {
    const { id } = resolveItemKey(item)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const number = getItemNumber(item)
    const name = getItemName(item)
    options.push({
      key: `search:${id}`,
      value: id,
      label: buildQuickPickLabel('搜索', number, name, id),
    })
  }
  return options
})

const bomChildOptions = computed<QuickPickOption[]>(() => {
  const options: QuickPickOption[] = []
  const seen = new Set<string>()
  const source = bomFilteredItems.value.length ? bomFilteredItems.value : bomItems.value
  for (const item of source) {
    const childId = resolveBomChildId(item)
    if (!childId || seen.has(childId)) continue
    seen.add(childId)
    const code = resolveBomChildNumber(item) || childId
    const name = String(item?.component_name || '')
    options.push({
      key: `bom-child:${childId}`,
      value: childId,
      label: buildQuickPickLabel('BOM', code, name, childId),
    })
  }
  return options
})

const bomLineOptions = computed<QuickPickOption[]>(() => {
  const options: QuickPickOption[] = []
  const seen = new Set<string>()
  const source = bomFilteredItems.value.length ? bomFilteredItems.value : bomItems.value
  for (const item of source) {
    const lineId = resolveBomLineId(item)
    if (!lineId || seen.has(lineId)) continue
    seen.add(lineId)
    const childId = resolveBomChildId(item)
    const code = resolveBomChildNumber(item) || childId || lineId
    const name = String(item?.component_name || '')
    options.push({
      key: `bom-line:${lineId}`,
      value: lineId,
      label: buildQuickPickLabel('BOM 行', code, name, lineId),
    })
  }
  return options
})

const whereUsedQuickOptions = computed(() =>
  mergeQuickPickOptions([...bomChildOptions.value, ...searchResultOptions.value])
)
const substituteQuickOptions = computed(() =>
  mergeQuickPickOptions([...bomChildOptions.value, ...searchResultOptions.value])
)
const compareQuickOptions = computed(() => searchResultOptions.value)

const bomSelectedCount = computed(() => bomSelectedLineIds.value.size)

const bomTablePathIdsList = computed(() => {
  const seen = new Set<string>()
  const list: string[] = []
  for (const item of bomFilteredItems.value) {
    const pathIds = formatBomTablePathIds(item)
    if (!pathIds || seen.has(pathIds)) continue
    seen.add(pathIds)
    list.push(pathIds)
  }
  return list
})

const bomTablePathIdsCount = computed(() => bomTablePathIdsList.value.length)

const bomTreeRows = computed<BomTreeRow[]>(() => {
  const items = bomItems.value
  if (!items.length) return []

  const parentMap = new Map<string, any[]>()
  for (const line of items) {
    const parentId = String(line?.parent_item_id || '')
    if (!parentMap.has(parentId)) {
      parentMap.set(parentId, [])
    }
    parentMap.get(parentId)?.push(line)
  }

  const rows: BomTreeRow[] = []
  const rootId = productId.value || productView.value.id || ''
  const rootLabel =
    productView.value.partNumber && productView.value.partNumber !== '-' ? productView.value.partNumber : rootId || 'root'
  const rootName = productView.value.name || ''
  const rootKey = rootId || rootLabel || 'root'
  const rootPathLabel = String(rootLabel || rootId || rootKey)
  const rootPathId = String(rootId || rootLabel || rootKey)

  const rootRow: BomTreeRow = {
    key: rootKey,
    parentKey: undefined,
    depth: 0,
    line: undefined,
    label: rootLabel,
    name: rootName,
    componentId: rootId,
    lineId: '',
    hasChildren: false,
    pathLabels: [rootPathLabel],
    pathIds: [rootPathId],
  }
  rows.push(rootRow)

  const sortLines = (lines: any[]) =>
    [...lines].sort((a, b) => {
      const aKey = String(a?.find_num ?? a?.findNum ?? a?.component_code ?? a?.component_id ?? a?.id ?? '')
      const bKey = String(b?.find_num ?? b?.findNum ?? b?.component_code ?? b?.component_id ?? b?.id ?? '')
      return aKey.localeCompare(bKey)
    })

  const seen = new Set<string>()
  const rootLines = [
    ...(parentMap.get(rootId) || []),
    ...(parentMap.get('') || []),
  ].filter((line) => {
    const key = resolveBomLineId(line) || `${resolveBomChildId(line)}-${resolveBomChildNumber(line)}`
    if (!key) return true
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  let autoIndex = 0
  const makeLineKey = (line: any) => {
    const base = resolveBomLineId(line) || resolveBomChildId(line) || resolveBomChildNumber(line)
    if (base) return base
    autoIndex += 1
    return `line-${autoIndex}`
  }

  const walk = (
    line: any,
    depth: number,
    parentKey: string,
    path: Set<string>,
    pathLabels: string[],
    pathIds: string[]
  ) => {
    const componentId = resolveBomChildId(line)
    const lineKey = makeLineKey(line)
    const key = `${parentKey}/${lineKey}`
    const label = line?.component_code || line?.component_id || componentId || resolveBomChildNumber(line) || lineKey
    const name = line?.component_name || ''
    const lineId = resolveBomLineId(line)
    const labelToken = String(label || componentId || lineKey)
    const idToken = String(componentId || label || lineKey)
    const nextLabels = [...pathLabels, labelToken]
    const nextIds = [...pathIds, idToken]
    const nextPath = new Set(path)
    const hasCycle = componentId ? nextPath.has(componentId) : false
    if (componentId && !hasCycle) {
      nextPath.add(componentId)
    }
    const children = componentId && !hasCycle ? parentMap.get(componentId) || [] : []
    rows.push({
      key,
      parentKey,
      depth,
      line,
      label,
      name,
      componentId,
      lineId,
      hasChildren: children.length > 0,
      pathLabels: nextLabels,
      pathIds: nextIds,
    })
    for (const child of sortLines(children)) {
      walk(child, depth + 1, key, nextPath, nextLabels, nextIds)
    }
  }

  for (const line of sortLines(rootLines)) {
    walk(line, 1, rootKey, new Set(rootId ? [rootId] : []), rootRow.pathLabels, rootRow.pathIds)
  }
  rootRow.hasChildren = rows.length > 1
  return rows
})

const bomPathRowMaps = computed(() => {
  const rows = bomTreeRows.value
  const byLineId = new Map<string, BomTreeRow>()
  const byPair = new Map<string, BomTreeRow>()
  const rowMap = new Map(rows.map((row) => [row.key, row]))
  for (const row of rows) {
    if (!row.line) continue
    const lineId = resolveBomLineId(row.line)
    if (lineId) {
      byLineId.set(lineId, row)
    }
    const parentRow = row.parentKey ? rowMap.get(row.parentKey) : undefined
    const parentId =
      row.line?.parent_item_id ??
      row.line?.parentItemId ??
      parentRow?.componentId ??
      ''
    const childId = resolveBomChildId(row.line) || row.componentId
    if (parentId || childId) {
      byPair.set(`${parentId}::${childId}`, row)
    }
  }
  return { byLineId, byPair }
})

const bomTreeFilteredKeys = computed(() => {
  const rows = bomTreeRows.value
  if (!rows.length) return new Set<string>()
  const needle = normalizeFilterNeedle(bomFilter.value)
  if (!needle) return new Set(rows.map((row) => row.key))

  const matches = new Set<string>()
  for (const row of rows) {
    const tokens = getBomTreeFilterTokens(row, bomFilterField.value)
    if (matchesFilter(needle, tokens)) {
      matches.add(row.key)
    }
  }

  const parentMap = new Map(rows.map((row) => [row.key, row.parentKey || '']))
  const included = new Set<string>()
  for (const key of matches) {
    let current = key
    while (current) {
      included.add(current)
      current = parentMap.get(current) || ''
    }
  }
  return included
})

const bomTreeVisibleRows = computed<BomTreeRow[]>(() => {
  const rows = bomTreeRows.value
  if (!rows.length) return []
  const included = bomTreeFilteredKeys.value
  const parentMap = new Map(rows.map((row) => [row.key, row.parentKey || '']))
  const collapsed = bomCollapsed.value
  const isHidden = (row: BomTreeRow) => {
    if (!included.has(row.key)) return true
    let parentKey = row.parentKey
    while (parentKey) {
      if (collapsed.has(parentKey)) return true
      parentKey = parentMap.get(parentKey) || ''
    }
    return false
  }
  return rows.filter((row) => !isHidden(row))
})

const bomTreeVisibleCount = computed(() => bomTreeVisibleRows.value.filter((row) => row.line).length)

const bomTreePathIdsList = computed(() => {
  const seen = new Set<string>()
  const list: string[] = []
  for (const row of bomTreeVisibleRows.value) {
    if (!row.line) continue
    const pathIds = formatBomPathIds(row)
    if (!pathIds || seen.has(pathIds)) continue
    seen.add(pathIds)
    list.push(pathIds)
  }
  return list
})

const bomTreePathIdsCount = computed(() => bomTreePathIdsList.value.length)

const bomTreeFilteredCount = computed(() => {
  const included = bomTreeFilteredKeys.value
  return bomTreeRows.value.filter((row) => row.line && included.has(row.key)).length
})

const bomHasTree = computed(() => bomTreeRows.value.some((row) => row.hasChildren))

const bomDisplayCount = computed(() =>
  bomView.value === 'tree' ? bomTreeVisibleCount.value : bomFilteredItems.value.length
)

const bomExportCount = computed(() =>
  bomView.value === 'tree' ? bomTreeFilteredCount.value : bomFilteredItems.value.length
)

const documentsFiltered = computed(() => {
  const needle = documentFilter.value.trim().toLowerCase()
  if (!needle) return documents.value
  return documents.value.filter((doc: any) => {
    const tokens = [
      getDocumentName(doc),
      getDocumentId(doc),
      getDocumentType(doc),
      getDocumentRevision(doc),
      getDocumentRole(doc),
      getDocumentAuthor(doc),
      getDocumentSourceSystem(doc),
      getDocumentSourceVersion(doc),
      getDocumentMime(doc),
      doc.id,
      doc.file_id,
    ]
    return tokens.some((token) => String(token || '').toLowerCase().includes(needle))
  })
})

const documentSortConfig: SortConfig = {
  name: { type: 'string', accessor: (doc: any) => getDocumentName(doc) },
  type: { type: 'string', accessor: (doc: any) => getDocumentType(doc) },
  revision: { type: 'string', accessor: (doc: any) => getDocumentRevision(doc) },
  role: { type: 'string', accessor: (doc: any) => getDocumentRole(doc) },
  mime: { type: 'string', accessor: (doc: any) => getDocumentMime(doc) },
  size: { type: 'number', accessor: (doc: any) => getDocumentSize(doc) ?? 0 },
  created: { type: 'date', accessor: (doc: any) => getDocumentCreatedAt(doc) },
  updated: { type: 'date', accessor: (doc: any) => getDocumentUpdatedAt(doc) },
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
      getApprovalTitle(entry),
      getApprovalRequester(entry),
      getApprovalRequesterId(entry),
      getApprovalProductName(entry),
      getApprovalProductNumber(entry),
      getApprovalProductId(entry),
      entry.product_id,
      entry.id,
    ]
    return tokens.some((token) => String(token || '').toLowerCase().includes(needle))
  })
})

const approvalSortConfig: SortConfig = {
  created: { type: 'date', accessor: (entry: any) => getApprovalCreatedAt(entry) },
  title: { type: 'string', accessor: (entry: any) => getApprovalTitle(entry) },
  status: { type: 'string', accessor: (entry: any) => getApprovalStatus(entry) },
  requester: { type: 'string', accessor: (entry: any) => getApprovalRequester(entry) },
  product: { type: 'string', accessor: (entry: any) => getApprovalProductNumber(entry) },
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
      getSubstituteNumber(entry),
      getSubstituteName(entry),
      getSubstituteStatus(entry),
      getItemNumber(entry.part),
      getItemName(entry.part),
      formatSubstituteRank(entry),
      formatSubstituteNote(entry),
      entry?.id,
      entry?.relationship?.id,
    ]
    return tokens.some((token) => String(token || '').toLowerCase().includes(needle))
  })
})

const bomLineContext = computed(() => {
  const lineId = bomLineId.value.trim()
  if (!lineId) return null
  return bomItems.value.find((item) => String(item.id) === lineId) || null
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
const BOM_COLLAPSE_STORAGE_KEY = 'plm_bom_tree_collapsed'
const BOM_FILTER_PRESETS_STORAGE_KEY = 'plm_bom_filter_presets'
const WHERE_USED_FILTER_PRESETS_STORAGE_KEY = 'plm_where_used_filter_presets'
const deepLinkPanelOptions = [
  { key: 'search', label: '搜索' },
  { key: 'product', label: '产品' },
  { key: 'documents', label: '文档' },
  { key: 'approvals', label: '审批' },
  { key: 'cad', label: 'CAD 元数据' },
  { key: 'where-used', label: 'Where-Used' },
  { key: 'compare', label: 'BOM 对比' },
  { key: 'substitutes', label: '替代件' },
]
const builtInDeepLinkPresets: DeepLinkPreset[] = [
  { key: 'cad-meta', label: 'CAD 元数据', panels: ['cad'] },
  { key: 'product-where-used', label: '产品 + Where-Used', panels: ['product', 'where-used'] },
  { key: 'product-bom-tree', label: '产品 + BOM 树形', panels: ['product'], params: { bomView: 'tree' } },
  { key: 'compare-substitutes', label: 'BOM 对比 + 替代件', panels: ['compare', 'substitutes'] },
  { key: 'docs-approvals', label: '文档 + 审批', panels: ['documents', 'approvals'] },
  { key: 'full-bom', label: '产品 + BOM 全链路', panels: ['product', 'where-used', 'compare', 'substitutes'] },
]
const deepLinkPresets = computed<DeepLinkPreset[]>(() => [
  ...builtInDeepLinkPresets,
  ...customDeepLinkPresets.value,
])

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
  bomDepth.value = DEFAULT_BOM_DEPTH
  bomEffectiveAt.value = ''
  bomFilter.value = ''
  bomFilterField.value = 'all'
  bomFilterPresetKey.value = ''
  bomFilterPresetName.value = ''
  bomFilterPresetImportText.value = ''
  bomFilterPresetImportMode.value = 'merge'
  bomFilterPresetGroup.value = ''
  bomFilterPresetGroupFilter.value = 'all'
  showBomPresetManager.value = false
  bomPresetSelection.value = []
  bomPresetBatchGroup.value = ''
  bomView.value = 'table'
  bomCollapsed.value = new Set()
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
  whereUsedView.value = 'table'
  whereUsed.value = null
  whereUsedError.value = ''
  whereUsedFilterField.value = 'all'
  compareLeftId.value = ''
  compareRightId.value = ''
  compareMode.value = ''
  compareMaxLevels.value = DEFAULT_COMPARE_MAX_LEVELS
  compareLineKey.value = DEFAULT_COMPARE_LINE_KEY
  compareIncludeChildFields.value = true
  compareIncludeSubstitutes.value = false
  compareIncludeEffectivity.value = false
  compareSyncEnabled.value = true
  compareEffectiveAt.value = ''
  compareFilter.value = ''
  compareRelationshipProps.value = DEFAULT_COMPARE_REL_PROPS
  bomCompare.value = null
  compareError.value = ''
  compareSchemaError.value = ''
  compareSchemaLoading.value = false
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
  substitutesDeletingId.value = null
  whereUsedFilter.value = ''
  whereUsedFilterPresetKey.value = ''
  whereUsedFilterPresetName.value = ''
  whereUsedFilterPresetImportText.value = ''
  whereUsedFilterPresetImportMode.value = 'merge'
  whereUsedFilterPresetGroup.value = ''
  whereUsedFilterPresetGroupFilter.value = 'all'
  showWhereUsedPresetManager.value = false
  whereUsedPresetSelection.value = []
  whereUsedPresetBatchGroup.value = ''
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
    whereUsedFilterField: '',
    compareLeftId: '',
    compareRightId: '',
    compareMode: '',
    compareLineKey: '',
    compareMaxLevels: undefined,
    compareIncludeChildFields: undefined,
    compareIncludeSubstitutes: undefined,
    compareIncludeEffectivity: undefined,
    compareSync: undefined,
    compareEffectiveAt: '',
    compareRelationshipProps: '',
    compareFilter: '',
    bomDepth: undefined,
    bomEffectiveAt: '',
    bomFilter: '',
    bomFilterField: '',
    bomView: '',
    bomCollapsed: '',
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
  productItemNumber.value = item.partNumber || item.item_number || item.itemNumber || item.code || ''
  if (item.itemType) {
    itemType.value = item.itemType
  }
  await loadProduct()
}

function applyCompareFromSearch(item: any, side: 'left' | 'right') {
  const targetId = item?.id || item?.item_id || item?.itemId
  const targetNumber = item?.partNumber || item?.item_number || item?.itemNumber || item?.code || ''
  if (!targetId && !targetNumber) {
    setDeepLinkMessage('搜索结果缺少 ID', true)
    return
  }
  if (side === 'left') {
    compareLeftId.value = targetId ? String(targetId) : String(targetNumber)
  } else {
    compareRightId.value = targetId ? String(targetId) : String(targetNumber)
  }
  scheduleQuerySync({
    compareLeftId: compareLeftId.value || undefined,
    compareRightId: compareRightId.value || undefined,
  })
  setDeepLinkMessage(`已设为对比${side === 'left' ? '左' : '右'}侧：${targetId || targetNumber}`)
}

async function copySearchValue(item: any, kind: 'id' | 'number') {
  const idValue = item?.id || item?.item_id || item?.itemId
  const numberValue = item?.partNumber || item?.item_number || item?.itemNumber || item?.code || ''
  const value = kind === 'id' ? idValue : numberValue
  if (!value) {
    setDeepLinkMessage(kind === 'id' ? '缺少 ID' : '缺少料号', true)
    return
  }
  const ok = await copyToClipboard(String(value))
  if (!ok) {
    setDeepLinkMessage('复制失败，请手动复制', true)
    return
  }
  setDeepLinkMessage(`已复制${kind === 'id' ? ' ID' : '料号'}：${value}`)
}

type ProductCopyKind = 'id' | 'number' | 'revision' | 'type' | 'status'

function normalizeProductCopyValue(value?: string): string {
  if (!value) return ''
  if (value === '-') return ''
  return value
}

function getProductCopyValue(kind: ProductCopyKind): string {
  if (kind === 'id') {
    return normalizeProductCopyValue(productView.value.id || productId.value)
  }
  if (kind === 'number') {
    return normalizeProductCopyValue(productView.value.partNumber)
  }
  if (kind === 'type') {
    return normalizeProductCopyValue(productView.value.itemType)
  }
  if (kind === 'status') {
    return normalizeProductCopyValue(productView.value.status)
  }
  return normalizeProductCopyValue(productView.value.revision)
}

function hasProductCopyValue(kind: ProductCopyKind): boolean {
  return Boolean(getProductCopyValue(kind))
}

async function copyProductField(kind: ProductCopyKind) {
  const value = getProductCopyValue(kind)
  if (!value) {
    const label =
      kind === 'id'
        ? 'ID'
        : kind === 'number'
          ? '料号'
          : kind === 'revision'
            ? '版本'
            : kind === 'type'
              ? '类型'
              : '状态'
    setDeepLinkMessage(`产品缺少${label}`, true)
    return
  }
  const ok = await copyToClipboard(value)
  if (!ok) {
    setDeepLinkMessage('复制失败，请手动复制', true)
    return
  }
  const label =
    kind === 'id'
      ? 'ID'
      : kind === 'number'
        ? '料号'
        : kind === 'revision'
          ? '版本'
          : kind === 'type'
            ? '类型'
            : '状态'
  setDeepLinkMessage(`已复制产品 ${label}：${value}`)
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
    if (productView.value.partNumber && !productItemNumber.value) {
      productItemNumber.value = productView.value.partNumber === '-' ? '' : productView.value.partNumber
    }
    if (productView.value.itemType && (itemType.value === DEFAULT_ITEM_TYPE || !itemType.value)) {
      itemType.value = productView.value.itemType
    }
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
    const params = new URLSearchParams()
    const depthValue = Number.isFinite(bomDepth.value) ? Math.max(1, Math.floor(bomDepth.value)) : undefined
    if (depthValue) {
      params.set('depth', String(depthValue))
    }
    const effectiveAt = normalizeEffectiveAt(bomEffectiveAt.value)
    if (effectiveAt) {
      params.set('effective_at', effectiveAt)
    }
    const query = params.toString()
    const endpoint = query
      ? `/api/federation/plm/products/${encodeURIComponent(productId.value)}/bom?${query}`
      : `/api/federation/plm/products/${encodeURIComponent(productId.value)}/bom`
    const result = await apiGet<{ ok: boolean; data: { items: any[] } }>(endpoint)
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

function resolveBomChildId(item: any): string {
  const value = item?.component_id ?? item?.componentId ?? item?.child_id ?? item?.childId
  return value ? String(value) : ''
}

function resolveBomChildNumber(item: any): string {
  const value =
    item?.component_code ??
    item?.componentCode ??
    item?.child_code ??
    item?.childCode ??
    item?.item_number ??
    item?.itemNumber ??
    item?.code
  return value ? String(value) : ''
}

function resolveBomLineId(item: any): string {
  const value = item?.id ?? item?.bom_line_id ?? item?.relationship_id ?? item?.relationshipId
  return value ? String(value) : ''
}

function formatBomPathIds(row: BomTreeRow): string {
  if (!row?.pathIds?.length) return ''
  return row.pathIds.filter((token) => String(token || '').length > 0).join(' / ')
}

function formatBomTablePathIds(item: Record<string, any>): string {
  const lineId = resolveBomLineId(item)
  const { byLineId, byPair } = bomPathRowMaps.value
  let row: BomTreeRow | undefined
  if (lineId) {
    row = byLineId.get(lineId)
  }
  if (!row) {
    const parentId = String(item?.parent_item_id ?? item?.parentItemId ?? '')
    const childId = resolveBomChildId(item)
    if (parentId || childId) {
      row = byPair.get(`${parentId}::${childId}`)
    }
  }
  if (!row?.pathIds?.length) return ''
  return row.pathIds.filter((token) => String(token || '').length > 0).join(' / ')
}

function formatBomFindNum(item: any): string {
  const value = item?.find_num ?? item?.findNum ?? item?.find_number ?? item?.sequence
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join(', ')
  }
  if (value === undefined || value === null || value === '') {
    return '-'
  }
  return String(value)
}

function formatBomRefdes(item: any): string {
  const value = item?.refdes ?? item?.refDes ?? item?.reference_designator
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join(', ')
  }
  if (value === undefined || value === null || value === '') {
    return '-'
  }
  return String(value)
}

function setBomDepthQuick(value: number): void {
  const next = Number.isFinite(value) ? Math.max(1, Math.floor(value)) : DEFAULT_BOM_DEPTH
  bomDepth.value = next
}

function resolveCompareLineId(entry: any): string {
  const value =
    entry?.relationship_id ??
    entry?.relationship?.id ??
    entry?.line?.relationship_id ??
    entry?.line?.id ??
    entry?.line_id ??
    ''
  return value ? String(value) : ''
}

async function copyToClipboard(value: string): Promise<boolean> {
  if (!value) return false
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch (_err) {
    // fallback below
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'absolute'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(textarea)
  return ok
}

function resolveWhereUsedParentId(entry: any): string {
  const value =
    entry?.parent?.id ??
    entry?.relationship?.source_id ??
    entry?.relationship?.parent_id ??
    entry?.parent_id ??
    ''
  return value ? String(value) : ''
}

function applyWhereUsedFromBom(item: any) {
  const childId = resolveBomChildId(item)
  if (!childId) {
    setDeepLinkMessage('BOM 行缺少子件 ID', true)
    return
  }
  whereUsedItemId.value = childId
  whereUsedError.value = ''
  scheduleQuerySync({ whereUsedItemId: childId })
  setDeepLinkMessage(`已填入 Where-Used 子件 ID：${childId}`)
  if (!whereUsedLoading.value) {
    void loadWhereUsed()
  }
}

function applyWhereUsedQuickPick() {
  const value = whereUsedQuickPick.value
  if (!value) return
  whereUsedItemId.value = value
  whereUsedError.value = ''
  scheduleQuerySync({ whereUsedItemId: value })
  setDeepLinkMessage(`已填入 Where-Used 子件 ID：${value}`)
  whereUsedQuickPick.value = ''
}

function applySubstitutesFromBom(item: any) {
  const lineId = resolveBomLineId(item)
  if (!lineId) {
    setDeepLinkMessage('BOM 行缺少行 ID', true)
    return
  }
  bomLineId.value = lineId
  substitutesError.value = ''
  substitutesActionStatus.value = ''
  substitutesActionError.value = ''
  scheduleQuerySync({ bomLineId: lineId })
  setDeepLinkMessage(`已填入替代件 BOM 行 ID：${lineId}`)
  if (!substitutesLoading.value) {
    void loadSubstitutes()
  }
}

function applyBomLineQuickPick() {
  const value = bomLineQuickPick.value
  if (!value) return
  bomLineId.value = value
  substitutesError.value = ''
  substitutesActionStatus.value = ''
  substitutesActionError.value = ''
  scheduleQuerySync({ bomLineId: value })
  setDeepLinkMessage(`已填入替代件 BOM 行 ID：${value}`)
  bomLineQuickPick.value = ''
}

function applySubstituteQuickPick() {
  const value = substituteQuickPick.value
  if (!value) return
  substituteItemId.value = value
  substitutesActionStatus.value = ''
  substitutesActionError.value = ''
  setDeepLinkMessage(`已填入替代件 ID：${value}`)
  substituteQuickPick.value = ''
}

function applyProductFromBom(item: any) {
  const childId = resolveBomChildId(item)
  const childNumber = resolveBomChildNumber(item)
  const target = childId || childNumber
  if (!target) {
    setDeepLinkMessage('BOM 行缺少子件标识', true)
    return
  }
  productId.value = childId
  productItemNumber.value = childId ? '' : childNumber
  productError.value = ''
  setDeepLinkMessage(`已切换到子件产品：${target}`)
  void loadProduct()
}

async function copyBomChildId(item: any) {
  const childId = resolveBomChildId(item)
  const childNumber = resolveBomChildNumber(item)
  const target = childId || childNumber
  if (!target) {
    setDeepLinkMessage('BOM 行缺少子件标识', true)
    return
  }
  const ok = await copyToClipboard(target)
  if (!ok) {
    setDeepLinkMessage('复制子件标识失败', true)
    return
  }
  const label = childId ? 'ID' : '料号'
  setDeepLinkMessage(`已复制子件${label}：${target}`)
}

async function copyBomPathIds(row: BomTreeRow) {
  const pathIds = formatBomPathIds(row)
  if (!pathIds) {
    setDeepLinkMessage('缺少路径 ID', true)
    return
  }
  const ok = await copyToClipboard(pathIds)
  if (!ok) {
    setDeepLinkMessage('复制路径 ID 失败', true)
    return
  }
  const lastToken = pathIds.split(' / ').slice(-1)[0] || pathIds
  setDeepLinkMessage(`已复制路径 ID（末级：${lastToken}）`)
}

async function copyBomTablePathIds(item: Record<string, any>) {
  const pathIds = formatBomTablePathIds(item)
  if (!pathIds) {
    setDeepLinkMessage('缺少路径 ID', true)
    return
  }
  const ok = await copyToClipboard(pathIds)
  if (!ok) {
    setDeepLinkMessage('复制路径 ID 失败', true)
    return
  }
  const lastToken = pathIds.split(' / ').slice(-1)[0] || pathIds
  setDeepLinkMessage(`已复制路径 ID（末级：${lastToken}）`)
}

async function copyPathIdsList(label: string, list: string[]) {
  if (!list.length) {
    setDeepLinkMessage(`暂无${label}路径 ID`, true)
    return
  }
  const ok = await copyToClipboard(list.join('\n'))
  if (!ok) {
    setDeepLinkMessage(`复制${label}路径 ID 失败`, true)
    return
  }
  setDeepLinkMessage(`已复制${label}路径 ID：${list.length} 条`)
}

async function copyValueList(label: string, list: string[]) {
  if (!list.length) {
    setDeepLinkMessage(`暂无${label}`, true)
    return
  }
  const ok = await copyToClipboard(list.join('\n'))
  if (!ok) {
    setDeepLinkMessage(`复制${label}失败`, true)
    return
  }
  setDeepLinkMessage(`已复制${label}：${list.length} 条`)
}

async function copyBomTablePathIdsBulk() {
  await copyPathIdsList('BOM', bomTablePathIdsList.value)
}

async function copyBomTreePathIdsBulk() {
  await copyPathIdsList('BOM树形', bomTreePathIdsList.value)
}

async function copyBomSelectedChildIds() {
  await copyValueList('子件', bomSelectedChildIds.value)
}

async function copyWhereUsedPathIdsValue(pathIds: string) {
  if (!pathIds) {
    setDeepLinkMessage('缺少路径 ID', true)
    return
  }
  const ok = await copyToClipboard(pathIds)
  if (!ok) {
    setDeepLinkMessage('复制路径 ID 失败', true)
    return
  }
  const lastToken = pathIds.split(' / ').slice(-1)[0] || pathIds
  setDeepLinkMessage(`已复制路径 ID（末级：${lastToken}）`)
}

async function copyWhereUsedPathIds(row: WhereUsedTreeRow) {
  const pathIds = formatWhereUsedPathIds(row)
  await copyWhereUsedPathIdsValue(pathIds)
}

async function copyWhereUsedEntryPathIds(entry: Record<string, any>) {
  const pathIds = formatWhereUsedEntryPathIds(entry)
  await copyWhereUsedPathIdsValue(pathIds)
}

async function copyWhereUsedTablePathIdsBulk() {
  await copyPathIdsList('Where-Used', whereUsedPathIdsList.value)
}

async function copyWhereUsedTreePathIdsBulk() {
  await copyPathIdsList('Where-Used树形', whereUsedTreePathIdsList.value)
}

async function copyWhereUsedSelectedParents() {
  await copyValueList('父件', whereUsedSelectedParents.value)
}

function clearWhereUsedSelection() {
  whereUsedSelectedEntryKeys.value = new Set()
}

function setWhereUsedSelection(keys: string[]) {
  const nextKeys = keys.filter(Boolean)
  if (!nextKeys.length) {
    whereUsedSelectedEntryKeys.value = new Set()
    return
  }
  const next = new Set(whereUsedSelectedEntryKeys.value)
  const hasAll = nextKeys.every((key) => next.has(key))
  for (const key of nextKeys) {
    if (hasAll) {
      next.delete(key)
    } else {
      next.add(key)
    }
  }
  whereUsedSelectedEntryKeys.value = next
}

function isWhereUsedEntrySelected(entry: Record<string, any>): boolean {
  const key = resolveWhereUsedEntryKey(entry)
  return key ? whereUsedSelectedEntryKeys.value.has(key) : false
}

function isWhereUsedTreeSelected(row: WhereUsedTreeRow): boolean {
  if (!row.entries.length) return false
  const selected = whereUsedSelectedEntryKeys.value
  for (const entry of row.entries) {
    const key = resolveWhereUsedEntryKey(entry)
    if (key && selected.has(key)) return true
  }
  return false
}

function selectWhereUsedTreeRow(row: WhereUsedTreeRow): void {
  const keys = row.entries.map((entry) => resolveWhereUsedEntryKey(entry)).filter(Boolean)
  setWhereUsedSelection(keys)
}

function selectWhereUsedTableRow(entry: Record<string, any>): void {
  const key = resolveWhereUsedEntryKey(entry)
  setWhereUsedSelection(key ? [key] : [])
}

function setBomSelection(lineIds: string[]) {
  const nextIds = lineIds.filter(Boolean)
  if (!nextIds.length) {
    bomSelectedLineIds.value = new Set()
    return
  }
  const next = new Set(bomSelectedLineIds.value)
  const hasAll = nextIds.every((id) => next.has(id))
  for (const id of nextIds) {
    if (hasAll) {
      next.delete(id)
    } else {
      next.add(id)
    }
  }
  bomSelectedLineIds.value = next
}

function clearBomSelection() {
  bomSelectedLineIds.value = new Set()
}

function isBomItemSelected(item: Record<string, any>): boolean {
  const lineId = resolveBomLineId(item)
  return lineId ? bomSelectedLineIds.value.has(lineId) : false
}

function isBomTreeSelected(row: BomTreeRow): boolean {
  const lineId = row.line ? resolveBomLineId(row.line) : ''
  return lineId ? bomSelectedLineIds.value.has(lineId) : false
}

function selectBomTreeRow(row: BomTreeRow): void {
  const lineId = row.line ? resolveBomLineId(row.line) : ''
  setBomSelection(lineId ? [lineId] : [])
}

function selectBomTableRow(item: Record<string, any>): void {
  const lineId = resolveBomLineId(item)
  setBomSelection(lineId ? [lineId] : [])
}

function isBomCollapsed(key: string): boolean {
  return bomCollapsed.value.has(key)
}

function toggleBomNode(key: string): void {
  const next = new Set(bomCollapsed.value)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  applyBomCollapsedState(next)
}

function expandAllBom(): void {
  applyBomCollapsedState(new Set())
}

function collapseAllBom(): void {
  const next = new Set<string>()
  for (const row of bomTreeRows.value) {
    if (row.hasChildren) {
      next.add(row.key)
    }
  }
  applyBomCollapsedState(next)
}

function expandBomToDepth(depth: number): void {
  const target = Number.isFinite(depth) ? Math.max(1, Math.floor(depth)) : DEFAULT_BOM_DEPTH
  const next = new Set<string>()
  for (const row of bomTreeRows.value) {
    if (row.hasChildren && row.depth >= target) {
      next.add(row.key)
    }
  }
  applyBomCollapsedState(next)
}

function applySubstitutesFromCompare(entry: any) {
  const lineId = resolveCompareLineId(entry)
  if (!lineId) {
    setDeepLinkMessage('对比行缺少关系 ID', true)
    return
  }
  bomLineId.value = lineId
  substitutesError.value = ''
  substitutesActionStatus.value = ''
  substitutesActionError.value = ''
  scheduleQuerySync({ bomLineId: lineId })
  setDeepLinkMessage(`已填入替代件 BOM 行 ID：${lineId}`)
  if (!substitutesLoading.value) {
    void loadSubstitutes()
  }
}

function applyProductFromWhereUsed(entry: any) {
  const parentId = resolveWhereUsedParentId(entry)
  if (!parentId) {
    setDeepLinkMessage('缺少父件 ID', true)
    return
  }
  productId.value = parentId
  productItemNumber.value = ''
  productError.value = ''
  setDeepLinkMessage(`已切换到产品：${parentId}`)
  void loadProduct()
}

function applyProductFromWhereUsedRow(row: WhereUsedTreeRow) {
  const parentId = row?.id
  if (!parentId) {
    setDeepLinkMessage('缺少父件 ID', true)
    return
  }
  applyProductFromWhereUsed({ parent: { id: parentId } })
}

function isWhereUsedCollapsed(key: string): boolean {
  return whereUsedCollapsed.value.has(key)
}

function toggleWhereUsedNode(key: string): void {
  const next = new Set(whereUsedCollapsed.value)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  whereUsedCollapsed.value = next
}

function expandAllWhereUsed(): void {
  whereUsedCollapsed.value = new Set()
}

function collapseAllWhereUsed(): void {
  const next = new Set<string>()
  for (const row of whereUsedTreeRows.value) {
    if (row.hasChildren) {
      next.add(row.key)
    }
  }
  whereUsedCollapsed.value = next
}

function applyProductFromCompareParent(entry: any) {
  const parent = getCompareParent(entry)
  const { id, itemNumber } = resolveItemKey(parent)
  if (!id && !itemNumber) {
    setDeepLinkMessage('缺少父件 ID', true)
    return
  }
  productId.value = id || ''
  productItemNumber.value = id ? '' : itemNumber
  productError.value = ''
  setDeepLinkMessage(`已切换到产品：${id || itemNumber}`)
  void loadProduct()
}

function applyWhereUsedFromCompare(entry: any) {
  const child = getCompareChild(entry)
  const { id, itemNumber } = resolveItemKey(child)
  const target = id || itemNumber
  if (!target) {
    setDeepLinkMessage('缺少子件 ID', true)
    return
  }
  whereUsedItemId.value = target
  whereUsedError.value = ''
  scheduleQuerySync({ whereUsedItemId: target })
  setDeepLinkMessage(`已切换 Where-Used 子件：${target}`)
  if (!whereUsedLoading.value) {
    void loadWhereUsed()
  }
}

async function copyCompareLineId(entry: any) {
  const lineId = resolveCompareLineId(entry)
  if (!lineId) {
    setDeepLinkMessage('缺少 Line ID', true)
    return
  }
  const ok = await copyToClipboard(lineId)
  if (!ok) {
    setDeepLinkMessage('复制失败，请手动复制', true)
    return
  }
  setDeepLinkMessage(`已复制 Line ID：${lineId}`)
}

function applyProductFromSubstitute(entry: any, target: 'substitute' | 'part') {
  const { id, itemNumber } = resolveItemKey(resolveSubstituteTarget(entry, target))
  if (!id && !itemNumber) {
    setDeepLinkMessage('缺少产品标识', true)
    return
  }
  productId.value = id || ''
  productItemNumber.value = id ? '' : itemNumber
  productError.value = ''
  const label = target === 'substitute' ? '替代件' : '原件'
  setDeepLinkMessage(`已切换到${label}产品：${id || itemNumber}`)
  void loadProduct()
}

async function copyBomLineId() {
  if (!bomLineId.value) {
    setDeepLinkMessage('缺少 BOM 行 ID', true)
    return
  }
  const ok = await copyToClipboard(bomLineId.value)
  if (!ok) {
    setDeepLinkMessage('复制失败，请手动复制', true)
    return
  }
  setDeepLinkMessage(`已复制 BOM 行 ID：${bomLineId.value}`)
}

function applyCompareFromProduct(side: 'left' | 'right') {
  if (!productId.value) {
    setDeepLinkMessage('请先加载产品', true)
    return
  }
  if (side === 'left') {
    compareLeftId.value = productId.value
  } else {
    compareRightId.value = productId.value
  }
  scheduleQuerySync({
    compareLeftId: compareLeftId.value || undefined,
    compareRightId: compareRightId.value || undefined,
  })
  setDeepLinkMessage(`已设为对比${side === 'left' ? '左' : '右'}侧：${productId.value}`)
}

function applyCompareQuickPick(side: 'left' | 'right') {
  const value = side === 'left' ? compareLeftQuickPick.value : compareRightQuickPick.value
  if (!value) return
  if (side === 'left') {
    compareLeftId.value = value
    compareLeftQuickPick.value = ''
  } else {
    compareRightId.value = value
    compareRightQuickPick.value = ''
  }
  compareError.value = ''
  scheduleQuerySync({
    compareLeftId: compareLeftId.value || undefined,
    compareRightId: compareRightId.value || undefined,
  })
  setDeepLinkMessage(`已填入对比${side === 'left' ? '左' : '右'}侧 ID：${value}`)
}

function swapCompareSides() {
  if (!compareLeftId.value || !compareRightId.value) return
  const left = compareLeftId.value
  compareLeftId.value = compareRightId.value
  compareRightId.value = left
  scheduleQuerySync({
    compareLeftId: compareLeftId.value || undefined,
    compareRightId: compareRightId.value || undefined,
  })
  setDeepLinkMessage('已交换对比左右')
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

function applyCompareSchemaDefaults(schema: CompareSchemaPayload | null) {
  if (!schema) return
  const defaults = schema.defaults || {}
  const defaultMaxLevels = Number(defaults.max_levels)
  if (Number.isFinite(defaultMaxLevels) && compareMaxLevels.value === DEFAULT_COMPARE_MAX_LEVELS) {
    compareMaxLevels.value = defaultMaxLevels
  }
  const defaultLineKey = typeof defaults.line_key === 'string' ? defaults.line_key.trim() : ''
  if (defaultLineKey && (compareLineKey.value === DEFAULT_COMPARE_LINE_KEY || !compareLineKey.value)) {
    compareLineKey.value = defaultLineKey
  }
  if (
    typeof defaults.include_substitutes === 'boolean' &&
    compareIncludeSubstitutes.value === false
  ) {
    compareIncludeSubstitutes.value = defaults.include_substitutes
  }
  if (
    typeof defaults.include_effectivity === 'boolean' &&
    compareIncludeEffectivity.value === false
  ) {
    compareIncludeEffectivity.value = defaults.include_effectivity
  }
}

async function loadBomCompareSchema() {
  compareSchemaLoading.value = true
  compareSchemaError.value = ''
  try {
    const result = await apiPost<{ ok: boolean; data: CompareSchemaPayload; error?: { message?: string } }>(
      '/api/federation/plm/query',
      { operation: 'bom_compare_schema' }
    )
    if (!result.ok) {
      throw new Error(result.error?.message || '加载 BOM 对比字段失败')
    }
    compareSchema.value = result.data
    applyCompareSchemaDefaults(result.data)
  } catch (error: any) {
    handleAuthError(error)
    compareSchemaError.value = error?.message || '加载 BOM 对比字段失败'
  } finally {
    compareSchemaLoading.value = false
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
  const requestedId = substituteItemId.value
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
    const relationId = result.data?.substitute_id
    const itemId = result.data?.substitute_item_id || requestedId
    substitutesActionStatus.value = relationId
      ? `已新增替代件 ${itemId}（关系 ${relationId}）`
      : `已新增替代件 ${itemId}`
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
  substitutesDeletingId.value = substituteId
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
    substitutesActionStatus.value = `已删除替代件 ${substituteId}`
    await loadSubstitutes()
  } catch (error: any) {
    handleAuthError(error)
    substitutesActionError.value = error?.message || '删除替代件失败'
  } finally {
    substitutesMutating.value = false
    substitutesDeletingId.value = null
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

function resolveItemKey(item?: Record<string, any> | null): { id: string; itemNumber: string } {
  if (!item) return { id: '', itemNumber: '' }
  const id = item.id || item.item_id || item.itemId || ''
  const itemNumber = item.item_number || item.itemNumber || item.code || ''
  return { id: id ? String(id) : '', itemNumber: itemNumber ? String(itemNumber) : '' }
}

function normalizeText(value: unknown, fallback = '-'): string {
  if (value === undefined || value === null || value === '') return fallback
  return String(value)
}

function getDocumentMetadata(doc: Record<string, any>): Record<string, any> {
  return doc?.metadata || {}
}

function getDocumentId(doc: Record<string, any>): string {
  const metadata = getDocumentMetadata(doc)
  return String(doc?.id || doc?.file_id || metadata.file_id || metadata.id || '')
}

function getDocumentName(doc: Record<string, any>): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(
    doc?.name ||
      metadata.filename ||
      doc?.filename ||
      metadata.file_name ||
      doc?.file_name ||
      doc?.id,
    '-',
  )
}

function getDocumentType(doc: Record<string, any>): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(
    doc?.document_type || metadata.document_type || doc?.file_type || metadata.file_type,
    '-',
  )
}

function getDocumentRevision(doc: Record<string, any>): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(
    doc?.engineering_revision ||
      doc?.revision ||
      metadata.document_version ||
      doc?.document_version,
    '-',
  )
}

function getDocumentRole(doc: Record<string, any>): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(
    doc?.engineering_state || metadata.file_role || doc?.file_role || metadata.role,
    '-',
  )
}

function getDocumentMime(doc: Record<string, any>): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(doc?.mime_type || metadata.mime_type || doc?.file_type, '-')
}

function getDocumentSize(doc: Record<string, any>): number | undefined {
  const metadata = getDocumentMetadata(doc)
  const raw = doc?.file_size ?? metadata.file_size ?? doc?.size
  if (raw === undefined || raw === null || raw === '') return undefined
  const size = Number(raw)
  return Number.isFinite(size) ? size : undefined
}

function getDocumentUpdatedAt(doc: Record<string, any>): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(
    doc?.updated_at || doc?.created_at || metadata.updated_at || metadata.created_at,
    '',
  )
}

function getDocumentPreviewUrl(doc: Record<string, any>): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(doc?.preview_url || metadata.preview_url, '')
}

function getDocumentDownloadUrl(doc: Record<string, any>): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(doc?.download_url || metadata.download_url, '')
}

function getDocumentAuthor(doc: Record<string, any>): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(doc?.author || metadata.author, '-')
}

function getDocumentSourceSystem(doc: Record<string, any>): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(doc?.source_system || metadata.source_system, '-')
}

function getDocumentSourceVersion(doc: Record<string, any>): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(doc?.source_version || metadata.source_version, '-')
}

function getDocumentCreatedAt(doc: Record<string, any>): string {
  const metadata = getDocumentMetadata(doc)
  return normalizeText(doc?.created_at || metadata.created_at, '')
}

async function copyDocumentId(doc: Record<string, any>) {
  const value = getDocumentId(doc)
  if (!value) {
    setDeepLinkMessage('文档缺少 ID。', true)
    return
  }
  const ok = await copyToClipboard(value)
  if (!ok) {
    setDeepLinkMessage('复制文档 ID 失败。', true)
    return
  }
  setDeepLinkMessage(`已复制文档 ID：${value}`)
}

async function copyDocumentUrl(doc: Record<string, any>, kind: 'preview' | 'download') {
  const url = kind === 'preview' ? getDocumentPreviewUrl(doc) : getDocumentDownloadUrl(doc)
  if (!url) {
    setDeepLinkMessage(`文档缺少${kind === 'preview' ? '预览' : '下载'}链接。`, true)
    return
  }
  const ok = await copyToClipboard(url)
  if (!ok) {
    setDeepLinkMessage('复制链接失败。', true)
    return
  }
  setDeepLinkMessage(`已复制${kind === 'preview' ? '预览' : '下载'}链接。`)
}

function getApprovalTitle(entry: Record<string, any>): string {
  return normalizeText(entry?.title || entry?.name || entry?.id, '-')
}

function getApprovalId(entry: Record<string, any>): string {
  return normalizeText(entry?.id || entry?.request_id, '-')
}

function getApprovalStatus(entry: Record<string, any>): string {
  return normalizeText(entry?.status || entry?.state, '-')
}

function getApprovalType(entry: Record<string, any>): string {
  return normalizeText(entry?.request_type || entry?.type || entry?.eco_type, '-')
}

function getApprovalRequester(entry: Record<string, any>): string {
  return normalizeText(
    entry?.requester_name ||
      entry?.created_by_name ||
      entry?.requester_id ||
      entry?.created_by_id,
    '-',
  )
}

function getApprovalRequesterId(entry: Record<string, any>): string {
  return normalizeText(entry?.requester_id || entry?.created_by_id, '-')
}

function getApprovalCreatedAt(entry: Record<string, any>): string {
  return normalizeText(entry?.created_at || entry?.createdAt || entry?.updated_at, '')
}

function getApprovalProductNumber(entry: Record<string, any>): string {
  return normalizeText(
    entry?.product_number ||
      entry?.productNumber ||
      entry?.product_code ||
      entry?.product_id,
    '-',
  )
}

function getApprovalProductId(entry: Record<string, any>): string {
  return normalizeText(entry?.product_id || entry?.productId || entry?.product?.id, '-')
}

function getApprovalProductName(entry: Record<string, any>): string {
  return normalizeText(entry?.product_name || entry?.productName, '-')
}

function resolveApprovalProductKey(entry: Record<string, any>): { id: string; itemNumber: string } {
  const id = entry?.product_id || entry?.productId || entry?.product?.id || ''
  const itemNumber =
    entry?.product_number ||
    entry?.productNumber ||
    entry?.product_code ||
    entry?.product?.item_number ||
    ''
  return { id: id ? String(id) : '', itemNumber: itemNumber ? String(itemNumber) : '' }
}

async function applyProductFromApproval(entry: Record<string, any>) {
  const { id, itemNumber } = resolveApprovalProductKey(entry)
  if (!id && !itemNumber) {
    setDeepLinkMessage('审批记录缺少产品标识。', true)
    return
  }
  productId.value = id || ''
  productItemNumber.value = id ? '' : itemNumber
  productError.value = ''
  setDeepLinkMessage(`已切换到产品：${id || itemNumber}`)
  await loadProduct()
}

async function copyApprovalId(entry: Record<string, any>) {
  const value = entry?.id ? String(entry.id) : ''
  if (!value) {
    setDeepLinkMessage('审批记录缺少 ID。', true)
    return
  }
  const ok = await copyToClipboard(value)
  if (!ok) {
    setDeepLinkMessage('复制审批 ID 失败。', true)
    return
  }
  setDeepLinkMessage(`已复制审批 ID：${value}`)
}

function getSubstitutePart(entry: Record<string, any>): Record<string, any> {
  return entry?.substitute_part || entry?.substitutePart || {}
}

function getSubstituteSourcePart(entry: Record<string, any>): Record<string, any> {
  return entry?.part || entry?.source_part || entry?.original_part || {}
}

function getSubstituteNumber(entry: Record<string, any>): string {
  const part = getSubstitutePart(entry)
  return part.item_number || part.itemNumber || part.code || part.id || entry.id || '-'
}

function getSubstituteId(entry: Record<string, any>): string {
  const part = getSubstitutePart(entry)
  return part.id || entry.id || '-'
}

function getSubstituteName(entry: Record<string, any>): string {
  const part = getSubstitutePart(entry)
  return part.name || part.label || part.title || '-'
}

function getSubstituteStatus(entry: Record<string, any>): string {
  const part = getSubstitutePart(entry)
  return part.state || part.status || part.lifecycle_state || '-'
}

function resolveSubstituteTarget(entry: Record<string, any>, target: 'substitute' | 'part'): Record<string, any> {
  return target === 'substitute' ? getSubstitutePart(entry) : getSubstituteSourcePart(entry)
}

function resolveSubstituteTargetKey(entry: Record<string, any>, target: 'substitute' | 'part'): string {
  const { id, itemNumber } = resolveItemKey(resolveSubstituteTarget(entry, target))
  return id || itemNumber || ''
}

function formatSubstituteRank(entry: Record<string, any>): string {
  const value = entry?.rank ?? entry?.relationship?.properties?.rank
  if (value === undefined || value === null || value === '') return '-'
  return String(value)
}

function formatSubstituteNote(entry: Record<string, any>): string {
  const value = entry?.relationship?.properties?.note || entry?.relationship?.properties?.comment
  if (value === undefined || value === null || value === '') return '-'
  return String(value)
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

function resolveCompareParentKey(entry?: Record<string, any> | null): string {
  const parent = getCompareParent(entry)
  const { id, itemNumber } = resolveItemKey(parent)
  return id || itemNumber || ''
}

function resolveCompareChildKey(entry?: Record<string, any> | null): string {
  const child = getCompareChild(entry)
  const { id, itemNumber } = resolveItemKey(child)
  return id || itemNumber || ''
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

function resolveCompareLineProps(entry?: Record<string, any> | null): Record<string, any> {
  if (!entry) return {}
  return (
    entry.line ||
    entry.properties ||
    entry.relationship?.properties ||
    entry.relationship ||
    {}
  )
}

function resolveSnakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, ch) => String(ch).toUpperCase())
}

function getCompareProp(entry: Record<string, any>, key: string): string {
  const props = resolveCompareLineProps(entry)
  const value =
    props[key] ??
    props[resolveSnakeToCamel(key)]
  if (value === undefined || value === null || value === '') return '-'
  return String(value)
}

function resolveCompareEntryKey(entry?: Record<string, any> | null): string {
  if (!entry) return ''
  return entry.relationship_id || entry.line_key || entry.child_id || ''
}

function resolveCompareLineValue(source: Record<string, any> | null, key: string): unknown {
  if (!source) return undefined
  return source[key] ?? source[resolveSnakeToCamel(key)]
}

function resolveCompareEntryLine(
  entry: Record<string, any>,
  kind: CompareSelectionKind,
  side: 'left' | 'right'
): Record<string, any> | null {
  if (kind === 'added') {
    return side === 'right' ? resolveCompareLineProps(entry) : null
  }
  if (kind === 'removed') {
    return side === 'left' ? resolveCompareLineProps(entry) : null
  }
  if (side === 'left') {
    return entry.before_line || entry.before || resolveCompareLineProps(entry)
  }
  return entry.after_line || entry.after || resolveCompareLineProps(entry)
}

function resolveCompareEntryNormalized(
  entry: Record<string, any>,
  kind: CompareSelectionKind,
  side: 'left' | 'right'
): Record<string, any> | null {
  if (kind === 'added') {
    return side === 'right' ? entry.line_normalized || null : null
  }
  if (kind === 'removed') {
    return side === 'left' ? entry.line_normalized || null : null
  }
  if (side === 'left') {
    return entry.before_normalized || null
  }
  return entry.after_normalized || null
}

function truncateCompareValue(value: string, limit = 160): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit - 3)}...`
}

function formatCompareFieldValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '-'
  if (Array.isArray(value)) {
    if (!value.length) return '-'
    const parts = value.map((entry) => {
      if (entry === null || entry === undefined) return ''
      if (typeof entry === 'object') return JSON.stringify(entry)
      return String(entry)
    }).filter(Boolean)
    return truncateCompareValue(parts.join(', ') || '-')
  }
  if (typeof value === 'object') {
    return truncateCompareValue(JSON.stringify(value))
  }
  return truncateCompareValue(String(value))
}

function resolveCompareFieldValue(
  entry: Record<string, any>,
  kind: CompareSelectionKind,
  side: 'left' | 'right',
  key: string
): string {
  const line = resolveCompareEntryLine(entry, kind, side)
  const value = resolveCompareLineValue(line, key)
  return formatCompareFieldValue(value)
}

function resolveCompareNormalizedValue(
  entry: Record<string, any>,
  kind: CompareSelectionKind,
  side: 'left' | 'right',
  key: string,
  change?: Record<string, any>
): string {
  let normalizedValue: unknown = undefined
  if (change) {
    normalizedValue = side === 'left' ? change.normalized_left : change.normalized_right
  }
  if (normalizedValue === undefined) {
    const normalized = resolveCompareEntryNormalized(entry, kind, side)
    normalizedValue = resolveCompareLineValue(normalized, key)
  }
  const formatted = formatCompareFieldValue(normalizedValue)
  if (formatted === '-') return ''
  const raw = resolveCompareFieldValue(entry, kind, side, key)
  if (formatted === raw) return ''
  return formatted
}

function selectCompareEntry(entry: Record<string, any>, kind: CompareSelectionKind): void {
  const key = resolveCompareEntryKey(entry)
  if (!key) return
  const current = compareSelected.value
  if (current && current.key === key && current.kind === kind) {
    compareSelected.value = null
  } else {
    compareSelected.value = { key, kind, entry }
    syncCompareTargets(entry)
  }
}

function clearCompareSelection(): void {
  compareSelected.value = null
}

function isCompareEntrySelected(entry: Record<string, any>, kind: CompareSelectionKind): boolean {
  const key = resolveCompareEntryKey(entry)
  if (!key) return false
  return Boolean(compareSelected.value && compareSelected.value.key === key && compareSelected.value.kind === kind)
}

function syncCompareTargets(entry: Record<string, any>): void {
  if (!compareSyncEnabled.value) return
  const child = getCompareChild(entry)
  const { id, itemNumber } = resolveItemKey(child)
  const target = id || itemNumber
  const lineId = resolveCompareLineId(entry)
  const messages: string[] = []

  if (target) {
    whereUsedItemId.value = target
    whereUsedError.value = ''
    scheduleQuerySync({ whereUsedItemId: target })
    messages.push(`Where-Used 子件：${target}`)
  }

  if (lineId) {
    bomLineId.value = lineId
    substitutesError.value = ''
    substitutesActionStatus.value = ''
    substitutesActionError.value = ''
    scheduleQuerySync({ bomLineId: lineId })
    messages.push(`替代件 BOM 行：${lineId}`)
  }

  if (!messages.length) {
    setDeepLinkMessage('对比行缺少子件/行 ID', true)
    return
  }

  setDeepLinkMessage(`已联动 ${messages.join('；')}`)
}

function getWhereUsedRefdes(entry: Record<string, any>): string {
  const line = entry?.line || entry?.relationship?.properties || entry?.relationship || {}
  const value = line.refdes ?? line.ref_des
  if (value === undefined || value === null || value === '') return '-'
  return String(value)
}

function getWhereUsedLineValue(entry: Record<string, any>, key: string): string {
  const line = entry?.line || entry?.relationship?.properties || entry?.relationship || {}
  const value = line[key]
  if (value === undefined || value === null || value === '') return '-'
  return String(value)
}

function resolveWhereUsedEntryKey(entry: Record<string, any>): string {
  return entry?._key || entry?.relationship?.id || ''
}

function getWhereUsedTreeEntry(row: WhereUsedTreeRow): Record<string, any> | null {
  return row.entries.length ? row.entries[0] : null
}

function getWhereUsedTreeLineValue(row: WhereUsedTreeRow, key: string): string {
  const entry = getWhereUsedTreeEntry(row)
  if (!entry) return '-'
  return getWhereUsedLineValue(entry, key)
}

function getWhereUsedTreeRefdes(row: WhereUsedTreeRow): string {
  const entry = getWhereUsedTreeEntry(row)
  if (!entry) return '-'
  return getWhereUsedRefdes(entry)
}

function getWhereUsedTreeRelationship(row: WhereUsedTreeRow): string {
  const entry = getWhereUsedTreeEntry(row)
  return entry?.relationship?.id || '-'
}

function formatWhereUsedEntryPathIds(entry: Record<string, any>): string {
  const nodes = Array.isArray(entry?.pathNodes) ? entry.pathNodes : []
  if (!nodes.length) return ''
  return nodes
    .map((node: any) => node?.id || node?.label)
    .filter((token) => String(token || '').length > 0)
    .join(' / ')
}

function formatWhereUsedPathIds(row: WhereUsedTreeRow): string {
  if (!row?.pathIds?.length) return ''
  return row.pathIds.filter((token) => String(token || '').length > 0).join(' / ')
}

function normalizeEffectiveAt(value: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString()
}

function serializeBomCollapsed(value: Set<string>): string {
  return Array.from(value).join('|')
}

function parseBomCollapsed(raw: string): Set<string> {
  if (!raw) return new Set()
  return new Set(raw.split('|').map((entry) => entry.trim()).filter(Boolean))
}

function resolveBomCollapseStorageKey(): string | null {
  const base = productId.value || productView.value.id || productItemNumber.value
  if (!base) return null
  return `${BOM_COLLAPSE_STORAGE_KEY}:${base}`
}

function loadStoredBomCollapsed(): Set<string> | null {
  if (typeof localStorage === 'undefined') return null
  const key = resolveBomCollapseStorageKey()
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return new Set(parsed.map((entry) => String(entry)).filter(Boolean))
  } catch (_err) {
    return null
  }
}

function persistBomCollapsed(value: Set<string>): void {
  if (typeof localStorage === 'undefined') return
  const key = resolveBomCollapseStorageKey()
  if (!key) return
  try {
    if (!value.size) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, JSON.stringify(Array.from(value)))
    }
  } catch (_err) {
    // ignore storage errors
  }
}

function filterBomCollapsed(value: Set<string>): Set<string> {
  const rows = bomTreeRows.value
  if (!rows.length) return value
  const allowed = new Set(rows.map((row) => row.key))
  return new Set(Array.from(value).filter((key) => allowed.has(key)))
}

function resolveBomCollapsedState(): Set<string> {
  const param = readQueryParam('bomCollapsed')
  if (param !== undefined) {
    return filterBomCollapsed(parseBomCollapsed(param))
  }
  const stored = loadStoredBomCollapsed()
  return stored ? filterBomCollapsed(stored) : new Set()
}

function syncBomCollapsedQuery(value: Set<string>): void {
  if (bomView.value !== 'tree') {
    scheduleQuerySync({ bomCollapsed: undefined })
    return
  }
  const serialized = serializeBomCollapsed(value)
  scheduleQuerySync({ bomCollapsed: serialized || undefined })
}

function applyBomCollapsedState(value: Set<string>): void {
  const filtered = filterBomCollapsed(value)
  bomCollapsed.value = filtered
  persistBomCollapsed(filtered)
  syncBomCollapsedQuery(filtered)
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
  documents: '文档',
  approvals: '审批',
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

function applyPresetParams(preset?: DeepLinkPreset | null): void {
  if (!preset?.params) return
  const bomViewParam = preset.params.bomView
  if (typeof bomViewParam === 'string') {
    const normalized = bomViewParam.trim().toLowerCase()
    if (normalized === 'tree' || normalized === 'table') {
      bomView.value = normalized as typeof bomView.value
    }
  }
}

function applyDeepLinkPreset() {
  if (!deepLinkPreset.value) {
    deepLinkScope.value = []
    return
  }
  const preset = deepLinkPresets.value.find((entry) => entry.key === deepLinkPreset.value)
  applyingPreset = true
  deepLinkScope.value = preset ? [...preset.panels] : []
  applyPresetParams(preset || null)
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

function createFilterPresetKey(prefix: string): string {
  const suffix = Math.random().toString(36).slice(2, 6)
  return `${prefix}:${Date.now().toString(36)}-${suffix}`
}

function upsertFilterPreset(
  presets: FilterPreset[],
  label: string,
  field: string,
  value: string,
  group: string,
  prefix: string
): { presets: FilterPreset[]; key: string } {
  const trimmedLabel = label.trim()
  const trimmedValue = value.trim()
  const trimmedGroup = group.trim()
  if (!trimmedLabel || !trimmedValue) {
    return { presets, key: '' }
  }
  const existingIndex = presets.findIndex((preset) => preset.label === trimmedLabel)
  if (existingIndex >= 0) {
    const updated = { ...presets[existingIndex], field, value: trimmedValue, group: trimmedGroup }
    const next = [...presets]
    next[existingIndex] = updated
    return { presets: next, key: updated.key }
  }
  const key = createFilterPresetKey(prefix)
  return {
    presets: [...presets, { key, label: trimmedLabel, field, value: trimmedValue, group: trimmedGroup }],
    key,
  }
}

function applyFilterPreset(
  presets: FilterPreset[],
  key: string
): FilterPreset | null {
  const preset = presets.find((entry) => entry.key === key)
  return preset || null
}

function saveBomFilterPreset() {
  if (!canSaveBomFilterPreset.value) {
    setDeepLinkMessage('请输入过滤条件和预设名称。', true)
    return
  }
  const { presets, key } = upsertFilterPreset(
    bomFilterPresets.value,
    bomFilterPresetName.value,
    bomFilterField.value,
    bomFilter.value,
    bomFilterPresetGroup.value,
    'bom'
  )
  bomFilterPresets.value = presets
  persistFilterPresets(BOM_FILTER_PRESETS_STORAGE_KEY, presets)
  bomFilterPresetKey.value = key
  bomFilterPresetName.value = ''
  bomFilterPresetGroup.value = ''
  setDeepLinkMessage('已保存 BOM 过滤预设。')
}

function applyBomFilterPreset() {
  const preset = applyFilterPreset(bomFilterPresets.value, bomFilterPresetKey.value)
  if (!preset) {
    setDeepLinkMessage('请选择 BOM 过滤预设。', true)
    return
  }
  bomFilterField.value = preset.field
  bomFilter.value = preset.value
  setDeepLinkMessage(`已应用 BOM 过滤预设：${preset.label}`)
}

function deleteBomFilterPreset() {
  if (!bomFilterPresetKey.value) return
  const next = bomFilterPresets.value.filter((preset) => preset.key !== bomFilterPresetKey.value)
  bomFilterPresets.value = next
  persistFilterPresets(BOM_FILTER_PRESETS_STORAGE_KEY, next)
  bomFilterPresetKey.value = ''
  setDeepLinkMessage('已删除 BOM 过滤预设。')
}

function assignBomPresetGroup() {
  const group = bomFilterPresetGroup.value.trim()
  if (!bomFilterPresetKey.value) return
  const next = bomFilterPresets.value.map((preset) =>
    preset.key === bomFilterPresetKey.value ? { ...preset, group } : preset
  )
  bomFilterPresets.value = next
  persistFilterPresets(BOM_FILTER_PRESETS_STORAGE_KEY, next)
  setDeepLinkMessage(group ? '已更新 BOM 过滤预设分组。' : '已清空 BOM 过滤预设分组。')
}

async function shareBomFilterPreset() {
  const preset = bomFilterPresets.value.find((entry) => entry.key === bomFilterPresetKey.value)
  if (!preset) {
    setDeepLinkMessage('请选择 BOM 过滤预设后分享。', true)
    return
  }
  const url = buildPresetShareUrl('bom', preset, bomFilterPresetImportMode.value)
  if (!url) {
    setDeepLinkMessage('生成 BOM 过滤预设分享链接失败。', true)
    return
  }
  const ok = await copyToClipboard(url)
  setDeepLinkMessage(
    ok ? '已复制 BOM 过滤预设分享链接。' : '复制 BOM 过滤预设分享链接失败。',
    !ok
  )
}

function selectAllBomPresets() {
  bomPresetSelection.value = bomFilteredPresets.value.map((preset) => preset.key)
}

function clearBomPresetSelection() {
  bomPresetSelection.value = []
}

function applyBomPresetBatchGroup() {
  if (!bomPresetSelection.value.length) {
    setDeepLinkMessage('请选择要批量修改的 BOM 过滤预设。', true)
    return
  }
  const group = bomPresetBatchGroup.value.trim()
  const selected = new Set(bomPresetSelection.value)
  bomFilterPresets.value = bomFilterPresets.value.map((preset) =>
    selected.has(preset.key) ? { ...preset, group } : preset
  )
  persistFilterPresets(BOM_FILTER_PRESETS_STORAGE_KEY, bomFilterPresets.value)
  bomPresetBatchGroup.value = ''
  setDeepLinkMessage(group ? '已批量更新 BOM 过滤预设分组。' : '已清空选中 BOM 过滤预设分组。')
}

function deleteBomPresetSelection() {
  if (!bomPresetSelection.value.length) {
    setDeepLinkMessage('请选择要删除的 BOM 过滤预设。', true)
    return
  }
  const selected = new Set(bomPresetSelection.value)
  const next = bomFilterPresets.value.filter((preset) => !selected.has(preset.key))
  bomFilterPresets.value = next
  persistFilterPresets(BOM_FILTER_PRESETS_STORAGE_KEY, next)
  if (!next.some((preset) => preset.key === bomFilterPresetKey.value)) {
    bomFilterPresetKey.value = ''
  }
  bomPresetSelection.value = []
  setDeepLinkMessage(`已删除 ${selected.size} 条 BOM 过滤预设。`)
}

function saveWhereUsedFilterPreset() {
  if (!canSaveWhereUsedFilterPreset.value) {
    setDeepLinkMessage('请输入过滤条件和预设名称。', true)
    return
  }
  const { presets, key } = upsertFilterPreset(
    whereUsedFilterPresets.value,
    whereUsedFilterPresetName.value,
    whereUsedFilterField.value,
    whereUsedFilter.value,
    whereUsedFilterPresetGroup.value,
    'where-used'
  )
  whereUsedFilterPresets.value = presets
  persistFilterPresets(WHERE_USED_FILTER_PRESETS_STORAGE_KEY, presets)
  whereUsedFilterPresetKey.value = key
  whereUsedFilterPresetName.value = ''
  whereUsedFilterPresetGroup.value = ''
  setDeepLinkMessage('已保存 Where-Used 过滤预设。')
}

function applyWhereUsedFilterPreset() {
  const preset = applyFilterPreset(whereUsedFilterPresets.value, whereUsedFilterPresetKey.value)
  if (!preset) {
    setDeepLinkMessage('请选择 Where-Used 过滤预设。', true)
    return
  }
  whereUsedFilterField.value = preset.field
  whereUsedFilter.value = preset.value
  setDeepLinkMessage(`已应用 Where-Used 过滤预设：${preset.label}`)
}

function deleteWhereUsedFilterPreset() {
  if (!whereUsedFilterPresetKey.value) return
  const next = whereUsedFilterPresets.value.filter(
    (preset) => preset.key !== whereUsedFilterPresetKey.value
  )
  whereUsedFilterPresets.value = next
  persistFilterPresets(WHERE_USED_FILTER_PRESETS_STORAGE_KEY, next)
  whereUsedFilterPresetKey.value = ''
  setDeepLinkMessage('已删除 Where-Used 过滤预设。')
}

function assignWhereUsedPresetGroup() {
  const group = whereUsedFilterPresetGroup.value.trim()
  if (!whereUsedFilterPresetKey.value) return
  const next = whereUsedFilterPresets.value.map((preset) =>
    preset.key === whereUsedFilterPresetKey.value ? { ...preset, group } : preset
  )
  whereUsedFilterPresets.value = next
  persistFilterPresets(WHERE_USED_FILTER_PRESETS_STORAGE_KEY, next)
  setDeepLinkMessage(group ? '已更新 Where-Used 过滤预设分组。' : '已清空 Where-Used 过滤预设分组。')
}

async function shareWhereUsedFilterPreset() {
  const preset = whereUsedFilterPresets.value.find(
    (entry) => entry.key === whereUsedFilterPresetKey.value
  )
  if (!preset) {
    setDeepLinkMessage('请选择 Where-Used 过滤预设后分享。', true)
    return
  }
  const url = buildPresetShareUrl('where-used', preset, whereUsedFilterPresetImportMode.value)
  if (!url) {
    setDeepLinkMessage('生成 Where-Used 过滤预设分享链接失败。', true)
    return
  }
  const ok = await copyToClipboard(url)
  setDeepLinkMessage(
    ok ? '已复制 Where-Used 过滤预设分享链接。' : '复制 Where-Used 过滤预设分享链接失败。',
    !ok
  )
}

function selectAllWhereUsedPresets() {
  whereUsedPresetSelection.value = whereUsedFilteredPresets.value.map((preset) => preset.key)
}

function clearWhereUsedPresetSelection() {
  whereUsedPresetSelection.value = []
}

function applyWhereUsedPresetBatchGroup() {
  if (!whereUsedPresetSelection.value.length) {
    setDeepLinkMessage('请选择要批量修改的 Where-Used 过滤预设。', true)
    return
  }
  const group = whereUsedPresetBatchGroup.value.trim()
  const selected = new Set(whereUsedPresetSelection.value)
  whereUsedFilterPresets.value = whereUsedFilterPresets.value.map((preset) =>
    selected.has(preset.key) ? { ...preset, group } : preset
  )
  persistFilterPresets(WHERE_USED_FILTER_PRESETS_STORAGE_KEY, whereUsedFilterPresets.value)
  whereUsedPresetBatchGroup.value = ''
  setDeepLinkMessage(group ? '已批量更新 Where-Used 过滤预设分组。' : '已清空选中 Where-Used 过滤预设分组。')
}

function deleteWhereUsedPresetSelection() {
  if (!whereUsedPresetSelection.value.length) {
    setDeepLinkMessage('请选择要删除的 Where-Used 过滤预设。', true)
    return
  }
  const selected = new Set(whereUsedPresetSelection.value)
  const next = whereUsedFilterPresets.value.filter((preset) => !selected.has(preset.key))
  whereUsedFilterPresets.value = next
  persistFilterPresets(WHERE_USED_FILTER_PRESETS_STORAGE_KEY, next)
  if (!next.some((preset) => preset.key === whereUsedFilterPresetKey.value)) {
    whereUsedFilterPresetKey.value = ''
  }
  whereUsedPresetSelection.value = []
  setDeepLinkMessage(`已删除 ${selected.size} 条 Where-Used 过滤预设。`)
}

function formatPresetLabelPreview(labels: string[]): string {
  if (!labels.length) return ''
  const sample = labels.slice(0, 3).join('、')
  return labels.length > 3 ? `${sample} 等` : sample
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  const base64 = btoa(binary)
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(value: string): string | null {
  if (!value) return null
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const pad = normalized.length % 4
  const padded = pad ? normalized + '='.repeat(4 - pad) : normalized
  try {
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch (_err) {
    return null
  }
}

function encodePresetSharePayload(preset: FilterPreset): string {
  const payload = JSON.stringify({
    label: preset.label,
    field: preset.field,
    value: preset.value,
    group: preset.group || '',
  })
  return encodeBase64Url(payload)
}

function decodePresetSharePayload(
  raw: string,
  fieldOptions: Array<{ value: string }>
): FilterPresetImportEntry | null {
  const decoded = decodeBase64Url(raw)
  if (!decoded) return null
  try {
    const parsed = JSON.parse(decoded)
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    const label = String(record.label ?? '').trim()
    const value = String(record.value ?? '').trim()
    if (!label || !value) return null
    const rawField = String(record.field ?? '').trim()
    const allowedFields = new Set(fieldOptions.map((option) => option.value))
    const field = allowedFields.has(rawField) ? rawField : 'all'
    const group = String(record.group ?? '').trim()
    return { key: '', label, field, value, group }
  } catch (_err) {
    return null
  }
}

function resolvePresetShareMode(value?: string): 'merge' | 'replace' {
  if (!value) return 'merge'
  return value.trim().toLowerCase() === 'replace' ? 'replace' : 'merge'
}

function buildPresetShareUrl(
  kind: 'bom' | 'where-used',
  preset: FilterPreset,
  mode: 'merge' | 'replace'
): string {
  if (typeof window === 'undefined') return ''
  const encoded = encodePresetSharePayload(preset)
  if (!encoded) return ''
  const base = `${window.location.origin}${route.path}`
  const params = new URLSearchParams()
  if (kind === 'bom') {
    params.set('bomPresetShare', encoded)
    if (mode === 'replace') params.set('bomPresetShareMode', mode)
  } else {
    params.set('whereUsedPresetShare', encoded)
    if (mode === 'replace') params.set('whereUsedPresetShareMode', mode)
  }
  const query = params.toString()
  return query ? `${base}?${query}` : base
}

function confirmFilterPresetImport(
  label: string,
  mode: 'merge' | 'replace',
  existingLabels: string[],
  conflictLabels: string[]
): boolean {
  if (typeof window === 'undefined') return true
  if (mode === 'replace' && existingLabels.length) {
    const sample = formatPresetLabelPreview(existingLabels)
    const hint = sample ? `（如：${sample}）` : ''
    return window.confirm(`将覆盖现有 ${existingLabels.length} 条${label}过滤预设${hint}，继续导入？`)
  }
  if (mode === 'merge' && conflictLabels.length) {
    const sample = formatPresetLabelPreview(conflictLabels)
    const hint = sample ? `（如：${sample}）` : ''
    return window.confirm(`检测到 ${conflictLabels.length} 条同名${label}过滤预设${hint}，将覆盖现有预设。是否继续？`)
  }
  return true
}

function importBomFilterPresetShare(raw: string, mode: 'merge' | 'replace') {
  const entry = decodePresetSharePayload(raw, bomFilterFieldOptions)
  if (!entry) {
    setDeepLinkMessage('BOM 过滤预设分享链接解析失败。', true)
    return
  }
  const existingLabels = bomFilterPresets.value.map((preset) => preset.label)
  const existingLabelSet = new Set(existingLabels)
  const conflictLabels = existingLabelSet.has(entry.label) ? [entry.label] : []
  const confirmed = confirmFilterPresetImport('BOM', mode, existingLabels, conflictLabels)
  if (!confirmed) {
    setDeepLinkMessage('已取消导入 BOM 过滤预设。', true)
    return
  }
  const { presets, added, updated } = mergeImportedFilterPresets(
    [entry],
    bomFilterPresets.value,
    'bom',
    mode
  )
  bomFilterPresets.value = presets
  persistFilterPresets(BOM_FILTER_PRESETS_STORAGE_KEY, presets)
  const imported = presets.find((preset) => preset.label === entry.label)
  bomFilterPresetKey.value = imported?.key || ''
  const importedCount = added + updated
  if (importedCount) {
    setDeepLinkMessage(
      `已导入 BOM 过滤预设：${entry.label}（新增 ${added}，更新 ${updated}）。`
    )
  } else {
    setDeepLinkMessage('未导入 BOM 过滤预设。', true)
  }
}

function importWhereUsedFilterPresetShare(raw: string, mode: 'merge' | 'replace') {
  const entry = decodePresetSharePayload(raw, whereUsedFilterFieldOptions)
  if (!entry) {
    setDeepLinkMessage('Where-Used 过滤预设分享链接解析失败。', true)
    return
  }
  const existingLabels = whereUsedFilterPresets.value.map((preset) => preset.label)
  const existingLabelSet = new Set(existingLabels)
  const conflictLabels = existingLabelSet.has(entry.label) ? [entry.label] : []
  const confirmed = confirmFilterPresetImport('Where-Used', mode, existingLabels, conflictLabels)
  if (!confirmed) {
    setDeepLinkMessage('已取消导入 Where-Used 过滤预设。', true)
    return
  }
  const { presets, added, updated } = mergeImportedFilterPresets(
    [entry],
    whereUsedFilterPresets.value,
    'where-used',
    mode
  )
  whereUsedFilterPresets.value = presets
  persistFilterPresets(WHERE_USED_FILTER_PRESETS_STORAGE_KEY, presets)
  const imported = presets.find((preset) => preset.label === entry.label)
  whereUsedFilterPresetKey.value = imported?.key || ''
  const importedCount = added + updated
  if (importedCount) {
    setDeepLinkMessage(
      `已导入 Where-Used 过滤预设：${entry.label}（新增 ${added}，更新 ${updated}）。`
    )
  } else {
    setDeepLinkMessage('未导入 Where-Used 过滤预设。', true)
  }
}

function parseFilterPresetImport(
  raw: string,
  fieldOptions: Array<{ value: string }>
): {
  entries: FilterPresetImportEntry[]
  skippedInvalid: number
  skippedMissing: number
  duplicateCount: number
} {
  const allowedFields = new Set(fieldOptions.map((option) => option.value))
  const map = new Map<string, FilterPresetImportEntry>()
  let skippedInvalid = 0
  let skippedMissing = 0
  let validCount = 0
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error('not-array')
  }
  for (const entry of parsed) {
    const isObject = entry && typeof entry === 'object'
    if (!isObject) {
      skippedInvalid += 1
      continue
    }
    const record = entry as Record<string, unknown>
    const label = String(record.label ?? '').trim()
    const value = String(record.value ?? '').trim()
    if (!label || !value) {
      skippedMissing += 1
      continue
    }
    const rawField = String(record.field ?? '').trim()
    const field = allowedFields.has(rawField) ? rawField : 'all'
    const key = String(record.key ?? '').trim()
    const group = String(record.group ?? '').trim()
    validCount += 1
    map.set(label, { key, label, field, value, group })
  }
  return {
    entries: Array.from(map.values()),
    skippedInvalid,
    skippedMissing,
    duplicateCount: Math.max(0, validCount - map.size),
  }
}

function mergeImportedFilterPresets(
  entries: FilterPresetImportEntry[],
  presets: FilterPreset[],
  prefix: string,
  mode: 'merge' | 'replace'
): { presets: FilterPreset[]; added: number; updated: number } {
  const next = mode === 'replace' ? [] : [...presets]
  const usedKeys = new Set(next.map((preset) => preset.key))
  let added = 0
  let updated = 0
  const ensureKey = (rawKey: string): string => {
    let key = rawKey || createFilterPresetKey(prefix)
    while (usedKeys.has(key)) {
      key = createFilterPresetKey(prefix)
    }
    usedKeys.add(key)
    return key
  }
  for (const entry of entries) {
    const label = entry.label
    const value = entry.value
    const field = entry.field
    const group = String(entry.group || '').trim()
    const rawKey = entry.key
    const existingIndex = next.findIndex((preset) => preset.label === label)
    if (existingIndex >= 0) {
      next[existingIndex] = { ...next[existingIndex], field, value, group }
      updated += 1
      continue
    }
    next.push({ key: ensureKey(rawKey), label, field, value, group })
    added += 1
  }
  return { presets: next, added, updated }
}

function exportFilterPresets(presets: FilterPreset[], label: string, filenamePrefix: string) {
  if (!presets.length) {
    setDeepLinkMessage(`暂无可导出的${label}过滤预设。`, true)
    return
  }
  const payload = JSON.stringify(presets, null, 2)
  const blob = new Blob([payload], { type: 'application/json;charset=utf-8;' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `${filenamePrefix}-${Date.now()}.json`
  link.click()
  URL.revokeObjectURL(link.href)
  setDeepLinkMessage(`已导出${label}过滤预设。`)
}

function importBomFilterPresetsFromText(raw: string) {
  const trimmed = raw.trim()
  if (!trimmed) {
    setDeepLinkMessage('请粘贴 BOM 过滤预设 JSON。', true)
    return
  }
  try {
    const { entries, skippedInvalid, skippedMissing, duplicateCount } = parseFilterPresetImport(
      trimmed,
      bomFilterFieldOptions
    )
    const skippedParts: string[] = []
    if (duplicateCount) skippedParts.push(`重复 ${duplicateCount} 条`)
    if (skippedInvalid) skippedParts.push(`格式错误 ${skippedInvalid} 条`)
    if (skippedMissing) skippedParts.push(`缺少字段 ${skippedMissing} 条`)
    const skippedText = skippedParts.length ? `，忽略 ${skippedParts.join('，')}` : ''
    if (!entries.length) {
      if (skippedParts.length) {
        setDeepLinkMessage(`未导入有效 BOM 过滤预设${skippedText}。`, true)
      } else {
        setDeepLinkMessage('未发现可导入的 BOM 过滤预设。', true)
      }
      return
    }
    const existingLabels = bomFilterPresets.value.map((preset) => preset.label)
    const existingLabelSet = new Set(existingLabels)
    const conflictLabels = entries
      .filter((entry) => existingLabelSet.has(entry.label))
      .map((entry) => entry.label)
    const confirmed = confirmFilterPresetImport(
      'BOM',
      bomFilterPresetImportMode.value,
      existingLabels,
      conflictLabels
    )
    if (!confirmed) {
      setDeepLinkMessage('已取消导入 BOM 过滤预设。', true)
      return
    }
    const { presets, added, updated } = mergeImportedFilterPresets(
      entries,
      bomFilterPresets.value,
      'bom',
      bomFilterPresetImportMode.value
    )
    bomFilterPresets.value = presets
    persistFilterPresets(BOM_FILTER_PRESETS_STORAGE_KEY, presets)
    bomFilterPresetImportText.value = ''
    if (!presets.some((preset) => preset.key === bomFilterPresetKey.value)) {
      bomFilterPresetKey.value = ''
    }
    const importedCount = added + updated
    if (importedCount) {
      setDeepLinkMessage(
        `已导入 ${importedCount} 条 BOM 过滤预设（新增 ${added}，更新 ${updated}）${skippedText}。`
      )
    } else if (skippedParts.length) {
      setDeepLinkMessage(`未导入有效 BOM 过滤预设${skippedText}。`, true)
    } else {
      setDeepLinkMessage('未发现可导入的 BOM 过滤预设。', true)
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'not-array') {
      setDeepLinkMessage('BOM 过滤预设 JSON 需要是数组。', true)
      return
    }
    setDeepLinkMessage('BOM 过滤预设 JSON 解析失败。', true)
  }
}

function importBomFilterPresets() {
  importBomFilterPresetsFromText(bomFilterPresetImportText.value)
}

function exportBomFilterPresets() {
  exportFilterPresets(bomFilterPresets.value, 'BOM', 'plm-bom-filter-presets')
}

function triggerBomFilterPresetFileImport() {
  bomFilterPresetFileInput.value?.click()
}

async function importBomFilterPresetFile(file: File) {
  if (!file) return
  if (file.type && !file.type.includes('json') && !file.name.endsWith('.json')) {
    setDeepLinkMessage('仅支持 BOM 过滤预设 JSON 文件。', true)
    return
  }
  try {
    const text = await file.text()
    importBomFilterPresetsFromText(text)
  } catch (_err) {
    setDeepLinkMessage('读取 BOM 过滤预设文件失败。', true)
  }
}

async function handleBomFilterPresetFileImport(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  await importBomFilterPresetFile(file)
  target.value = ''
}

function clearBomFilterPresets() {
  if (!bomFilterPresets.value.length) return
  bomFilterPresets.value = []
  persistFilterPresets(BOM_FILTER_PRESETS_STORAGE_KEY, [])
  bomFilterPresetKey.value = ''
  bomFilterPresetGroupFilter.value = 'all'
  setDeepLinkMessage('已清空 BOM 过滤预设。')
}

function importWhereUsedFilterPresetsFromText(raw: string) {
  const trimmed = raw.trim()
  if (!trimmed) {
    setDeepLinkMessage('请粘贴 Where-Used 过滤预设 JSON。', true)
    return
  }
  try {
    const { entries, skippedInvalid, skippedMissing, duplicateCount } = parseFilterPresetImport(
      trimmed,
      whereUsedFilterFieldOptions
    )
    const skippedParts: string[] = []
    if (duplicateCount) skippedParts.push(`重复 ${duplicateCount} 条`)
    if (skippedInvalid) skippedParts.push(`格式错误 ${skippedInvalid} 条`)
    if (skippedMissing) skippedParts.push(`缺少字段 ${skippedMissing} 条`)
    const skippedText = skippedParts.length ? `，忽略 ${skippedParts.join('，')}` : ''
    if (!entries.length) {
      if (skippedParts.length) {
        setDeepLinkMessage(`未导入有效 Where-Used 过滤预设${skippedText}。`, true)
      } else {
        setDeepLinkMessage('未发现可导入的 Where-Used 过滤预设。', true)
      }
      return
    }
    const existingLabels = whereUsedFilterPresets.value.map((preset) => preset.label)
    const existingLabelSet = new Set(existingLabels)
    const conflictLabels = entries
      .filter((entry) => existingLabelSet.has(entry.label))
      .map((entry) => entry.label)
    const confirmed = confirmFilterPresetImport(
      'Where-Used',
      whereUsedFilterPresetImportMode.value,
      existingLabels,
      conflictLabels
    )
    if (!confirmed) {
      setDeepLinkMessage('已取消导入 Where-Used 过滤预设。', true)
      return
    }
    const { presets, added, updated } = mergeImportedFilterPresets(
      entries,
      whereUsedFilterPresets.value,
      'where-used',
      whereUsedFilterPresetImportMode.value
    )
    whereUsedFilterPresets.value = presets
    persistFilterPresets(WHERE_USED_FILTER_PRESETS_STORAGE_KEY, presets)
    whereUsedFilterPresetImportText.value = ''
    if (!presets.some((preset) => preset.key === whereUsedFilterPresetKey.value)) {
      whereUsedFilterPresetKey.value = ''
    }
    const importedCount = added + updated
    if (importedCount) {
      setDeepLinkMessage(
        `已导入 ${importedCount} 条 Where-Used 过滤预设（新增 ${added}，更新 ${updated}）${skippedText}。`
      )
    } else if (skippedParts.length) {
      setDeepLinkMessage(`未导入有效 Where-Used 过滤预设${skippedText}。`, true)
    } else {
      setDeepLinkMessage('未发现可导入的 Where-Used 过滤预设。', true)
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'not-array') {
      setDeepLinkMessage('Where-Used 过滤预设 JSON 需要是数组。', true)
      return
    }
    setDeepLinkMessage('Where-Used 过滤预设 JSON 解析失败。', true)
  }
}

function importWhereUsedFilterPresets() {
  importWhereUsedFilterPresetsFromText(whereUsedFilterPresetImportText.value)
}

function exportWhereUsedFilterPresets() {
  exportFilterPresets(whereUsedFilterPresets.value, 'Where-Used', 'plm-where-used-filter-presets')
}

function triggerWhereUsedFilterPresetFileImport() {
  whereUsedFilterPresetFileInput.value?.click()
}

async function importWhereUsedFilterPresetFile(file: File) {
  if (!file) return
  if (file.type && !file.type.includes('json') && !file.name.endsWith('.json')) {
    setDeepLinkMessage('仅支持 Where-Used 过滤预设 JSON 文件。', true)
    return
  }
  try {
    const text = await file.text()
    importWhereUsedFilterPresetsFromText(text)
  } catch (_err) {
    setDeepLinkMessage('读取 Where-Used 过滤预设文件失败。', true)
  }
}

async function handleWhereUsedFilterPresetFileImport(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  await importWhereUsedFilterPresetFile(file)
  target.value = ''
}

function clearWhereUsedFilterPresets() {
  if (!whereUsedFilterPresets.value.length) return
  whereUsedFilterPresets.value = []
  persistFilterPresets(WHERE_USED_FILTER_PRESETS_STORAGE_KEY, [])
  whereUsedFilterPresetKey.value = ''
  whereUsedFilterPresetGroupFilter.value = 'all'
  setDeepLinkMessage('已清空 Where-Used 过滤预设。')
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
  if (documentRole.value || documentFilter.value) targets.push(deepLinkPanelLabels.documents)
  if (approvalsStatus.value !== DEFAULT_APPROVAL_STATUS || approvalsFilter.value) {
    targets.push(deepLinkPanelLabels.approvals)
  }
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
  append('whereUsedFilterField', whereUsedFilterField.value !== 'all' ? whereUsedFilterField.value : undefined)
  append('bomDepth', bomDepth.value !== DEFAULT_BOM_DEPTH ? bomDepth.value : undefined)
  append('bomEffectiveAt', bomEffectiveAt.value)
  append('bomFilter', bomFilter.value)
  append('bomFilterField', bomFilterField.value !== 'all' ? bomFilterField.value : undefined)
  append('bomView', bomView.value !== 'table' ? bomView.value : undefined)
  if (bomView.value === 'tree' && bomCollapsed.value.size) {
    const collapsedValue = serializeBomCollapsed(bomCollapsed.value)
    append('bomCollapsed', collapsedValue)
  }
  append('compareLeftId', compareLeftId.value)
  append('compareRightId', compareRightId.value)
  append('compareMode', compareMode.value)
  append('compareLineKey', compareLineKey.value !== DEFAULT_COMPARE_LINE_KEY ? compareLineKey.value : undefined)
  append('compareMaxLevels', compareMaxLevels.value !== DEFAULT_COMPARE_MAX_LEVELS ? compareMaxLevels.value : undefined)
  append('compareIncludeChildFields', compareIncludeChildFields.value !== true ? compareIncludeChildFields.value : undefined)
  append('compareIncludeSubstitutes', compareIncludeSubstitutes.value !== false ? compareIncludeSubstitutes.value : undefined)
  append('compareIncludeEffectivity', compareIncludeEffectivity.value !== false ? compareIncludeEffectivity.value : undefined)
  append('compareSync', compareSyncEnabled.value !== true ? compareSyncEnabled.value : undefined)
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
  const whereUsedFilterFieldParam = readQueryParam('whereUsedFilterField')
  if (whereUsedFilterFieldParam !== undefined) {
    const matched = whereUsedFilterFieldOptions.find(
      (entry) => entry.value === whereUsedFilterFieldParam
    )
    if (matched) {
      whereUsedFilterField.value = matched.value
    }
  }
  const bomDepthParam = parseQueryNumber(readQueryParam('bomDepth'))
  if (bomDepthParam !== undefined) {
    bomDepth.value = Math.max(1, Math.floor(bomDepthParam))
  }
  const bomEffectiveAtParam = readQueryParam('bomEffectiveAt')
  if (bomEffectiveAtParam !== undefined) {
    bomEffectiveAt.value = bomEffectiveAtParam
  }
  const bomFilterParam = readQueryParam('bomFilter')
  if (bomFilterParam !== undefined) {
    bomFilter.value = bomFilterParam
  }
  const bomFilterFieldParam = readQueryParam('bomFilterField')
  if (bomFilterFieldParam !== undefined) {
    const matched = bomFilterFieldOptions.find((entry) => entry.value === bomFilterFieldParam)
    if (matched) {
      bomFilterField.value = matched.value
    }
  }
  const bomViewParam = readQueryParam('bomView')
  if (bomViewParam !== undefined) {
    const normalized = bomViewParam.trim().toLowerCase()
    if (normalized === 'tree' || normalized === 'table') {
      bomView.value = normalized as typeof bomView.value
    }
  }
  const bomCollapsedParam = readQueryParam('bomCollapsed')
  if (bomCollapsedParam !== undefined) {
    const parsed = filterBomCollapsed(parseBomCollapsed(bomCollapsedParam))
    bomCollapsed.value = parsed
    persistBomCollapsed(parsed)
  } else if (bomView.value === 'tree') {
    const stored = loadStoredBomCollapsed()
    if (stored) {
      bomCollapsed.value = filterBomCollapsed(stored)
    }
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
  const compareSyncParam = parseQueryBoolean(readQueryParam('compareSync'))
  if (compareSyncParam !== undefined) {
    compareSyncEnabled.value = compareSyncParam
  }
  const bomLineParam = readQueryParam('bomLineId')
  if (bomLineParam !== undefined) {
    bomLineId.value = bomLineParam
  }
  const substitutesFilterParam = readQueryParam('substitutesFilter')
  if (substitutesFilterParam !== undefined) {
    substitutesFilter.value = substitutesFilterParam
  }

  const bomPresetShareParam = readQueryParam('bomPresetShare')
  if (bomPresetShareParam !== undefined) {
    if (bomPresetShareParam) {
      const mode = resolvePresetShareMode(readQueryParam('bomPresetShareMode'))
      importBomFilterPresetShare(bomPresetShareParam, mode)
    }
    syncQueryParams({ bomPresetShare: undefined, bomPresetShareMode: undefined })
  }
  const whereUsedPresetShareParam = readQueryParam('whereUsedPresetShare')
  if (whereUsedPresetShareParam !== undefined) {
    if (whereUsedPresetShareParam) {
      const mode = resolvePresetShareMode(readQueryParam('whereUsedPresetShareMode'))
      importWhereUsedFilterPresetShare(whereUsedPresetShareParam, mode)
    }
    syncQueryParams({ whereUsedPresetShare: undefined, whereUsedPresetShareMode: undefined })
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
  if (allowsPanel('documents') && productId.value) tasks.push(loadDocuments())
  if (allowsPanel('approvals') && productId.value) tasks.push(loadApprovals())
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

function loadStoredPresets(): DeepLinkPreset[] {
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
      .filter(Boolean) as DeepLinkPreset[]
  } catch (_err) {
    return []
  }
}

function loadStoredFilterPresets(storageKey: string): FilterPreset[] {
  if (typeof localStorage === 'undefined') {
    return []
  }
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((entry) => {
        const key = String(entry?.key || '').trim()
        const label = String(entry?.label || '').trim()
        const field = String(entry?.field || '').trim()
        const value = String(entry?.value || '').trim()
        const group = String(entry?.group || '').trim()
        if (!key || !label || !field || !value) return null
        return { key, label, field, value, group }
      })
      .filter(Boolean) as FilterPreset[]
  } catch (_err) {
    return []
  }
}

function persistPresets(presets: DeepLinkPreset[]) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(DEEP_LINK_PRESETS_STORAGE_KEY, JSON.stringify(presets))
  } catch (_err) {
    // ignore storage errors
  }
}

function persistFilterPresets(storageKey: string, presets: FilterPreset[]) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(storageKey, JSON.stringify(presets))
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

function formatEffectivityProps(props: Record<string, any>): string {
  const from = props.effectivity_from ?? props.effectivityFrom ?? props.effectivity_from_date
  const to = props.effectivity_to ?? props.effectivityTo ?? props.effectivity_to_date
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

function formatEffectivity(entry: Record<string, any>): string {
  const props = resolveCompareLineProps(entry)
  const primary = formatEffectivityProps(props)
  if (primary !== '-') return primary

  const beforeProps = entry?.before_line || entry?.before || {}
  const afterProps = entry?.after_line || entry?.after || {}
  const beforeText = formatEffectivityProps(beforeProps)
  const afterText = formatEffectivityProps(afterProps)
  if (beforeText !== '-' || afterText !== '-') {
    if (beforeText !== afterText && beforeText !== '-' && afterText !== '-') {
      return `${beforeText} → ${afterText}`
    }
    return afterText !== '-' ? afterText : beforeText
  }
  return '-'
}

function formatSubstituteCount(entry: Record<string, any>): string {
  const resolveCount = (props: Record<string, any>): number | null => {
    const subs = props.substitutes ?? props.substitute_items
    if (Array.isArray(subs)) return subs.length
    const raw = props.substitute_count ?? props.substitutes_count ?? props.substituteCount
    const count = Number(raw)
    if (Number.isFinite(count)) return count
    return null
  }

  const props = resolveCompareLineProps(entry)
  const count = resolveCount(props)
  if (count !== null) {
    return count > 0 ? String(count) : '-'
  }

  const beforeProps = entry?.before_line || entry?.before || {}
  const afterProps = entry?.after_line || entry?.after || {}
  const beforeCount = resolveCount(beforeProps)
  const afterCount = resolveCount(afterProps)
  if (beforeCount !== null || afterCount !== null) {
    const beforeText = beforeCount && beforeCount > 0 ? String(beforeCount) : '-'
    const afterText = afterCount && afterCount > 0 ? String(afterCount) : '-'
    if (beforeText !== afterText) {
      return `${beforeText} → ${afterText}`
    }
    return afterText !== '-' ? afterText : beforeText
  }
  return '-'
}

function filterCompareEntries(entries: any[]): any[] {
  const needle = compareFilter.value.trim().toLowerCase()
  if (!needle) return entries
  return entries.filter((entry) => {
    const pathNodes = Array.isArray(entry?.path) ? entry.path : []
    const pathTokens = pathNodes.flatMap((node: any) => [
      node?.id,
      node?.item_number,
      node?.itemNumber,
      node?.code,
      node?.name,
      node?.label,
    ])
    const lineProps = resolveCompareLineProps(entry)
    const tokens = [
      getItemNumber(entry.parent),
      getItemName(entry.parent),
      getItemNumber(entry.child),
      getItemName(entry.child),
      entry.relationship_id,
      entry.line_key,
      lineProps.find_num ?? lineProps.findNum,
      lineProps.refdes,
      lineProps.quantity,
      lineProps.uom,
      ...pathTokens,
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
  const headers = [
    'level',
    'parent_id',
    'parent_number',
    'parent_name',
    'path',
    'path_ids',
    'quantity',
    'uom',
    'find_num',
    'refdes',
    'relationship_id',
  ]
  const rows = whereUsedFilteredRows.value.map((entry: any) => [
    String(entry.level ?? ''),
    String(entry.parent?.id || entry.relationship?.source_id || ''),
    getItemNumber(entry.parent),
    getItemName(entry.parent),
    entry.pathLabel || '',
    formatWhereUsedEntryPathIds(entry),
    (() => {
      const value = getWhereUsedLineValue(entry, 'quantity')
      return value === '-' ? '' : value
    })(),
    (() => {
      const value = getWhereUsedLineValue(entry, 'uom')
      return value === '-' ? '' : value
    })(),
    (() => {
      const value = getWhereUsedLineValue(entry, 'find_num')
      return value === '-' ? '' : value
    })(),
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

async function copyCompareDetailRows() {
  if (!compareDetailRows.value.length) {
    setDeepLinkMessage('暂无字段对照', true)
    return
  }
  const headers = [
    'field_key',
    'field_label',
    'description',
    'left',
    'right',
    'severity',
    'normalized_left',
    'normalized_right',
  ]
  const rows = compareDetailRows.value.map((row) => [
    row.key,
    row.label,
    row.description || '',
    row.left === '-' ? '' : row.left,
    row.right === '-' ? '' : row.right,
    row.severity || '',
    row.normalizedLeft || '',
    row.normalizedRight || '',
  ])
  const lines = [headers, ...rows].map((line) => line.join('\t')).join('\n')
  const ok = await copyToClipboard(lines)
  if (!ok) {
    setDeepLinkMessage('复制字段对照失败', true)
    return
  }
  setDeepLinkMessage(`已复制字段对照：${rows.length} 行`)
}

function exportCompareDetailCsv() {
  if (!compareDetailRows.value.length) {
    setDeepLinkMessage('暂无字段对照', true)
    return
  }
  const headers = [
    'field_key',
    'field_label',
    'description',
    'left',
    'right',
    'severity',
    'normalized_left',
    'normalized_right',
  ]
  const rows = compareDetailRows.value.map((row) => [
    row.key,
    row.label,
    row.description || '',
    row.left === '-' ? '' : row.left,
    row.right === '-' ? '' : row.right,
    row.severity || '',
    row.normalizedLeft || '',
    row.normalizedRight || '',
  ])
  downloadCsv(`plm-bom-compare-detail-${Date.now()}.csv`, headers, rows)
  setDeepLinkMessage('已导出字段对照。')
}


function exportBomCsv() {
  const normalize = (value: string) => (value === '-' ? '' : value)
  if (bomView.value === 'tree') {
    const headers = [
      'root_product_id',
      'depth',
      'path',
      'path_ids',
      'component_code',
      'component_name',
      'component_id',
      'quantity',
      'unit',
      'find_num',
      'refdes',
      'bom_line_id',
      'parent_component_id',
      'parent_line_id',
    ]
    const rowMap = new Map(bomTreeRows.value.map((row) => [row.key, row]))
    const included = bomTreeFilteredKeys.value
    const rootProductId = String(productId.value || productView.value.id || '')
    const rows = bomTreeRows.value
      .filter((row) => row.line && included.has(row.key))
      .map((row) => {
        const line = row.line || {}
        const labels = row.pathLabels?.length
          ? row.pathLabels
          : [String(row.label || row.componentId || row.key)]
        const idChain = row.pathIds?.length
          ? row.pathIds
          : [String(row.componentId || row.label || row.key)]
        const parentRow = row.parentKey ? rowMap.get(row.parentKey) : undefined
        const parentComponentId = parentRow?.componentId || ''
        const parentLineId = parentRow?.line ? resolveBomLineId(parentRow.line) : ''
        return [
          rootProductId,
          String(row.depth ?? ''),
          labels.join(' / '),
          idChain.join(' / '),
          normalize(String(line.component_code ?? line.componentCode ?? '')),
          normalize(String(line.component_name ?? line.componentName ?? '')),
          String(resolveBomChildId(line) || row.componentId || ''),
          normalize(String(line.quantity ?? '')),
          normalize(String(line.unit ?? line.uom ?? '')),
          normalize(String(formatBomFindNum(line) || '')),
          normalize(String(formatBomRefdes(line) || '')),
          String(resolveBomLineId(line) || ''),
          String(parentComponentId || ''),
          String(parentLineId || ''),
        ]
      })
    downloadCsv(`plm-bom-tree-${Date.now()}.csv`, headers, rows)
    return
  }
  const headers = [
    'level',
    'component_code',
    'component_name',
    'component_id',
    'quantity',
    'unit',
    'find_num',
    'refdes',
    'path_ids',
    'bom_line_id',
    'parent_item_id',
  ]
  const rows = bomFilteredItems.value.map((item: any) => [
    String(item.level ?? ''),
    normalize(String(item.component_code ?? item.componentCode ?? '')),
    normalize(String(item.component_name ?? item.componentName ?? '')),
    String(resolveBomChildId(item) || ''),
    normalize(String(item.quantity ?? '')),
    normalize(String(item.unit ?? '')),
    normalize(String(formatBomFindNum(item) || '')),
    normalize(String(formatBomRefdes(item) || '')),
    String(formatBomTablePathIds(item) || ''),
    String(resolveBomLineId(item) || ''),
    String(item.parent_item_id ?? item.parentItemId ?? ''),
  ])
  downloadCsv(`plm-bom-${Date.now()}.csv`, headers, rows)
}

function exportSubstitutesCsv() {
  const normalize = (value: string) => (value === '-' ? '' : value)
  const headers = [
    'bom_line_id',
    'substitute_id',
    'substitute_number',
    'substitute_name',
    'substitute_status',
    'part_id',
    'part_number',
    'part_name',
    'part_status',
    'rank',
    'note',
    'relationship_id',
  ]
  const rows = substitutesRows.value.map((entry: any) => [
    String(substitutes.value?.bom_line_id || ''),
    normalize(String(getSubstituteId(entry) || '')),
    normalize(String(getSubstituteNumber(entry) || '')),
    normalize(String(getSubstituteName(entry) || '')),
    normalize(String(getSubstituteStatus(entry) || '')),
    String(entry.part?.id || ''),
    String(entry.part?.item_number || ''),
    String(entry.part?.name || ''),
    String(entry.part?.state || entry.part?.status || ''),
    normalize(String(formatSubstituteRank(entry) || '')),
    normalize(String(formatSubstituteNote(entry) || '')),
    String(entry.relationship?.id || ''),
  ])
  downloadCsv(`plm-substitutes-${Date.now()}.csv`, headers, rows)
}

function exportDocumentsCsv() {
  const headers = [
    'id',
    'name',
    'document_type',
    'revision',
    'role',
    'author',
    'source_system',
    'source_version',
    'mime_type',
    'file_size',
    'created_at',
    'updated_at',
    'preview_url',
    'download_url',
  ]
  const rows = documentsSorted.value.map((doc: any) => [
    String(doc.id || ''),
    String(getDocumentName(doc) || ''),
    String(getDocumentType(doc) || ''),
    String(getDocumentRevision(doc) || ''),
    String(getDocumentRole(doc) || ''),
    String(getDocumentAuthor(doc) || ''),
    String(getDocumentSourceSystem(doc) || ''),
    String(getDocumentSourceVersion(doc) || ''),
    String(getDocumentMime(doc) || ''),
    String(getDocumentSize(doc) ?? ''),
    String(getDocumentCreatedAt(doc) || ''),
    String(getDocumentUpdatedAt(doc) || ''),
    String(getDocumentPreviewUrl(doc) || ''),
    String(getDocumentDownloadUrl(doc) || ''),
  ])
  downloadCsv(`plm-documents-${Date.now()}.csv`, headers, rows)
}

function exportApprovalsCsv() {
  const headers = [
    'id',
    'title',
    'status',
    'type',
    'requester',
    'requester_id',
    'created_at',
    'product_number',
    'product_name',
    'product_id',
  ]
  const rows = approvalsSorted.value.map((entry: any) => [
    String(entry.id || ''),
    String(getApprovalTitle(entry) || ''),
    String(getApprovalStatus(entry) || ''),
    String(getApprovalType(entry) || ''),
    String(getApprovalRequester(entry) || ''),
    String(getApprovalRequesterId(entry) || ''),
    String(getApprovalCreatedAt(entry) || ''),
    String(getApprovalProductNumber(entry) || ''),
    String(getApprovalProductName(entry) || ''),
    String(getApprovalProductId(entry) || ''),
  ])
  downloadCsv(`plm-approvals-${Date.now()}.csv`, headers, rows)
}

function approvalStatusClass(value?: string): string {
  const normalized = (value || '').toLowerCase()
  if (normalized === 'approved') return 'status-approved'
  if (normalized === 'rejected') return 'status-rejected'
  return 'status-pending'
}

function itemStatusClass(value?: string): string {
  const normalized = (value || '').toLowerCase()
  if (!normalized || normalized === '-') return 'status-neutral'
  if (['released', 'active', 'approved', 'valid'].includes(normalized)) return 'status-approved'
  if (['obsolete', 'rejected', 'inactive', 'invalid'].includes(normalized)) return 'status-rejected'
  if (['draft', 'inwork', 'pending', 'review', 'wip'].includes(normalized)) return 'status-pending'
  return 'status-neutral'
}

function getCompareFieldLabel(field: string): string {
  return compareFieldLabelMap.value.get(field) || field
}

function normalizeCompareSeverity(value?: string): string {
  const normalized = (value || '').toLowerCase()
  if (normalized === 'major') return 'major'
  if (normalized === 'minor') return 'minor'
  return 'info'
}

function compareSeverityRank(value?: string): number {
  const normalized = normalizeCompareSeverity(value)
  if (normalized === 'major') return 3
  if (normalized === 'minor') return 2
  return 1
}

function getCompareEntrySeverity(entry: Record<string, any>): string {
  const explicit = entry?.severity
  if (explicit) return normalizeCompareSeverity(explicit)
  const changes = Array.isArray(entry?.changes) ? entry.changes : []
  if (!changes.length) return 'info'
  let best = 'info'
  let bestRank = 0
  for (const change of changes) {
    const meta = compareFieldMetaMap.value.get(change.field)
    const resolved = normalizeCompareSeverity(change.severity || meta?.severity)
    const rank = compareSeverityRank(resolved)
    if (rank > bestRank) {
      best = resolved
      bestRank = rank
    }
  }
  return best
}

function getCompareChangeRows(entry: Record<string, any>) {
  const changes = Array.isArray(entry?.changes) ? entry.changes : []
  const rows = changes.map((change: any, idx: number) => {
    const meta = compareFieldMetaMap.value.get(change.field)
    const severity = normalizeCompareSeverity(change.severity || meta?.severity)
    return {
      key: `${change.field || 'field'}-${idx}`,
      field: change.field,
      label: meta?.label || change.field || '-',
      description: meta?.source || '',
      normalized: meta?.normalized || '',
      severity,
      left: change.left,
      right: change.right,
    }
  })
  rows.sort((a: any, b: any) => {
    const rankDiff = compareSeverityRank(b.severity) - compareSeverityRank(a.severity)
    if (rankDiff) return rankDiff
    return String(a.label).localeCompare(String(b.label))
  })
  return rows
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

function compareRowClass(entry: Record<string, any>): string {
  const severity = getCompareEntrySeverity(entry)
  return `compare-row compare-row-${severity}`
}

onMounted(() => {
  refreshAuthStatus()
  authTimer = window.setInterval(refreshAuthStatus, 30000)
  window.addEventListener('storage', refreshAuthStatus)
  documentColumns.value = loadStoredColumns(DOCUMENT_COLUMNS_STORAGE_KEY, defaultDocumentColumns)
  approvalColumns.value = loadStoredColumns(APPROVAL_COLUMNS_STORAGE_KEY, defaultApprovalColumns)
  customDeepLinkPresets.value = loadStoredPresets()
  bomFilterPresets.value = loadStoredFilterPresets(BOM_FILTER_PRESETS_STORAGE_KEY)
  whereUsedFilterPresets.value = loadStoredFilterPresets(WHERE_USED_FILTER_PRESETS_STORAGE_KEY)
  if (['valid', 'expiring'].includes(authState.value)) {
    void loadBomCompareSchema()
  }
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
  () => [bomFilterPresetGroupFilter.value, bomFilterPresets.value],
  () => {
    if (!bomFilteredPresets.value.some((preset) => preset.key === bomFilterPresetKey.value)) {
      bomFilterPresetKey.value = ''
    }
    const allowed = new Set(bomFilteredPresets.value.map((preset) => preset.key))
    bomPresetSelection.value = bomPresetSelection.value.filter((key) => allowed.has(key))
  }
)

watch(
  () => [whereUsedFilterPresetGroupFilter.value, whereUsedFilterPresets.value],
  () => {
    if (!whereUsedFilteredPresets.value.some((preset) => preset.key === whereUsedFilterPresetKey.value)) {
      whereUsedFilterPresetKey.value = ''
    }
    const allowed = new Set(whereUsedFilteredPresets.value.map((preset) => preset.key))
    whereUsedPresetSelection.value = whereUsedPresetSelection.value.filter((key) => allowed.has(key))
  }
)

watch(showBomPresetManager, (value) => {
  if (value) return
  bomPresetSelection.value = []
  bomPresetBatchGroup.value = ''
})

watch(showWhereUsedPresetManager, (value) => {
  if (value) return
  whereUsedPresetSelection.value = []
  whereUsedPresetBatchGroup.value = ''
})

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
  () => [
    whereUsedFilter.value,
    whereUsedFilterField.value,
    compareFilter.value,
    substitutesFilter.value,
    bomFilter.value,
    bomFilterField.value,
  ],
  ([whereUsed, whereUsedField, compareValue, substituteValue, bomFilterValue, bomFilterFieldValue]) => {
    scheduleQuerySync({
      whereUsedFilter: whereUsed || undefined,
      whereUsedFilterField: whereUsedField !== 'all' ? whereUsedField : undefined,
      compareFilter: compareValue || undefined,
      substitutesFilter: substituteValue || undefined,
      bomFilter: bomFilterValue || undefined,
      bomFilterField: bomFilterFieldValue !== 'all' ? bomFilterFieldValue : undefined,
    })
  }
)

watch(
  whereUsed,
  () => {
    whereUsedCollapsed.value = new Set()
    whereUsedSelectedEntryKeys.value = new Set()
  }
)

watch(
  bomItems,
  () => {
    applyBomCollapsedState(resolveBomCollapsedState())
    bomSelectedLineIds.value = new Set()
  }
)

watch(
  bomCompare,
  () => {
    compareSelected.value = null
  }
)

watch(
  bomView,
  (value) => {
    if (value === 'tree') {
      applyBomCollapsedState(resolveBomCollapsedState())
    } else {
      syncBomCollapsedQuery(bomCollapsed.value)
    }
  }
)

watch(authState, (value) => {
  if (!compareSchema.value && !compareSchemaLoading.value && ['valid', 'expiring'].includes(value)) {
    void loadBomCompareSchema()
  }
})

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
    compareSyncEnabled.value,
    compareEffectiveAt.value,
    compareRelationshipProps.value,
    bomDepth.value,
    bomEffectiveAt.value,
    bomLineId.value,
    bomView.value,
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
    compareSyncValue,
    compareEffectiveValue,
    comparePropsValue,
    bomDepthValue,
    bomEffectiveValue,
    bomLineValue,
    bomViewValue,
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
      compareSync: compareSyncValue !== true ? compareSyncValue : undefined,
      compareEffectiveAt: compareEffectiveValue || undefined,
      compareRelationshipProps:
        comparePropsValue !== DEFAULT_COMPARE_REL_PROPS ? comparePropsValue : undefined,
      bomDepth: bomDepthValue !== DEFAULT_BOM_DEPTH ? bomDepthValue : undefined,
      bomEffectiveAt: bomEffectiveValue || undefined,
      bomLineId: bomLineValue || undefined,
      bomView: bomViewValue !== 'table' ? bomViewValue : undefined,
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

.field-inline {
  display: flex;
  gap: 6px;
  align-items: center;
}

.field-inline + .field-inline {
  margin-top: 6px;
}

.field-inline select {
  min-width: 120px;
}

.field-inline input {
  flex: 1;
  min-width: 0;
}

.field-actions {
  display: inline-flex;
  gap: 4px;
  flex-wrap: wrap;
}

.preset-manager {
  margin-top: 8px;
  padding: 8px;
  border: 1px dashed #e5e7eb;
  border-radius: 8px;
  background: #fafafa;
  display: grid;
  gap: 6px;
}

.preset-list {
  display: grid;
  gap: 4px;
  max-height: 160px;
  overflow: auto;
  padding-right: 4px;
}

.preset-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #374151;
}

.btn.danger {
  border-color: #fecaca;
  color: #b91c1c;
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

.context-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin: 8px 0;
  font-size: 12px;
  color: #111827;
}

.context-title {
  font-weight: 600;
  color: #374151;
}

.context-divider {
  width: 1px;
  height: 16px;
  background: #e5e7eb;
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

.data-table tbody tr {
  cursor: pointer;
}

.data-table tbody tr.row-selected {
  background: #f8fafc;
}

.where-used-tree,
.bom-tree {
  border: 1px solid #eef0f2;
  border-radius: 8px;
  overflow: hidden;
  margin-top: 8px;
}

.tree-row {
  display: grid;
  grid-template-columns: 1.6fr 1.2fr repeat(4, 0.6fr) 1fr 0.8fr;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border-bottom: 1px solid #eef0f2;
  font-size: 12px;
}

.tree-row:not(.tree-header) {
  cursor: pointer;
}

.tree-row.selected {
  background: #eff6ff;
}

.tree-row:last-child {
  border-bottom: none;
}

.tree-header {
  background: #f8fafc;
  font-weight: 600;
  color: #374151;
}

.tree-cell {
  min-width: 0;
}

.tree-node {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.tree-node-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.tree-bom-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tree-bom-meta .btn {
  align-self: flex-start;
}

.tree-toggle {
  border: none;
  background: transparent;
  color: #4b5563;
  font-size: 12px;
  line-height: 1;
  padding: 0;
  width: 16px;
  height: 16px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.tree-toggle:disabled {
  cursor: default;
  color: #cbd5f5;
}

.tree-root .tree-toggle {
  color: #111827;
}

.tree-multi {
  margin-left: 4px;
  font-size: 11px;
  color: #6b7280;
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

.compare-detail {
  margin-top: 12px;
  border: 1px solid #eef0f2;
  border-radius: 8px;
  padding: 10px 12px;
  background: #fdfdfd;
}

.compare-detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.compare-detail-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.compare-field-row.changed {
  background: #eef2ff;
}

.data-table.compact th,
.data-table.compact td {
  padding: 6px 6px;
  font-size: 12px;
}

.compare-row.compare-row-major {
  background: #fff1f2;
}

.compare-row.compare-row-minor {
  background: #fffbeb;
}

.compare-row.compare-row-info {
  background: #f8fafc;
}

.compare-row:hover {
  background: #eef2ff;
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

.compare-kind-added {
  color: #065f46;
  background: #d1fae5;
  border-color: #a7f3d0;
}

.compare-kind-removed {
  color: #7f1d1d;
  background: #fee2e2;
  border-color: #fecaca;
}

.compare-kind-changed {
  color: #92400e;
  background: #fef3c7;
  border-color: #fde68a;
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

.diff-field-meta {
  display: inline-flex;
  margin-left: 6px;
  font-size: 11px;
  color: #6b7280;
}

.diff-value {
  font-size: 12px;
  color: #111827;
}

.diff-value-left,
.diff-value-right {
  font-variant-numeric: tabular-nums;
}

.diff-arrow {
  margin: 0 6px;
  color: #9ca3af;
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
