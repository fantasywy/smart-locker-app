# 本地构建

小程序依赖 `@vant/weapp`，它的组件代码不在源码树里，而由微信开发者工具的「构建 npm」生成到 `miniprogram/miniprogram_npm/`。该目录被 gitignore，所以**每次干净检出都要重建**。

## 步骤

```bash
pnpm install
# 微信开发者工具 → 工具 → 构建 npm
pnpm verify:npm   # 退出码 0 再打开模拟器
```

构建前跑 `pnpm verify:npm` 也安全：它会直接指出构建产物目录不存在。

## 不构建会怎样

模拟器启动失败，报 `miniprogram/pages/index/index.json: ["usingComponents"]["van-toast"]: "@vant/weapp/toast/index" … 路径下未找到组件`。这条报错只列候选路径、不指向根因，容易误判成路径写错。`pnpm verify:npm` 把同一事实提前成一条断言，并检查构建产物内部的相对 `require`（如 `transition/index.js` → `../mixins/transition`），能抓到「构建跑完了但产物不全」这种静默失败。

## nodeLinker

微信开发者工具只按 npm 的扁平目录跟随依赖，所以 pnpm 必须用 hoisted 布局。**pnpm 12 不再读取 `.npmrc` 的 `node-linker`**，配置写在 `pnpm-workspace.yaml` 的 `nodeLinker: hoisted`。

改完 `pnpm install` 后自检：

```bash
pnpm config get node-linker            # hoisted
ls -ld node_modules/@vant/weapp        # 真实目录，不是符号链接
```

2026-10-24 在 hoisted 布局下重跑「构建 npm」：466 个文件与 `@vant/weapp/dist` 逐一对齐，`pnpm verify:npm` 262 项全过。
