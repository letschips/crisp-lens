/* 对拍：在真实 ANKS 库上，Lens 的路由预览必须和 Python 路由器 `scan` 的结论一致。
   失败模式：JS 预览与 knowledge_router.resolve_target 语义漂移，面板给出错误的目标目录。
   本机没有 ANKS 库（或没有 Python 3.11+）时跳过。 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { loadApi } = require("./stub.cjs");

const VAULT = process.env.ANKS_VAULT
  || path.join(os.homedir(), "Library/Mobile Documents/iCloud~md~obsidian/Documents/AI-native Knowledge System");
const ROUTER = path.join(VAULT, "Sidecar/tools/knowledge-router/knowledge_router.py");
const RULES = path.join(VAULT, "Sidecar/tools/knowledge-router/routing-rules.toml");

function python() {
  for (const bin of ["python3", path.join(os.homedir(), ".local/bin/python3.13"), "/opt/homebrew/bin/python3"]) {
    try {
      execFileSync(bin, ["-c", "import sys, tomllib; assert sys.version_info >= (3, 11)"], { stdio: "ignore" });
      return bin;
    } catch (_) { /* next */ }
  }
  return null;
}

const py = fs.existsSync(ROUTER) ? python() : null;

test("真实库：每篇 Markdown 的路由预览与 route scan 一致", { skip: !py && "no ANKS vault / Python 3.11+" }, () => {
  const api = loadApi();
  const contract = api.parseContract(JSON.parse(execFileSync(py, [ROUTER, "contract", "--vault", VAULT, "--rules", RULES], { encoding: "utf8" })));
  const dump = `
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("kr", sys.argv[1]); kr = importlib.util.module_from_spec(spec)
sys.modules["kr"] = kr; spec.loader.exec_module(kr)
vault = Path(sys.argv[2]); rules = kr.load_rules(Path(sys.argv[3])); out = []
for p in kr.iter_files(vault):
    rel = kr.norm_rel(p.relative_to(vault))
    if p.suffix.lower() != ".md": continue
    meta = kr.read_frontmatter(p)
    d = kr.resolve_target(rel, p, rules, meta=meta)
    out.append({"path": rel, "meta": meta, "status": d.status, "target": d.expected_dir, "rule": d.rule})
print(json.dumps(out, ensure_ascii=False, default=str))
`;
  const rows = JSON.parse(execFileSync(py, ["-c", dump, ROUTER, VAULT, RULES], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  assert.ok(rows.length > 50, `扫描到的笔记太少：${rows.length}`);
  const mismatches = [];
  let compared = 0;
  for (const row of rows) {
    const js = api.previewRoute(row.path, row.meta, contract);
    if (js.status === "delegated") continue;
    compared++;
    const pyStatus = row.status === "protected" ? "ignored" : row.status;
    const jsStatus = js.status === "review" ? "unroutable" : js.status;
    if (pyStatus !== jsStatus || (["correct", "misplaced"].includes(pyStatus) && row.target !== js.target)) {
      mismatches.push(`${row.path}: py=${row.status}→${row.target} js=${js.status}→${js.target}`);
    }
  }
  console.log(`parity compared=${compared} total=${rows.length}`);
  assert.ok(compared > 50, `对拍样本太少：${compared}`);
  assert.deepEqual(mismatches, []);
});
