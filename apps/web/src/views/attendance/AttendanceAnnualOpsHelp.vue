<script setup lang="ts">
type Translate = (en: string, zh: string) => string

defineProps<{
  tr: Translate
}>()
</script>

<template>
  <details class="annual-ops-help" data-attendance-help="annual-ops">
    <summary>{{ tr('Attendance help', '考勤帮助') }}</summary>
    <div class="annual-ops-help__panel">
      <p>
        {{
          tr(
            'These four cards write annual-leave minutes. While the engine is off, adjust, backfill, and accrual submits stay disabled. A single-balance preview only reads the balance and still runs.',
            '这四张卡写的是年假分钟。引擎关闭时，调整、回填和发放的提交按钮是禁用的。单人余额预览只读取余额，这时仍可点。',
          )
        }}
      </p>
      <ol class="annual-ops-help__steps">
        <li>
          <strong>{{ tr('1. Manual adjustment', '1. 手工调整') }}</strong>
          <p>
            {{
              tr(
                'Search a person by name or email. The request sends that user id. Reason is free text (1–500 characters); the list offers Grant, Reversal, and Manual correction, and you can type anything else. A positive amount creates a manual lot with no expiry. A negative amount deducts active lots first-expiring first and rolls the whole adjustment back if the balance is short.',
                '按姓名或邮箱搜索人员。请求提交的是该用户 ID。原因是自由文本（1–500 字）；列表里有补发、冲正、手工更正，也可以自己写。正数新建一条没有到期时间的手工额度。负数按先到期先扣，余额不够则整笔回滚。',
              )
            }}
          </p>
        </li>
        <li>
          <strong>{{ tr('2. Bulk adjustment', '2. 批量手工调整') }}</strong>
          <p>
            {{
              tr(
                'Each chip shows the person’s name. The payload is still one user id per row, at most 50, sharing one delta and one reason. Confirm once, then each person is posted separately with their own idempotency key. A partial failure keeps the per-row result; retry sends only the rows that did not succeed.',
                '每个标签显示人员姓名。提交的仍是每人一个用户 ID，最多 50 人，共用一份变动和原因。确认一次后，每人单独提交，并各有自己的幂等键。部分失败会留下每一行的结果；重试只提交还没成功的行。',
              )
            }}
          </p>
        </li>
        <li>
          <strong>{{ tr('3. Expiry backfill', '3. 过期回填') }}</strong>
          <p>
            {{
              tr(
                'Dry-run counts accrual lots that still have no expiry and writes nothing. Commit fills only those annual accrual lots, using the expiry stored on the run that created them. Manual-adjustment lots are not in the scan. A failed dry-run clears the previous one, so commit cannot reuse a stale count.',
                '预演只统计「发放产生、还没有到期时间」的额度，不写入。提交只补这些年假发放额度，到期时间用当时那次发放记下的值。手工调整产生的额度不在扫描里。预演失败会清掉上一次预演，提交不能沿用过期的计数。',
              )
            }}
          </p>
        </li>
        <li>
          <strong>{{ tr('4. Accrual', '4. 发放') }}</strong>
          <p>
            {{
              tr(
                'Period is 2000–2100. As-of defaults to today. A dry-run records the run and each person, and creates no balance lots. Commit is what creates the lots. A year that is not this year or next needs the extra confirmation. Changing the period or as-of clears the dry-run, so commit stays disabled until you preview again.',
                '年度在 2000–2100。截止日期默认今天。预演记下这次运行和每个人的结果，不生成余额。提交才会生成额度。不是今年或明年时，还要再勾一次确认。改年度或截止日期会清掉预演，要重新预演才能提交。',
              )
            }}
          </p>
        </li>
      </ol>
      <figure class="annual-ops-help__figure">
        <figcaption>{{ tr('What each button writes', '每个按钮写什么') }}</figcaption>
        <ol>
          <li>{{ tr('Preview: read balance', '预览：只读余额') }}</li>
          <li>{{ tr('Dry-run backfill: count only', '回填预演：只计数') }}</li>
          <li>{{ tr('Dry-run accrual: audit rows, no lots', '发放预演：运行记录，无额度') }}</li>
          <li>{{ tr('Commit: write the lots', '提交：写入额度') }}</li>
        </ol>
      </figure>
    </div>
  </details>
</template>

<style scoped>
.annual-ops-help {
  margin-left: auto;
  font-size: 13px;
  color: #667085;
}

.annual-ops-help summary {
  cursor: pointer;
  color: #2563eb;
  font-weight: 600;
}

.annual-ops-help__panel {
  margin-top: 8px;
  padding: 12px;
  border: 1px solid #eaecf0;
  border-radius: 8px;
  background: #f8fafc;
  color: #1f2329;
}

.annual-ops-help__steps {
  margin: 0;
  padding-left: 18px;
}

.annual-ops-help__steps p {
  margin: 4px 0 8px;
}

.annual-ops-help__figure {
  margin: 0;
}

.annual-ops-help__figure ol {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.annual-ops-help__figure li {
  padding: 6px 8px;
  border-radius: 6px;
  background: #fff;
  border-left: 3px solid #1d4ed8;
}
</style>
