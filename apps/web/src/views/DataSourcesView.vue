<template>
  <DataSourcesPanel />
</template>

<script setup lang="ts">
// Thin route shell. The whole 外接数据源 surface (markup, store wiring, data-testids) now lives in
// components/data-sources/DataSourcesPanel.vue so the SAME component can also be rendered inside
// 数据工厂's 连接管理 section. This view keeps the standalone page mounting alive for anyone who
// still reaches the page component directly; the '/data-sources' ROUTE itself now redirects into
// the workbench (see router/appRoutes.ts).
import DataSourcesPanel from '../components/data-sources/DataSourcesPanel.vue'
</script>
