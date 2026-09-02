// BOM备料 工作台 — 人话层 / THE PLAIN-LANGUAGE LAYER.
//
// WHY THIS FILE EXISTS. The workbench shipped speaking to the people who BUILT it: the install page
// led with `plm_stock_preparation_confirmation_decision`, `ext-columns-written-human-band-untouched`,
// `installerMayModify=false` and raw route paths, and the queues rendered their server enums
// (`keep_multiple_rows`, `pending_confirm`, `missing_child_bom`) as the primary content. Owner's
// verdict on the live deployment: 「这些字都太工程化,就算那些实施人员都看不懂」.
//
// ONE PAGE, THREE READERS. The install page in particular was serving three audiences at once —
// the customer admin ("what will be installed, what am I confirming, did it work?"), the implementer
// ("which step failed and how do I fix it"), and us ("full technical state") — and only the third
// was served. This module is the first reader's half.
//
// THE RULE, and the one thing to keep in mind when editing this file:
//
//   PLAIN LANGUAGE IS THE DEFAULT; THE TECHNICAL DETAIL IS DEMOTED, NEVER DELETED.
//
// Every identifier this module translates STILL renders — inside the `技术详情(排障用)` disclosure
// (StockPrepTechnicalDetails.vue) that each panel now carries. An objectId, an env var NAME, a route
// path, a blocker code, a `fix.run` line: those are things a person COPIES in order to act, so they
// stay verbatim. What changes is which of the two a reader meets first.
//
// TRANSLATE MEANING, NEVER MECHANISM-BY-NAME. `k3ExternalWrite permanently_disabled` does not become
// "K3 外部写入 永久禁用" (that is the same sentence with the same problem); it becomes
// 「不向 K3 写入任何数据(永久,不可开启)」 — what it means for the reader's system.
//
// EVERY LOOKUP FAILS SOFT. Each function returns `null` for a key it does not know, and every caller
// falls back to the served text / raw token. A vocabulary added server-side therefore degrades to
// today's behaviour (the technical token, shown as before) instead of blanking a cell — the same
// posture installPlan.ts takes toward a manifest section its backend predates.
//
// VALUES-FREE. This module is a static table of constants. It holds no customer value, reads no
// response, and cannot introduce one: every string below is authored here and committed.

/** One bilingual string. The views' own `bi(zh, en)` picks the side; this module never reads locale. */
export interface StockPrepPlainText {
  zh: string
  en: string
}

/** A translated identifier: what it means, and (where there is one) what to do about it. */
export interface StockPrepPlainEntry extends StockPrepPlainText {
  /** The next action a reader can take. Present only where there genuinely is one. */
  zhNext?: string
  enNext?: string
}

function lookup<T>(map: Record<string, T>, key: string | null | undefined): T | null {
  if (typeof key !== 'string' || key.length === 0) return null
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null
}

// ---------------------------------------------------------------------------
// The disclosure itself
// ---------------------------------------------------------------------------

/**
 * The label every 技术详情 disclosure carries. ONE constant, so the surface cannot end up with four
 * different names for the same affordance — a reader who learns to look for it on the install page
 * finds the identical words on the exception queue.
 */
export const STOCK_PREP_TECHNICAL_DETAILS_LABEL: StockPrepPlainText = Object.freeze({
  zh: '技术详情(排障用)',
  en: 'Technical details (for troubleshooting)',
})

// ---------------------------------------------------------------------------
// Install-run outcomes — 装好了吗?
// ---------------------------------------------------------------------------

/**
 * OK / SKIP / FAIL in words, so a person can answer 「装好了吗?」 without reading a code.
 *
 * SKIP is the one that most needed saying: it is human work still outstanding, NOT a broken install,
 * and the old `SKIP` badge said neither. It keeps the amber of the existing colour system; the
 * REASON that follows it (why this step was skipped, and whether that is a problem) is rendered with
 * the same weight as an OK line and must never be dropped.
 */
export const STOCK_PREP_STEP_OUTCOME: Record<string, StockPrepPlainText> = Object.freeze({
  ok: Object.freeze({ zh: '成功', en: 'Done' }),
  skip: Object.freeze({ zh: '跳过', en: 'Skipped' }),
  fail: Object.freeze({ zh: '失败', en: 'Failed' }),
  pending: Object.freeze({ zh: '待运行', en: 'Not run yet' }),
})

export function stockPrepStepOutcomeText(status: string): StockPrepPlainText {
  return lookup(STOCK_PREP_STEP_OUTCOME, status) ?? STOCK_PREP_STEP_OUTCOME.pending
}

// ---------------------------------------------------------------------------
// Permission codes — 谁能做什么
// ---------------------------------------------------------------------------

/**
 * The three codes, led by WHAT THE HOLDER CAN DO rather than by the code. The code itself stays
 * visible next to the sentence — it is what an implementer greps for and what an admin types into
 * the role editor — but it is no longer the whole of what the page says.
 */
export const STOCK_PREP_PERMISSION_PLAIN: Record<string, StockPrepPlainEntry> = Object.freeze({
  'stock-prep:read': Object.freeze({
    zh: '查看备料数据',
    en: 'View stock-preparation data',
    zhNext: '能打开备料工作台、看待确认清单和进度,不能修改任何内容。',
    enNext: 'Can open the workbench and read the pending list and progress; changes nothing.',
  }),
  'stock-prep:operate': Object.freeze({
    zh: '填写数据 / 做确认',
    en: 'Enter data and confirm',
    zhNext: '能对冲突做出决定并填写确认的值 —— 日常干活的人用这一个。',
    enNext: 'Can decide a conflict and fill in the confirmed value — this is the day-to-day one.',
  }),
  'stock-prep:admin': Object.freeze({
    zh: '管理表结构 / 安装应用',
    en: 'Manage tables and install the app',
    zhNext: '能打开安装页、看默认配置与体检结果。建表本身仍需平台管理员。',
    enNext: 'Can open the install page and read the defaults and the health check. Creating the tables themselves still needs a platform admin.',
  }),
})

export function stockPrepPermissionPlain(code: string): StockPrepPlainEntry | null {
  return lookup(STOCK_PREP_PERMISSION_PLAIN, code)
}

/**
 * What 「零自动持有」 means for the person reading it: nobody holds these yet, and that is the
 * install behaving correctly rather than a step that failed.
 */
export const STOCK_PREP_NO_AUTOMATIC_HOLDERS: StockPrepPlainEntry = Object.freeze({
  zh: '安装后暂无人持有这三项权限,需要管理员在角色里逐个分配。',
  en: 'After installing, nobody holds any of the three — an admin assigns each one in the role editor.',
  zhNext: '这是有意的:安装不会把任何现有角色悄悄变成备料角色。',
  enNext: 'That is deliberate: installing never turns an existing role into a stock-preparation role behind your back.',
})

// ---------------------------------------------------------------------------
// Managed tables
// ---------------------------------------------------------------------------

/** Keyed by the manifest object `id` (not the objectId — that is the technical handle). */
export const STOCK_PREP_OBJECT_PLAIN: Record<string, StockPrepPlainEntry> = Object.freeze({
  confirmationDecisionLedger: Object.freeze({
    zh: '备料确认账本',
    en: 'Confirmation ledger',
    zhNext: '记录每一条需要人工拿主意的冲突:谁在什么时候定的、定成了什么。',
    enNext: 'Records every conflict a person had to decide: who decided, when, and what they decided.',
  }),
  sandboxTarget: Object.freeze({
    zh: '备料试运行表',
    en: 'Trial-run table',
    zhNext: '先在这张表上跑一遍,确认结果对了再谈正式表 —— 装错了只影响这一张。',
    enNext: 'The run happens here first; only once the result looks right does anything else come into it — a mistake stays inside this one table.',
  }),
})

export function stockPrepObjectPlain(id: string): StockPrepPlainEntry | null {
  return lookup(STOCK_PREP_OBJECT_PLAIN, id)
}

// ---------------------------------------------------------------------------
// The four fences — 系统绝对不会做的事
// ---------------------------------------------------------------------------

/**
 * §14's 「只展示,无开关」 posture entries. The old page printed `k3ExternalWrite
 * permanently_disabled` and left the reader to work out that this is a PROMISE, not a fault.
 *
 * These sentences all say the same structural thing on purpose — "the system does not do X" — because
 * that is the reassurance a customer admin is actually looking for on an install page.
 */
export const STOCK_PREP_POSTURE_PLAIN: Record<string, StockPrepPlainEntry> = Object.freeze({
  productionApply: Object.freeze({
    zh: '不向正式表写入数据',
    en: 'Writes nothing to your production tables',
    zhNext: '当前部署没有开正式写入,只在试运行表里操作。',
    enNext: 'This deployment has production writes closed; everything happens in the trial-run table.',
  }),
  k3ExternalWrite: Object.freeze({
    zh: '不向 K3 写入任何数据(永久,不可开启)',
    en: 'Never writes anything into K3 (permanent, cannot be switched on)',
    zhNext: '可以拿 K3 的数据做对照,但一个字也不会写回去。',
    enNext: 'K3 data can be read for comparison; not one field is ever written back.',
  }),
  b2aTrialRegistry: Object.freeze({
    zh: '不启用后台自动改数(处于关闭状态)',
    en: 'The automatic-rewrite trial is off',
    zhNext: '要开需要负责人单独决定,安装过程碰不到它。',
    enNext: 'Turning it on is a separate decision by the owner; installing never touches it.',
  }),
  outboundHttpWrite: Object.freeze({
    zh: '不向外部系统发送数据',
    en: 'Sends no data to any outside system',
    zhNext: '没有配置任何外发目标,这是正确状态,不是漏配。',
    enNext: 'No outbound target is configured — that is the correct state, not a missing setting.',
  }),
})

export function stockPrepPosturePlain(id: string): StockPrepPlainEntry | null {
  return lookup(STOCK_PREP_POSTURE_PLAIN, id)
}

/**
 * `installerMayModify=false` in words. The old page rendered the assignment itself, which reads as
 * debug output; what it MEANS is a promise about the install run.
 */
export const STOCK_PREP_INSTALLER_MAY_NOT_MODIFY: StockPrepPlainText = Object.freeze({
  zh: '安装过程不会改动上面这些设置 —— 本页也没有开关可改。',
  en: 'Installing changes none of the settings above — and this page has no switch to change them with.',
})

export const STOCK_PREP_INSTALLER_MAY_MODIFY_WARNING: StockPrepPlainText = Object.freeze({
  zh: '读到的清单声称安装过程可以改动这些设置 —— 这与设计不符,请先联系我们再安装。',
  en: 'The manifest we read claims the installer may change these settings — that contradicts the design; talk to us before installing.',
})

// ---------------------------------------------------------------------------
// Deployment-data config surfaces
// ---------------------------------------------------------------------------

export const STOCK_PREP_CONFIG_SURFACE_PLAIN: Record<string, StockPrepPlainEntry> = Object.freeze({
  customerPack: Object.freeze({
    zh: '这套部署要装哪些列',
    en: 'Which columns this deployment installs',
    zhNext: '每家客户的列不一样,所以这份清单放在部署机上,不随程序发布。没配 = 一列都不装。',
    enNext: 'Every customer needs different columns, so the list lives on the deployment machine rather than in the release. Not configured means no column is installed at all.',
  }),
  extFieldMapping: Object.freeze({
    zh: '源系统的字段对应到哪一列',
    en: 'Which source field lands in which column',
    zhNext: '同样按客户放在部署机上。没对应上的字段不会被写入。',
    enNext: 'Also per-customer, also on the deployment machine. A field with no match is simply not written.',
  }),
  sandboxWriteAuthorization: Object.freeze({
    zh: '允许写入的试运行表清单',
    en: 'Which trial-run tables may be written',
    zhNext: '不在清单里的表写不进去 —— 装列会成功,写数据会被拦下。',
    enNext: 'A table not on the list cannot be written: installing columns still succeeds, writing rows is refused.',
  }),
})

export function stockPrepConfigSurfacePlain(id: string): StockPrepPlainEntry | null {
  return lookup(STOCK_PREP_CONFIG_SURFACE_PLAIN, id)
}

/** What "部署期数据 · 永不入库" is telling the reader. */
export const STOCK_PREP_DEPLOYMENT_DATA_TAG: StockPrepPlainText = Object.freeze({
  zh: '装在服务器上,不存进本系统',
  en: 'Set on the server, never stored in this system',
})

// ---------------------------------------------------------------------------
// Acceptance criteria — 怎么算装成功了
// ---------------------------------------------------------------------------

export const STOCK_PREP_ACCEPTANCE_PLAIN: Record<string, StockPrepPlainEntry> = Object.freeze({
  'ext-columns-written-human-band-untouched': Object.freeze({
    zh: '从 PLM 拉来的列有值,您手工填写的内容一个字没变',
    en: 'The columns pulled from PLM have values, and nothing you typed by hand has changed',
  }),
  'second-refresh-all-skip': Object.freeze({
    zh: '同样的数据再同步一次,不会重复写入',
    en: 'Syncing the same data a second time writes nothing again',
  }),
})

export function stockPrepAcceptancePlain(id: string): StockPrepPlainEntry | null {
  return lookup(STOCK_PREP_ACCEPTANCE_PLAIN, id)
}

// ---------------------------------------------------------------------------
// Preflight blockers — 哪里卡住了,下一步做什么
// ---------------------------------------------------------------------------

/**
 * The seven codes from `PREFLIGHT_BLOCKER_CODES` (plugin-integration-core/lib/
 * stock-preparation-preflight.cjs). Each carries WHAT is missing and WHAT TO DO — the code and the
 * route's own paste-able `fix.run` line still render, verbatim, in the disclosure beside it.
 */
export const STOCK_PREP_BLOCKER_PLAIN: Record<string, StockPrepPlainEntry> = Object.freeze({
  STOCK_PREP_CONFIRMATION_LEDGER_NOT_READY: Object.freeze({
    zh: '确认账本这张表还没建好',
    en: 'The confirmation ledger table is not in place yet',
    zhNext: '点下面的「开始安装」就会建 —— 这一条会自己消失。',
    enNext: 'Start install below creates it — this one clears itself.',
  }),
  STOCK_PREP_CUSTOMER_PACK_NOT_CONFIGURED: Object.freeze({
    zh: '还没告诉系统这套部署要装哪些列',
    en: 'Nobody has told the system which columns this deployment installs',
    zhNext: '需要在部署机上放好客户列清单文件并指向它,本页没有、也不应该有输入框。',
    enNext: 'The column list has to be placed on the deployment machine and pointed at. This page has no field for it and must never grow one.',
  }),
  STOCK_PREP_PACK_TARGET_MISSING: Object.freeze({
    zh: '列清单里没写要装到哪张表',
    en: 'The column list does not say which table to install into',
    zhNext: '请补上目标表,再重新预检。',
    enNext: 'Add the target table to the list, then re-run the check.',
  }),
  STOCK_PREP_PACK_TARGET_INCOMPLETE: Object.freeze({
    zh: '目标表存在,但还缺列',
    en: 'The target table exists but is missing columns',
    zhNext: '点「开始安装」补齐;重复运行是安全的。',
    enNext: 'Start install fills them in; running it again is safe.',
  }),
  STOCK_PREP_EXT_FIELD_MAPPING_NOT_CONFIGURED: Object.freeze({
    zh: '还没说源系统的字段对应到哪一列',
    en: 'Nothing says which source field lands in which column',
    zhNext: '同样是部署机上的一份文件。缺它不会装坏,只是拉不到数据。',
    enNext: 'Another file on the deployment machine. Missing it breaks nothing — it just means no data arrives.',
  }),
  STOCK_PREP_SANDBOX_MODE_NOT_ENABLED: Object.freeze({
    zh: '试运行模式没打开',
    en: 'Trial-run mode is not switched on',
    zhNext: '在部署机上打开后重新预检。',
    enNext: 'Switch it on at the deployment machine, then re-run the check.',
  }),
  STOCK_PREP_SANDBOX_ALLOWLIST_MISSING_TARGET: Object.freeze({
    zh: '目标表不在允许写入的清单里',
    en: 'The target table is not on the list of tables that may be written',
    zhNext: '把这张表加进允许清单 —— 否则列装得上,数据写不进。',
    enNext: 'Add the table to the allowlist, or the columns install but no row can be written.',
  }),
})

export function stockPrepBlockerPlain(code: string): StockPrepPlainEntry | null {
  return lookup(STOCK_PREP_BLOCKER_PLAIN, code)
}

// ---------------------------------------------------------------------------
// 源就绪预检 — the SOURCE side
//
// A separate register from the deployment blockers above, because the reader's next action is a
// different KIND of action. A deployment blocker is fixed on our machine, by us, usually by pressing
// the install button. A source blocker is a fact about the customer's system: the next line has to
// tell an implementer what to check over there, or who to ask, and must never pretend a button here
// will fix it.
//
// The sentence that earns this whole feature is `topology_mismatch`. Before it existed, that
// condition was invisible: the run "succeeded" and produced zero rows, and finding out why took a day
// of reading someone else's schema. It now says the thing out loud, in the words a person uses.
// ---------------------------------------------------------------------------

export const STOCK_PREP_SOURCE_BLOCKER_PLAIN: Record<string, StockPrepPlainEntry> = Object.freeze({
  source_unreachable: Object.freeze({
    zh: '连不上对方的系统',
    en: 'The customer system cannot be reached',
    zhNext: '先确认网络、地址和账号能通 —— 这一步之前的所有判断都不作数。',
    enNext: 'Check the network, the address and the account first — nothing below this line means anything until it answers.',
  }),
  entry_table_missing: Object.freeze({
    zh: '找项目编号的那张表不在对方库里',
    en: 'The table project numbers are looked up in is not in that database',
    zhNext: '要么连错了库,要么这家的表名不一样。把下面「技术详情」里的表名拿给对方确认。',
    enNext: 'Either this is the wrong database, or this customer names that table differently. Take the table name from the technical details below and confirm it with them.',
  }),
  no_project_numbers: Object.freeze({
    zh: '表在,但里面一个项目编号都没有',
    en: 'The table is there, but it holds no project numbers at all',
    zhNext: '多半是连到了空的测试库。换成有数据的那套再试 —— 继续往下做只会白做。',
    enNext: 'This is usually an empty test database. Point at the populated one and re-run; going further would waste the afternoon.',
  }),
  no_bom_rows: Object.freeze({
    zh: 'BOM 表是空的',
    en: 'The BOM tables are empty',
    zhNext: '同上:确认连的是不是那套真正在用的库。',
    enNext: 'Same as above: confirm this is the database they actually work in.',
  }),
  no_bom_bridge: Object.freeze({
    zh: '没找到从项目到 BOM 的那条路',
    en: 'No path from a project to its BOM was found',
    zhNext: '两种已知走法(订单模块 / 设计BOM)都没有数据。需要对方告诉我们他们的 BOM 挂在哪张表上。',
    enNext: 'Neither known route — the order module or the design BOM — carries any lines. We need them to tell us which table their BOM hangs off.',
  }),
  // The finding that came out of measuring the real customer PLM: the BIGGEST BOM table is not
  // necessarily the production one. Naming a winner on row count alone handed back the wrong table.
  bom_store_signals_conflict: Object.freeze({
    zh: '有两张表都像是放 BOM 的,几条线索指向不同的那一张 —— 系统不替你选',
    en: 'Two tables both look like the BOM store and the evidence points different ways — the system will not choose',
    zhNext: '下面列了每条线索各指向哪张表:「字段字典的声明」和「数量列的存放形态」是强线索,「行数多少」只能当参考 —— 行数最多的那张,不一定是生产在用的那张(设计稿、历史数据都会很大)。请对方确认他们的备料实际读哪一张,再按那张配置。',
    enNext: 'Below, each piece of evidence and the table it points at. The field dictionary’s declaration and the shape of the quantity column are the strong ones; row count is only a hint — the biggest table is often not the live one (design drafts and history are bulky). Ask them which table their own 备料 reads, and configure that one.',
  }),
  bridge_ambiguous: Object.freeze({
    zh: '两条路都有数据,数量也接近,系统不替你猜',
    en: 'Both routes carry data in comparable amounts, and the system will not guess between them',
    zhNext: '请对方确认业务上以哪一条为准,再按那条配置。',
    enNext: 'Ask them which one the business treats as authoritative, then configure that one.',
  }),
  // Deliberately a SEPARATE sentence from bridge_ambiguous. "We compared them and they came out
  // close" and "both are bigger than we looked" are different facts with different ways out, and an
  // operator who cannot tell them apart is stuck at a permanent blocker with no next step.
  bridge_undecidable_at_cap: Object.freeze({
    zh: '两条路都装满了抽样上限,光看抽样分不出哪条是主的',
    en: 'Both routes are full past the sample limit, so a sample cannot tell which one is the main one',
    zhNext: '预检每张表只抽读一小页(不会去全表扫描对方的库)。请对方确认业务上以哪一条为准,然后在下面直接指定 —— 指定之后本页会照那条继续检查,并且会一直标明「这条是人指定的,不是测出来的」。',
    enNext: 'The check reads only one small page per table — it will not scan their database. Ask them which route the business treats as authoritative and declare it below; the check then continues against that one, and the report keeps saying it was declared rather than measured.',
  }),
  declared_bridge_contradicts_measurement: Object.freeze({
    zh: '你指定的那条路,和实测出来的对不上',
    en: 'The route you declared is not the one the data shows',
    zhNext: '实测是有数据支撑的,所以这里以实测为准、不采纳指定。要么指定改成实测那条,要么先跟对方核对 —— 很可能是连错了库。',
    enNext: 'The measurement has data behind it, so it stands and the declaration is not applied. Either declare the measured route instead, or check with them first — this is often a sign of the wrong database.',
  }),
  topology_mismatch: Object.freeze({
    zh: '配置走的路,和这家实际的形状对不上 —— 照现在配置跑,会拉到 0 行',
    en: 'The configured route does not match this source’s actual shape — as configured, the run will return 0 rows',
    zhNext: '下面写了配置走哪条、实测是哪条。把读取配置改到实测那条上,再预检一次。',
    enNext: 'Below it says which route is configured and which one was measured. Point the read configuration at the measured one and check again.',
  }),
})

export function stockPrepSourceBlockerPlain(code: string): StockPrepPlainEntry | null {
  return lookup(STOCK_PREP_SOURCE_BLOCKER_PLAIN, code)
}

/** Warnings: worth saying, never a reason to stop. */
export const STOCK_PREP_SOURCE_WARNING_PLAIN: Record<string, StockPrepPlainEntry> = Object.freeze({
  no_preset_match: Object.freeze({
    zh: '这套库的表名不像我们已知的任何一家',
    en: 'These table names do not look like any vendor we already know',
    zhNext: '不影响继续 —— 只是没有现成的字段字典可以套,配置要多问几句。',
    enNext: 'Not a blocker — it only means there is no ready-made field dictionary to lean on, so configuration takes a few more questions.',
  }),
  preset_ambiguous: Object.freeze({
    zh: '这套库同时像好几家,系统不替你选',
    en: 'This database resembles more than one known vendor, and the system will not choose',
    zhNext: '按实际情况人工指定用哪一份字段字典。',
    enNext: 'Name the field dictionary to use, by hand.',
  }),
  quantity_field_mismatch: Object.freeze({
    zh: '数量列配错了位置',
    en: 'The quantity column is configured in the wrong slot',
    zhNext: '实测出来的那一列写在下面。照着改,否则数量会整列是空的。',
    enNext: 'The measured column is named below. Change it to that, or the quantity column comes through empty.',
  }),
  quantity_field_unresolved: Object.freeze({
    zh: '没能确定数量存在哪一列',
    en: 'Could not determine which column holds the quantity',
    zhNext: '需要对方指认。拉数据本身还能跑,但数量列大概率是空的。',
    enNext: 'They need to point it out. The pull still runs, but the quantity column will most likely be empty.',
  }),
  quantity_field_ambiguous: Object.freeze({
    zh: '有好几列都像数量(比如数量和重量都是数字),系统不替你选',
    en: 'Several columns all look like the quantity (quantity and weight are both numeric), and the system will not choose',
    zhNext: '候选列在下面列着。对方的字段字典读不到时,只能请他们指认哪一列是数量 —— 这里宁可说不知道,也不会挑一列写进去。',
    enNext: 'The candidates are listed below. With their field dictionary unreadable, they have to say which one is the quantity — this check would rather say it does not know than name one.',
  }),
  quantity_field_undetectable_on_this_carrier: Object.freeze({
    zh: '这张表根本没有数量列 —— 它的字段是塞在一个文本字段里的 JSON',
    en: 'This table has no quantity column at all — its fields are packed as JSON inside one text column',
    zhNext: '字段确实在(下面列了认出来的那几个槽名),只是现在的读取方式只会读「列」,读不到 JSON 里面。要用这张表就得先决定怎么解这个 JSON;这不是「没有数量」。',
    enNext: 'The fields are there (the slot names recognised are listed below) — but the current read addresses COLUMNS and cannot see inside JSON. Using this table means deciding how to unpack that blob first. This is not the same as "no quantity".',
  }),
  bridge_declared_not_measured: Object.freeze({
    zh: '这次的「走哪条路」是人指定的,不是测出来的',
    en: 'The route in this report was declared by a person, not measured',
    zhNext: '抽样分不出来时这是正常做法。但请记住:下面所有基于这条路的判断,都建立在这个指定正确的前提上。',
    enNext: 'That is the right move when the sample cannot decide. Just remember every finding below that depends on the route rests on the declaration being right.',
  }),
  quantity_readings_disagree: Object.freeze({
    zh: '两种判法给出了不同的数量列',
    en: 'The two readings disagree about which column holds the quantity',
    zhNext: '一种是读对方自己的字段字典,一种是看哪一列全是数字。两者不一致时以对方确认为准。',
    enNext: 'One reads their own field dictionary; the other looks for the column that is numeric throughout. When they disagree, their answer wins.',
  }),
  node_type_column_absent: Object.freeze({
    zh: '这套库没有「节点类型」这一列',
    en: 'This database has no node-type column',
    zhNext: '不影响判断 —— 只是「有几个是项目节点」这句话这次算不出来。',
    enNext: 'Harmless — it only means "how many of these are project nodes" could not be counted this time.',
  }),
  dictionary_unreadable: Object.freeze({
    zh: '对方的字段字典表读不到',
    en: 'Their field-dictionary table could not be read',
    zhNext: '可能是没授权。系统改用「看哪一列全是数字」来判断,准确度略低。',
    enNext: 'Possibly not granted. The system falls back to finding the column that is numeric throughout, which is slightly less certain.',
  }),
})

export function stockPrepSourceWarningPlain(code: string): StockPrepPlainEntry | null {
  return lookup(STOCK_PREP_SOURCE_WARNING_PLAIN, code)
}

/** The four lines the panel leads with, and the words for each verdict. */
export const STOCK_PREP_SOURCE_CHECK_PLAIN: Record<string, StockPrepPlainEntry> = Object.freeze({
  reachable: Object.freeze({
    zh: '能连上、能读到表',
    en: 'Reachable, and the tables answer',
  }),
  'has-data': Object.freeze({
    zh: '里面有真实的项目和 BOM 数据',
    en: 'It holds real project and BOM data',
  }),
  'bom-store': Object.freeze({
    zh: '确定了 BOM 存在哪张表(不是「哪张最大」)',
    en: 'Established which table holds the BOM — not merely which is biggest',
  }),
  topology: Object.freeze({
    zh: '实测的 schema 形状,和配置一致',
    en: 'The measured schema shape matches the configuration',
  }),
  preset: Object.freeze({
    zh: '认出了这是哪一家的 schema(按表名指纹,不是按公司名)',
    en: 'Recognised whose schema this is — by table-name fingerprint, not by company name',
  }),
})

export function stockPrepSourceCheckPlain(id: string): StockPrepPlainEntry | null {
  return lookup(STOCK_PREP_SOURCE_CHECK_PLAIN, id)
}

/** The bridges, in words. An implementer should not have to know what "order-module" means. */
export const STOCK_PREP_SOURCE_BRIDGE_PLAIN: Record<string, StockPrepPlainText> = Object.freeze({
  'order-module': Object.freeze({ zh: '走订单模块', en: 'through the order module' }),
  'design-bom': Object.freeze({ zh: '走设计BOM表', en: 'through the design-BOM table' }),
  ambiguous: Object.freeze({ zh: '两条都有数据,未定', en: 'both routes carry data — undecided' }),
  none: Object.freeze({ zh: '两条都没有数据', en: 'neither route carries data' }),
  unknown: Object.freeze({ zh: '未知', en: 'unknown' }),
})

export function stockPrepSourceBridgePlain(bridge: string): StockPrepPlainText | null {
  return lookup(STOCK_PREP_SOURCE_BRIDGE_PLAIN, bridge)
}

export const STOCK_PREP_SOURCE_VERDICT_PLAIN: Record<string, StockPrepPlainText> = Object.freeze({
  go: Object.freeze({
    zh: '这个源可以接。',
    en: 'This source is ready to connect.',
  }),
  'no-go': Object.freeze({
    zh: '这个源现在还接不了。下面逐条写了卡在哪、该找谁。',
    en: 'This source is not ready yet. Each line below says what is in the way and who can clear it.',
  }),
})

export function stockPrepSourceVerdictPlain(verdict: string): StockPrepPlainText | null {
  return lookup(STOCK_PREP_SOURCE_VERDICT_PLAIN, verdict)
}

// ---------------------------------------------------------------------------
// Error codes reaching an operator surface
// ---------------------------------------------------------------------------

/**
 * The server error vocabulary is OPEN (confirmApi clamps to an enum SHAPE, not to a fixed list), so
 * this map cannot be exhaustive and does not try to be: known codes get a sentence, everything else
 * gets the generic one. Either way the code itself stays on screen, subordinate to the sentence —
 * it is the thing a person quotes when they ask us for help.
 */
export const STOCK_PREP_ERROR_PLAIN: Record<string, StockPrepPlainText> = Object.freeze({
  STOCK_PREPARATION_CONFIRM_REQUEST_FAILED: Object.freeze({
    zh: '这一步没有保存成功,数据没有变化。',
    en: 'That did not save; nothing was changed.',
  }),
  FORBIDDEN: Object.freeze({
    zh: '当前账号没有做这件事的权限。',
    en: 'This account is not allowed to do that.',
  }),
  EXCEPTION_BULK_MIXED_TYPES: Object.freeze({
    zh: '选中的行不是同一类问题,批量处理要求同一类。',
    en: 'The selected rows are not the same kind of problem; a bulk action needs one kind.',
  }),
  CONFIRM_UNIT_CANDIDATE_NOT_FOUND: Object.freeze({
    zh: '这条建议已经过期(数据在您查看期间变了),请刷新后重看。',
    en: 'This suggestion is out of date (the data changed while you were looking) — refresh and read it again.',
  }),
})

export const STOCK_PREP_ERROR_GENERIC: StockPrepPlainText = Object.freeze({
  zh: '这一步没有保存成功,数据没有变化。',
  en: 'That did not save; nothing was changed.',
})

export function stockPrepErrorPlain(code: string): StockPrepPlainText {
  return lookup(STOCK_PREP_ERROR_PLAIN, code) ?? STOCK_PREP_ERROR_GENERIC
}

/** The HTTP read failures the install page surfaces. Status stays visible in the disclosure. */
export const STOCK_PREP_READ_FAILED: StockPrepPlainText = Object.freeze({
  zh: '没能读到这套部署的信息,请稍后再试。',
  en: 'Could not read this deployment’s information — try again shortly.',
})

// ---------------------------------------------------------------------------
// 一线看得见自己工厂的项目 — the five HONEST empty states
// ---------------------------------------------------------------------------

/**
 * WHY THIS TABLE EXISTS. The confirmation queue had ONE empty state — 「都清了」 — and it was shown
 * for three completely different situations: the project had never been synced into this deployment,
 * the operator mistyped the number, and the project was genuinely up to date. Only the third of those
 * is good news, and telling a person "all clear" when the truth is "we have never heard of that
 * number" is the kind of wrong answer that costs a shift.
 *
 * The server now returns the two facts needed to tell them apart (`directoryReady`, `ledgerReady`)
 * plus the caller's own project directory, so each state below is DECIDABLE rather than guessed.
 *
 * …AND THE FIFTH, which is what happens when there is no directory to decide from at all. Three real
 * principals never get one: a `stock-prep:read`-only queue watcher (the client correctly never asks
 * for them), an operate-holder whose load failed, and a tenantless platform admin whom the server
 * refuses by design. The first version of this table had no state for them, so `emptyState` returned
 * null and the page rendered NOTHING where the pre-change page had at least said 「都清了」 — a
 * strictly worse answer than the wrong one it replaced. `directory_unavailable` says both halves of
 * what is actually known, and claims neither the good news nor the accusation.
 *
 * Keys are front-end state ids, not server enums — nothing server-side emits them — so this map is
 * exhaustive by construction and `stockPrepDirectoryEmptyPlain` has no generic fallback to hide a
 * missing case behind. A new state must be added here or it does not render.
 */
export const STOCK_PREP_DIRECTORY_EMPTY_PLAIN: Record<string, StockPrepPlainEntry> = Object.freeze({
  /**
   * No directory at all: not permitted, not loaded, or not loadable. Deliberately VALUES-FREE and
   * deliberately NOT `nothing_synced` — we do not know that nothing was synced, and saying so would
   * send the operator to an administrator who has nothing to fix.
   */
  directory_unavailable: Object.freeze({
    zh: '这个项目号下当前没有待办;项目清单不可用,无法判断是否已同步。',
    en: 'Nothing is pending for this project number; the project list is unavailable, so we cannot tell you whether it was ever synced.',
  }),
  /** The project table is not provisioned, or holds nothing: nothing has ever been synced here. */
  nothing_synced: Object.freeze({
    zh: '这台系统里还没有任何项目。',
    en: 'No project has been brought into this system yet.',
    zhNext: '不是您的操作有问题 —— 需要管理员先把项目同步进来,同步完这里就会列出来。',
    enNext: 'Nothing you did is wrong — an administrator has to sync the projects in first; they will be listed here once that is done.',
  }),
  /** The directory has projects, but none matches the number the operator typed. */
  project_not_found: Object.freeze({
    zh: '这个项目号在系统里查不到。',
    en: 'That project number is not in this system.',
    zhNext: '可能是号码打错了,也可能这个项目还没同步进来。可以直接从下面的列表里挑,支持按号码或名称搜。',
    enNext: 'It may be a typo, or that project may not have been synced in yet. Pick from the list below instead — you can search it by number or by name.',
  }),
  /** The ledger table is not provisioned: pending counts are all zero because nothing can be recorded. */
  ledger_missing: Object.freeze({
    zh: '记录确认结果的表还没建好,所以现在看不到待办。',
    en: 'The table that records your decisions has not been created, so no pending work can show yet.',
    zhNext: '项目本身能看到,但要开始处理,得先请管理员建这张表。',
    enNext: 'You can still see the projects; an administrator has to create that table before you can start working through them.',
  }),
  /** The good news case — and now it only shows when it is actually true. */
  nothing_pending: Object.freeze({
    zh: '这个项目下没有需要您处理的事 —— 都清了。',
    en: 'Nothing on this project needs your attention — it is all clear.',
  }),
})

export type StockPrepDirectoryEmptyState = keyof typeof STOCK_PREP_DIRECTORY_EMPTY_PLAIN

/** Fails soft to `null` like every other lookup here; the caller then renders nothing rather than a lie. */
export function stockPrepDirectoryEmptyPlain(state: string | null | undefined): StockPrepPlainEntry | null {
  return lookup(STOCK_PREP_DIRECTORY_EMPTY_PLAIN, state ?? null)
}

/**
 * THE DECISION, as a pure function so it can be tested without a component and cannot drift between
 * the copy above and the view below. Order matters and is the point:
 *
 *   0. directory_unavailable — checked FIRST, because every diagnosis below reads a directory. With
 *                         no directory in hand the honest answer is "the queue is empty and we cannot
 *                         say why", and guessing any of the other four would be a claim we cannot back.
 *   1. nothing_synced   — the deployment really is empty; every other diagnosis is then noise, and
 *                         the operator is not the person who can fix it either way.
 *   2. project_not_found— only meaningful once we know the directory has SOMETHING to not-find in.
 *   3. ledger_missing   — the project is real, but no pending work could exist to show.
 *   4. nothing_pending  — everything is provisioned and this project really is clear.
 *
 * Returns null when there IS pending work, i.e. when no empty state should render at all.
 */
export function stockPrepDirectoryEmptyState(input: {
  /**
   * Whether a directory response is in hand at all. Optional and defaulting to TRUE so the four
   * directory-derived states keep their exact previous behaviour for every existing caller; a caller
   * that can be without a directory passes it explicitly.
   */
  directoryAvailable?: boolean
  directoryReady: boolean
  ledgerReady: boolean
  projectCount: number
  /** The number currently typed/selected, or '' when the operator has not chosen one. */
  projectNo: string
  /** Whether that number matches a project in the caller's own directory. */
  projectKnown: boolean
  /** Rows the confirmation queue returned for it. */
  pendingRowCount: number
}): StockPrepDirectoryEmptyState | null {
  // Work waiting is never an empty state, whatever we do or do not know about the directory.
  if (input.pendingRowCount > 0) return null
  if (input.directoryAvailable === false) return 'directory_unavailable'
  if (!input.directoryReady || input.projectCount === 0) return 'nothing_synced'
  if (input.projectNo !== '' && !input.projectKnown) return 'project_not_found'
  if (!input.ledgerReady) return 'ledger_missing'
  if (input.pendingRowCount === 0) return 'nothing_pending'
  return null
}

// ---------------------------------------------------------------------------
// Operator vocabularies — the enums the queues used to render raw
// ---------------------------------------------------------------------------

/** Confirmation-queue decision status. */
export const STOCK_PREP_DECISION_STATUS_PLAIN: Record<string, StockPrepPlainText> = Object.freeze({
  pending: Object.freeze({ zh: '等您确认', en: 'Waiting for you' }),
  confirmed: Object.freeze({ zh: '已确认', en: 'Confirmed' }),
  superseded: Object.freeze({ zh: '已作废(数据变了)', en: 'Superseded (the data changed)' }),
})

/** Confirmation-queue resolution actions — the frozen three-word server vocabulary. */
export const STOCK_PREP_DECISION_ACTION_PLAIN: Record<string, StockPrepPlainEntry> = Object.freeze({
  keep_multiple_rows: Object.freeze({
    zh: '几条都留着',
    en: 'Keep them all',
    zhNext: '这几行都是对的,一起保留。',
    enNext: 'All of these rows are correct — keep every one.',
  }),
  accept_current: Object.freeze({
    zh: '按现在这条算',
    en: 'Go with the current one',
    zhNext: '先用当前这条,源头的数据要另外去改。',
    enNext: 'Use the current row for now; the source data still needs fixing separately.',
  }),
  manual_hold: Object.freeze({
    zh: '先挂起,回头再说',
    en: 'Park it for now',
    zhNext: '现在定不了,挂起来不影响别人继续。',
    enNext: 'Not decidable right now; parking it does not block anyone else.',
  }),
})

/** Exception-queue resolution actions (a different, four-word vocabulary from the one above). */
export const STOCK_PREP_EXCEPTION_ACTION_PLAIN: Record<string, StockPrepPlainText> = Object.freeze({
  mapping_confirmed: Object.freeze({ zh: '物料对应关系已确认', en: 'Material match confirmed' }),
  unit_rule_confirmed: Object.freeze({ zh: '单位换算已确认', en: 'Unit conversion confirmed' }),
  accepted_change: Object.freeze({ zh: '认可这次变化', en: 'Change accepted' }),
  manual_hold: Object.freeze({ zh: '先挂起,回头再说', en: 'Parked for now' }),
})

/** Exception types. */
export const STOCK_PREP_EXCEPTION_TYPE_PLAIN: Record<string, StockPrepPlainText> = Object.freeze({
  missing_mapping: Object.freeze({ zh: '找不到对应的 ERP 物料', en: 'No matching ERP material' }),
  multi_candidate: Object.freeze({ zh: '对应到了多个物料,要选一个', en: 'Several materials match — pick one' }),
  version_conflict: Object.freeze({ zh: '版本对不上', en: 'Versions disagree' }),
  erp_item_missing: Object.freeze({ zh: 'ERP 里没有这个物料', en: 'That material does not exist in ERP' }),
  unit_missing: Object.freeze({ zh: '没有单位换算规则', en: 'No unit-conversion rule' }),
  unit_conflict: Object.freeze({ zh: '单位换算规则互相矛盾', en: 'Unit-conversion rules contradict each other' }),
  invalid_qty: Object.freeze({ zh: '数量不合法', en: 'The quantity is not usable' }),
  missing_child_bom: Object.freeze({ zh: '下层 BOM 没拉到', en: 'A child BOM did not come through' }),
})

export const STOCK_PREP_EXCEPTION_SEVERITY_PLAIN: Record<string, StockPrepPlainText> = Object.freeze({
  info: Object.freeze({ zh: '提示', en: 'For information' }),
  warning: Object.freeze({ zh: '注意', en: 'Worth a look' }),
  blocking: Object.freeze({ zh: '拦路项(不处理就出不了料)', en: 'Blocking (nothing ships until it is handled)' }),
})

export const STOCK_PREP_EXCEPTION_STATUS_PLAIN: Record<string, StockPrepPlainText> = Object.freeze({
  open: Object.freeze({ zh: '待处理', en: 'Open' }),
  resolved: Object.freeze({ zh: '已处理', en: 'Handled' }),
  ignored: Object.freeze({ zh: '已忽略', en: 'Ignored' }),
  deferred: Object.freeze({ zh: '暂缓', en: 'Deferred' }),
})

/** Material-mapping match status. */
export const STOCK_PREP_MATCH_STATUS_PLAIN: Record<string, StockPrepPlainText> = Object.freeze({
  matched: Object.freeze({ zh: '已对上', en: 'Matched' }),
  pending_confirm: Object.freeze({ zh: '等人确认', en: 'Waiting for confirmation' }),
  multi_candidate: Object.freeze({ zh: '有多个候选', en: 'Several candidates' }),
  not_found: Object.freeze({ zh: '没找到', en: 'Not found' }),
  version_conflict: Object.freeze({ zh: '版本对不上', en: 'Versions disagree' }),
})

export const STOCK_PREP_VERSION_POLICY_PLAIN: Record<string, StockPrepPlainText> = Object.freeze({
  drawing_and_version: Object.freeze({ zh: '图号 + 版本都要一致', en: 'Drawing and version must both match' }),
  drawing_only: Object.freeze({ zh: '只看图号,不看版本', en: 'Match on drawing only, ignore version' }),
  manual: Object.freeze({ zh: '人工指定', en: 'Set by hand' }),
})

export const STOCK_PREP_MATCH_METHOD_PLAIN: Record<string, StockPrepPlainText> = Object.freeze({
  historical_confirmed: Object.freeze({ zh: '沿用以前确认过的', en: 'Reused an earlier confirmation' }),
  exact_code_candidate: Object.freeze({ zh: '编码完全相同', en: 'Codes are identical' }),
  normalized_code_candidate: Object.freeze({ zh: '编码格式化后相同', en: 'Codes match once tidied up' }),
  name_spec_candidate: Object.freeze({ zh: '名称与规格相近', en: 'Name and spec look alike' }),
  none: Object.freeze({ zh: '没匹配上', en: 'No match' }),
  manual_confirm: Object.freeze({ zh: '人工确认的', en: 'Confirmed by a person' }),
})

/** Prep-line statuses. */
export const STOCK_PREP_LINE_STATUS_PLAIN: Record<string, StockPrepPlainText> = Object.freeze({
  draft: Object.freeze({ zh: '可以用', en: 'Usable' }),
  held: Object.freeze({ zh: '卡住了', en: 'Held up' }),
  unknown: Object.freeze({ zh: '状态未知', en: 'Unknown' }),
})

export const STOCK_PREP_LINE_MAPPING_STATUS_PLAIN: Record<string, StockPrepPlainText> = Object.freeze({
  ...STOCK_PREP_MATCH_STATUS_PLAIN,
  unknown: Object.freeze({ zh: '状态未知', en: 'Unknown' }),
})

export const STOCK_PREP_LINE_UNIT_STATUS_PLAIN: Record<string, StockPrepPlainText> = Object.freeze({
  converted: Object.freeze({ zh: '已换算', en: 'Converted' }),
  missing_rule: Object.freeze({ zh: '缺换算规则', en: 'No conversion rule' }),
  conflict: Object.freeze({ zh: '换算规则矛盾', en: 'Conversion rules contradict' }),
  unknown: Object.freeze({ zh: '状态未知', en: 'Unknown' }),
})

/** Unit-conversion engine outcomes and held reasons. */
export const STOCK_PREP_UNIT_OUTCOME_PLAIN: Record<string, StockPrepPlainText> = Object.freeze({
  reused: Object.freeze({ zh: '沿用已有规则', en: 'Existing rule applies' }),
  candidate: Object.freeze({ zh: '有建议,等您确认', en: 'Suggested — waiting for you' }),
  held: Object.freeze({ zh: '定不了,缺东西', en: 'Cannot decide — something is missing' }),
  unknown: Object.freeze({ zh: '状态未知', en: 'Unknown' }),
})

export const STOCK_PREP_UNIT_REASON_PLAIN: Record<string, StockPrepPlainText> = Object.freeze({
  missing_mapping: Object.freeze({ zh: '这行还没对上 ERP 物料', en: 'This row has no ERP material yet' }),
  missing_material: Object.freeze({ zh: '找不到物料信息', en: 'The material record is missing' }),
  missing_design_unit: Object.freeze({ zh: '设计单位是空的', en: 'The design unit is empty' }),
  missing_issue_unit: Object.freeze({ zh: '领用单位是空的', en: 'The issue unit is empty' }),
  rule_missing: Object.freeze({ zh: '没有可用的换算规则', en: 'No usable conversion rule' }),
  rule_conflict: Object.freeze({ zh: '有多条规则互相矛盾', en: 'Several rules contradict each other' }),
})

export const STOCK_PREP_UNIT_SCOPE_PLAIN: Record<string, StockPrepPlainText> = Object.freeze({
  material: Object.freeze({ zh: '只对某个物料', en: 'One material only' }),
  category: Object.freeze({ zh: '对一类物料', en: 'A whole category' }),
  generic: Object.freeze({ zh: '对所有物料', en: 'Everything' }),
})

export const STOCK_PREP_ROUNDING_PLAIN: Record<string, StockPrepPlainText> = Object.freeze({
  none: Object.freeze({ zh: '不取整', en: 'No rounding' }),
  ceil: Object.freeze({ zh: '往上进位', en: 'Round up' }),
  floor: Object.freeze({ zh: '往下舍去', en: 'Round down' }),
  nearest: Object.freeze({ zh: '四舍五入', en: 'Round to nearest' }),
  pack_size: Object.freeze({ zh: '按整包凑', en: 'Round to a whole pack' }),
})

/** Snapshot-diff change kinds, already plain in Chinese but worth the same treatment in English. */
export const STOCK_PREP_DIFF_KIND_PLAIN: Record<string, StockPrepPlainText> = Object.freeze({
  added: Object.freeze({ zh: '新增的行', en: 'Rows added' }),
  removed: Object.freeze({ zh: '删掉的行', en: 'Rows removed' }),
  quantityChanged: Object.freeze({ zh: '数量改了', en: 'Quantity changed' }),
  unitChanged: Object.freeze({ zh: '单位改了', en: 'Unit changed' }),
  versionChanged: Object.freeze({ zh: '版本改了', en: 'Version changed' }),
  pathChanged: Object.freeze({ zh: '在 BOM 里挪了位置', en: 'Moved within the BOM' }),
  missingChildBom: Object.freeze({ zh: '下层 BOM 没拉到', en: 'A child BOM did not come through' }),
  fingerprintChanged: Object.freeze({ zh: '其他内容有改动', en: 'Something else changed' }),
})

/** Snapshot-diff row review status / diff type. */
export const STOCK_PREP_DIFF_REVIEW_PLAIN: Record<string, StockPrepPlainText> = Object.freeze({
  pending: Object.freeze({ zh: '待看', en: 'To review' }),
  reviewed: Object.freeze({ zh: '已看过', en: 'Reviewed' }),
  held: Object.freeze({ zh: '挂起', en: 'Parked' }),
})

/**
 * ONE lookup for every vocabulary above. Callers pass the map and the raw token; a token the map
 * does not know comes back as `null` and the caller renders the raw token exactly as it does today.
 */
export function stockPrepEnumPlain(
  map: Record<string, StockPrepPlainText>,
  token: string | null | undefined,
): StockPrepPlainText | null {
  return lookup(map, token)
}

// ---------------------------------------------------------------------------
// 项目接入 — the sync entry's four steps
// ---------------------------------------------------------------------------

/**
 * The owner's spec for this surface was one sentence — 「PLM系统接通后,在页面哪里可点击项目号,然后
 * 该项目号里的bom就自动导入到我们的多维表中」 — so the panel's own words have to be that plain. Each
 * entry below leads with WHAT HAPPENED and, where there is one, WHAT TO DO NEXT. The reason CODE
 * still renders, subordinate, inside the panel's 技术详情 disclosure, because it is what a person
 * quotes when they ask us for help.
 *
 * The register is the install page's, and the SKIP rule is the one that matters most here: a skipped
 * step is work still waiting for a person, NOT a broken import, and it is rendered with the same
 * weight as a successful line.
 */
export const STOCK_PREP_SYNC_REASON_PLAIN: Record<string, StockPrepPlainEntry> = Object.freeze({
  // 1. 试算
  PLAN_READY: Object.freeze({
    zh: '算好了,没有需要人拿主意的地方',
    en: 'Planned — nothing needs a person to decide',
  }),
  PLAN_HELD_FOR_CONFIRMATION: Object.freeze({
    zh: '算好了,但其中有几行系统拿不准',
    en: 'Planned, but the system is unsure about some rows',
    zhNext: '这些行会先交给人确认,不会跟着这次一起写进去。',
    enNext: 'Those rows go to a person first and are not written with this run.',
  }),
  PLAN_PROJECT_NOT_FOUND: Object.freeze({
    zh: 'PLM 里没有找到这个项目号',
    en: 'PLM has no project with that number',
    zhNext: '请核对项目号有没有打错;也可能这个项目还没到 PLM 里。什么都没有改动。',
    enNext: 'Check the number for a typo — or the project may not be in PLM yet. Nothing was changed.',
  }),
  PLAN_LARGE_BOM_BOUNDED: Object.freeze({
    zh: '这个项目的 BOM 太大,没法当场展开',
    en: 'This project’s BOM is too large to expand on the spot',
    zhNext: '系统已经转去后台通道处理,下面能看到进度 —— 不用重新点同步,也不用联系我们。',
    enNext: 'The system has switched to the background channel — progress shows below. No need to sync again, and no need to contact us.',
  }),
  PLAN_NOT_APPLYABLE: Object.freeze({
    zh: '这次试算没能得出可以写入的计划',
    en: 'This plan cannot be written',
    zhNext: '源数据里有拦路的问题。什么都没有改动,可以稍后再试一次。',
    enNext: 'Something in the source data is blocking it. Nothing was changed; you can try again later.',
  }),
  PLAN_READ_FAILED: Object.freeze({
    zh: '没能连上取数,试算没有跑起来',
    en: 'Could not reach the source, so nothing was planned',
    zhNext: '稍后再试一次。什么都没有改动。',
    enNext: 'Try again shortly. Nothing was changed.',
  }),
  PLAN_MALFORMED_RESPONSE: Object.freeze({
    zh: '服务器回了一个看不懂的答复',
    en: 'The server answered with something we cannot read',
    zhNext: '通常是中间有一层网关拦了。请联系管理员;什么都没有改动。',
    enNext: 'Usually a gateway in between. Ask an administrator; nothing was changed.',
  }),

  // 2. 确认
  NOTHING_TO_CONFIRM: Object.freeze({
    zh: '这次没有需要确认的事',
    en: 'Nothing needed confirming this time',
  }),
  CONFIRMATIONS_QUEUED: Object.freeze({
    zh: '拿不准的行已经放进「确认队列」',
    en: 'The uncertain rows are now in the confirmation queue',
    zhNext: '到「确认队列」逐条拿主意,处理完再回来同步一次。',
    enNext: 'Work through them on the confirmation-queue tab, then sync again.',
  }),
  RECONCILE_UNAVAILABLE: Object.freeze({
    zh: '这次没能刷新「确认队列」',
    en: 'The confirmation queue was not refreshed this time',
    zhNext: '队列里原有的待办还在。可以直接去「确认队列」看,或稍后再同步一次。',
    enNext: 'Anything already in the queue is still there. Open the tab, or sync again later.',
  }),

  // 3. 写入
  IMPORTED: Object.freeze({
    zh: 'BOM 已经写进多维表',
    en: 'The BOM is in the multitable',
    zhNext: '可以到多维表里看数据了。',
    enNext: 'You can open the multitable and look at the data.',
  }),
  ALREADY_UP_TO_DATE: Object.freeze({
    zh: '表里已经是最新的,这次一行都不用改',
    en: 'The table was already current — not one row needed changing',
    zhNext: '同一份数据再同步一次不会重复写,这是正常的。',
    enNext: 'Syncing the same data again writes nothing twice; that is the expected result.',
  }),
  WRITE_HELD_FOR_CONFIRMATION: Object.freeze({
    zh: '先不写入 —— 等您把拿不准的那几行定下来',
    en: 'Not written yet — waiting for you to decide the uncertain rows',
    zhNext: '到「确认队列」处理完,再回来点一次同步,这次就会写进去。',
    enNext: 'Clear them on the confirmation-queue tab, then sync again and it will write.',
  }),
  WRITE_NO_PLAN: Object.freeze({
    zh: '没有可以执行的计划,所以没有写入',
    en: 'There was no plan to carry out, so nothing was written',
    zhNext: '请重新试算一次。什么都没有改动。',
    enNext: 'Run the plan again. Nothing was changed.',
  }),
  WRITE_PARTIAL: Object.freeze({
    zh: '写进去一部分,还有一部分没写成',
    en: 'Some rows landed and some did not',
    zhNext: '已经写进去的不会重复写。再同步一次会把剩下的补上。',
    enNext: 'What landed will not be written twice. Sync again to pick up the rest.',
  }),
  WRITE_FAILED: Object.freeze({
    zh: '这一步没有写成,数据没有变化',
    en: 'That did not write; nothing was changed',
    zhNext: '可以再点一次同步;重复同步不会弄乱数据。',
    enNext: 'You can sync again — re-syncing cannot scramble your data.',
  }),

  // 4. 批次存档
  BATCH_ARCHIVED: Object.freeze({
    zh: '这次的样子已经存了一份',
    en: 'A copy of what this sync saw has been kept',
    zhNext: '到「BOM 快照批次与差异」可以拿它和上一份比。',
    enNext: 'Compare it with the previous one on the snapshot-batch and diff tab.',
  }),
  BATCH_ALREADY_ARCHIVED: Object.freeze({
    zh: '这一批之前已经存过了,没有重复存',
    en: 'This batch was already kept; nothing was stored twice',
  }),
  BATCH_ARCHIVE_OUTCOME_UNKNOWN: Object.freeze({
    zh: '存档这一步跑完了,但服务器没说清这批是新存的还是原本就有',
    en: 'The archive step finished, but the server did not say whether this batch is new or was already there',
    zhNext: '到「BOM 快照批次与差异」看一眼就知道;导入本身不受影响。',
    enNext: 'The snapshot-batch and diff tab shows which; the import itself is unaffected.',
  }),
  BATCH_ARCHIVE_DISABLED: Object.freeze({
    zh: '这套部署没有开启批次存档',
    en: 'This deployment does not keep snapshot batches',
    zhNext: '数据已经写进多维表了,只是不会留历史批次用来做差异对比。这是设置,不是故障。',
    enNext: 'The data is in the multitable; there is just no historical batch to diff against. That is a setting, not a fault.',
  }),
  BATCH_ARCHIVE_NOT_ATTEMPTED: Object.freeze({
    zh: '这次没有写入数据,所以不用存档',
    en: 'Nothing was written this time, so there is nothing to keep',
  }),
  BATCH_ARCHIVE_FAILED: Object.freeze({
    zh: '数据已经写进去了,但这次的存档没成功',
    en: 'The data is in, but keeping a copy of this sync did not work',
    zhNext: '导入本身不受影响,可以照常用。差异对比会少这一批,再同步一次通常就补上了。',
    enNext: 'The import itself is fine and usable. The diff view will be missing this batch; syncing again usually adds it.',
  }),
})

export function stockPrepSyncReasonPlain(reason: string): StockPrepPlainEntry | null {
  return lookup(STOCK_PREP_SYNC_REASON_PLAIN, reason)
}

/**
 * 「导进去了吗?」 — answered in one sentence before any step is read, the way the install page
 * answers 「装好了吗?」. `held` is the one that had to be said out loud: it is the system waiting for
 * a person, and a page that renders it as a red failure teaches operators to ignore red.
 */
export const STOCK_PREP_SYNC_VERDICT_PLAIN: Record<string, StockPrepPlainEntry> = Object.freeze({
  imported: Object.freeze({
    zh: '导入完成 —— 这个项目的 BOM 已经在多维表里了。',
    en: 'Imported — this project’s BOM is now in the multitable.',
  }),
  already_up_to_date: Object.freeze({
    zh: '已经是最新的 —— 表里的数据和 PLM 一致,这次没有需要改的行。',
    en: 'Already current — the table matches PLM and no row needed changing.',
  }),
  /**
   * A PARTIAL WRITE IS AN IMPORT. Rows are in the sheet. This sentence used to be the `blocked` one —
   * 「这次没有导入成功,数据没有变化」 — which was simply false, and false in the direction that costs
   * an operator the most: they go looking for data they are told is not there.
   */
  partial: Object.freeze({
    zh: '写入了一部分 —— 已经写进去的行现在就在多维表里,还有几行没有写成。',
    en: 'Partly written — the rows that landed are in the multitable now, and some did not write.',
    zhNext: '已经写进去的不会重复写。再点一次同步会把剩下的补上;还是补不上的话,下面每一步都写了卡在哪里。',
    enNext: 'What landed will not be written twice. Sync again to pick up the rest; if it still does not, each step below says where it stopped.',
  }),
  held: Object.freeze({
    zh: '还差一步:有几行需要您先拿个主意,定完再同步一次就写进去了。',
    en: 'One step to go: a few rows need your decision. Decide them, sync again, and it writes.',
    zhNext: '这不是出错 —— 系统碰到拿不准的地方会停下来问您,而不是自己猜。',
    enNext: 'This is not an error — where the system is unsure it stops and asks you rather than guessing.',
  }),
  blocked: Object.freeze({
    zh: '这次没有导入成功,数据没有变化。',
    en: 'Nothing was imported this time, and nothing was changed.',
  }),
  not_run: Object.freeze({
    zh: '还没有同步过。填上项目号,点「同步这个项目」。',
    en: 'Not synced yet. Type a project number and press sync.',
  }),
})

export function stockPrepSyncVerdictPlain(verdict: string): StockPrepPlainEntry | null {
  return lookup(STOCK_PREP_SYNC_VERDICT_PLAIN, verdict)
}

// ---------------------------------------------------------------------------
// 大 BOM 后台通道 — the seven phases of largeBomPull.ts's run
// ---------------------------------------------------------------------------

/**
 * `PLAN_LARGE_BOM_BOUNDED` above says the ONE sentence that fires the moment the SKIP lands; these
 * six cover every NON-FAILURE phase of the background channel after that, one entry per
 * non-`failed` `StockPreparationLargeBomPullPhase`. There is deliberately NO `failed` entry here: a
 * failure renders through `stockPrepErrorPlain` below instead — the SAME lookup every other failure
 * on this workbench uses (`FORBIDDEN`, a confirm-request failure, …) — rather than a second, bespoke
 * "something went wrong" sentence living in a different table than the one an operator's other
 * failures already come from.
 */
export const STOCK_PREP_LARGE_BOM_PHASE_PLAIN: Record<string, StockPrepPlainEntry> = Object.freeze({
  queued: Object.freeze({
    zh: '排队中,准备展开这个项目的 BOM',
    en: 'Queued — about to expand this project’s BOM',
  }),
  expanding: Object.freeze({
    zh: '正在后台展开 BOM…',
    en: 'Expanding the BOM in the background…',
  }),
  planning: Object.freeze({
    zh: '展开完成,正在核对和现有数据的差异',
    en: 'Expansion done — checking for conflicts with what is already there',
  }),
  confirm_required: Object.freeze({
    zh: '有几行系统拿不准,需要人工确认',
    en: 'Some rows need a person to confirm',
    zhNext: '这条 BOM 太大,现在还不能在这个面板里帮您确认这些行;请联系我们安排处理。到目前为止什么都没有写入。',
    enNext: 'This BOM is too large for this panel to walk you through those rows yet — ask us to arrange it. Nothing has been written so far.',
  }),
  applying: Object.freeze({
    zh: '正在把展开出来的数据写进多维表…',
    en: 'Writing the expanded rows into the multitable…',
  }),
  done: Object.freeze({
    zh: 'BOM 已经写进多维表',
    en: 'The BOM is in the multitable',
    zhNext: '可以到多维表里看数据了。',
    enNext: 'You can open the multitable and look at the data.',
  }),
})

export function stockPrepLargeBomPhasePlain(phase: string): StockPrepPlainEntry | null {
  return lookup(STOCK_PREP_LARGE_BOM_PHASE_PLAIN, phase)
}
