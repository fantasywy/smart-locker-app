## Agent skills

### Issue tracker

Issues 和 specs 存放在 GitHub Issues（`fantasywy/smart-locker-app`），所有操作走 `gh` CLI。See `docs/agents/issue-tracker.md`.

### Triage labels

五个 canonical triage roles 使用默认 label 字符串：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context：repo 根目录一个 `GLOSSARY.md` 加 `docs/adr/`。See `docs/agents/domain.md`.

### 本地构建

`miniprogram_npm/` 是 gitignore 的构建产物，干净检出后必须 `pnpm install` + 开发者工具「构建 npm」，否则 `@vant/weapp/*` 全部解析失败。用 `pnpm verify:npm` 验收产物。See `docs/agents/build.md`.
