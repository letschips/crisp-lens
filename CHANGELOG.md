# Changelog

## 0.2.0 — 2026-11-03

- 「加入 Now」改为「加入 Tempo」：通过 Crisp Tempo 的 `createTaskFromSource` 新建任务并带上当前笔记；同一天同一篇同一标题只建一次。
- 字段推进只允许改 `status`；`*_type`、`platform`、`audience`、`publication_status` 改为只读显示当前值。不参与路由的文件（如 content-projects）不显示字段推进；当前值不在契约里时照实显示。
- 收件箱采集件：没有 frontmatter 显示「收件箱草稿」；有 frontmatter 但缺 type/topic 显示「待规范」并给出 route fix。
- 标题优先用 `title`；没有 `id` 时用 `content_id`。
- 界面改为平铺：去掉卡片和分区标题，动作改为标题行图标按钮，状态用圆点，规则名进提示；没有关联时不显示关联区；页脚只在契约异常时出现，不再显示全局负荷。
- 侧栏顶部让出一个标题栏高度，内容起点与主区视图标题栏下沿对齐；修正主题覆盖导致面板内边距失效。

## 0.1.0 — 2026-10-09

- 首个版本：右侧栏「当前页对象面板」。对象卡（type / topic / id）、路由预览（读 `.runtime/snapshot/route-contract.json`）、按契约 `domains` 推进字段、`*_ids` 正向与反向关联、新建关联问题、加入 Now、桌面端交给 `anks route fix` 归位与刷新契约。
- 插件不移动文件；路由规则只来自 ANKS 路由契约，指纹与 `routing-rules.toml` 不一致时提示过期。
- 对拍测试：真实库 916 篇笔记的路由预览与 Python `route scan` 一致。
