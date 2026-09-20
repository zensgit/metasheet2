/**
 * #5861 —— 安装去重给 `POST /templates/:id/install` 加了三类语句:事务级咨询锁、
 * 去重账本的读/写、以及账本的过期清理(见 src/multitable/template-install-dedupe.ts)。
 *
 * 路由级 mock-pool 测试的 store 是「认不出来的 SQL 就抛」的白名单式 fake,所以每一个
 * 走 install 路由的 store 都得认识这三类语句,否则会以 500 假红。这个 helper 给
 * **不测去重** 的那些 suite 用:锁恒成功、账本恒为空(= 永不重放)、写与清理恒成功。
 *
 * 真正验证去重语义的是 tests/unit/multitable-template-install-dedupe.test.ts —— 那里的
 * store 自己实现了一把真的按 key 互斥的锁和一个真的账本 Map,**不**用这个 helper。
 *
 * @returns 命中这三类语句时返回结果;不是这三类返回 null,交回调用方原来的分支。
 */
export function handleTemplateInstallDedupeSql(
  normalizedSql: string,
): { rows: any[]; rowCount?: number } | null {
  if (normalizedSql.includes('pg_advisory_xact_lock')) return { rows: [{}] }
  if (normalizedSql.includes('meta_multitable_template_installs')) return { rows: [], rowCount: 0 }
  return null
}
