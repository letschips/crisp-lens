/* ==========================================================================
   Crisp Lens - current-note object panel for ANKS
   读当前笔记的 frontmatter 与 ANKS 路由契约，给出对象卡、路由预览、字段推进、
   关联与动作（加入 Crisp Tempo）。插件从不移动文件：归位交给 `anks route fix`。
   ========================================================================== */

const { Plugin, ItemView, PluginSettingTab, Setting, Notice, Modal, TFile, Platform, setIcon } = require("obsidian");

let execFile = null;
try {
  ({ execFile } = require("child_process"));
} catch (_) {
  execFile = null;
}

const VIEW_TYPE = "crisp-lens-view";
const CONTRACT_SCHEMA = "anks-route-contract-v1";
const CONTRACT_PATH = ".runtime/snapshot/route-contract.json";
const RULES_PATH = "Sidecar/tools/knowledge-router/routing-rules.toml";
const DEFAULT_RELATION_FIELDS = ["source_ids", "knowledge_ids", "research_ids", "question_ids", "related_ids", "source_id"];
const DEFAULT_SETTINGS = {
  relationFields: DEFAULT_RELATION_FIELDS.join(", "),
};
const TEMPO_PLUGIN_ID = "crisp-tempo";
// 契约 domains 里只有 status 是生命周期；其余（*_type、platform、audience、publication_status）是分类或发布事实，只读。
const PROGRESS_FIELDS = new Set(["status"]);
const STATUS_LABEL = {
  correct: "已归位",
  misplaced: "待归位",
  unroutable: "无法路由",
  review: "待复核",
  ignored: "不参与路由",
  delegated: "交给 CLI 判断",
  draft: "收件箱草稿",
  normalize: "待规范",
};

/* ---------------- 纯逻辑（导出供测试） ---------------- */

function parseContract(payload) {
  if (!payload || typeof payload !== "object") return null;
  const data = payload.schema === CONTRACT_SCHEMA ? payload : payload.data;
  if (!data || data.schema !== CONTRACT_SCHEMA || !Array.isArray(data.rules)) return null;
  return data;
}

function str(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function deriveTopic(path, fm) {
  const topic = str(fm.topic);
  if (topic) return topic;
  const parts = path.split("/");
  return parts.length >= 2 && parts[0] === "Topics" ? parts[1] : null;
}

function isIgnored(path, contract) {
  const name = path.split("/").pop();
  const ignore = contract.ignore || {};
  if ((ignore.names || []).includes(name)) return true;
  return (ignore.prefixes || []).some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix));
}

function ruleMatches(fm, match) {
  return Object.entries(match).every(([key, expected]) => {
    const actual = str(fm[key]).toLowerCase();
    const allowed = (Array.isArray(expected) ? expected : [expected]).map((v) => str(v).toLowerCase());
    return allowed.includes(actual);
  });
}

function renderTarget(template, values) {
  const needed = [...new Set([...template.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]))];
  const missing = needed.filter((key) => !str(values[key]));
  if (missing.length) return { target: null, missing };
  for (const key of needed) {
    const value = str(values[key]);
    if (value === "." || value === ".." || /[\/\\\0]/.test(value)) return { target: null, missing: [], unsafe: key };
  }
  return { target: template.replace(/\{([^{}]+)\}/g, (_, key) => str(values[key])), missing: [] };
}

/** Preview of knowledge_router.resolve_target for Markdown in the `rules` group.
 *  Core, assets and redirects are delegated to the CLI; `route scan` stays authoritative. */
function previewRoute(path, fm, contract) {
  fm = fm || {};
  if (!contract) return { status: "delegated", reason: "缺少路由契约" };
  if (isIgnored(path, contract)) return { status: "ignored", reason: "命中忽略设置" };
  if (path.startsWith("Core/System/") || /^Topics\/[^/]+\/system\//.test(path) || path.startsWith("Sidecar/")) {
    return { status: "ignored", reason: "系统文件" };
  }
  const topic = deriveTopic(path, fm);
  const flag = str(fm.routing_status).toLowerCase();
  const conf = fm.routing_confidence === undefined || fm.routing_confidence === null ? null : Number(fm.routing_confidence);
  const threshold = contract.safety?.review_below_confidence ?? 0.92;
  if (["needs-review", "needs-classification", "to-organize"].includes(flag) || (conf !== null && !Number.isNaN(conf) && conf < threshold)) {
    return { status: "review", topic, reason: `标记为待复核（置信度 ${conf ?? 0}）` };
  }
  if (str(fm.scope).toLowerCase() === "core" || fm.core_kind || path.startsWith("Core/")) {
    return { status: "delegated", topic, reason: "Core 对象走晋升流程" };
  }
  if (!path.toLowerCase().endsWith(".md")) return { status: "delegated", topic, reason: "附件由 CLI 按扩展名路由" };
  if (!str(fm.type)) return { status: "unroutable", topic, reason: "缺少 type", missing: ["type"] };
  if (!topic) return { status: "unroutable", reason: "缺少 topic，且不在 Topics/<topic> 下", missing: ["topic"] };
  if (str(fm.type) === "redirect") return { status: "delegated", topic, reason: "redirect 留在原位" };

  const values = { ...fm, topic };
  for (const rule of contract.rules) {
    if (rule.group !== "rules" || !ruleMatches(fm, rule.match || {})) continue;
    const rendered = renderTarget(rule.target, values);
    if (!rendered.target) {
      return {
        status: "unroutable", topic, rule: rule.name, missing: rendered.missing,
        reason: rendered.unsafe ? `字段 ${rendered.unsafe} 的值不能用作目录名` : `缺少字段：${rendered.missing.join("、")}`,
      };
    }
    const current = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    return { status: current === rendered.target ? "correct" : "misplaced", topic, rule: rule.name, target: rendered.target };
  }
  return { status: "unroutable", topic, reason: "字段组合没有命中任何路由规则" };
}

function fieldDomains(type, contract) {
  const domains = contract?.domains?.[str(type)];
  return domains ? { ...domains } : {};
}

function toIdList(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value];
  return list.map((v) => str(v).replace(/^["']|["']$/g, "")).filter(Boolean);
}

function buildIdIndex(entries, relationFields) {
  const byId = new Map();
  const incoming = new Map();
  for (const { path, fm } of entries) {
    const id = toIdList(fm?.id)[0];
    if (id && !byId.has(id)) byId.set(id, path);
  }
  for (const { path, fm } of entries) {
    for (const field of relationFields) {
      for (const id of toIdList(fm?.[field])) {
        if (!incoming.has(id)) incoming.set(id, []);
        incoming.get(id).push({ field, path });
      }
    }
  }
  return { byId, incoming };
}

function relationsFor(path, fm, index, relationFields) {
  const outgoing = [];
  for (const field of relationFields) {
    for (const id of toIdList(fm?.[field])) outgoing.push({ field, id, path: index.byId.get(id) || null });
  }
  const ownId = toIdList(fm?.id)[0];
  const incoming = ownId ? (index.incoming.get(ownId) || []).filter((ref) => ref.path !== path) : [];
  return { outgoing, incoming };
}

function isProgressField(field) {
  return PROGRESS_FIELDS.has(field);
}

function objectId(fm) {
  return toIdList(fm?.id)[0] || toIdList(fm?.content_id)[0] || "";
}

/** 收件箱采集件的真实去向：`route fix` 只给有 frontmatter 的采集件补 type/topic（capture_normalize），
 *  没有 frontmatter 的留在原地。其他情况返回 null，沿用路由预览。 */
function captureState(path, route, hasFrontmatter) {
  if (route?.status !== "unroutable" || !/^Topics\/[^/]+\/raw\/inbox\//.test(path)) return null;
  if (!hasFrontmatter) return "draft";
  return (route.missing || []).some((key) => key === "type" || key === "topic") ? "normalize" : null;
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Tempo 的 createTaskFromSource 按 sourceId 去重：同一天同一篇同一标题重复提交只建一次。 */
function buildTempoTask({ title, path, day }) {
  const clean = str(title).replace(/\s+/g, " ");
  if (!clean) throw new Error("行动不能为空");
  return { sourceId: `crisp-lens:${fnv1a(`${day}|${path}|${clean}`)}`, title: clean, notePath: path };
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function safeFileName(title) {
  return title.replace(/[\\/:*?"<>|#^\[\]]/g, "-").replace(/\s+/g, " ").trim();
}

function buildQuestionNote({ title, topic, fromId, fromLink, contract, now = new Date() }) {
  const clean = str(title);
  if (!clean) throw new Error("问题标题不能为空");
  const rule = (contract?.rules || []).find((r) => r.name === "question-backlog");
  const folder = rule ? renderTarget(rule.target, { topic }).target : null;
  if (!folder) throw new Error("契约里找不到 question-backlog 规则，无法确定目录");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const id = `QST-${date.replace(/-/g, "")}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const lines = [
    "---",
    "type: question",
    `id: "${id}"`,
    `topic: "${topic}"`,
    "status: backlog",
    `created: ${date}`,
    `updated: ${date}`,
    `owner: "topic:${topic}"`,
    "confidence: n/a",
    "priority: medium",
  ];
  if (fromId) lines.push("related_ids:", `  - "${fromId}"`);
  else lines.push("related_ids: []");
  lines.push("---", "", `# ${clean}`, "", "## 为什么重要", "");
  if (fromLink) lines.push(`来自 [[${fromLink}]]。`, "");
  lines.push("## 当前理解", "", "## 什么证据可以解决它", "", "## 相关知识", "", "## 研究日志", "");
  return { folder, fileName: `${safeFileName(clean)}.md`, id, content: lines.join("\n") };
}

function contractFreshness(contract, rulesFingerprint) {
  if (!contract) return "missing";
  if (!rulesFingerprint) return "unknown";
  return contract.rules_fingerprint === rulesFingerprint ? "fresh" : "stale";
}

async function sha256Hex(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------------- 视图 ---------------- */

class TitleModal extends Modal {
  constructor(app, heading, placeholder, onSubmit) {
    super(app);
    this.heading = heading;
    this.placeholder = placeholder;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.heading });
    const input = contentEl.createEl("input", { cls: "crisp-lens-input", attr: { type: "text", placeholder: this.placeholder } });
    const row = contentEl.createDiv({ cls: "crisp-lens-modal-row" });
    const ok = row.createEl("button", { cls: "mod-cta", text: "确定" });
    const submit = async () => {
      const value = str(input.value);
      if (!value) return;
      this.close();
      await this.onSubmit(value);
    };
    ok.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) submit();
    });
    window.setTimeout(() => input.focus?.(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class LensView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Crisp Lens"; }
  getIcon() { return "scan-eye"; }

  async onOpen() { this.render(); }

  render() {
    const root = this.contentEl;
    root.empty();
    root.addClass("crisp-lens-view");
    const plugin = this.plugin;
    const file = plugin.currentFile();
    if (!file) {
      root.createDiv({ cls: "crisp-lens-empty", text: "打开一篇笔记后显示它的对象信息" });
      this.renderFooter(root);
      return;
    }
    const fm = plugin.frontmatterOf(file);
    const route = previewRoute(file.path, fm, plugin.contract);
    const capture = captureState(file.path, route, plugin.hasFrontmatter(file));

    this.renderHead(root, file, fm, route);
    this.renderRoute(root, route, capture);
    if (route.status !== "ignored") this.renderFields(root, file, fm);
    this.renderRelations(root, file, fm);
    this.renderFooter(root);
  }

  renderHead(root, file, fm, route) {
    const plugin = this.plugin;
    const head = root.createDiv({ cls: "crisp-lens-head" });
    const top = head.createDiv({ cls: "crisp-lens-head-top" });
    top.createDiv({ cls: "crisp-lens-title", text: str(fm.title) || file.basename });
    const tools = top.createDiv({ cls: "crisp-lens-tools" });
    const id = objectId(fm);
    const topic = route.topic || deriveTopic(file.path, fm);
    const tool = (icon, label, handler, disabled = false) => {
      const btn = tools.createEl("button", { cls: "crisp-lens-icon-btn clickable-icon", attr: { "aria-label": label, "data-tooltip-position": "top" } });
      setIcon(btn, icon);
      btn.disabled = disabled;
      btn.addEventListener("click", handler);
      return btn;
    };
    tool("fingerprint", "复制 ID", () => plugin.copy(id, "已复制 ID"), !id);
    tool("link", "复制内链", () => plugin.copy(`[[${file.basename}]]`, "已复制内链"));
    tool("circle-help", "新建关联问题", () => plugin.promptQuestion(file, fm, topic), !topic || !plugin.contract);
    tool("list-plus", "加入 Tempo", () => plugin.promptTempo(file), !plugin.tempoAvailable());

    const meta = head.createDiv({ cls: "crisp-lens-meta" });
    meta.createSpan({ cls: "crisp-lens-chip", text: str(fm.type) || "无 type" });
    if (topic) meta.createSpan({ cls: "crisp-lens-chip", text: topic });
    if (id) {
      const idChip = meta.createSpan({ cls: "crisp-lens-chip is-id", text: id, attr: { "aria-label": "点击复制", "data-tooltip-position": "top" } });
      idChip.addEventListener("click", () => plugin.copy(id, "已复制 ID"));
    }
  }

  renderRoute(root, route, capture) {
    const status = capture || route.status;
    const section = root.createDiv({ cls: "crisp-lens-section crisp-lens-route" });
    const row = section.createDiv({ cls: "crisp-lens-route-row" });
    const label = row.createSpan({ cls: `crisp-lens-status is-${status}`, text: STATUS_LABEL[status] || status });
    if (route.rule) label.setAttribute("aria-label", route.rule);
    if (status === "misplaced") section.createDiv({ cls: "crisp-lens-target", text: `→ ${route.target}` });
    const reason = {
      draft: "没有 frontmatter，留在收件箱",
      normalize: "route fix 会先补 type / topic 再归位",
    }[capture] || (status === "misplaced" ? "" : route.reason);
    if (reason) section.createDiv({ cls: "crisp-lens-muted", text: reason });
    if (status !== "misplaced" && status !== "normalize") return;
    if (this.plugin.launchpadBridgeOn()) {
      section.createDiv({ cls: "crisp-lens-muted", text: "Launchpad 事件桥已开启，会自动归位" });
      return;
    }
    const btn = section.createEl("button", { cls: "crisp-lens-btn", text: "交给 route fix 归位" });
    btn.disabled = !this.plugin.canRunAnks();
    if (btn.disabled) btn.setAttribute("aria-label", "仅桌面端可运行 ANKS CLI");
    btn.addEventListener("click", () => this.plugin.routeFix());
  }

  renderFields(root, file, fm) {
    const domains = fieldDomains(fm.type, this.plugin.contract);
    const progress = Object.keys(domains).filter(isProgressField);
    const readonly = Object.keys(domains).filter((field) => !isProgressField(field) && str(fm[field]));
    if (!progress.length && !readonly.length) return;
    const section = root.createDiv({ cls: "crisp-lens-section crisp-lens-fields" });
    for (const field of progress) {
      const row = section.createDiv({ cls: "crisp-lens-field", attr: { "data-field": field } });
      row.createDiv({ cls: "crisp-lens-field-name", text: field });
      const values = row.createDiv({ cls: "crisp-lens-values" });
      const raw = str(fm[field]);
      const current = raw.toLowerCase();
      const known = domains[field].some((value) => String(value).toLowerCase() === current);
      if (raw && !known) values.createSpan({ cls: "crisp-lens-chip is-outside", text: raw, attr: { "aria-label": "不在契约取值里", "data-tooltip-position": "top" } });
      for (const value of domains[field]) {
        const active = current === String(value).toLowerCase();
        const chip = values.createEl("button", { cls: `crisp-lens-value${active ? " is-active" : ""}`, text: value });
        if (!active) chip.addEventListener("click", () => this.plugin.setField(file, field, value));
      }
    }
    for (const field of readonly) {
      const row = section.createDiv({ cls: "crisp-lens-field is-readonly", attr: { "data-field": field } });
      row.createDiv({ cls: "crisp-lens-field-name", text: field });
      row.createDiv({ cls: "crisp-lens-field-value", text: str(fm[field]) });
    }
  }

  renderRelations(root, file, fm) {
    const rel = this.plugin.relations(file, fm);
    if (!rel.outgoing.length && !rel.incoming.length) return;
    const section = root.createDiv({ cls: "crisp-lens-section crisp-lens-relations" });
    const name = (path) => path.split("/").pop().replace(/\.md$/, "");
    for (const ref of rel.outgoing) {
      const row = section.createDiv({ cls: `crisp-lens-rel${ref.path ? "" : " is-missing"}` });
      row.createSpan({ cls: "crisp-lens-rel-field", text: ref.field });
      const link = row.createSpan({ cls: "crisp-lens-rel-link", text: ref.path ? name(ref.path) : `${ref.id}（未找到）` });
      link.setAttribute("aria-label", ref.id);
      if (ref.path) link.addEventListener("click", () => this.plugin.openPath(ref.path));
    }
    if (rel.incoming.length) {
      section.createDiv({ cls: "crisp-lens-subtitle", text: `被引用 ${rel.incoming.length}` });
      for (const ref of rel.incoming) {
        const row = section.createDiv({ cls: "crisp-lens-rel is-incoming" });
        row.createSpan({ cls: "crisp-lens-rel-field", text: ref.field });
        const link = row.createSpan({ cls: "crisp-lens-rel-link", text: name(ref.path) });
        link.addEventListener("click", () => this.plugin.openPath(ref.path));
      }
    }
  }

  renderFooter(root) {
    const fresh = this.plugin.freshness;
    if (fresh === "fresh") return;
    const footer = root.createDiv({ cls: "crisp-lens-footer" });
    const label = { stale: "契约已过期", unknown: "契约未校验", missing: "缺少路由契约" }[fresh];
    footer.createSpan({
      cls: `crisp-lens-chip${fresh === "unknown" ? "" : " is-warning"}`,
      text: label,
      attr: { "aria-label": "运行 anks snapshot build 重新生成", "data-tooltip-position": "top" },
    });
    if (this.plugin.canRunAnks()) {
      const refresh = footer.createEl("button", { cls: "crisp-lens-link-btn", text: "刷新契约" });
      refresh.addEventListener("click", () => this.plugin.refreshContract());
    }
  }
}

/* ---------------- 插件 ---------------- */

class CrispLensPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) || {});
    this.contract = null;
    this.freshness = "missing";
    this.index = { byId: new Map(), incoming: new Map() };
    this.renderTimer = null;

    this.registerView(VIEW_TYPE, (leaf) => new LensView(leaf, this));
    this.addRibbonIcon("scan-eye", "打开 Crisp Lens", () => this.activateView());
    this.addCommand({ id: "open", name: "打开当前页对象面板", callback: () => this.activateView() });
    this.addCommand({ id: "refresh-contract", name: "刷新路由契约", callback: () => this.refreshContract() });
    this.addSettingTab(new LensSettingTab(this.app, this));

    this.registerEvent(this.app.workspace.on("file-open", () => this.scheduleRender()));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      this.scheduleIndex();
      if (file?.path === this.currentFile()?.path) this.scheduleRender();
    }));
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.scheduleIndex()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleIndex()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleIndex()));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file?.path === CONTRACT_PATH || file?.path === RULES_PATH) this.reloadSnapshots();
    }));

    this.app.workspace.onLayoutReady(async () => {
      await this.reloadSnapshots();
      this.rebuildIndex();
      this.renderViews();
    });
  }

  onunload() {
    window.clearTimeout(this.renderTimer);
    window.clearTimeout(this.indexTimer);
  }

  relationFields() {
    const list = String(this.settings.relationFields || "").split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    return list.length ? list : DEFAULT_RELATION_FIELDS;
  }

  currentFile() {
    const file = this.app.workspace.getActiveFile?.();
    return file && file.extension === "md" ? file : null;
  }

  frontmatterOf(file) {
    return this.app.metadataCache.getFileCache(file)?.frontmatter || {};
  }

  hasFrontmatter(file) {
    return Boolean(this.app.metadataCache.getFileCache(file)?.frontmatter);
  }

  rebuildIndex() {
    const entries = this.app.vault.getMarkdownFiles().map((file) => ({ path: file.path, fm: this.frontmatterOf(file) }));
    this.index = buildIdIndex(entries, this.relationFields());
  }

  relations(file, fm) {
    return relationsFor(file.path, fm, this.index, this.relationFields());
  }

  scheduleIndex() {
    window.clearTimeout(this.indexTimer);
    this.indexTimer = window.setTimeout(() => {
      this.rebuildIndex();
      this.renderViews();
    }, 600);
  }

  scheduleRender() {
    window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => this.renderViews(), 80);
  }

  renderViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view?.render?.();
  }

  async readJson(path) {
    try {
      if (!(await this.app.vault.adapter.exists(path))) return null;
      return JSON.parse(await this.app.vault.adapter.read(path));
    } catch (error) {
      console.warn(`Crisp Lens: cannot read ${path}`, error);
      return null;
    }
  }

  async reloadSnapshots() {
    this.contract = parseContract(await this.readJson(CONTRACT_PATH));
    let fingerprint = null;
    try {
      if (await this.app.vault.adapter.exists(RULES_PATH)) fingerprint = await sha256Hex(await this.app.vault.adapter.read(RULES_PATH));
    } catch (_) {
      fingerprint = null;
    }
    this.freshness = contractFreshness(this.contract, fingerprint);
    this.scheduleRender();
  }

  launchpadBridgeOn() {
    return Boolean(this.app.plugins?.plugins?.["crisp-launchpad"]?.settings?.autoRouteEnabled) && this.canRunAnks();
  }

  canRunAnks() {
    const hasBasePath = Boolean(this.app.vault.adapter.getBasePath?.());
    const isWindows = typeof process !== "undefined" && process.platform === "win32";
    return !Platform.isMobile && typeof execFile === "function" && hasBasePath && !isWindows;
  }

  runAnks(args) {
    if (!this.canRunAnks()) return Promise.reject(new Error("仅桌面端可运行 ANKS CLI"));
    const env = typeof process !== "undefined" ? process.env || {} : {};
    const PATH = ["/opt/homebrew/bin", "/usr/local/bin", env.HOME ? `${env.HOME}/.local/bin` : "", env.PATH].filter(Boolean).join(":");
    return new Promise((resolve, reject) => {
      execFile("sh", ["Sidecar/bin/anks", ...args], {
        cwd: this.app.vault.adapter.getBasePath(),
        timeout: 180000,
        maxBuffer: 1024 * 1024 * 8,
        env: { ...env, PATH },
      }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || stdout || error.message).trim().split("\n").slice(-3).join(" ")));
        else resolve(stdout);
      });
    });
  }

  async routeFix() {
    try {
      const out = await this.runAnks(["route", "fix", "--min-confidence", "1"]);
      const moved = (String(out).match(/^\s*(?:MOVED|\[MOVED\])/gim) || []).length;
      new Notice(moved ? `Crisp Lens：已归位 ${moved} 个文件` : "Crisp Lens：route fix 已运行");
    } catch (error) {
      new Notice(`Crisp Lens：route fix 失败：${error.message}`, 8000);
    }
  }

  async refreshContract() {
    try {
      await this.runAnks(["snapshot", "build", "--only", "route-contract"]);
      await this.reloadSnapshots();
      new Notice("Crisp Lens：路由契约已刷新");
    } catch (error) {
      new Notice(`Crisp Lens：刷新契约失败：${error.message}`, 8000);
    }
  }

  async setField(file, field, value) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm[field] = value;
    });
    new Notice(`Crisp Lens：${field} → ${value}`);
  }

  async copy(text, message) {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    new Notice(`Crisp Lens：${message}`);
  }

  async openPath(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file) await this.app.workspace.getLeaf(false).openFile(file);
  }

  promptQuestion(file, fm, topic) {
    new TitleModal(this.app, "新建关联问题", "这篇引出的问题是……", async (title) => {
      try {
        const note = buildQuestionNote({
          title, topic, fromId: toIdList(fm.id)[0], fromLink: file.basename, contract: this.contract,
        });
        if (!this.app.vault.getAbstractFileByPath(note.folder)) await this.app.vault.createFolder(note.folder);
        let path = `${note.folder}/${note.fileName}`;
        for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = `${note.folder}/${note.fileName.replace(/\.md$/, "")} ${n}.md`;
        const created = await this.app.vault.create(path, note.content);
        new Notice(`Crisp Lens：已新建问题 ${note.id}`);
        await this.app.workspace.getLeaf(false).openFile(created);
      } catch (error) {
        new Notice(`Crisp Lens：${error.message}`, 8000);
      }
    }).open();
  }

  tempoApi() {
    if (!this.app.plugins?.enabledPlugins?.has(TEMPO_PLUGIN_ID)) return null;
    const tempo = this.app.plugins?.plugins?.[TEMPO_PLUGIN_ID];
    return typeof tempo?.createTaskFromSource === "function" ? tempo : null;
  }

  tempoAvailable() {
    return Boolean(this.tempoApi());
  }

  promptTempo(file) {
    new TitleModal(this.app, "加入 Tempo", "下一步要做什么", async (title) => {
      const tempo = this.tempoApi();
      if (!tempo) {
        new Notice("Crisp Lens：请先启用 Crisp Tempo", 8000);
        return;
      }
      try {
        const now = new Date();
        const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        await tempo.createTaskFromSource(buildTempoTask({ title, path: file.path, day }));
        new Notice("Crisp Lens：已加入 Tempo");
      } catch (error) {
        new Notice(`Crisp Lens：${error.message}`, 8000);
      }
    }).open();
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.rebuildIndex();
    this.renderViews();
  }
}

class LensSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("关联字段")
      .setDesc("frontmatter 里存放其他对象 ID 的字段，逗号分隔")
      .addText((text) => text
        .setValue(this.plugin.settings.relationFields)
        .onChange(async (value) => {
          this.plugin.settings.relationFields = value;
          await this.plugin.saveSettings();
        }));
  }
}

module.exports = CrispLensPlugin;
module.exports.parseContract = parseContract;
module.exports.previewRoute = previewRoute;
module.exports.fieldDomains = fieldDomains;
module.exports.buildIdIndex = buildIdIndex;
module.exports.relationsFor = relationsFor;
module.exports.buildQuestionNote = buildQuestionNote;
module.exports.buildTempoTask = buildTempoTask;
module.exports.isProgressField = isProgressField;
module.exports.captureState = captureState;
module.exports.contractFreshness = contractFreshness;
module.exports.DEFAULT_RELATION_FIELDS = DEFAULT_RELATION_FIELDS;
module.exports.LensView = LensView;
module.exports.VIEW_TYPE = VIEW_TYPE;
