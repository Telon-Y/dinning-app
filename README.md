# dinning-app（应用壳）

这个仓库只放应用壳：页面、规则代码、schema 和第三方库，用于通过 GitHub Pages 发布。

- 数据不在这里：`data.json` 存在私有仓库 `Telon-Y/Dinning`，通过 GitHub API 读写。
- 令牌不进这个仓库：令牌只存在使用者手机本机（浏览器 IndexedDB）。
- 入口：仓库根 `index.html` 会自动跳转到 `./app/`。
- 部署：推送 main 后由 `.github/workflows/pages.yml` 自动发布到 GitHub Pages。

本仓库是发布产物，源文件在私有仓库维护；改动先在私有仓库做，再运行发布脚本。
