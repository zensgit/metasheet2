# 多维表应用(Multitable Application)模型(2026-08-30,DRAFT)

> **地位**:接管后产品化候选二号,与《源接入自助化:确认不配置》(候选一号)配对;不进入当前任何门;values-free。
> **命名与定位由 owner 给出(2026-08-30)**:备料不是"一个插件的功能",而是第一个**多维表应用**。

## 0. 一句话定义

**多维表应用 = 建在多维表底座上的可安装业务单元**:一组受管表 + 操作页面 + 权限码 + 配置面 + 验收判据,由一份应用清单(manifest)声明,点击"安装"即自动就位。**装的是表和配置,不是代码**——代码永远随产品版本发布(CI/pin/溯源),动态代码分发是章程红线,永不做。

## 1. 应用清单(manifest)——安装器的唯一输入

```
app: stock-preparation
  managedObjects:                 # 幂等 ensure,安装器逐一补齐
    - plm_stock_preparation_confirmation_decision   (确认裁决账本, 16列)
    - plm_stock_preparation_sandbox_*               (沙箱目标, 25列; objectId 由清单给定, 不许自拟)
  permissions: stock-prep:read / :operate / :admin  # 种子化, 零自动授予(R-11)
  views: /stock-prep 确认队列工作台
  configSurfaces:                 # 安装后引导, 不阻塞安装
    - customer pack(装列)  - ext 字段映射  - 只读数据源(走"确认不配置"流程)
  envContract:                    # configure 脚本写入; 值随清单
    - STOCK_PREP_SANDBOX_MODE / STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS
  acceptance:                     # 安装完成的定义
    - dry-run→apply 后 ext_ 列非空 且 human_preserved 列保持空
    - 二次刷新全 skip(幂等)
  posture(只报不改):production Apply 关闭 / K3 永久禁写 / B2a 休眠 / 出站写门未设
```

## 2. 安装 = preflight(查)+ bootstrap(补)+ acceptance(验)

三个组件全部已有或在途:preflight 聚合检查(#5344 线)、幂等 ensure 端点(已有)、合成验收自举(脚本化中)。"安装"按钮只是把三者按清单串起来加进度条。**首次真机部署的两次事故(命名空间自拟、双方表名对不上)就是清单必须存在的理由**:objectId 在清单里,人不再取名。

## 3. 客户旅程(与候选一号拼合)

**装应用(一键)→ 接源(确认不配置,五步)→ 用(确认队列三动作)** ——全程点击与确认,零手工配置、零术语。

## 4. 治理不变量(安装器永不越过)

- 动态代码分发不存在;应用启停不改变任何围栏姿态;
- posture 四项只展示,永无"修复"按钮——安装器不得诱导武装 B2a/出站写/production Apply;
- 真实客户源接入永远走 草案→审核→服务端文件,不因"应用化"而短路;
- 受管表创建幂等且限于应用自己的命名空间(沙箱前缀守卫已实证)。

## 5. 节奏

- **H0(现在)**:首家客户手工走完;preflight + 自举脚本落地——它们就是安装器的前后两半。
- **H1(接管完成后)**:manifest 格式 + 安装页(点击→进度→绿),备料作首个应用做验收样本;判据:安装页产出与首家手工过程等效(同一组 ensure/配置/验收,零人工命名)。
- **H2**:第二个应用(考勤或审批按此模型改造)证明 manifest 的通用性;届时才谈应用列表/按租户开通。
