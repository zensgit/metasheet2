/**
 * G-B2-17: 模板中心 requester 卡片画廊 — 纯过滤函数。
 *
 * 「给定模板列表 + 分类筛选 + 搜索词 → 可见模板」这条逻辑被抽到这里，独立于
 * TemplateCenterView.vue 之外，理由：
 *   1. 卡片画廊（!canManageTemplates 分支）需要即时过滤反馈 —— 用户每敲一个字符就重算可见
 *      集合，不必等 Enter/blur 触发后端请求（后端请求仍然发生，只是画廊不等它）。
 *   2. 覆盖范围比后端 `search` 参数更宽：同时命中模板名称与描述（参见
 *      approvals/api.ts 里 `listTemplates` 的 mock 实现，目前只按名称过滤），画廊要对普通
 *      员工诚实 —— 描述里的关键词也应该能被搜到。
 *   3. 管理员表格视图完全不消费这个函数，继续直接渲染 `store.templates`（后端过滤），行为
 *      不变 —— 这是分叉设计的一部分，不是遗漏。
 *
 * 保持零依赖（不碰 store / API / Vue），方便用矩阵单测钉死行为，而不必挂载整个视图组件。
 */

export interface GalleryFilterableTemplate {
  name: string
  description?: string | null
  category?: string | null
}

export interface GalleryFilterOptions {
  /** 空字符串 / undefined / null = 不按分类过滤（全部分类）。 */
  category?: string | null
  /** 空字符串 / undefined / null = 不按搜索词过滤（全部模板）。 */
  search?: string | null
}

/**
 * 过滤规则：
 *   - category 非空时，只保留 `category` 精确相等的模板（未分组模板在筛了具体分类时不出现）。
 *   - search 非空时，大小写不敏感地匹配 name 或 description 任一命中即保留。
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
    const description = tpl.description?.toLowerCase() ?? ''
    return name.includes(query) || description.includes(query)
  })
}
