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
- **Domain docs**：single-context —— repo root `CONTEXT.md` + `docs/adr/`，由 `/domain-modeling` 懒创建，缺失时静默继续。

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
- **Frontier（下一步可开）**：D1 #5、D2 #6、D3 #7、D4 #8、D5 #9、D6 #10、D7 #11、P1 #12、T2 #14。
- Resolve 约定（来自 `docs/agents/issue-tracker.md`）：评论 answer → `gh issue close` → 向 map 的 Decisions so far 追加 context pointer。
- findings 分支：`research/r1-api-mapping`、`research/r2-pickup-code-semantics`、`research/r3-open-gaps`（文件 `docs/research/*.md`）；本地副本 `.scratch/smart-locker-app/research/`。
- 推送方式：正文写 `.scratch/smart-locker-app/chart/*.md` → `gh issue create --body-file`（脚本 `push-chart.sh`，台账 `created.map`）。

## `.scratch/` 约定

- 兄弟仓库（`java/smart-locker`、`smart-locker-admin`、`vue/smart-locker-device`）统一用 `.scratch/<effort-name>/`（`spec.md` + `issues/NN-slug.md`，`Status:` 行记状态、评论追加到 `## Comments`）。
- 本仓库的 `.scratch/smart-locker-app/charting-brief.md` 是 wayfinder charting 的**临时 handoff**（2026-09-20 建）—— **已作废**（顶部加了 SUPERSEDED banner，未删除；`.scratch/` 未入版本控制，删除不可逆）。canonical artifact 现为 issue #1 及其 sub-issues。
- `.scratch/smart-locker-app/chart/`：推送前的正文草稿（`00-map.md` + `R*/D*/P1/T*`）+ `push-chart.sh` + 台账 `created.map`（ID→number→dbid）。`.scratch/smart-locker-app/research/`：三份 findings 的本地可读副本。
