# Crisp Lens 设计

- 日期：2026-10-09
- 插件 ID：`crisp-lens`，ANKS 私有，不进发布管线
- 来源：`Topics/self-media/research/content-projects/AI-native Knowledge System/FLO.W Core 工作台机制拆解与 ANKS 借鉴设计.md`

## 定位

右侧栏的「当前页对象面板」。FLO.W Core 用「当前页」按钮按对象类型给动作；ANKS 缺的正是这一层：Launchpad 是全局仪表盘，没有「我正在看的这篇是什么、该往哪走」的视角。

## 边界（ANKS 红线）

- **插件不移动文件**。归位一律交给 `anks route fix --min-confidence 1`（桌面端按钮，或 Launchpad 事件桥）。
- **规则单源**。路由规则、字段取值范围只读 `.runtime/snapshot/route-contract.json`（`anks route contract` 的输出），不解析 TOML、不内置规则。契约指纹和 `routing-rules.toml` 的 sha256 不一致时提示过期。
- **不改语义分类**。`type`、`topic` 不提供一键修改；契约 `domains` 里只有 `status` 可推进，`*_type`、`platform`、`audience`、`publication_status` 只读；不参与路由的文件（如 content-projects，有自己的发布关卡）不显示字段推进。
- 路由状态是**预览**，只覆盖 `rules` 组；Core、附件、redirect 显示为交给 CLI 判断，结论以 `route scan` 为准。

## 功能（0.2.0）

1. 对象卡：文件名、`type`、`topic`、`id`（点击复制）。
2. 路由：已归位 / 待归位 → 目标目录 / 无法路由 + 原因（缺 type、缺 project、标记待复核等）。
3. 字段推进：当前 `type` 在契约 `domains` 里的每个字段，用候选值按钮切换；写入走 `processFrontMatter`。
4. 关联：`source_ids`、`knowledge_ids`、`research_ids`、`question_ids`、`related_ids`、`source_id` 的正向解析（找不到的 ID 标红）与反向「被引用」。
5. 动作（标题行图标）：复制 ID（无 `id` 时用 `content_id`）、复制内链、新建关联问题（写到契约算出的 `questions/backlog` 目录，`related_ids` 带上当前 ID）、加入 Tempo（`createTaskFromSource`，带 notePath）；交给 route fix（桌面）。
6. 页脚：只在契约过期、缺失或未校验时出现，附刷新契约（桌面）。
7. 收件箱采集件：没有 frontmatter 的是草稿，留在收件箱；有 frontmatter 但缺 type/topic 的由 `route fix` 先规范再归位（capture_normalize）。

## 不做

- 不复制 Launchpad 的速记、看板和报表，不复制 Pulse 的统计。
- 不做插件内实时移动、冲突后缀另存、拖动文件改属性。
