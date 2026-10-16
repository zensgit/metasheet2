# SA-05C2：已知实例只读观察，不冒充历史发送证明

日期2026-09-30；基线b35d4cd1fbaa50d0cf15e1a75745f77624a9468a叠本地SA01–05C1。内部机制决策；无新runtime consumer、真实凭据读取或网络授权，后续独立发布仍按GOV-08。

## 1. 真实缺口与范围

SA05C1的ACK只表示协议应答。旧备料用六键搜索、父图号补比较，未核分页/total；查空后创建、取第一条更新、吞错计成功均不可继承。当前planner示例七键，但合同支持1–8个映射键；可选空父项只在emptyKeyFields内允许absent/null/空字符串归一，纯空白不可。

本片新增固定GetFormDataByID传输与纯观察比较，保留原runner/store/088不改。只有显式注入fetch才能调用，缺省OFF；全部测试合成，零真实token/业务API。不给用户新增发送/回查按钮，不接worker、路由、Automation或新env开关。

不能声称完成历史对账：088没存原grant/config/row，公共投影也没ACK实例；当前配置不能代替历史快照。未来要可信不可变plan/grant材料或与prepare原子落地的锚点，以及独立读取授权、私有回查口/只追加observation存储。本片不修改旧终态、不重新领取或发送。

## 2. 官方协议证据

实读[官方yida_1_0固定1986c966](https://github.com/alibabacloud-go/dingtalk/blob/1986c966942afc67b8ccae59d29d57989a45fe76/yida_1_0/client.go)：GetFormDataByIDRequest5622–5635；ResponseBody5666–5679；执行24393–24444。GET `/v1.0/yida/forms/instances/{id}`，query包含appType/systemToken/userId，可选language本片不传；header x-acs-dingtalk-access-token。响应formInstId、formData，另有modifiedTimeGMT/originator。本片只保留前两者。HTTPS是本地强制策略。

**响应不回显appType/formUuid，不能构造虚假的响应表单身份。** 请求appType与既有实例ID只能约束请求；获准表单/实例归属需未来可信来源证明。此函数的matched仅指该实例的所比较字段，不证明表单归属、历史内容、本次操作因果或全局无重复。

## 3. 固定只读transport

新增CJS `lib/yida-form-readback.cjs`：

```text
createYidaFormReadback({fetch,readEnablement?})
  .read({appType,instanceId,accessToken,systemToken,userId},{signal})
  -> {statusCode,instanceId,formData}
```

闭集own-data输入，不收URL/header/path/body。appType 1..128无控制/首尾空白；路径instanceId只接受ASCII字母数字下划线连字符1..128（本地限制，不能把GET路径当任意字符串拼接）。accessToken1..8192无控制/首尾空白；systemToken1..4096、userId1..128非全空白，字节保留。仅本realm直接原生AbortSignal，拒Proxy/继承。开关缺省OFF，仅exact `'true'`；误返回普通同realm原生Promise（直接Promise.prototype、无自身constructor）时，在受保护的观察调用中消费拒绝，但异步值仍拒绝。其它Promise只拒绝，不触发其constructor/then getter、不改写调用方对象。不承诺处理同进程恶意依赖事先制造的未捕获拒绝或全局原型篡改；调用本身的失败仍为固定DISABLED。

固定HTTPS/GET/query用URLSearchParams编码；appType/systemToken/userId在编码前逐UTF-16 code unit拒绝孤立surrogate，保留合法surrogate pair，避免URLSearchParams静默替换为U+FFFD而改变材料；编码再解码必须与原字符串完全一致，不trim/normalize。凭据在协议要求的query中，只到私有fetch，不能进入结果/日志/异常。Accept JSON，redirect:error；拒3xx/redirected/非2xx/空或错形状，404也不证明未发送。无重试、分页、search、刷新token或默认fetch。

与既有transport相同保留实际pending：取消向下传递、取消reader做best effort，fetch忽略signal时等待它真正结束，再丢弃迟到结果；不承诺物理socket已终止。原生Response/ReadableStream、最大128KiB UTF-8正文/131073次read，显式Content-Length先界定、实际字节再次界定。深度12、节点4096、每对象/数组最多256项、字符串最多8192字符。schema顶层只收官方四字段，必须formInstId与请求精确相等、formData为plain object；其余两字段不返回，内部formData复制冻结。不回显HTTP header/上游异常。

JSON必须在接受数值前验证原始词法：拒重复键（含转义等价）、负零、非有限、不安全整数、精度舍入/下溢；合法等价指数/小数写法可接受，不能仅JSON.parse后比较。使用有界线性词法解析，不用eval或巨型回溯正则。允许未映射字段中有受预算约束的标准JSON嵌套值，不为比较几个控件假设整张表没有其它字段。固定YIDA_READBACK_*错误，无cause/原文。

## 4. 纯values-free比较

新增ESM `lib/yida-readback-observation.mjs`：

```text
compareYidaReadback({config,row,expectedInstanceId,observation})
```

config须实际v2，row单条，调用实际buildYidaStaticPlan且恰好一行有效、payload/业务键有效。所有输入先做plain own-data/Proxy/getter/非有限/负零、256KiB/4096节点/深度12预检，再用strict canonical codec复制冻结；不先把-0规范化成0。expectedInstanceId为null或上述安全路径ID；update非null还必须等于planner实例。observation为null或transport的精确三个字段，2xx、ID合法、formData标准JSON对象。无I/O，不导入store/token/runner。

known instance匹配后，比较字段集合为实际planner.payload目标字段与config.businessKey映射目标字段的并集：同类型精确比较；不trim、不string→number、不array→string。仅emptyKeyFields声明的空业务键以absent/null/''等价；纯空白不等价。其它发送字段缺失分别计missing、错误值/类型计mismatched；其它未发送/未作身份的远端字段忽略。特别是update中省略字段并不要求远端清空。

结果闭集：

```text
kind: 'yida_known_instance_observation'
status: 'observed_match' | 'observed_mismatch' | 'inconclusive'
businessVerified: false
historyVerified: false
formOwnershipVerified: false
canRetry: false
comparedFieldCount, matchedFieldCount, mismatchedFieldCount, missingFieldCount
businessKeyMismatchCount
reasonCodes: 固定有界枚举数组
```

前三个字段计数和missing合计必须等于compared，key mismatch为其中子集。unknown实例、无observation、实例不符均inconclusive且所有计数0，理由依次INSTANCE_UNRESOLVED/NO_OBSERVATION/INSTANCE_MISMATCH；字段差异理由FIELD_MISMATCH/FIELD_MISSING，完全一致理由空。不给业务值、字段名、凭据、实例/目标ID、摘要或原始响应。缺少实例的未知CREATE不会退化成查询后重建。config/formUuid变化不能靠供应商不存在的字段验证，结果固定三个false明确不升级为成功。

## 5. 验证与停止

真实planner→固定readback→原生Response/流→纯比较组合，只有fetch合成；无假planner/比较守卫。明确测不同源布局、1–8键、空父项、已发送字段与省略字段、数值词法、空/错实例/404、重定向、取消、流预算、getter/Proxy、零日志/零ledger/零send，以及更换formUuid无法被该响应证明的限制正例。新两Node整文件登记实际test-chain。独立作者写组合/反例，主审执行最终候选和合法内存变异；不借旧测试绿证明新路径。

撤掉未注册模块和测试登记即可回滚，不碰088/历史。最终SA05仍须持久授权/原始锚点/真实表单归属/业务收据与恢复；SA06继续待独立可信动作合同。这个增量不缩小总目标，也不宣称在线发送或历史对账已经交付。

## 6. 当前整合续记（2026-10-09）

两模块及两Node测试已按旧源原字节迁入afd32b704候选，与当前C1、088/089/090/091共同回归；全部宜搭Node416/416、provenance/链门4/4。未注册runtime消费者、未调用远端、未改协议/观察语义，四个false保证仍保留。完整证据见目标§128及candidate `artifacts/yida-runner-20261009/verification.md`；这不是远端现版本协议验收或历史业务成功回执。
