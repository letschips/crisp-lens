/* 最小 obsidian 桩：只实现 main.js 用到的 API，供纯逻辑与渲染测试加载插件。 */

const Module = require("node:module");

if (typeof window === "undefined") global.window = global;

class FakeEl {
  constructor(tag = "div", opts = {}) {
    this.tagName = tag;
    this.children = [];
    this.classes = new Set();
    this.attrs = {};
    this.listeners = {};
    this.textContent = "";
    this.title = "";
    this.disabled = false;
    if (opts.cls) String(opts.cls).split(/\s+/).filter(Boolean).forEach((c) => this.classes.add(c));
    if (opts.text !== undefined) this.textContent = String(opts.text);
    if (opts.attr) Object.assign(this.attrs, opts.attr);
  }
  _append(child) { child.parent = this; this.children.push(child); return child; }
  createDiv(opts = {}) { return this._append(new FakeEl("div", opts)); }
  createSpan(opts = {}) { return this._append(new FakeEl("span", opts)); }
  createEl(tag, opts = {}) { return this._append(new FakeEl(tag, opts)); }
  empty() { this.children.length = 0; this.textContent = ""; return this; }
  addClass(c) { this.classes.add(c); return this; }
  toggleClass(c, on) { if (on) this.classes.add(c); else this.classes.delete(c); return this; }
  setText(t) { this.textContent = String(t); return this; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  click() { (this.listeners.click || []).forEach((fn) => fn({ preventDefault() {}, stopPropagation() {} })); }
  allText() {
    return [this.textContent, ...this.children.map((c) => c.allText())].join(" ").replace(/\s+/g, " ").trim();
  }
  find(pred) {
    if (pred(this)) return this;
    for (const c of this.children) { const hit = c.find(pred); if (hit) return hit; }
    return null;
  }
  findAll(pred, out = []) {
    if (pred(this)) out.push(this);
    this.children.forEach((c) => c.findAll(pred, out));
    return out;
  }
}

function loadApi({ mobile = false } = {}) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "obsidian") {
      class Plugin {
        constructor(app) { this.app = app; this._views = new Map(); this._commands = []; this._events = []; }
        async loadData() { return {}; }
        async saveData() {}
        registerView(type, factory) { this._views.set(type, factory); }
        registerEvent(ref) { this._events.push(ref); return ref; }
        addCommand(cmd) { this._commands.push(cmd); return cmd; }
        addRibbonIcon() { return new FakeEl("div"); }
        addSettingTab() {}
      }
      class ItemView { constructor(leaf) { this.leaf = leaf || {}; this.contentEl = new FakeEl("div"); } }
      class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = new FakeEl("div"); } }
      class Setting {
        constructor() {}
        setName() { return this; } setDesc() { return this; }
        addText(cb) { cb({ setValue() { return this; }, setPlaceholder() { return this; }, onChange() { return this; } }); return this; }
      }
      class Notice { constructor(msg) { Notice.last = String(msg); } }
      class Modal { constructor(app) { this.app = app; this.contentEl = new FakeEl("div"); } open() { this.onOpen?.(); } close() { this.onClose?.(); } }
      class TFile {}
      const Platform = { isMobile: mobile };
      return { Plugin, ItemView, PluginSettingTab, Setting, Notice, Modal, TFile, Platform, setIcon() {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve("../main.js")];
  const api = require("../main.js");
  Module._load = originalLoad;
  return api;
}

module.exports = { FakeEl, loadApi };
