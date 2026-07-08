# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-07-07

Initial release.

### Added

- **`AskAntigravity` tool** — delegates a self-contained sub-task to Google
  Antigravity's `agy` CLI (the CLI for Gemini) via `agy -p`, streams stdout
  as partial output, and returns the final response. The tool answers to
  three names the CLI is known by — **gemini**, **antigravity**, and **agy**
  — surfaced in its description so the model maps any of them to this single
  tool.
- **Multi-turn conversations with agy** — optional `conversationId` param.
  Omit for a one-shot (agy starts fresh); pass the id returned in a prior
  call's result (`details.conversationId`) to resume that conversation with
  full context. The agent decides per call which mode to use. On fresh runs
  the extension discovers the new conversation id agy creates (snapshot +
  diff of agy's conversations dir, the one technique borrowed from
  [`antigravity-acp`](https://github.com/shubzkothekar/antigravity-acp)'s
  `scan.ts`); on continued runs it passes `--conversation <id>` which agy
  resumes natively. agy holds all state in its own SQLite DB; the extension
  is otherwise stateless.
- **Friendly model aliases** — `flash`, `pro`, `gemini`, plus tier/version
  qualifiers (`flash high`, `3.1 pro`). Aliases resolve to the exact
  `agy models` string using numeric version comparison, with nearest-tier
  fallback (Pro has no Medium → falls back to High; ties break toward the
  higher tier so "latest and greatest" wins).
- **`/agy` slash command** — interactive picker (`SettingsList`) for the
  default model and default thinking tier. If the project config shadows the
  global, the change is written there so it actually takes effect; otherwise
  it writes to global. Outside TUI (RPC/headless), prints a read-only status
  snapshot.
- **Config file** — `~/.pi/agent/ask-antigravity.json` (global) merged over
  `.pi/ask-antigravity.json` (project). Atomic writes (temp + rename).
- **Defaults** — model `flash`, thinking `medium` (Gemini 3.5 Flash Medium).
- **Circular-delegation guard** — refuses to spawn agy when the active Pi
  provider is already `antigravity`/`agy`.
- **Process lifecycle** — spawned `agy` runs in a detached process group so
  its own exec subprocesses are killed on abort/timeout (not orphaned); a
  watchdog enforces the timeout cap directly (not just via agy's
  `--print-timeout`); stdout/stderr decoded at the stream level for UTF-8
  safety across pipe chunks; throttled status updates avoid O(n²) re-renders.
- **Environment support** — `AGY_BIN`, `AGY_EXTRA_ARGS`,
  `AGY_CONVERSATIONS_DIR`.
