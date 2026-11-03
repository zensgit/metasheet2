<script setup lang="ts">
type Translate = (en: string, zh: string) => string

defineProps<{
  tr: Translate
}>()
</script>

<template>
  <details class="payroll-help" data-attendance-help="payroll-cycle">
    <summary>{{ tr('Attendance help', '考勤帮助') }}</summary>
    <div class="payroll-help__panel">
      <p>
        {{
          tr(
            'Dates are calendar days, shown as 年-月-日. The saved value stays yyyy-mm-dd.',
            '日期是日历日。中文界面用「年-月-日」选择，保存的值仍是 yyyy-mm-dd。',
          )
        }}
      </p>
      <ol class="payroll-help__steps">
        <li>
          <strong>{{ tr('1. One cycle', '1. 创建一条') }}</strong>
          <p>
            {{
              tr(
                'Manual (no template) needs both a start date and an end date, and the start must not be after the end. With a template, a blank start or end is filled from the template window using the anchor date, or today when the anchor is also blank. Name is optional. Status is open, closed, or archived. Load summary and Export CSV use the cycle you just saved or opened for edit. They do not create a cycle.',
                '选「手工」（不选模板）时，开始日期和结束日期都要填，且开始不能晚于结束。选了模板时，开始或结束留空会按锚点套用模板窗口；锚点也留空则按当天。名称可空。状态是开启、关闭或归档。「加载汇总」和「导出 CSV」针对刚保存或正在编辑的那一条，不会新建周期。',
              )
            }}
          </p>
        </li>
        <li>
          <strong>{{ tr('2. Batch', '2. 批量生成') }}</strong>
          <p>
            {{
              tr(
                'Pick a template, or leave it on Default template to use the template marked Default. Anchor date is required. Count is 1–36: each next cycle moves the anchor one month later and applies the template window. The name is “prefix start~end”; a blank prefix uses the template name. A cycle with the same start and end already in this org is skipped, not overwritten. Metadata must be JSON and is stored with the generation note. Status Closed also writes the settlement snapshot.',
                '选择模板，或保持「默认模板」以使用标了「默认」的那一份。锚点日期必填。数量是 1–36：下一条把锚点再推一个月，再套模板窗口。名称是「前缀 开始~结束」；前缀留空就用模板名称。本组织已有相同起止日的周期会被跳过，不会覆盖。元数据必须是 JSON，并和生成信息一起保存。状态选关闭时，还会写下结算快照。',
              )
            }}
          </p>
        </li>
      </ol>
      <figure class="payroll-help__figure">
        <figcaption>{{ tr('Three cycles from one anchor', '同一锚点连续生成 3 条') }}</figcaption>
        <ol class="payroll-help__batch" aria-hidden="true">
          <li><span>1</span><strong>{{ tr('Anchor month', '锚点当月') }}</strong></li>
          <li><span>2</span><strong>{{ tr('+1 month', '+1 个月') }}</strong></li>
          <li><span>3</span><strong>{{ tr('+2 months', '+2 个月') }}</strong></li>
        </ol>
      </figure>
    </div>
  </details>
</template>

<style scoped>
.payroll-help {
  font-size: 13px;
  color: var(--ms-text-2, #667085);
}

.payroll-help summary {
  cursor: pointer;
  color: var(--ms-color-primary, #2563eb);
  font-weight: 600;
}

.payroll-help__panel {
  display: grid;
  gap: 12px;
  margin-top: 8px;
  padding: 12px;
  border: 1px solid var(--ms-border-light, #eaecf0);
  border-radius: 8px;
  background: var(--ms-bg-page, #f8fafc);
  color: var(--ms-text-1, #1f2329);
}

.payroll-help__steps {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.payroll-help__steps p {
  margin: 4px 0 0;
}

.payroll-help__figure {
  margin: 0;
  display: grid;
  gap: 8px;
}

.payroll-help__batch {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.payroll-help__batch li {
  display: grid;
  justify-items: center;
  min-width: 88px;
  padding: 8px;
  border-radius: 8px;
  background: #dbeafe;
  color: #1e3a8a;
}

.payroll-help__batch span {
  font-size: 12px;
}
</style>
