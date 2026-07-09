/**
 * G-B2-17: 模板中心 requester 卡片画廊 — 纯过滤函数。
 *
 * 「给定模板列表 + 分类筛选 + 搜索词 → 可见模板」这条逻辑被抽到这里，独立于
 * TemplateCenterView.vue 之外，理由：
 *   1. 卡片画廊（!canManageTemplates 分支）需要即时过滤反馈 —— 用户每敲一个字符就重算可见
 *      集合，不必等 Enter 触发后端请求。
 *   2. 管理员表格视图完全不消费这个函数，继续直接渲染 `store.templates`（后端过滤），行为
 *      不变 —— 这是分叉设计的一部分，不是遗漏。
 *
 * **谓词必须与服务端一致**（这是本模块最重要的约束）。服务端 `listTemplates` 的实际 SQL 是：
 *
 *     (name ILIKE '%q%' OR key ILIKE '%q%')   AND   category = $n
 *
 * 因此这里也只匹配 **name 或 key**，且分类是**精确相等**：
 *   - 若这里额外匹配 `description`：用户边打字时能看到一张「描述命中」的卡，一按 Enter
 *     服务端重新过滤（不看 description）→ 卡片**凭空消失**。让人看见一个按下回车就不存在的
 *     结果，比不给即时反馈更糟。
 *   - 若这里**漏掉** `key`：服务端明明按 key 命中并返回了该模板，画廊却把它**过滤掉**
 *     —— 用户按 key 搜索得到一片空白。（这正是本函数最初的缺陷。）
 *
 * 即：本地过滤是「服务端会返回什么」的忠实预览（分页范围内），不是一套更宽或更窄的平行语义。
 * 若将来希望描述可搜，正确的做法是**改服务端谓词**，而不是让前端单方面放宽。
 *
 * 保持零依赖（不碰 store / API / Vue），方便用矩阵单测钉死行为，而不必挂载整个视图组件。
 */

export interface GalleryFilterableTemplate {
  name: string
  /** 与服务端 `key ILIKE` 对齐；模板列表 DTO 一定带它。 */
  key?: string | null
  category?: string | null
}

export interface GalleryFilterOptions {
  /** 空字符串 / undefined / null = 不按分类过滤（全部分类）。 */
  category?: string | null
  /** 空字符串 / undefined / null = 不按搜索词过滤（全部模板）。 */
  search?: string | null
}

/**
 * 过滤规则（与服务端 SQL 谓词一一对应）：
 *   - category 非空 → 只保留 `category` 精确相等的模板（未分组模板在筛了具体分类时不出现）。
 *   - search 非空 → 大小写不敏感地匹配 `name` 或 `key`，任一命中即保留。**不匹配 description**。
 *   - 两个条件都提供时取交集（AND）。
 *   - 两者都为空 → 原样返回全量（不筛）。
 *   - 无命中 → 返回空数组。
 */
export function filterGalleryTemplates<T extends GalleryFilterableTemplate>(
  templates: readonly T[],
  options: GalleryFilterOptions = {},
): T[] {
  const category = options.category?.trim() || ''
  const query = options.search?.trim().toLowerCase() || ''

  return templates.filter((tpl) => {
    if (category && tpl.category !== category) return false
    if (!query) return true
    const name = tpl.name?.toLowerCase() ?? ''
    const key = tpl.key?.toLowerCase() ?? ''
    return name.includes(query) || key.includes(query)
  })
}
