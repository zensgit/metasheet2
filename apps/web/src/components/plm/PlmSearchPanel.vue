<template>
  <section class="panel">
    <div class="panel-header">
      <div>
        <h2>产品搜索</h2>
        <p class="subtext">基于联邦接口快速定位可用的 PLM 产品 ID</p>
      </div>
      <button class="btn primary" :disabled="panel.searchLoading.value" @click="panel.searchProducts">
        {{ panel.searchLoading.value ? '搜索中...' : '搜索' }}
      </button>
    </div>

    <div class="form-grid">
      <label for="plm-search-query">
        关键词
        <input
          id="plm-search-query"
          v-model.trim="panel.searchQuery.value"
          name="plmSearchQuery"
          placeholder="可留空，返回最新记录"
        />
      </label>
      <label for="plm-search-item-type">
        Item Type
        <input
          id="plm-search-item-type"
          v-model.trim="panel.searchItemType.value"
          name="plmSearchItemType"
          placeholder="Part"
        />
      </label>
      <label for="plm-search-limit">
        Limit
        <input
          id="plm-search-limit"
          v-model.number="panel.searchLimit.value"
          name="plmSearchLimit"
          type="number"
          min="1"
          max="50"
        />
      </label>
    </div>

    <p v-if="panel.searchError.value" class="status error">{{ panel.searchError.value }}</p>
    <p v-else-if="panel.searchResults.value.length" class="status">
      共 {{ panel.searchTotal.value }} 条，当前展示 {{ panel.searchResults.value.length }} 条
    </p>
    <div v-if="!panel.searchResults.value.length" class="empty">暂无搜索结果</div>
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
        <tr v-for="item in panel.searchResults.value" :key="item.id">
          <td>{{ item.name || '-' }}</td>
          <td>{{ item.partNumber || item.item_number || item.itemNumber || item.code || '-' }}</td>
          <td>{{ item.status || '-' }}</td>
          <td>{{ item.itemType || '-' }}</td>
          <td>{{ item.updatedAt || item.updated_at || '-' }}</td>
          <td>
            <div class="inline-actions">
              <button class="btn" @click="panel.applySearchItem(item)">使用</button>
              <button class="btn ghost mini" @click="panel.applyCompareFromSearch(item, 'left')">
                左对比
              </button>
              <button class="btn ghost mini" @click="panel.applyCompareFromSearch(item, 'right')">
                右对比
              </button>
              <button class="btn ghost mini" @click="panel.copySearchValue(item, 'id')">
                复制 ID
              </button>
              <button class="btn ghost mini" @click="panel.copySearchValue(item, 'number')">
                复制料号
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import type { PlmSearchPanelModel } from '../../views/plm/plmPanelModels'

defineProps<{
  panel: PlmSearchPanelModel
}>()
</script>

<style scoped src="./PlmPanelShared.css"></style>
