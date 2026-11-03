# 插件更新规则（强制）

本仓库的插件更新**只能**走自建 npm 源 `https://npm.carljoy.cn/`：

- **检测**：`GET https://npm.carljoy.cn/<包名>`，读 `dist-tags.latest`（实现在 `lib/update.js`）。
- **下载**：打包安装调用 `pluginManager.installBundle('<包名>@<版本>', { registry: 'https://npm.carljoy.cn/' })`；
  HMR 拒绝覆盖时，只允许回退到**同一个 registry** 的 tarball。
- **禁止**：`api.github.com`、`/releases/latest`、`/releases/download`、`raw.githubusercontent.com`、`gh release`
  等任何 GitHub 版本查询或下载路径。
- **同步**：更新逻辑只改 `lib/update.js`，并把 `lib/update.js`、`test/update.test.mjs`、
  `test/update-rule.test.mjs`、本文件逐字同步到另外三个仓库（在 `dsh-registry` 里跑
  `npm run sync-updater`，用 `npm run check-updater` 校验）。
- **发布**：打 `v*` 标签后由 `.github/workflows/release.yml` 执行 `npm publish` 到自建源，
  需要仓库 secret `NPM_TOKEN`；不再创建或上传 GitHub Release。
- **强制检查**：`test/update-rule.test.mjs` 会扫描源码和 workflow 并让违规直接失败。
  修改更新逻辑时必须保持它和 `test/update.test.mjs` 全部通过。
