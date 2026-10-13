<script setup lang="ts">
type Translate = (en: string, zh: string) => string

defineProps<{
  tr: Translate
}>()
</script>

<template>
  <details class="report-fields-help" data-attendance-help="report-fields">
    <summary>{{ tr('Attendance help', '考勤帮助') }}</summary>
    <div class="report-fields-help__panel">
      <p>
        {{
          tr(
            'Reload reads the catalog. Sync catalog makes sure the sheet exists, seeds missing field rows, then reads them back. Neither one pushes attendance period rows.',
            '重载字段只读取当前目录。同步字段目录会确保目录存在、补写缺失的字段行，再读回来。两者都不推送考勤周期数据。',
          )
        }}
      </p>
      <ol class="report-fields-help__steps">
        <li>
          <strong>{{ tr('1. Filters', '1. 筛选') }}</strong>
          <p>
            {{
              tr(
                'Search matches name, code, description, and the formula text. Status and category hide rows in the list. While a filter is active, the dependency graph is hidden and the live reference chips are replaced by the static chips.',
                '搜索匹配名称、编码、说明和公式文本。状态和分类只隐藏列表里的行。有筛选时，依赖图不显示，实时引用芯片换成静态芯片。',
              )
            }}
          </p>
        </li>
        <li>
          <strong>{{ tr('2. Formula scopes', '2. 公式范围') }}</strong>
          <p>
            {{
              tr(
                'An expression starts with =. Record scope reads {code} on that row. Summary scope wraps fields in SUM, AVERAGE, COUNT, or COUNTA, or uses aliases such as {total_minutes}. In v1 a formula field cannot reference another formula field. Preview is the check that matters, and it does not write the catalog.',
                '公式以 = 开头。单记录用 {编码} 读这一行。周期汇总用 SUM、AVERAGE、COUNT、COUNTA 包住字段，或用 {total_minutes} 这类别名。v1 不允许公式字段互相引用。预览是真正的校验，而且不写入目录。',
              )
            }}
          </p>
        </li>
        <li>
          <strong>{{ tr('3. Functions', '3. 函数') }}</strong>
          <p>
            {{
              tr(
                'The reference lists 29 functions in six groups: condition, logical, math, aggregate, date, and text. NOW, TODAY, lookups (VLOOKUP / INDEX / MATCH), cross-table cell refs, and scripts are blocked. System formulas have no edit button. Open Formula reference above the create form to insert a chip.',
                '公式参考列出 6 组共 29 个函数：条件、逻辑、数学、聚合、日期、文本。NOW、TODAY、查找函数（VLOOKUP / INDEX / MATCH）、跨表单元格引用和脚本被禁用。系统公式没有编辑按钮。创建表单上方展开「公式参考」可点芯片。',
              )
            }}
          </p>
        </li>
      </ol>
      <figure class="report-fields-help__figure">
        <figcaption>{{ tr('Reload vs sync', '重载与同步') }}</figcaption>
        <ol>
          <li>{{ tr('Reload: read only', '重载：只读目录') }}</li>
          <li>{{ tr('Sync: seed missing field rows', '同步：补齐缺失字段行') }}</li>
          <li>{{ tr('Preview: does not save', '预览：不保存') }}</li>
        </ol>
      </figure>
    </div>
  </details>
</template>

<style scoped>
.report-fields-help {
  font-size: 13px;
  color: #667085;
}

.report-fields-help summary {
  cursor: pointer;
  color: #2563eb;
  font-weight: 600;
}

.report-fields-help__panel {
  margin-top: 8px;
  padding: 12px;
  border: 1px solid #eaecf0;
  border-radius: 8px;
  background: #f8fafc;
  color: #1f2329;
}

.report-fields-help__steps {
  margin: 0;
  padding-left: 18px;
}

.report-fields-help__steps p {
  margin: 4px 0 8px;
}

.report-fields-help__figure {
  margin: 0;
}

.report-fields-help__figure ol {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.report-fields-help__figure li {
  padding: 6px 8px;
  border-radius: 6px;
  background: #fff;
  border-left: 3px solid #1d4ed8;
}
</style>
