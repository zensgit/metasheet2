# Time Machine O-2 阶梯 —— L1(staging ENABLE triggers)关闭记录

> **状态:CLOSED**(owner 宣告,2026-08-26)。本文件是 L1 的证据台账,**不授权任何后续动作**:
> L2 及其之后仍 HOLD,production 未触碰,四个 recovery flag 全程 OFF。

## 0. 一页看全

L1 的四条判据全部有据,证据均绑定 exact SHA,且每条都记录了它**证明不了**什么。
时间窗:`2026-08-24T10:25:17.641Z` → `2026-08-25T14:55:51Z`(≈28.5h,已满足 ≥2 日历日以外的现行判据口径见 §5)。

| 判据 | 证据 | 结论 |
|---|---|---|
| L1 电池 PASS | run `32862460377` @ `8fa91caf644fa9f638243067e64f31eec997c075` | PASS |
| staging 姿态见证 | run `32862572066`,`mode=postdeploy-full posture=l1-armed` | PASS |
| PostgreSQL 观察轴 | run `32871925465` @ `ab4d5955be`,`mode=l1-postgres-window` | PASS |
| 时延观察 | 同电池 run,§4 | **有界残留,owner 已接受** |

## 1. L1 电池

```
VERDICT: PASS - 11/11 surfaces blocked with RECOVERY_AUTHORITY_BUSY,
11/11 cleared after release, 2/2 wrong-kind controls green,
6/9 recovery-authority TRIGGERS exercised this run (declarative ceiling 6/9),
43 census sites NOT driven, 0 failure(s)
```

**provenance(A1.3 绑定)**:
```
script_sha256 = cfb6ec0a79ca7d42dae3ef39fb51dfd472ac27d1566e31f7318a8dbbf47a5970
build_commit  = 8fa91caf644fa9f638243067e64f31eec997c075
posture       = 9/9 ARMED
failures      = []
```

**⚠️ 这条绑定救过一次假关闭。** 更早的一次 battery(run `32837267731`)同样报 PASS、零残留、凭据清除,
但其 `script_sha256 = 62419aa6…` 对应 `c345c6b405` —— **staging 镜像当时仍停在 08-24 的旧版**,
`#5147` 之后的 `multitable-l1-battery.mjs`(`94c96d5f → cfb6ec0a`)从未进过该镜像。
若只读 `VERDICT: PASS` 就宣告关闭,会把**旧树上的证据**当成 post-#5147 验收。
处置:owner 裁定重部署 exact SHA(拒绝"接受旧绑定"),部署后四项核验全过
(`build_commit`✓ / `script SHA`✓ / triggers `O`×9 ✓ / 五个 flag 全未设 ✓),再重跑电池。
**教训:PASS 不等于 PASS 在你以为的那棵树上。**

## 2. 姿态见证(bridge)

```
schema: VERDICT: PASS - recovery authority triggers/functions match the expected
        armed schema posture and no foreign_record_id FK exists on meta_links
VERDICT: PASS (postdeploy-full) — exact ladder posture 'l1-armed' matches
        running/next-restart flags and database recovery schema matches its expected trigger posture
```

**它检的是 5 个 flag,不是 4 个** —— `MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION` 是 #5151
加入姿态见证的第五个。(本线一份摘要曾按 #5151 前的旧口径写成 4 个,已更正;证据不受影响。)

## 3. PostgreSQL 观察轴 —— 换源,不是放宽判据

```
VERDICT: PASS (l1-postgres-window) — ordered PostgreSQL logs contain exactly 11 markers
in each constructed battery window; no authority-busy marker occurred outside them
and no deadlock was observed
```
五窗各 11、总计/构造 55/55、窗外 40001 = 0、40P01 = 0、解析错误 0。

**为什么需要换源**:先前尝试用 `docker logs --since` 取观察证据,得到"40001 命中 0"。
**那个 0 是假的**:容器在 `14:52:44Z` 因本次重部署被重建,日志只覆盖其后约 20 分钟
(占 28.5h 窗口的 ~1.2%,且落在窗口末尾),`--since` 取不到重建前的任何内容。
判别依据不是推理——**电池在窗口内构造过 11 次 BUSY,而探针命中 0**:
已知必然存在的东西没出现 ⇒ 探针瞎了,不能反读成"环境干净"(空读≠不存在)。
改用**跨容器重建留存的有序 PostgreSQL 日志**后,同一问题才有真答案。

**判据非恒真**(`multitable-recovery-flag-containment-check.yml`,分支 `ab4d5955be`):
`parse_errors > 0 || controls != 5 || marker_outside != 0 || deadlocks != 0` 任一即 `exit 2`。
其中 `controls != 5` 是正控:它要求五个 battery 窗口**各自**命中 11 个 marker。
**首轮 FAIL 正是它抓出了遗漏的第五次 battery run**;修正方式是补上真实运行记录,
**不是**把 `!= 5` 放宽 —— 这是"修正判据"与"迁就判据"的分界。

## 4. 时延观察 —— OWNER 已接受的有界残留

来源:电池 run `32862460377`,n=24。

| 组 | 含义 | 区间 |
|---|---|---|
| `cleared` | 释放后正常写入(= 无冲突时的平台权限写) | 26.4 – 112.0 ms |
| `blocked` | 持租约时被 409 拒 | 18.7 – 60.3 ms |
| `wrong-kind` | 不同租约种类,应放行 | 24.0 / 97.5 ms |

> **`platform permission-write latency = no material regression OBSERVED`**
> **RESIDUAL(owner-accepted 2026-08-26)**:同一请求集合**没有 triggers-DISABLED 对照基线**,
> 也**没有正式阈值**。因此这是「**未见明显劣化**」,**不是**「已证明无回归」。
> 任何引用本条的人必须同时引用这一行。

**使残留有界的三条(记录依据,不是论证结论)**:
1. `c345c6b405..8fa91caf64` **零新迁移**;multitable 运行时仅 #5157 两个文件,且该路径 default-OFF,
   L1 覆盖的既有授权写者未变 ⇒ 若有回归,只能来自触发器本身开销,而非新代码。
2. 触发器是 `BEFORE ROW` + `pg_try_advisory_xact_lock`(**非阻塞**),锁序 census 实证其
   "只产 busy/unavailable、不形成等待边" ⇒ 每行开销常数级,不随并发放大。
3. 上界 112ms 落在**放行**路径,竞争侧上界反而更低(60.3ms)。
   **这不构成证明**,但与"有回归"的预期方向相反。

## 5. 时间门

`2026-08-25T10:25:17Z` 门已满足。owner 裁定:部署 exact SHA 后**无需机械重等完整时间窗**
(依据:`c345c6b405..8fa91caf64` 无新迁移、唯一 multitable 运行时变化为 default-OFF 路径),
原观察时长沿用,但**必须以新镜像的 battery + bridge 补齐证据** —— 已补齐(§1、§2)。

## 6. 本次关闭**不**授权的事

- L2 及其之后:**HOLD**,直至 owner 就阶梯 erratum 的四项作出裁决并据此修订阶梯
  (顺序 fence 不晚于 strict / 第五个 flag 入 §0 清单 / 明确哪一级 provision trust checkpoint /
  该 flag 的运维证据载体)。**ratify erratum 本身不解除 HOLD。**
- production:未触碰,不在本次范围。
- 四个 recovery flag:全程 OFF,本次未改动任何 flag。
