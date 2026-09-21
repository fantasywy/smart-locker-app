# MEMORY.md — smart-locker-app 项目长期约定

## 项目本体

- 微信小程序，TypeScript + Sass。`project.config.json` 的 `useCompilerPlugins: ["typescript", "sass"]`，`miniprogramRoot: miniprogram/`。
- 结构：`miniprogram/`（app.ts/jsons、pages/{index,logs}、components/navigation-bar、utils）、`typings/types/wx/*`。
- 包管理用 pnpm；目前 `devDependencies` 只有 `miniprogram-api-typings`。

## 版本控制

- git 仓库于 2026-09-20 初始化，主分支 `main`。
- remote：`origin` = `git@github.com:fantasywy/smart-locker-app.git`（SSH）；`main` 跟踪 `origin/main`。首次 push 于 2026-09-20 15:42 完成。
- 提交者：`fantasywy <2329985979@qq.com>`（来自全局 git config）。
- **沙箱内可 push（2026-09-20 实测，推翻早前结论）**。早前症状：`~/.ssh`（`Could not stat /root/.ssh: Permission denied`），且 `ssh_config.d` 触发 "Bad owner or permissions"。**修正**：加这组参数即可正常 push —— `HOME=/home/fantasywy GIT_SSH_COMMAND='ssh -F /dev/null -i /home/fantasywy/.ssh/id_ed25519 -o UserKnownHostsFile=/home/fantasywy/.ssh/known_hosts'`。
- **`gh` 已装好可用**（2026-09-20）：`~/.local/bin/gh` v2.101.0，从 release tarball 装（**无需 sudo**；解压必须 `--no-same-owner`）。认证走设备码，token 存 `~/.config/gh/hosts.yml`，scope `repo,read:org`。每次调用前 `export PATH=/home/fantasywy/.local/bin:$PATH HOME=/home/fantasywy`。
- **沙箱 `/tmp` 是 10M tmpfs** → 大文件下载要换目录（如 `~/.local/dl`）。
- `.gitignore` 排除：`node_modules/`、`miniprogram_npm/`、`project.private.config.json`、`*.bak`、`dist/`、编辑器与系统文件、`*.log`。
  - `*.bak` 是微信开发者工具自动生成的备份（`app.json.bak` 等），不入库。
  - `project.private.config.json` 按微信官方惯例属本地私有配置，不入库。
- `.workbuddy/`（项目记忆）目前**纳入**版本控制。若要排除需改 `.gitignore`。

## Engineering skills 约定

由 `setup-matt-pocock-skills` 建立，入口在 `AGENTS.md` 的 `## Agent skills`：

- **Issue tracker**：**GitHub Issues**（`fantasywy/smart-locker-app`），操作走 `gh` CLI。最初因无 remote 选了 Local markdown，配好 remote 后改用 GitHub。
- **Triage labels**：保留五个 canonical 字符串（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`），见 `docs/agents/triage-labels.md`。在 GitHub 上这些是真实 label，`gh --add-label` 会自动创建。
- **Domain docs**：single-context —— repo root `CONTEXT.md` + `docs/adr/`，由 `/domain-modeling` 懒创建，缺失时静默继续。**`CONTEXT.md` 已于 2026-09-21 建立**（D2 的术语：柜机码 / 中控屏 / 开门指令 / 取件码 / 取件开门 / 存入 / 取件）。
- **spec 编号**：`docs/spec/NN-<topic>.md`，编号即阅读顺序，D 票顺延取号。现有 `01-entry-and-identity.md`（D1）、`02-c-end-device-boundary.md`（D2）。ADR：`docs/adr/0001-c-end-no-locker-browsing.md`（D1 占用 0001，D7 的 ADR 需顺延为 0002）。

改 tracker 或 label 名字直接编辑 `docs/agents/*.md`；只有换 tracker 类型或从零重来才需重跑该 skill。
**前置依赖**：triage / to-tickets / to-spec / wayfinder 依赖能访问 GitHub，否则跑不起来。

## GitHub 连接器（替代 `gh` 的路径）

- **连接器只有「公共仓库只读」权限**（2026-09-20 实测）：私有仓库一律 404；公共仓库可读，但 `issue_write` 一律 `403 Resource not accessible by integration`。→ **写 issue 不要走连接器，走 `gh` CLI**。
- 已绑定 **GitHub 连接器**（`bound: true, enabled: true`），endpoint `https://api.githubcopilot.com/mcp/`；凭据以 `Authorization` header override 加密存于 `~/.workbuddy/connectors/<identity-id>/connector-states.json`。
- **坑（已实测）**：连接器的 MCP 工具**只在「绑定之后新开」的 session 里可见**——工具注册发生在 session 边界。在绑定它的那个 session 内，`create_issue` / `list_issues` / `get_me` 等名字全部搜不到，直接调用报 `not found in the deferred tools index`。**绑定完必须重开 session。**
- 仓库于 2026-09-20 转为 **PUBLIC**（用户为解阻塞而翻转）。**注意**：chart 的 ticket body 引用了后端 §13 端点 / §15 错误码 / 设备签名等只存在于私有仓库的细节，等于对外发布；如需收回隐私把仓库翻回私有即可 —— `gh` token 的 `repo` scope 对私有/公共都能写。
- 连接器工具补上后的等价操作名：`create_issue` / `list_issues` / `get_issue` / `update_issue` / `add_issue_comment` / `sub_issue_write`。

## Wayfinder chart（canonical artifact）

- **map = issue #1**（label `wayfinder:map`），child **#2–#14**，全部 native sub-issue；blocking 用 native dependencies（database id）。
- 编号：R1 #2 / R2 #3 / R3 #4（research）；D1 #5 / D2 #6 / D3 #7 / D4 #8 / D5 #9 / D6 #10 / D7 #11（grilling）；P1 #12（prototype）；T1 #13 / T2 #14（task）。
- Blocking edges：R1→D1/D4/D5/D6；R2→D2；R3→D3；D3→T1。
- Labels：`wayfinder:map|research|grilling|prototype|task`。**R1–R3（#2–#4）已于 2026-09-20 resolve 关闭**，随之解锁 D1–D6；`#5`–`#10` 的 `blocked_by` 实测已归 0。**T1（#13）仍被 D3 阻塞**。
- **Frontier（下一步可开）**：D3 #7、D4 #8、D5 #9、D6 #10、D7 #11、P1 #12、T2 #14 —— **D1 #5 与 D2 #6 已于 2026-09-20 / 09-21 resolve**（T1 #13 仍被 D3 阻塞）。
- Resolve 约定（来自 `docs/agents/issue-tracker.md`）：评论 answer → `gh issue close` → 向 map 的 Decisions so far 追加 context pointer。

### D2 的结论（#6，2026-09-21，三轮 grilling）

**取件链路的关键事实**（票面原前提被推翻）：

- **开门只能由服务端 `OPEN_CELL` 指令驱动**，指令来源只有三个：`13.7` 下单（`USER_DROP`）、`13.11` 支付（`USER_PICKUP`，**支付即开门**）、管理端手动（`ADMIN_FORCE`）。
- **屏端 `pickup-verify` 不产生任何指令** ⇒ 屏上敲取件码从不开门。屏 = 只读查询台，小程序 = 唯一开门发起方。
- **取件码没有开门力**：它只是「带到屏上敲」的查询凭据。⇒ C 端必须有「**取件开门**」动作，实现 = 幂等 `13.11`（未清账先清账；已清账则只重发指令）。**重试入口就是同一个按钮**。
- 派生判定：**能不能取件 = `pickupCode !== null`**；**付没付清 = `payAmount !== null`**（⚠️ 不是 `> 0` —— 全免单是 0 元 `SUCCESS` 支付单）。
- ⚠️ **一期 `paid` 与 `openCommandIssued` 都写死 `true`**（`AppOrderServiceImpl.java:199`）⇒ 不是「指令下发了」的证据，点完不许渲染「门已开」。
- 「把码发给别人代取」判死（开门只认本人 token）；取件不可达的唯一人工出口 = 客服 → 管理端 `ADMIN_FORCE`。
- 产物：`docs/spec/02-c-end-device-boundary.md` + 新建 repo root **`CONTEXT.md`**（首个 glossary，single-context）。屏侧**无需改动**，只有两条登记项（hint 术语同步、屏端键盘按钮文案「开门」的观感冲突）。
- findings 分支：`research/r1-api-mapping`、`research/r2-pickup-code-semantics`、`research/r3-open-gaps`（文件 `docs/research/*.md`）；本地副本 `.scratch/smart-locker-app/research/`。
- 推送方式：正文写 `.scratch/smart-locker-app/chart/*.md` → `gh issue create --body-file`（脚本 `push-chart.sh`，台账 `created.map`）。

## `.scratch/` 约定

- 兄弟仓库（`java/smart-locker`、`smart-locker-admin`、`vue/smart-locker-device`）统一用 `.scratch/<effort-name>/`（`spec.md` + `issues/NN-slug.md`，`Status:` 行记状态、评论追加到 `## Comments`）。
- 本仓库的 `.scratch/smart-locker-app/charting-brief.md` 是 wayfinder charting 的**临时 handoff**（2026-09-20 建）—— **已作废**（顶部加了 SUPERSEDED banner，未删除；`.scratch/` 未入版本控制，删除不可逆）。canonical artifact 现为 issue #1 及其 sub-issues。
- `.scratch/smart-locker-app/chart/`：推送前的正文草稿（`00-map.md` + `R*/D*/P1/T*`）+ `push-chart.sh` + 台账 `created.map`（ID→number→dbid）。`.scratch/smart-locker-app/research/`：三份 findings 的本地可读副本。
