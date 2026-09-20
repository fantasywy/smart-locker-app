# MEMORY.md — smart-locker-app 项目长期约定

## 项目本体

- 微信小程序，TypeScript + Sass。`project.config.json` 的 `useCompilerPlugins: ["typescript", "sass"]`，`miniprogramRoot: miniprogram/`。
- 结构：`miniprogram/`（app.ts/jsons、pages/{index,logs}、components/navigation-bar、utils）、`typings/types/wx/*`。
- 包管理用 pnpm；目前 `devDependencies` 只有 `miniprogram-api-typings`。

## 版本控制

- git 仓库于 2026-09-20 初始化，主分支 `main`。
- remote：`origin` = `git@github.com:fantasywy/smart-locker-app.git`（SSH）；`main` 跟踪 `origin/main`。首次 push 于 2026-09-20 15:42 完成。
- 提交者：`fantasywy <2329985979@qq.com>`（来自全局 git config）。
- **沙箱内无法 push**：SSH 读不到 `~/.ssh`（`Could not stat /root/.ssh: Permission denied`），且 `ssh_config.d` 触发 "Bad owner or permissions"。推送需由用户在自己的终端执行；沙箱内可用 `git log`/reflog 验证同步状态。
- `gh` 与 `glab` 均**未安装**（Arch Linux + pacman）。`sudo` 在沙箱内不可用（`/etc/sudo.conf` 被映射成 uid 65534）→ 安装需用户执行 `sudo pacman -S github-cli`。
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
**前置依赖**：triage / to-tickets / to-spec / wayfinder 依赖 `gh` 已安装并 `gh auth login`，否则跑不起来。
