**Findings 就位** → 分支 `research/r1-api-mapping`，文件 `docs/research/R1-api-mapping.md`。取用：`git show research/r1-api-mapping:docs/research/R1-api-mapping.md`（本地副本 `.scratch/smart-locker-app/research/R1-api-mapping.md`）。

**Gist**：§13 全部 16 个端点逐条拆到「方法 / 鉴权 / 请求字段 / 响应字段（含可空性）/ 全量错误码 / 幂等性」；四类端到端时序；令牌生命周期；15 条字段陷阱表；站点列表缺口确认。

**下游可直接拿去用的三条**

1. **401 判定式**：`401 + 2001` → 静默刷新一次并重放原请求；`401 + 2005` → 直接清登录态跳登录。这是 C 端请求层的地基，D7 可直接引用。
2. **支付响应里的 `orderStatus` 返回的是「当前实际状态」**（`IN_PROGRESS` / `TIMEOUT`），**不是** `COMPLETED`（后端 #8 修正过旧契约）。判断「已支付待取件」只认 `paid`。→ 直接约束 D6 的状态机与文案。
3. **「参考快照」陷阱字段在 C 端是 `estimatedAmount`**（仅「已存入且未结算」非空），**不是** brief 里写的 `payable` —— `payable` 只出现在设备端 `pickup-verify`。金额单位一律为**分**。

**文档冲突 / 未说清（比结论更重要）**

- **`13.6 GET /lockers/by-code` 鉴权自相矛盾**：§13 总则称需 Bearer，§1 路由例外清单又把它列为免 access 查询。**这条直接卡 D1 的入口设计**（未登录能否扫码查柜机）。
- `13.3 登出`鉴权未写明（路径在 `/auth/*` 例外里，但语义上必须能定位用户才能作废 refresh）。
- `13.16 积分明细`响应只写「结构同管理端 9.3」，字段形状未贴出 → C 端 TS 类型缺定义。
- `13.7` 柜机不存在时归 `4004` 还是 `4001`（错误码表两者都在）→ 建议客户端两个都兜。
- 订单 `status` 与 `cellType` 的枚举全集未在用户端章节穷举，需去管理端 7.1 取。

**未做**：不裁决交互；未改任何仓库。本票按 charting 约定保持 open，待确认后关闭以解锁 D1 / D4 / D5 / D6。
