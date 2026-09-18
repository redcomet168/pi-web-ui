#!/usr/bin/env node
/**
 * apply-send-hotfix.mjs — idempotent ops patch for npm-installed pi-web-ui.
 *
 * WHY: pi-web-ui 0.90.1 ships express 5.2.1 + send 1.2.1. send@1.x removed the
 * legacy dotfile fallback: its default 'ignore' policy 404s ANY path containing
 * a dot-segment. pi-web-ui stores plugins/themes under ~/.pi-web/ (dot-dir), so
 * on a fresh install/update every plugin client bundle (/plugins/<id>/client/*),
 * workspace dot-dir file downloads, and user theme CSS silently 404 while the
 * server log still claims the plugins "activated".
 *
 * FIX: pass { dotfiles: "allow" } at the affected send sites. Workspace-file
 * routes additionally get a basename guard so dotfile FILES (e.g. .env) stay
 * refused — matching pre-update send@0.19 semantics (dot-DIRECTORIES served,
 * dot-FILES refused).
 *
 * Apply after EVERY `npm i -g pi-web-ui` update (the patch lives in the
 * npm-installed dist and is wiped by updates):
 *
 *   node scripts/apply-send-hotfix.mjs              # patch + restart + smoke test
 *   node scripts/apply-send-hotfix.mjs --check      # report only, no writes
 *   node scripts/apply-send-hotfix.mjs --no-restart # patch, skip service restart
 *   node scripts/apply-send-hotfix.mjs --target <path/to/index.js>
 *   node scripts/apply-send-hotfix.mjs --self-test  # verify against pristine 0.90.1
 *
 * Exit codes: 0 = all sites applied (or already applied); 1 = a required site's
 * input pattern was NOT found on an unpatched file (upstream changed — inspect).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const MARKER = `dotfiles: "allow"`;
const GUARD = (indent) =>
  `${indent}if (basename(abs).startsWith(".")) { res.status(404).end("not found"); return; }`;
const PORT = process.env.PORT || "8787";
const PLUGIN_DATA_DIR = join(process.env.HOME || "/root", ".pi-web", "plugins");

// ---------------------------------------------------------------------------
// Patch definitions. Input patterns are exact strings from pristine 0.90.1 —
// never line numbers. Each entry: { name, apply(text) -> {text, status, count} }
// status: "applied" | "already" | "notfound"
// ---------------------------------------------------------------------------

function patchPluginRoute(text) {
  const input = `res.sendFile(abs, (err) => {`;
  const output = `res.sendFile(abs, { ${MARKER} }, (err) => {`;
  if (text.includes(output)) return { text, status: "already" };
  if (text.includes(input)) return { text: text.split(input).join(output), status: "applied" };
  return { text, status: "notfound" };
}

// Sites 2 & 4 share the same input `res.sendFile(abs);` (2 occurrences in
// pristine 0.90.1) and receive the same guard + options treatment.
function patchWorkspaceSendFile(text) {
  const outputSig = `res.sendFile(abs, { ${MARKER} });`;
  const re = /^([ \t]*)res\.sendFile\(abs\);$/gm;
  const count = (text.match(re) || []).length;
  if (count === 0) {
    return { text, status: text.includes(outputSig) ? "already" : "notfound", count: 0 };
  }
  const patched = text.replace(
    re,
    (m, indent) =>
      `${GUARD(indent)}\n${indent}res.sendFile(abs, { ${MARKER} });`
  );
  return { text: patched, status: "applied", count };
}

function patchWorkspaceDownload(text) {
  const outputSig = `res.download(abs, name, { ${MARKER} });`;
  const input = `res.download(abs, name);`;
  if (text.includes(outputSig)) return { text, status: "already" };
  const re = /^([ \t]*)res\.download\(abs, name\);$/m;
  const m = text.match(re);
  if (!m) return { text, status: "notfound" };
  const indent = m[1];
  const replacement = `${GUARD(indent)}\n${indent}res.download(abs, name, { ${MARKER} });`;
  return { text: text.replace(input, replacement), status: "applied" };
}

function patchThemeRoute(text) {
  const input = `res.sendFile(file);`;
  const output = `res.sendFile(file, { ${MARKER} });`;
  if (text.includes(output)) return { text, status: "already" };
  if (text.includes(input)) return { text: text.split(input).join(output), status: "applied" };
  return { text, status: "notfound" };
}

function ensureBasenameImport(text) {
  const importRe = /^import\s*\{([^}]*)\}\s*from\s*["']node:path["'];?$/m;
  const m = text.match(importRe);
  if (m) {
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    if (!names.includes("basename")) {
      names.push("basename");
      return { text: text.replace(importRe, `import { ${names.join(", ")} } from "node:path";`), status: "applied" };
    }
    return { text, status: "already" };
  }
  // No node:path import at all — add one above the first import line.
  const firstImport = text.match(/^import .*$/m);
  if (!firstImport) return { text, status: "notfound" };
  return {
    text: text.replace(firstImport[0], `import { basename } from "node:path";\n${firstImport[0]}`),
    status: "applied",
  };
}

const PATCHES = [
  { name: "plugin bundle route", fn: patchPluginRoute },
  { name: "workspace sendFile (preview + attachment routes)", fn: patchWorkspaceSendFile },
  { name: "workspace res.download (download branch)", fn: patchWorkspaceDownload },
  { name: "theme CSS route", fn: patchThemeRoute },
  { name: "basename import present", fn: ensureBasenameImport },
];

// ---------------------------------------------------------------------------
// Core routine (pure-ish: file text in → report out). Used by CLI and self-test.
// ---------------------------------------------------------------------------

function applyHotfix(originalText) {
  const report = [];
  let text = originalText;
  for (const { name, fn } of PATCHES) {
    const r = fn(text);
    text = r.text;
    report.push({ name, status: r.status, count: r.count });
  }
  return { text, report };
}

function summarize(report) {
  const applied = report.filter((r) => r.status === "applied");
  const already = report.filter((r) => r.status === "already");
  const missing = report.filter((r) => r.status === "notfound");
  for (const r of report) {
    const tag = r.status === "applied" ? "APPLIED" : r.status === "already" ? "already applied" : "PATTERN-NOT-FOUND";
    console.log(`  [${tag}] ${r.name}${r.count !== undefined && r.status === "applied" ? ` (${r.count} site(s))` : ""}`);
  }
  if (missing.length > 0) {
    console.error(`\n!! ${missing.length} pattern(s) not found — upstream code likely changed.`);
    console.error("!! Inspect the send/download call sites above; update this script's patterns.");
  }
  return { applied, already, missing };
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function detectTarget() {
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    return join(root, "pi-web-ui", "dist", "server", "index.js");
  } catch {
    return "/usr/lib/node_modules/pi-web-ui/dist/server/index.js";
  }
}

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

function restartAndSmokeTest(target) {
  // Syntax gate before any service touch.
  const check = sh(process.execPath, ["--check", target]);
  if (check.status !== 0) {
    console.error("FAIL: node --check rejected the patched file:\n" + check.stderr);
    process.exitCode = 1;
    return;
  }
  console.log("  node --check: OK");

  const unit = sh("systemctl", ["cat", "pi-web-ui.service"], { stdio: "ignore" });
  if (unit.status !== 0) {
    console.log("  (no pi-web-ui systemd unit — skipping restart + smoke test)");
    return;
  }
  console.log("  restarting pi-web-ui.service ...");
  const restart = sh("systemctl", ["restart", "pi-web-ui.service"]);
  if (restart.status !== 0) {
    console.error("FAIL: systemctl restart failed:\n" + restart.stderr);
    process.exitCode = 1;
    return;
  }
  sh("sleep", ["3"]);

  const base = `http://localhost:${PORT}`;
  let pass = true;

  // Plugin bundle smoke test (first installed plugin with a client entry).
  let pluginId = null;
  try {
    pluginId = execFileSync("ls", [PLUGIN_DATA_DIR], { encoding: "utf8" })
      .split("\n").filter(Boolean)
      .find((id) => {
        try {
          return readFileSync(join(PLUGIN_DATA_DIR, id, "client", "entry.mjs"), "utf8").length > 0;
        } catch {
          return false;
        }
      }) || null;
  } catch { /* no plugins dir — skip */ }

  if (pluginId) {
    const bundle = sh("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `${base}/plugins/${pluginId}/client/entry.mjs`]);
    const ok = bundle.stdout === "200";
    console.log(`  GET /plugins/${pluginId}/client/entry.mjs → ${bundle.stdout} (expect 200) ${ok ? "PASS" : "FAIL"}`);
    pass = pass && ok;
  } else {
    console.log("  (no installed plugins with client/entry.mjs — bundle smoke test skipped)");
  }

  // Traversal guard must still 404.
  const trav = sh("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--path-as-is",
    pluginId ? `${base}/plugins/${pluginId}/client/../manifest.json` : `${base}/plugins/x/client/../manifest.json`]);
  const travOk = trav.stdout === "404" || trav.stdout === "400";
  console.log(`  GET traversal probe → ${trav.stdout} (expect 404) ${travOk ? "PASS" : "FAIL"}`);
  pass = pass && travOk;

  console.log(pass ? "\nSMOKE TEST: PASS" : "\nSMOKE TEST: FAIL");
  if (!pass) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Self-test: prove the script works on a pristine 0.90.1 tarball, twice+.
// ---------------------------------------------------------------------------

function selfTest() {
  console.log("self-test: fetching pristine pi-web-ui@0.90.1 via npm pack ...");
  const dir = mkdtempSync(join(tmpdir(), "send-hotfix-test-"));
  try {
    execFileSync("npm", ["pack", "pi-web-ui@0.90.1", "--silent"], { cwd: dir, stdio: "inherit" });
    execFileSync("tar", ["-xzf", "pi-web-ui-0.90.1.tgz"], { cwd: dir });
    const target = join(dir, "package", "dist", "server", "index.js");
    const pristine = readFileSync(target, "utf8");

    console.log("\nself-test run 1 (fresh apply):");
    const r1 = applyHotfix(pristine);
    const s1 = summarize(r1.report);
    if (s1.missing.length > 0) throw new Error("run 1: some patterns not found on pristine file");
    if (r1.text === pristine) throw new Error("run 1: file unchanged");
    writeFileSync(target, r1.text);
    const syntax = sh(process.execPath, ["--check", target]);
    if (syntax.status !== 0) throw new Error("run 1: patched file fails node --check");

    console.log("\nself-test run 2 (idempotency):");
    const r2 = applyHotfix(r1.text);
    if (r2.text !== r1.text) throw new Error("run 2: file changed — patch is not idempotent");
    if (r2.report.some((x) => x.status === "applied")) throw new Error("run 2: re-applied something");

    console.log("\nself-test run 3 (byte-identical to run 2):");
    const r3 = applyHotfix(r2.text);
    if (Buffer.compare(Buffer.from(r2.text), Buffer.from(r3.text)) !== 0) {
      throw new Error("run 3: bytes differ from run 2");
    }
    console.log("  run 2 and run 3 outputs are byte-identical");

    console.log("\nSELF-TEST: PASS");
  } catch (err) {
    console.error(`\nSELF-TEST: FAIL — ${err.message} (artifacts left in ${dir})`);
    process.exitCode = 1;
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes("--self-test")) {
  selfTest();
  process.exit(process.exitCode || 0);
}

const targetIdx = args.indexOf("--target");
const target = resolve(targetIdx !== -1 ? args[targetIdx + 1] : detectTarget());
const checkOnly = args.includes("--check");
const noRestart = args.includes("--no-restart");

console.log(`target: ${target}`);
let original;
try {
  original = readFileSync(target, "utf8");
} catch (err) {
  console.error(`FAIL: cannot read target — ${err.message}`);
  process.exit(1);
}

console.log(checkOnly ? "mode: check (no writes)" : "mode: apply");
const { text, report } = applyHotfix(original);
const { applied, already, missing } = summarize(report);

if (checkOnly) {
  const allApplied = missing.length === 0 && applied.length === 0 && already.length === PATCHES.length;
  console.log(allApplied ? "\nCHECK: hotfix fully present" : "\nCHECK: hotfix NOT fully present");
  process.exit(allApplied ? 0 : 1);
}

if (applied.length === 0 && missing.length === 0) {
  console.log("\nNothing to do — hotfix already fully applied.");
  if (!noRestart) restartAndSmokeTest(target);
  process.exit(0);
}

if (missing.length > 0 && applied.length === 0 && already.length === 0) {
  // Fresh unpatched file, nothing matched — do not write a mangled file.
  console.error("\nABORT: no patterns matched; file left untouched.");
  process.exit(1);
}

writeFileSync(target, text);
console.log(`\nWrote patched file (${applied.length} site group(s) applied).`);

if (missing.length > 0) {
  // Partial application on an upstream-changed file: surface loudly, still
  // keep the working sites (they're individually safe), but fail the run.
  process.exitCode = 1;
}
if (!noRestart) restartAndSmokeTest(target);
process.exit(process.exitCode || 0);
