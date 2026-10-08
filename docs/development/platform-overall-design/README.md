# MetaSheet 业务应用平台化总体设计 — v9.1 冻结稿与评审链存档

> **为什么有这个目录(2026-08-24)**:v9.1 被宣布"冻结为 Ratification Review 输入"后,其**唯一副本**一直躺在一个会话临时目录里,仓库零副本——临时目录一清,冻结设计就蒸发。本目录把冻结稿与整条评审链落库。此前 `AGENTS.md` 引用的这份文档在仓库里并不存在;自本提交起存在。

## 文件

| 文件 | 是什么 |
|---|---|
| `metasheet-business-app-platform-overall-design-v9.1-20260820.md` | **冻结稿本体**(机械勘误版,Ready for Ratification Review — Not Yet Design-Locked;基线 rebaseline 至 `c5a4a94f7`) |
| `multitable-external-data-and-app-template-design-20260820.md` | 姊妹篇:外部数据引入 + 应用模板设计 |
| `reviews/codex-cross-review-of-claude-two-docs-20260820.md` | 评审链起点:对最初两份设计(v3 期)的复核——"约 80% 可采纳,不能原样立项" |
| `reviews/codex-deep-review-of-v6-20260820.md` | v6 深审:"接近 design-lock",进锁前必修六项 |
| `reviews/claude-reply-to-codex-fifth-round-20260820.md` | 我方对第五轮(v8)的逐项裁决 + 停止 prose 往返的收敛提议 |
| `reviews/codex-sixth-review-of-v9-20260820.md` | 第六轮(对 v9):有条件接受,列八条机械勘误 → 触发 v9.1 |

## 两条必须知道的警告

1. **不要把 Downloads 里的旧 PDF 递给任何评审人。** 2026-08-24 审计确认:磁盘上挂着 v9.1 文件名的 PDF 实际渲染的是 **v3 陈稿**(首页写"总体设计 v3",基线 `9d4a87824`)。正式送审 PDF 尚未重排;在那之前,唯一权威版本是本目录的 markdown。
2. **冻结 ≠ ratify。** 冻结钉在 `c5a4a94f7fc4ae8347ea9ad9da9fa446ccd87a4d`;ratification 从未发生,截至本提交 main 已漂移约 100 个 commit / 12 个迁移。届时基线需重钉并重跑代码事实,不能直接消费本冻结点。

## 第六轮复核完成度(2026-08-24 逐条审计结论)

按性质分开算,不按"开发"混算:

- **文档勘误 8 条**:6 完成、1 部分(勘误 4:`timer` 一词全文零出现,两处仍保留 §2.5 明确说不要投的 designer 租户授权方向)、1 未做(勘误 8:PDF 重排)。
- **代码**:#5034 已合入 main,BPMN fail-closed 门**机制侧六面全关**、开关精确 `'true'` 才开;但**八条验收测试零条完整落地**——尤其"已有 timer 不执行"(评审专门点名的最硬一条)没有任何测试播种 WAITING `bpmn_timer_jobs` 行再以 flag off 验证;关闭前盘点不存在;`assertSheetScope` 盘点从未产出、默认仍 observe;**App Center 权限 runtime enforcement 一行未写**(评审结尾"不能对客户宣称权限隔离"在今天的 main 上原样成立)。
- **三个 spike(Principal / Mirror Publication / External Key Registry)**:零启动。按计划排在冻结之后,不算延误——但 §12 明说 P1 通用底座被它们卡死。
- **运维门**:四层 A/B/C/D 全部成文,C 层已合入 main(`../takeover-beiliao-20260821/beiliao-production-go-live-gate.md`);**门项 0/11 通过**(设计使然:通过靠演练与授权,不靠代码)。
- **B2a 窄路径**:`B2a` 在 main 全部 tracked 内容中**零出现**——评审要求的登记/范围/到期/禁复用机制只存在于冻结稿散文里,目前窄只靠自觉。

values-free:本目录不含主机名 / IP / 口令 / 凭据。
