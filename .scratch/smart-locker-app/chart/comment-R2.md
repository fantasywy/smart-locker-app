**Findings 就位** → 分支 `research/r2-pickup-code-semantics`，文件 `docs/research/R2-pickup-code-semantics.md`（本地副本 `.scratch/smart-locker-app/research/R2-pickup-code-semantics.md`）。

**三个问题的直接答案**

1. **扫码 tab 是柜机码，不是取件码。** 内容 = 模板（默认 `{lockerCode}`）× 设备身份里的 `deviceCode`：`TerminalScanTab.vue:25-28`、`terminal-config.ts:25,122-126`；测试断言 `码内容：WD-02`（`terminal-scan.spec.ts:42-46`）。它是**出向**展示（屏 → 手机），**不回流**进 `pickup-verify`。
2. **`pickup-verify` 契约**：请求 `{pickupCode(6 位数字), lockerCode}`，`lockerCode` 必须与验签身份 `X-Device-Code` 一致、否则 `9003`；成功回 `{matched:true, orderNo, cellNo(可空), cellType, status, payable(可空), paid, hint(可空)}`；失败走 **HTTP 200 + `matched:false` + `reason(INVALID|CONSUMED)`**，不返回业务码。注意 `reject`（业务码 `9001/9002/9003`）与 `unmatched`（`INVALID/CONSUMED`）是**两个独立分支**，不要合并处理。
3. **取件码生命周期**：在 `DOOR_CLOSED`「规则 1」里与 `startAt` 同时写入；6 位零填充、**同一柜机内历史唯一不复用**；订单终局即失效；核销后码**保留在订单上供审计**，重复提交**稳定返回 `CONSUMED`**。中控屏**永不展示**取件码（键盘 tab 只接收键入，扫码 tab 只出柜机码）。

**可行性结论（D2 的事实基线）**

「小程序生成二维码 → 屏扫」在**当前实现下不可行**：屏端全仓无任何入站扫码 / 媒体采集能力（grep `camera|getUserMedia|mediaDevices` 命中的全是 3D 场景相机），唯一接收取件码的入口是屏上键盘键入，`pickup-verify` 也只接受键入值。要走这条路必须做**屏侧改造**，而屏侧改造属本 effort 的 **Out of scope**。对照之下，「小程序显示 6 位码 + 屏上键盘敲」已被现有契约完整支持、**零屏侧改动**。

**对既有记载的两处更正（已独立复核）**

- device **ADR-0003 与支付无关** —— 其真实主题是「开门只由指令驱动，点击门 = 模拟用户关门」（`0003-door-opens-only-by-command.md`）。「一期柜机屏不承载支付」的真出处是 `java/smart-locker/docs/API设计文档.md:1257`（另有屏端 `device/pickup.ts:19-21` 注释）。map #1 的 Notes 已按此更正。
- **「中控屏九态」需要收窄**：`TerminalStatus` 枚举其实只有 **7 个值**，九态是**显示态**（待机/输入中共用 `input`，已付清/待支付共用 `matched`）。九态完整触发表见 findings §4。

**未做**：**不裁决** A/B 选型（属 D2）；未改任何仓库。本票保持 open，待确认后关闭以解锁 D2。
