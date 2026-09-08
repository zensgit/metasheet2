<template>
  <div class="sp-help" data-testid="stock-prep-help-card">
    <p class="sp-help__lead">
      {{ bi(
        '这一页说清三件事:平常怎么用、第一次怎么装、出问题了去哪查。每一条后面都有一个直接跳过去的链接。',
        'Three things, in plain words: how this page is used day to day, how a deployment is set up the first time, and where to look when something goes wrong. Each one links straight to the place it happens.',
      ) }}
    </p>

    <!--
      三条流程,一条一段。每段一句"这是给谁的",一句"按什么顺序做",再一个直链。
      DIRECT LINKS ARE TAB SWITCHES, not routes: the shell owns navigation for this page and every
      other in-page jump on it already goes through `navigate-stage`. Emitting a key the rail may not
      be showing this principal is impossible here — each link is rendered only when its own flow is
      offered, and the shell folds every key through `visibleViews` before it activates one.
    -->
    <section
      v-for="flow in flows"
      :key="flow.key"
      class="sp-help__flow"
      :data-testid="`stock-prep-help-flow-${flow.key}`"
    >
      <h3 class="sp-help__h3">{{ bi(flow.zhTitle, flow.enTitle) }}</h3>
      <p class="sp-help__who">{{ bi(flow.zhWho, flow.enWho) }}</p>
      <p class="sp-help__body">{{ bi(flow.zhBody, flow.enBody) }}</p>
      <!--
        R-11 ON A HELP PAGE. A link is a control, so it renders only when its destination is one this
        principal actually has. A `stock-prep:read` queue watcher sees this page (it is static copy)
        but has neither 今天要处理 nor 开始使用; a link to them would either 403 on arrival or —
        worse, because the shell folds an unknown key back to the landing — silently do nothing.
      -->
      <button
        v-if="props.availableKeys.includes(flow.target)"
        type="button"
        class="sp-help__link"
        :data-testid="`stock-prep-help-link-${flow.key}`"
        @click="emit('navigate-stage', flow.target)"
      >
        {{ bi(flow.zhLink, flow.enLink) }}
      </button>
    </section>

    <p class="sp-help__foot">
      {{ bi(
        '看到一串大写英文的报错码,在下面的「错误码对照」里搜它,那里写了这条码是什么意思、下一步该做什么、该找谁。',
        'If an all-caps error code comes up, search it in the code reference below: it says what the code means, what to do next, and whose job that is.',
      ) }}
    </p>
  </div>
</template>

<script setup lang="ts">
// P1-1 / 设计稿 §2.2 【帮助】—「怎么用这个页面」。
//
// STATIC BY DESIGN. It issues no request, reads no service and holds no state: it is the one place
// on this workbench that is allowed to be a page of prose, and giving it a data dependency would
// mean the help page can fail to load. Every sentence describes behaviour that already shipped —
// nothing here promises a control that does not exist.
//
// VALUES-FREE. No project number, no part number, no host name; 「一个项目」 stands in for whatever
// the reader is holding, exactly as the design doc's own wireframes do.
//
// The 错误码对照 half of this rail group is NOT here: it is the existing, self-contained
// `StockPreparationCodeHelpPanel`, mounted as this view's second section by the shell. One tab, two
// sections — a second tab key would have addressed a disclosure that is already one click away.
import { useLocale } from '../../../composables/useLocale'

const props = withDefaults(defineProps<{
  /**
   * The rail keys this principal can actually reach, handed down by the shell. The card decides
   * NOTHING about permissions itself — it only asks "is this destination on the rail?", which is the
   * same folded list the rail renders.
   */
  availableKeys?: string[]
}>(), { availableKeys: () => [] })

const emit = defineEmits<{ (e: 'navigate-stage', viewKey: string): void }>()

const { locale } = useLocale()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

interface StockPrepHelpFlow {
  key: string
  zhTitle: string
  enTitle: string
  zhWho: string
  enWho: string
  zhBody: string
  enBody: string
  /** The rail key this flow starts on. */
  target: string
  zhLink: string
  enLink: string
}

const flows: StockPrepHelpFlow[] = [
  {
    key: 'daily',
    zhTitle: '平常怎么用',
    enTitle: 'Day to day',
    zhWho: '给一线:采购、仓库、备料员。',
    enWho: 'For the floor: purchasing, warehouse, whoever prepares materials.',
    zhBody: '打开页面先看「今天要处理」,上面列着在等您的项目。点进一个项目:先从 PLM 把 BOM 拉进来;'
      + '系统拿不准的行会停下来问您,逐条拿完主意以后回来再同步一次,数据才会写进多维表;'
      + '要给别人一份就导出 Excel。整个过程不会改动 ERP/K3 里的任何数据。',
    enBody: 'Start on 今天要处理 — it lists the projects waiting for you. Open one: pull its BOM in from PLM;'
      + ' anything the system is unsure about stops and asks you, and once you have decided each one you come back'
      + ' and sync again — that is the step that writes the data into the multitable. Export to Excel when someone'
      + ' needs a copy. None of this changes anything inside ERP/K3.',
    target: 'home',
    zhLink: '去「今天要处理」',
    enLink: 'Go to 今天要处理',
  },
  {
    key: 'onboarding',
    zhTitle: '第一次装这套东西',
    enTitle: 'Setting it up the first time',
    zhWho: '给管理员:第一次把这套部署接起来的人。',
    enWho: 'For the administrator setting a deployment up for the first time.',
    zhBody: '「开始使用」里是一张六步地图:接一条只读连接、证明它只能读、告诉备料用这条源、建表装列、'
      + '给角色授权、拿一个项目跑一遍。任何一步都能点开看 —— 它是地图,不是闸机,前一步没做完也不挡着您看后一步。'
      + '装完之后再回来复查,去「数据来源与体检」。',
    enBody: '开始使用 lays out six steps: wire a read-only connection, prove it can only read, point stock preparation'
      + ' at it, create the tables and columns, grant the roles, then take one project through end to end. Every step'
      + ' opens — it is a map, not a turnstile, and an unfinished step never blocks the next one. Come back to'
      + ' Sources & Health Check afterwards to re-check.',
    target: 'getting-started',
    zhLink: '去「开始使用」',
    enLink: 'Go to 开始使用',
  },
  {
    key: 'troubleshooting',
    zhTitle: '出问题了去哪查',
    enTitle: 'When something looks wrong',
    zhWho: '给管理员:被问到「这个项目怎么回事」的时候。',
    enWho: 'For the administrator being asked what happened to a project.',
    zhBody: '「记录与排查」里有两块:上面是这套部署现在好不好(没检查过的项会明说「未检查」,不会涂成绿的);'
      + '下面按项目号查谁在什么时候动过它。那份记录只涵盖确认、对账、导出、通知下一步四类动作,'
      + '所以「这里没有记录」不等于「没有人动过这个项目」—— 面板上把这句话常驻写着。',
    enBody: '记录与排查 has two halves. The top one says whether this deployment is healthy right now — anything that'
      + ' has never been checked says so rather than being painted green. The bottom one looks up who touched a'
      + ' project and when. That record covers four kinds of action only, so "nothing here" does not mean "nobody'
      + ' touched it" — the panel says so permanently, in those words.',
    target: 'ops',
    zhLink: '去「记录与排查」',
    enLink: 'Go to 记录与排查',
  },
]
</script>

<style scoped>
.sp-help {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-4);
}

.sp-help__lead {
  margin: 0;
  color: var(--ms-text-2);
  line-height: 1.7;
}

.sp-help__flow {
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.sp-help__h3 {
  margin: 0 0 4px;
  font-size: var(--ms-font-size-section-title);
  color: var(--ms-text-1);
}

.sp-help__who {
  margin: 0 0 var(--ms-space-2);
  color: var(--ms-text-3);
  font-size: 13px;
}

.sp-help__body {
  margin: 0 0 var(--ms-space-3);
  color: var(--ms-text-2);
  line-height: 1.7;
}

.sp-help__link {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: var(--ms-bg-card);
  padding: 6px var(--ms-space-3);
  color: var(--ms-text-2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.sp-help__link:hover {
  color: var(--ms-color-primary);
  border-color: var(--ms-color-primary);
}

.sp-help__foot {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 13px;
  line-height: 1.7;
}
</style>
