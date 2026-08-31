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
    zhNext: '要走后台展开的通道,请联系我们安排。什么都没有改动。',
    enNext: 'It needs the background expansion channel — ask us to arrange it. Nothing was changed.',
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
