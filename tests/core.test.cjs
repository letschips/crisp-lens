/* 纯逻辑测试：契约解析、路由预览、字段域、关联索引、新建问题、Tempo 任务。
   每条测试对应一个会让面板给出错误指引的失败模式。 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { loadApi } = require("./stub.cjs");

const api = loadApi();
const envelope = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/route-contract.json"), "utf8"));
const contract = api.parseContract(envelope);

test("契约：既接受快照包装体，也接受裸契约；格式不对返回 null", () => {
  assert.equal(contract.schema, "anks-route-contract-v1");
  assert.equal(api.parseContract(envelope.data).schema, "anks-route-contract-v1");
  assert.equal(api.parseContract({ schema: "other" }), null);
  assert.equal(api.parseContract(null), null);
});

test("路由预览：位置正确的 question 判为已归位", () => {
  const r = api.previewRoute(
    "Topics/self-media/questions/backlog/a.md",
    { type: "question", status: "backlog" },
    contract,
  );
  assert.equal(r.status, "correct");
  assert.equal(r.rule, "question-backlog");
});

test("路由预览：改了 status 但还没移动，判为待归位并给出目标目录", () => {
  const r = api.previewRoute(
    "Topics/self-media/questions/backlog/a.md",
    { type: "question", status: "to-research" },
    contract,
  );
  assert.equal(r.status, "misplaced");
  assert.equal(r.target, "Topics/self-media/questions/to-research");
});

test("路由预览：规则按契约顺序取第一条命中（与 Python 一致）", () => {
  // output+content+published+wechat 同时命中多条，必须取更具体、排在前面的那条
  const r = api.previewRoute(
    "Topics/self-media/outputs/content/x.md",
    { type: "output", artifact_type: "content", status: "published", publication_status: "published", platform: "wechat" },
    contract,
  );
  assert.equal(r.rule, "output-content-published-wechat");
  assert.equal(r.target, "Topics/self-media/outputs/content/published/公众号");
});

test("路由预览：模板字段缺失时报无法路由并列出缺的字段", () => {
  const r = api.previewRoute(
    "Topics/self-media/research/x.md",
    { type: "research", research_type: "content-project" },
    contract,
  );
  assert.equal(r.status, "unroutable");
  assert.deepEqual(r.missing, ["project"]);
});

test("路由预览：不安全的模板值（含斜杠）不能拼出路径", () => {
  const r = api.previewRoute(
    "Topics/self-media/research/x.md",
    { type: "research", research_type: "content-project", project: "../escape" },
    contract,
  );
  assert.equal(r.status, "unroutable");
});

test("路由预览：缺 type、低置信度、忽略前缀、受保护目录分别给出对应状态", () => {
  assert.equal(api.previewRoute("Topics/self-media/raw/x.md", {}, contract).status, "unroutable");
  assert.equal(
    api.previewRoute("Topics/self-media/raw/x.md", { type: "raw", routing_confidence: 0.5 }, contract).status,
    "review",
  );
  assert.equal(api.previewRoute("Now/行动.md", {}, contract).status, "ignored");
  assert.equal(api.previewRoute("Topics/self-media/system/scope.md", {}, contract).status, "ignored");
  assert.equal(api.previewRoute("Core/Methods/x.md", { core_kind: "method" }, contract).status, "delegated");
});

test("路由预览：topic 优先取 frontmatter，其次取路径", () => {
  const r = api.previewRoute("Topics/main-business/knowledge/x.md", { type: "knowledge", topic: "self-media" }, contract);
  assert.equal(r.target, "Topics/self-media/knowledge");
});

test("字段域：只返回该类型可推进的字段，不含 type", () => {
  const d = api.fieldDomains("question", contract);
  assert.deepEqual(d.status, ["backlog", "parked", "ready-to-produce", "to-research"]);
  assert.equal(d.type, undefined);
  assert.deepEqual(api.fieldDomains("unknown", contract), {});
});

test("关联：正向解析 ID、标出找不到的 ID，反向列出被引用", () => {
  const entries = [
    { path: "A.md", fm: { id: "RES-1", source_ids: ["SRC-1", "SRC-404"], knowledge_ids: [] } },
    { path: "S.md", fm: { id: "SRC-1" } },
    { path: "Q.md", fm: { id: "QST-1", related_ids: ["RES-1"] } },
    { path: "N.md", fm: { content_id: "RES-1" } },
  ];
  const index = api.buildIdIndex(entries, api.DEFAULT_RELATION_FIELDS);
  const rel = api.relationsFor("A.md", entries[0].fm, index, api.DEFAULT_RELATION_FIELDS);
  assert.deepEqual(
    rel.outgoing.map((x) => [x.field, x.id, x.path]),
    [["source_ids", "SRC-1", "S.md"], ["source_ids", "SRC-404", null]],
  );
  // content_id 不是关联字段，不能算被引用
  assert.deepEqual(rel.incoming.map((x) => [x.field, x.path]), [["related_ids", "Q.md"]]);
});

test("关联：标量和逗号外的 YAML 形状都能读，ID 前后空白与引号被清理", () => {
  const index = api.buildIdIndex([{ path: "S.md", fm: { id: " SRC-1 " } }], api.DEFAULT_RELATION_FIELDS);
  const rel = api.relationsFor("A.md", { source_id: "SRC-1" }, index, api.DEFAULT_RELATION_FIELDS);
  assert.equal(rel.outgoing[0].path, "S.md");
});

test("新建关联问题：写到契约算出的 backlog 目录，related_ids 带上来源 ID", () => {
  const now = new Date(2026, 9, 9, 14, 5, 7);
  const note = api.buildQuestionNote({ title: "FLO.W 的路由能否借鉴", topic: "self-media", fromId: "RES-20261009-FLOW-CORE-ANKS", fromLink: "FLO.W Core 研究", contract, now });
  assert.equal(note.folder, "Topics/self-media/questions/backlog");
  assert.equal(note.fileName, "FLO.W 的路由能否借鉴.md");
  assert.match(note.content, /^---\ntype: question\nid: "QST-20261009-140507"\n/);
  assert.match(note.content, /status: backlog/);
  assert.match(note.content, /owner: "topic:self-media"/);
  assert.match(note.content, /related_ids:\n  - "RES-20261009-FLOW-CORE-ANKS"/);
  assert.match(note.content, /\[\[FLO\.W Core 研究\]\]/);
});

test("新建关联问题：标题里的路径字符被替换，空标题拒绝", () => {
  const note = api.buildQuestionNote({ title: "a/b:c?", topic: "self-media", contract, now: new Date(2026, 0, 1) });
  assert.equal(note.fileName, "a-b-c-.md");
  assert.throws(() => api.buildQuestionNote({ title: "  ", topic: "self-media", contract }));
});

test("Tempo 任务：同一篇、同一天、同一标题只建一次；换标题或换笔记就是新任务", () => {
  const day = "2026-11-03";
  const a = api.buildTempoTask({ title: " 补证据 ", path: "Topics/x/a.md", day });
  assert.deepEqual(Object.keys(a).sort(), ["notePath", "sourceId", "title"]);
  assert.equal(a.title, "补证据");
  assert.equal(a.notePath, "Topics/x/a.md");
  assert.match(a.sourceId, /^crisp-lens:[0-9a-f]{8}$/);
  assert.equal(api.buildTempoTask({ title: "补证据", path: "Topics/x/a.md", day }).sourceId, a.sourceId);
  assert.notEqual(api.buildTempoTask({ title: "补证据2", path: "Topics/x/a.md", day }).sourceId, a.sourceId);
  assert.notEqual(api.buildTempoTask({ title: "补证据", path: "Topics/x/b.md", day }).sourceId, a.sourceId);
  assert.notEqual(api.buildTempoTask({ title: "补证据", path: "Topics/x/a.md", day: "2026-11-04" }).sourceId, a.sourceId);
  assert.throws(() => api.buildTempoTask({ title: "  ", path: "a.md", day }));
});

test("字段：只有 status 可推进；分类字段（*_type、platform、audience、publication_status）只读", () => {
  assert.equal(api.isProgressField("status"), true);
  for (const f of ["artifact_type", "source_type", "inbox_type", "platform", "audience", "publication_status", "type", "topic"]) {
    assert.equal(api.isProgressField(f), false, f);
  }
});

test("收件箱采集件：没有 frontmatter 是草稿；有 frontmatter 但缺 type/topic 交给 route fix 规范", () => {
  const unroutable = { status: "unroutable", missing: ["type"] };
  assert.equal(api.captureState("Topics/s/raw/inbox/a.md", unroutable, false), "draft");
  assert.equal(api.captureState("Topics/s/raw/inbox/scratch/a.md", unroutable, true), "normalize");
  // 不在收件箱、或缺的不是 type/topic，不改口径
  assert.equal(api.captureState("Topics/s/raw/a.md", unroutable, true), null);
  assert.equal(api.captureState("Topics/s/raw/inbox/a.md", { status: "unroutable", missing: ["project"] }, true), null);
  assert.equal(api.captureState("Topics/s/raw/inbox/a.md", { status: "correct" }, true), null);
});

test("契约过期：指纹不一致才算过期，拿不到规则文件时不误报", () => {
  assert.equal(api.contractFreshness(contract, contract.rules_fingerprint), "fresh");
  assert.equal(api.contractFreshness(contract, "deadbeef"), "stale");
  assert.equal(api.contractFreshness(contract, null), "unknown");
  assert.equal(api.contractFreshness(null, "x"), "missing");
});
