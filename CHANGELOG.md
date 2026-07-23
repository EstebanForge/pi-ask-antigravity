# Changelog

All notable changes to this project will be documented in this file.

## [1.0.1] - 2026-07-23

### Fixed

- **`gemini-flash-latest` and `gemini-pro-latest` aliases now win over
  versioned entries when no version is pinned.** Previously, asking for
  `flash` resolved to the highest version of the flash family (e.g.
  `Gemini 3.6 Flash (Medium)`), which is a concrete snapshot — not
  Google's "latest release" pointer. The resolver now prefers entries
  with `version: null` (the aliases that `parseModelLine` produces from
  names like `Gemini Flash Latest`) over versioned entries. Falls back
  to the highest version if no alias is present in the catalog, so
  older agy builds without `*-latest` entries keep working.
- **Leading-dash values passed as `model` are rejected before reaching
  argv.** A value like `--dangerously-skip-permissions` used to land
  verbatim as the `--model` token; the tool now refuses it with a clear
  error message, matching the `CONV_ID_RE` threat model already applied
  to conversation ids.

### Changed

- `modelParam` is now a plain `Type.String()` instead of a conditional
  `StringEnum` built from the live catalog. The enum was too restrictive
  when discovery succeeded (the common case): any tiered or pinned
  alias like `"flash high"` or `"3.5 flash"` failed AJV validation
  before `resolveModel` ever saw it. Plain `Type.String()` lets the
  resolver handle every documented form and falls back to agy for
  unknown slugs. The now-unused `StringEnum` import is gone.

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
