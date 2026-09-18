# PR Draft — for Johnson's review (NOT submitted anywhere yet)

> **Target:** upstream `xing-shuyin/pi-web-ui` (currently unreachable — repo dark; npm is the only channel).
> **Fallback target:** open as a PR/issue on `redcomet168/pi-web-ui` for the record.
> **Note for reviewer:** upstream distributes built artifacts only, so the attached patch is against the published `pi-web-ui@0.90.1` `dist/server/index.js`. The source-level change for `server/index.ts` is identical in shape (same five call sites, described below).

---

## PR title

**fix(server): pass `dotfiles: "allow"` at user-path `sendFile`/`download` sites — express 5 / send 1.2 upgrade 404s every plugin bundle under `~/.pi-web`**

## 中文摘要

升级 express 4→5（send 0.19→1.2）后，send 1.x 删除了 dotfile 的 legacy 回退：默认 `ignore` 会 404 任何路径里带点号段的文件，而默认 DATA_DIR 是 `~/.pi-web` —— 于是所有插件 client bundle、用户主题 CSS、工作区点号目录文件下载全部 404。插件服务端正常"activated"，浏览器端却空白。修复：在五处用户可见路径的 `res.sendFile`/`res.download` 传入 `{ dotfiles: "allow" }`，工作区文件路由另加 basename 守卫，完整复刻 send@0.19 的语义（点号目录放行、点号文件仍然拒绝）。

## Body

### Problem

After the release that upgraded express 4.22 → 5.2 (and `send` 0.19 → 1.2), **every plugin renders as a blank view**. Server-side activation succeeds (journal shows `[plugin:<id>] activated`), but the browser gets nothing.

`send@1.2` removed the legacy dotfile fallback that `send@0.19` applied when no `dotfiles` option was set:

- **0.19:** only paths whose *final component* is a dotfile (e.g. `.env`) were refused; dot-*directories* anywhere in the path were fine.
- **1.2:** the default `ignore` policy refuses **any path containing a dot-segment anywhere**.

The plugin data dir defaults to `~/.pi-web` — a dot-directory — so **every user on the default configuration is affected**:

- `GET /plugins/<id>/client/entry.mjs` → `404 "not found"` (served from the `res.sendFile` error callback — the route handler runs, headers go out, `send` then fails)
- `GET /themes/<user-theme>.css` → 404 (user themes live in `<dataDir>/themes`)
- `GET /api/file?path=...&download=1` for any workspace file under a dot-directory (e.g. `.pi/kanban.md`) → 404
- same for the `/api/preview/*splat` route

### Root cause

Five user-reachable file-serving call sites pass no options to `send`:

| Site | Route |
|---|---|
| `res.sendFile(abs, cb)` | `/plugins/:id/client/*splat` — plugin client bundles |
| `res.sendFile(abs)` | `/api/file` (media/text preview branch) |
| `res.download(abs, name)` | `/api/file` (download branch — `res.download` spawns its own `send()`) |
| `res.sendFile(abs)` | `/api/preview/*splat` |
| `res.sendFile(file)` | `/themes/:id.css` (user themes) |

Note the SPA catch-all (`index.html`) is unaffected — only paths under `<dataDir>` and workspace paths hit this.

### Fix

Restore `send@0.19` semantics explicitly:

1. **Plugin bundles & user themes:** pass `{ dotfiles: "allow" }` — these paths are author/user-controlled content already gated by other mechanisms (client subtree confinement + traversal guard; theme ids come from the scanned theme list, not raw paths).
2. **Workspace file routes** (`/api/file` both branches, `/api/preview/*splat`): pass `{ dotfiles: "allow" }` **and** refuse dotfile *files* explicitly (`basename(abs).startsWith(".")` → 404) so the fix does not introduce the ability to fetch `.env` etc. Net behavior is identical to pre-upgrade: dot-directories serve, dotfile files don't.

Source-level diff is the same five call sites in `server/index.ts`; the attached patch applies to the published 0.90.1 artifact.

### Alternatives considered

- **`root` option + relative path** — preserves send's scoped dotfile check but requires plumbing a relative path through `resolvePluginClientFile` at every site; larger diff for the same outcome.
- **Unguarded `allow` everywhere** — simpler, but silently makes workspace `.env`-style files downloadable: a behavior regression we shouldn't ship.
- **Wait for `send`** — the 1.x behavior is intentional; there is no flag to restore the legacy fallback globally.

### Testing

On Linux, default `~/.pi-web` data dir, one plugin installed:

| Probe | Before | After |
|---|---|---|
| `GET /plugins/<id>/client/entry.mjs` | 404 | **200** |
| `GET /api/file?path=<ws>/.pi/kanban.md&download=1` | 404 | **200** |
| `GET /api/file?path=<ws>/.env&download=1` | 404 | 404 (unchanged — still refused) |
| `GET /plugins/<id>/client/../manifest.json` (`--path-as-is`) | 404 | 404 (traversal guard intact) |
| path outside workspace | 400 | 400 (guard intact) |

All three plugins (view, render, WebSocket data flow) verified working after the patch; an idempotent patch script with a three-run self-test (fresh apply → idempotent → byte-identical) against a pristine `npm pack pi-web-ui@0.90.1` tarball accompanies this PR.

---

## Attachment

`send-dotfile-hotfix-0.90.1.patch` — unified diff, pristine 0.90.1 → patched, 5 sites, +21/−6. (Also parked at `docs/send-dotfile-hotfix-0.90.1.patch` in this repo.)
