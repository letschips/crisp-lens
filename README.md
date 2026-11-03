# Crisp Lens

ANKS 插件：右侧栏显示当前笔记在 ANKS 里的对象信息。随 Crisp 套装 / ANKS 安装包附带，之后的更新从 GitHub Releases 下载。设计与边界见 `docs/design.md`。

- 依赖 ANKS 路由契约：`sh Sidecar/bin/anks snapshot build`（生成 `.runtime/snapshot/route-contract.json`）
- 插件不移动文件，归位交给 `anks route fix`
- 开发：`npm run check`（含与真实库 `route scan` 的对拍；没有库时跳过）
- 安装：复制 `main.js`、`manifest.json`、`styles.css` 到 `<vault>/.obsidian/plugins/crisp-lens/`
