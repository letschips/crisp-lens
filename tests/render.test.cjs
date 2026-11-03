/* 渲染冒烟：面板在各种对象状态下不抛异常、给出正确指引，且从不自己移动文件。 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { FakeEl, loadApi } = require("./stub.cjs");

const api = loadApi();
const contract = api.parseContract(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/route-contract.json"), "utf8")));

function fakePlugin({ file, fm, bridge = false, desktop = true, freshness = "fresh", entries = [], hasFm = true, tempo = true }) {
  const calls = { setField: [], routeFix: 0, tempo: 0, copied: [] };
  const index = api.buildIdIndex(entries, api.DEFAULT_RELATION_FIELDS);
  return {
    calls,
    contract,
    freshness,
    currentFile: () => file,
    frontmatterOf: () => fm,
    hasFrontmatter: () => hasFm,
    tempoAvailable: () => tempo,
    relations: (f, meta) => api.relationsFor(f.path, meta, index, api.DEFAULT_RELATION_FIELDS),
    launchpadBridgeOn: () => bridge,
    canRunAnks: () => desktop,
    setField: (f, field, value) => calls.setField.push([field, value]),
    routeFix: () => { calls.routeFix++; },
    copy: (text) => calls.copied.push(text),
    openPath() {}, promptQuestion() {}, refreshContract() {},
    promptTempo: () => { calls.tempo++; },
  };
}

function render(plugin) {
  const view = new api.LensView({}, plugin);
  view.render();
  return view.contentEl;
}

const byLabel = (root, label) => root.find((el) => el.attrs?.["aria-label"] === label);
const valueChips = (root) => root.findAll((el) => el.classes.has("crisp-lens-value"));

const questionFile = { path: "Topics/self-media/questions/backlog/Q.md", basename: "Q", extension: "md" };

test("没有打开笔记时显示空状态，不抛异常", () => {
  const root = render(fakePlugin({ file: null, fm: {} }));
  assert.ok(root.allText().includes("打开一篇笔记"));
});

test("已归位的 question：显示状态与可推进的 status 候选，当前值不可点", () => {
  const plugin = fakePlugin({ file: questionFile, fm: { type: "question", status: "backlog", id: "QST-1" } });
  const root = render(plugin);
  const text = root.allText();
  assert.ok(text.includes("已归位"));
  assert.ok(text.includes("QST-1"));
  const active = root.find((el) => el.classes.has("crisp-lens-value") && el.classes.has("is-active"));
  assert.equal(active.textContent, "backlog");
  const next = root.find((el) => el.classes.has("crisp-lens-value") && el.textContent === "to-research");
  next.click();
  assert.deepEqual(plugin.calls.setField, [["status", "to-research"]]);
});

test("待归位且事件桥关闭：给出目标目录和 route fix 按钮，按钮只调用 CLI", () => {
  const plugin = fakePlugin({ file: questionFile, fm: { type: "question", status: "parked" } });
  const root = render(plugin);
  assert.ok(root.allText().includes("→ Topics/self-media/questions/parked"));
  const btn = root.find((el) => el.textContent === "交给 route fix 归位");
  assert.ok(btn && !btn.disabled);
  btn.click();
  assert.equal(plugin.calls.routeFix, 1);
});

test("待归位且 Launchpad 事件桥开启：不重复提供归位按钮", () => {
  const root = render(fakePlugin({ file: questionFile, fm: { type: "question", status: "parked" }, bridge: true }));
  assert.ok(root.allText().includes("事件桥已开启"));
  assert.equal(root.find((el) => el.textContent === "交给 route fix 归位"), null);
});

test("移动端：归位按钮禁用并说明原因", () => {
  const root = render(fakePlugin({ file: questionFile, fm: { type: "question", status: "parked" }, desktop: false }));
  const btn = root.find((el) => el.textContent === "交给 route fix 归位");
  assert.ok(btn.disabled);
});

test("关联：找不到的 ID 标为缺失，被引用列表出现", () => {
  const fm = { type: "question", status: "backlog", id: "QST-1", related_ids: ["RES-404"] };
  const entries = [{ path: "Topics/self-media/research/R.md", fm: { id: "RES-9", question_ids: ["QST-1"] } }];
  const root = render(fakePlugin({ file: questionFile, fm, entries }));
  assert.ok(root.find((el) => el.classes.has("is-missing")));
  assert.ok(root.allText().includes("被引用 1"));
});

test("页脚：契约新鲜时不占位；过期时显示警示态，不再显示全局负荷", () => {
  const fresh = render(fakePlugin({ file: questionFile, fm: { type: "question", status: "backlog" } }));
  assert.equal(fresh.find((el) => el.classes.has("crisp-lens-footer")), null);
  assert.ok(!fresh.allText().includes("负荷"));
  const stale = render(fakePlugin({ file: questionFile, fm: { type: "question", status: "backlog" }, freshness: "stale" }));
  const warnings = stale.findAll((el) => el.classes.has("is-warning")).map((el) => el.textContent);
  assert.deepEqual(warnings, ["契约已过期"]);
});

test("没有 id 的笔记：复制 ID 按钮禁用", () => {
  const root = render(fakePlugin({ file: questionFile, fm: { type: "question", status: "backlog" } }));
  assert.ok(byLabel(root, "复制 ID").disabled);
});

test("content-project 的 article：标题用 title，复制 ID 用 content_id，不参与路由时不出现字段推进", () => {
  const file = { path: "Topics/self-media/content-projects/P/article.md", basename: "article", extension: "md" };
  const fm = { type: "output", artifact_type: "content", status: "draft", publication_status: "not-published", platform: "wechat", title: "长期记忆换成纯文本", content_id: "WECHAT-1" };
  const plugin = fakePlugin({ file, fm });
  const root = render(plugin);
  assert.ok(root.allText().includes("长期记忆换成纯文本"));
  assert.ok(root.allText().includes("不参与路由"));
  assert.equal(valueChips(root).length, 0);
  const copyId = byLabel(root, "复制 ID");
  assert.ok(!copyId.disabled);
  copyId.click();
  assert.deepEqual(plugin.calls.copied, ["WECHAT-1"]);
});

test("可路由的 output：分类字段只读显示当前值，只有 status 能点", () => {
  const file = { path: "Topics/self-media/outputs/content/drafts/x.md", basename: "x", extension: "md" };
  const fm = { type: "output", artifact_type: "content", status: "draft", platform: "wechat", publication_status: "published" };
  const plugin = fakePlugin({ file, fm });
  const root = render(plugin);
  const chips = valueChips(root);
  assert.deepEqual([...new Set(chips.map((el) => el.parent.parent.attrs["data-field"]))], ["status"]);
  assert.ok(!root.find((el) => el.textContent === "health_report"));
  const readonly = root.findAll((el) => el.classes.has("crisp-lens-field-value")).map((el) => el.textContent);
  assert.deepEqual(readonly, ["content", "wechat", "published"]);
  root.find((el) => el.classes.has("crisp-lens-value") && el.textContent === "final").click();
  assert.deepEqual(plugin.calls.setField, [["status", "final"]]);
});

test("当前值不在契约里：照实显示，不高亮任何候选", () => {
  const plugin = fakePlugin({ file: questionFile, fm: { type: "question", status: "someday" } });
  const root = render(plugin);
  const active = root.findAll((el) => el.classes.has("crisp-lens-value") && el.classes.has("is-active"));
  assert.equal(active.length, 0);
  const outside = root.find((el) => el.classes.has("is-outside"));
  assert.equal(outside.textContent, "someday");
});

test("收件箱里没有 frontmatter 的草稿：中性状态，不报红，也不给归位按钮", () => {
  const file = { path: "Topics/self-media/raw/inbox/感悟.md", basename: "感悟", extension: "md" };
  const root = render(fakePlugin({ file, fm: {}, hasFm: false }));
  assert.ok(root.allText().includes("收件箱草稿"));
  assert.equal(root.find((el) => el.classes.has("is-unroutable")), null);
  assert.equal(root.find((el) => el.textContent === "交给 route fix 归位"), null);
});

test("收件箱里缺 type 的采集件：待规范，给 route fix 按钮", () => {
  const file = { path: "Topics/self-media/raw/inbox/a.md", basename: "a", extension: "md" };
  const plugin = fakePlugin({ file, fm: { title: "x" } });
  const root = render(plugin);
  assert.ok(root.allText().includes("待规范"));
  root.find((el) => el.textContent === "交给 route fix 归位").click();
  assert.equal(plugin.calls.routeFix, 1);
});

test("加入 Tempo 取代加入 Now；Tempo 不可用时按钮禁用", () => {
  const plugin = fakePlugin({ file: questionFile, fm: { type: "question", status: "backlog" } });
  const root = render(plugin);
  assert.ok(!root.allText().includes("Now"));
  byLabel(root, "加入 Tempo").click();
  assert.equal(plugin.calls.tempo, 1);
  const off = render(fakePlugin({ file: questionFile, fm: { type: "question", status: "backlog" }, tempo: false }));
  assert.ok(byLabel(off, "加入 Tempo").disabled);
});

test("没有关联也没有被引用：不渲染关联区", () => {
  const root = render(fakePlugin({ file: questionFile, fm: { type: "question", status: "backlog", id: "QST-1" } }));
  assert.equal(root.find((el) => el.classes.has("crisp-lens-relations")), null);
});
