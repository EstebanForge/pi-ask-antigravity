/**
 * AskAntigravity — delegate a self-contained sub-task to Google Antigravity's
 * `agy` CLI (the CLI for Gemini). The AskClaude-style delegation pattern,
 * pointed at Gemini via agy.
 *
 * One self-contained tool. Spawns `agy -p`, streams its stdout as partial
 * output, returns the final response. agy runs its OWN tool loop (read,
 * write, edit, exec) inside the workspace.
 *
 * Model aliases: friendly names resolve to the exact `agy models` string.
 *   "flash"            -> latest Flash, default tier (config)
 *   "flash high"       -> latest Flash, high thinking
 *   "pro"              -> latest Pro, default tier (config)
 *   "3.5 flash low"    -> pinned version + tier
 *   "Gemini 3.5 Flash (Medium)" -> exact passthrough
 *
 * Config: ~/.pi/agent/ask-antigravity.json (global) merged over
 *         .pi/ask-antigravity.json (project). Editable via /agy.
 *
 * Two modes (agent decides per call):
 *   - omit conversationId  -> one-shot, agy starts fresh
 *   - pass conversationId   -> resume that agy conversation (full context)
 * The id is discovered on fresh runs by snapshotting agy's conversations dir
 * before spawn and diffing after (agy -p never prints it). This is the one
 * technique borrowed from antigravity-acp's scan.ts.
 *
 * Env:  AGY_BIN (binary path), AGY_EXTRA_ARGS (extra args; whitespace-split,
 *       so values containing spaces are not supported).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentToolResult,
	getSettingsListTheme,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// --- Constants -------------------------------------------------------------

const DEFAULT_TIMEOUT_MIN = 10;
const GRACE_AFTER_TIMEOUT_MS = 5000;
const STATUS_INTERVAL_MS = 1000;
const STATUS_TAIL_CHARS = 160;
const DISCOVERY_TIMEOUT_MS = 8_000;
const DISCOVERY_POLL_ATTEMPTS = 5;
const DISCOVERY_POLL_MS = 100;
const GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "ask-antigravity.json");

const DEFAULT_MODEL = "flash";
const DEFAULT_THINKING = "medium";

// Per-family fallback tier when none is specified and no config default.
// Flash defaults to medium (per spec); Pro only ships Low/High, so "latest
// and greatest" = high.
const FAMILY_DEFAULT_TIER: Record<Family, ThinkingTier> = {
	flash: "medium",
	pro: "high",
	other: "medium",
};

const TIER_RANK: Record<ThinkingTier, number> = { low: 0, medium: 1, high: 2 };

// agy conversation ids are UUID DB-stems (e.g. "9e6fdc2f-f9f9-4096-95fc-7852528b50cc").
// Reject anything that isn't, so a leading-dash value can't misbind on agy's
// arg parser as the token after --conversation.
const CONV_ID_RE = /^[A-Za-z0-9]{1,128}$/;

const AGY_DESCRIPTION = `Delegate a self-contained sub-task to Google Antigravity. agy is the CLI for Gemini, so this tool is reached under three equivalent names the user may use interchangeably: **gemini**, **antigravity**, and **agy**. When the user says "ask gemini", "ask antigravity", "ask agy", or otherwise refers to any of these, call THIS tool. agy runs its OWN tool loop: it can read, write, edit, and execute inside the workspace, then returns its final answer. Use for a second opinion from a different model family, Gemini-specific reasoning, or isolated sub-tasks you do not need to drive step-by-step. Provide a complete, self-contained task description; agy will not see this conversation.

TWO MODES (you choose):
- **One-shot (isolated)**: omit conversationId. agy starts fresh with no memory of prior calls. Use for independent questions.
- **Continued conversation**: pass the conversationId returned in the PREVIOUS call's details (details.conversationId). agy resumes that conversation with full context intact — use for follow-ups, multi-turn refinement, or when the user says "ask agy to follow up / continue / now do X based on what you just did". Thread the id from each result into the next call.`;

// --- Types -----------------------------------------------------------------

type ThinkingTier = "low" | "medium" | "high";
type Family = "flash" | "pro" | "other";

interface ModelEntry {
	full: string; // exact agy string, e.g. "Gemini 3.5 Flash (Medium)"
	family: Family;
	version: string | null; // "3.5"
	tier: ThinkingTier | null;
}

interface Config {
	defaultModel: string;
	defaultThinking: ThinkingTier;
}

// --- Version helpers -------------------------------------------------------

/** Descending numeric version compare. "3.10" > "3.9" (lexical sort would
 *  wrongly rank "3.9" higher because '9' > '1'). */
function compareVersionsDesc(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da !== db) return db - da; // descending
	}
	return 0;
}

// --- Config ----------------------------------------------------------------

function projectConfigPath(): string {
	return path.join(process.cwd(), ".pi", "ask-antigravity.json");
}

function tryReadJson(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function loadConfig(): Config {
	const global = tryReadJson(GLOBAL_CONFIG_PATH);
	const project = tryReadJson(projectConfigPath());
	const merged = { ...global, ...project };

	const thinkingRaw = String(merged.defaultThinking ?? DEFAULT_THINKING).toLowerCase();
	const thinking: ThinkingTier =
		thinkingRaw === "low" || thinkingRaw === "high" ? thinkingRaw : "medium";

	return {
		defaultModel: String(merged.defaultModel ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL,
		defaultThinking: thinking,
	};
}

interface SaveResult {
	path: string;
	/** Keys whose effect is shadowed by a project config (info only). */
	routedToProject: boolean;
}

/** Persist a config patch. If the project config already defines any patched
 *  key, write to the PROJECT file so the change actually takes effect
 *  (project shadows global on load); otherwise write to global.
 *  Atomic: temp file + rename, with temp cleanup on failure. */
function saveConfig(patch: Partial<Config>): SaveResult {
	const projectRaw = tryReadJson(projectConfigPath());
	const projectShadows = Object.keys(patch).some((k) => k in projectRaw);
	const targetPath = projectShadows ? projectConfigPath() : GLOBAL_CONFIG_PATH;

	const existing = tryReadJson(targetPath);
	const next = { ...existing, ...patch };
	const dir = path.dirname(targetPath);
	fs.mkdirSync(dir, { recursive: true });

	const tmp = `${targetPath}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(tmp, targetPath);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {}
		throw err;
	}
	return { path: targetPath, routedToProject: projectShadows };
}

// --- Model parsing + alias resolution --------------------------------------

/** Parse one `agy models` line into a structured entry. */
function parseModelLine(line: string): ModelEntry | null {
	const full = line.trim();
	if (!full) return null;

	const lower = full.toLowerCase();
	const family: Family = lower.includes("flash")
		? "flash"
		: lower.includes("pro")
			? "pro"
			: "other";

	const versionMatch = lower.match(/(\d+\.\d+)/);
	const version = versionMatch ? versionMatch[1] : null;

	const tierMatch = lower.match(/\((low|medium|high)\)/);
	const tier = tierMatch ? (tierMatch[1] as ThinkingTier) : null;

	return { full, family, version, tier };
}

/** Pick the available tier closest in rank to the preferred one. Distance
 *  ties (e.g. Low/High around Medium) break toward the higher tier so
 *  "latest and greatest" wins when a family lacks the requested tier. */
function nearestTier(available: ThinkingTier[], preferred: ThinkingTier): ThinkingTier {
	if (available.includes(preferred)) return preferred;
	const sorted = [...available].sort((a, b) => {
		const da = Math.abs(TIER_RANK[a] - TIER_RANK[preferred]);
		const db = Math.abs(TIER_RANK[b] - TIER_RANK[preferred]);
		return da !== db ? da - db : TIER_RANK[b] - TIER_RANK[a];
	});
	return sorted[0] ?? preferred;
}

/**
 * Resolve a friendly alias / partial name to an exact agy model string.
 * Returns null if resolution is not possible (caller passes input through
 * to agy, which may resolve or fail on its own).
 */
function resolveModel(
	input: string,
	entries: ModelEntry[],
	defaultThinking: ThinkingTier,
): string | null {
	const lower = input.toLowerCase().trim();

	// 1. Exact full-string match (case-insensitive).
	const exact = entries.find((e) => e.full.toLowerCase() === lower);
	if (exact) return exact.full;

	// 2. Parse the alias.
	let family: Family | null = lower.includes("flash")
		? "flash"
		: lower.includes("pro")
			? "pro"
			: null;
	const versionMatch = lower.match(/(\d+\.\d+)/);
	const version = versionMatch ? versionMatch[1] : null;
	const tierMatch = lower.match(/\b(low|medium|high)\b/);
	const tier = tierMatch ? (tierMatch[1] as ThinkingTier) : null;

	// "gemini" alone, "default", or empty -> default family (flash).
	if (!family && (/gemini/.test(lower) || lower === "" || lower === "default")) {
		family = "flash";
	}
	if (!family) return null; // unknown family -> let agy handle it

	// 3. Filter by family.
	let candidates = entries.filter((e) => e.family === family);
	if (candidates.length === 0) return null;

	// 4. Pin version if specified; otherwise pick the HIGHEST version
	//    (numeric compare, not lexical — see compareVersionsDesc).
	if (version) {
		const versioned = candidates.filter((e) => e.version === version);
		if (versioned.length > 0) candidates = versioned;
	} else {
		// Prefer Google's official `gemini-*-latest` aliases (entries with no
		// parseable version in their name, e.g. "Gemini Flash Latest") when
		// the user did NOT pin a specific version. The alias is the
		// versionless pointer Google intends for "the current release" and
		// hot-swaps on every release, while versioned entries like
		// "Gemini 3.6 Flash (Medium)" stay available via explicit pinning
		// (e.g. "3.6 flash medium"). Falls back to the highest versioned
		// entry if no alias is present in the catalog.
		const aliases = candidates.filter((e) => e.version === null);
		if (aliases.length > 0) {
			candidates = aliases;
		} else {
			const versions = candidates
				.map((e) => e.version)
				.filter((v): v is string => v !== null)
				.sort(compareVersionsDesc);
			if (versions.length > 0) {
				const top = versions[0];
				const latest = candidates.filter((e) => e.version === top);
				if (latest.length > 0) candidates = latest;
			}
		}
	}

	// 5. Pick tier: explicit > config default (if the family offers it) >
	//    family default. Pro has no Medium, so "pro" + default medium falls
	//    back to the Pro family default (High), not nearest-Medium.
	const familyTiers = new Set(
		candidates.map((e) => e.tier).filter((t): t is ThinkingTier => t !== null),
	);
	if (familyTiers.size === 0) return candidates[0].full; // no tiers on any entry

	const preferred =
		tier ??
		(familyTiers.has(defaultThinking) ? defaultThinking : FAMILY_DEFAULT_TIER[family]);
	const chosenTier = nearestTier([...familyTiers], preferred);
	return (candidates.find((e) => e.tier === chosenTier) ?? candidates[0]).full;
}

// --- agy process helpers ---------------------------------------------------

function resolveAgy(): string {
	return process.env.AGY_BIN || "agy";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Query `agy models`. Returns [] on any failure (non-fatal). */
async function discoverModels(binary: string): Promise<ModelEntry[]> {
	try {
		const text = await new Promise<string>((resolve, reject) => {
			const proc = spawn(binary, ["models"], {
				stdio: ["ignore", "pipe", "ignore"],
				shell: false,
			});
			// Decode at the stream level so multibyte codepoints split across
			// pipe chunks don't corrupt.
			proc.stdout?.setEncoding("utf8");
			let out = "";
			let done = false;
			const finish = (v: string) => {
				if (done) return;
				done = true;
				clearTimeout(watchdog);
				resolve(v);
			};
			proc.stdout?.on("data", (d: string) => (out += d));
			proc.on("error", (err) => {
				clearTimeout(watchdog);
				reject(err);
			});
			proc.on("close", (code) => finish(code === 0 ? out : ""));
			// Bound the spawn so a hung agy (auth prompt, network stall) can't
			// block extension load indefinitely.
			const watchdog = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {}
				finish("");
			}, DISCOVERY_TIMEOUT_MS);
		});
		return text
			.split("\n")
			.map(parseModelLine)
			.filter((e): e is ModelEntry => e !== null);
	} catch {
		return [];
	}
}

function extraArgs(): string[] {
	const raw = process.env.AGY_EXTRA_ARGS;
	return raw ? raw.split(/\s+/).filter((s) => s.length > 0) : [];
}

// --- Conversation discovery (the one technique borrowed from antigravity-acp) --
// agy -p does NOT print the conversation id, so for a fresh prompt we snapshot
// the conversations dir before spawn and pick the single new .db after. For a
// continued call we pass --conversation <id> and agy reuses it (no new file).

const CONVERSATIONS_DIR =
	process.env.AGY_CONVERSATIONS_DIR ||
	path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations");

/** Snapshot the set of conversation ids (*.db stems) currently on disk. */
function snapshotConversations(dir: string): Set<string> {
	const out = new Set<string>();
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return out;
	}
	for (const f of entries) {
		if (f.endsWith(".db")) out.add(f.slice(0, -3));
	}
	return out;
}

/** Find the single new conversation id created since `before`. Returns null if
 *  none, or if several appeared (can't safely pick which one is ours). */
function newConversationId(dir: string, before: Set<string>): string | null {
	const created = [...snapshotConversations(dir)].filter((id) => !before.has(id));
	if (created.length === 0) return null;
	if (created.length > 1) return null; // ambiguous; refuse to bind
	return created[0] ?? null;
}

// --- Extension -------------------------------------------------------------

interface AgyDetails {
	model: string | null;
	resolvedModel: string | null;
	conversationId: string | null;
	exitCode: number;
	aborted: boolean;
	timedOut: boolean;
	durationMs: number;
	stderr: string;
}

export default async function (pi: ExtensionAPI) {
	const binary = resolveAgy();
	// Discovered once at load; frozen for the session. Run /reload after an
	// `agy update` to refresh. Failure is non-fatal: resolveModel falls back
	// to passthrough so exact slugs typed by the user still work.
	const discovered = await discoverModels(binary).catch(() => []);

	// --- /agy: view / change default model + thinking ---------------------

	// Friendly model options offered in the picker. Exact strings also work
	// if typed, but the menu presents the common aliases.
	const MODEL_OPTIONS = ["flash", "pro", "gemini"];
	const THINKING_OPTIONS: ThinkingTier[] = ["low", "medium", "high"];

	pi.registerCommand("agy", {
		description:
			"AskAntigravity config: show status, or open the model/thinking picker. Usage: /agy",
		handler: async (_args, ctx) => {
			const config = loadConfig();

			// Headless / RPC fallback: print a status snapshot.
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					[
						`AskAntigravity config`,
						`  defaultModel:    ${config.defaultModel}`,
						`  defaultThinking: ${config.defaultThinking}`,
						`  resolved:        ${resolveModel(config.defaultModel, discovered, config.defaultThinking) ?? "(agy default)"}`,
						``,
						`Edit: ~/.pi/agent/ask-antigravity.json`,
					].join("\n"),
					"info",
				);
				return;
			}

			// Resolve the display string for the current default model.
			const currentResolved =
				resolveModel(config.defaultModel, discovered, config.defaultThinking) ?? config.defaultModel;

			const items: SettingItem[] = [
				{
					id: "defaultModel",
					label: "Default model",
					description:
						"Friendly alias resolved to the latest matching agy model. 'flash' = latest Flash, 'pro' = latest Pro, 'gemini' = latest Flash.",
					currentValue: `${config.defaultModel} → ${currentResolved}`,
					values: MODEL_OPTIONS.map((m) => {
						const r = resolveModel(m, discovered, config.defaultThinking) ?? m;
						return `${m} → ${r}`;
					}),
				},
				{
					id: "defaultThinking",
					label: "Default thinking",
					description:
						"Thinking tier used when the model alias doesn't name one. Pro has no Medium; it falls back to the nearest (Low or High).",
					currentValue: config.defaultThinking,
					values: THINKING_OPTIONS,
				},
			];

			const pending: Partial<Config> = {};

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(
					new Text(theme.fg("accent", theme.bold("AskAntigravity defaults")), 1, 1),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 4, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						if (id === "defaultModel") {
							// Value is "alias → resolved"; keep the alias part.
							const alias = newValue.split("→")[0].trim();
							pending.defaultModel = alias;
						} else if (id === "defaultThinking") {
							pending.defaultThinking = newValue as ThinkingTier;
						}
					},
					() => done(undefined),
				);
				container.addChild(settingsList);

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});

			if (Object.keys(pending).length === 0) return;

			try {
				const result = saveConfig(pending);
				const changed = Object.entries(pending)
					.map(([k, v]) => `${k}=${v}`)
					.join(", ");
				const where = result.routedToProject
					? "(written to project .pi/ask-antigravity.json — it shadows global)"
					: "";
				ctx.ui.notify(`Saved: ${changed}${where ? ` ${where}` : ""}`, "info");
			} catch (err) {
				ctx.ui.notify(
					`Failed to save config: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});

	// --- Tool registration -------------------------------------------------

	// Model param: free string (friendly alias OR exact). Previously this
	// was a StringEnum built from the live catalog; that made tiered/pinned
	// aliases ("flash high", "3.5 flash") fail AJV validation before
	// resolveModel ever saw them. Type.String() lets the resolver handle
	// every documented form and falls back to agy for unknown slugs.
	const modelParam = Type.Optional(
		Type.String({
			description:
				"Model alias or exact id. Friendly: 'flash' (latest Flash, prefers the gemini-flash-latest alias), 'pro' (latest Pro, prefers gemini-pro-latest), 'gemini' (=flash). Add a tier: 'flash high', 'pro low'. Pin a version: '3.5 flash'. Exact: 'Gemini 3.5 Flash (Medium)'. Omit for the configured default.",
		}),
	);

	pi.registerTool({
		name: "AskAntigravity",
		label: "Ask Antigravity",
		description: AGY_DESCRIPTION,
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"Self-contained task for agy. Include all context agy needs; it cannot see this conversation.",
			}),
			cwd: Type.Optional(
				Type.String({
					description: "Absolute workspace path agy runs in. Defaults to the current project root.",
				}),
			),
			model: modelParam,
			skipPermissions: Type.Optional(
				Type.Boolean({
					description:
						"Pass --dangerously-skip-permissions so agy auto-approves its own write/edit/exec tool calls. Required for tasks that mutate files. Use with care.",
				}),
			),
			conversationId: Type.Optional(
				Type.String({
					description:
						"Omit for a one-shot (agy starts fresh). To CONTINUE a previous agy conversation with its context intact, pass the conversationId returned in that call's details. agy resumes that conversation.",
				}),
			),
			timeoutMinutes: Type.Optional(
				Type.Number({
					description: `Hard cap on the agy run in minutes. Default ${DEFAULT_TIMEOUT_MIN}.`,
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// Circular-delegation guard (best-effort). This extension registers
			// NO provider, so the check only fires if a future agy-as-provider
			// extension registers a provider literally named antigravity/agy.
			// Cheap insurance; harmless otherwise.
			if (ctx.model?.provider === "antigravity" || ctx.model?.provider === "agy") {
				return {
					content: [
						{
							type: "text",
							text: "Error: AskAntigravity cannot be used when the active provider is already agy/Antigravity — you're already running through it.",
						},
					],
					details: {
						model: null,
						resolvedModel: null,
						conversationId: null,
						exitCode: 0,
						aborted: false,
						timedOut: false,
						durationMs: 0,
						stderr: "circular delegation blocked",
					},
				};
			}

			const config = loadConfig();
			const requestedModel = (params.model as string | undefined) ?? config.defaultModel;
			// Defensive: reject leading-dash model values that could misbind
			// on agy's arg parser when spliced as the `--model` value. Same
			// threat model as CONV_ID_RE — a leading-dash value can't be a
			// model id, so refuse it instead of letting it reach argv.
			if (typeof params.model === "string" && params.model.trim().startsWith("-")) {
				return {
					content: [
						{
							type: "text",
							text: `model value "${params.model}" starts with "-" — not a valid model id. Use a friendly alias (e.g. "flash", "pro", "gemini") or a known exact id (e.g. "Gemini 3.5 Flash (Medium)").`,
						},
					],
					details: emptyDetails(requestedModel, null),
				};
			}
			const resolved =
				resolveModel(requestedModel, discovered, config.defaultThinking) ?? requestedModel;

			const start = Date.now();
			const cwd = params.cwd || ctx.cwd || process.cwd();

			// Validate cwd up front for a clearer error than agy's ENOENT.
			try {
				const stat = fs.statSync(cwd);
				if (!stat.isDirectory()) {
					return {
						content: [{ type: "text", text: `cwd is not a directory: ${cwd}` }],
						details: emptyDetails(requestedModel, resolved),
					};
				}
			} catch {
				return {
					content: [{ type: "text", text: `cwd does not exist: ${cwd}` }],
					details: emptyDetails(requestedModel, resolved),
				};
			}

			const timeoutMin = params.timeoutMinutes ?? DEFAULT_TIMEOUT_MIN;

			// Continuity: if a conversationId is provided AND validates as an agy
			// id (UUID-ish DB stem, never a leading-dash flag), resume it; otherwise
			// snapshot the conversations dir so we can discover the new id agy
			// creates (agy -p never prints it). This is the one mechanism
			// borrowed from antigravity-acp's scan.ts. Validation rejects values
			// that could misbind on agy's arg parser (e.g. --dangerously-skip-
			// permissions passed as the token after --conversation).
			const rawConvId = params.conversationId;
			const isContinuation =
				typeof rawConvId === "string" && rawConvId.length > 0 && CONV_ID_RE.test(rawConvId);
			const snapshot = isContinuation ? null : snapshotConversations(CONVERSATIONS_DIR);

			const args: string[] = ["--add-dir", cwd];
			const extra = extraArgs();
			if (extra.length) args.push(...extra);
			if (resolved) args.push("--model", resolved);
			if (params.skipPermissions) args.push("--dangerously-skip-permissions");
			if (isContinuation) args.push("--conversation", rawConvId as string);
			args.push("--print-timeout", `${timeoutMin}m`);
			args.push("-p", params.prompt);

			const details: AgyDetails = {
				model: requestedModel,
				resolvedModel: resolved,
				conversationId: isContinuation ? (rawConvId as string) : null,
				exitCode: 0,
				aborted: false,
				timedOut: false,
				durationMs: 0,
				stderr: "",
			};

			let out = "";

			// Throttled status updates (claude-bridge pattern): emit a short
			// status line on an interval instead of the full buffer on every
			// stdout chunk, avoiding O(n²) re-renders on long runs.
			const statusInterval = onUpdate
				? setInterval(() => {
						const elapsed = Math.floor((Date.now() - start) / 1000);
						const tail = out.slice(-STATUS_TAIL_CHARS);
						const text = tail
							? `(running ${elapsed}s)\n…${tail}`
							: `(running ${elapsed}s)`;
						onUpdate({
							content: [{ type: "text", text }],
							details: { ...details, durationMs: Date.now() - start },
						});
					}, STATUS_INTERVAL_MS)
				: null;

			try {
				const outcome = await new Promise<{
					exitCode: number;
					aborted: boolean;
					timedOut: boolean;
				}>((resolveP, rejectP) => {
					// detached: true so we can signal the whole process group.
					// agy spawns its own exec subprocesses in -p mode; a direct
					// kill would orphan those grandchildren.
					const proc = spawn(binary, args, {
						cwd,
						stdio: ["ignore", "pipe", "pipe"],
						shell: false,
						detached: true,
					});

					// Decode at the stream level so multibyte UTF-8 split across
					// pipe chunks doesn't corrupt (Gemini output is non-ASCII).
					proc.stdout?.setEncoding("utf8");
					proc.stderr?.setEncoding("utf8");

					proc.stdout?.on("data", (d: string) => {
						out += d;
					});
					proc.stderr?.on("data", (d: string) => {
						details.stderr += d;
					});

					let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
					let watchdog: ReturnType<typeof setTimeout> | undefined;
					let settled = false;
					let timedOut = false;

					// Kill the whole process group; SIGTERM first, then SIGKILL
					// after a grace period if it hasn't exited.
					const killTree = () => {
						try {
							if (proc.pid) process.kill(-proc.pid, "SIGTERM");
						} catch {}
						// Only arm the SIGKILL timer once.
						if (!sigkillTimer) {
							sigkillTimer = setTimeout(() => {
								try {
									if (proc.pid) process.kill(-proc.pid, "SIGKILL");
								} catch {}
							}, GRACE_AFTER_TIMEOUT_MS);
						}
					};

					const cleanup = () => {
						if (watchdog) clearTimeout(watchdog);
						if (sigkillTimer) clearTimeout(sigkillTimer);
						if (signal) signal.removeEventListener("abort", onAbort);
					};

					const onAbort = () => killTree();

					// Enforce the timeout cap ourselves (not just via
					// --print-timeout, which agy could ignore or not support).
					watchdog = setTimeout(() => {
						timedOut = true;
						killTree();
					}, timeoutMin * 60_000);

					if (signal) {
						if (signal.aborted) killTree();
						else signal.addEventListener("abort", onAbort, { once: true });
					}

					const finish = (code: number | null) => {
						if (settled) return;
						settled = true;
						cleanup();
						// Distinguish an aborted run from a normal close: if the
						// abort signal fired, treat as cancelled regardless of
						// exit code (killTree produces a non-zero code, but be
						// explicit and order-independent). Likewise surface a
						// timeout distinctly from a genuine non-zero exit.
						resolveP({
							exitCode: code ?? 0,
							aborted: !!signal?.aborted,
							timedOut,
						});
					};

					proc.on("error", (err) => {
						cleanup();
						rejectP(err);
					});
					proc.on("close", finish);
				});

				if (statusInterval) clearInterval(statusInterval);

				details.exitCode = outcome.exitCode;
				details.aborted = outcome.aborted;
				details.timedOut = outcome.timedOut;
				details.durationMs = Date.now() - start;

				// For a fresh run, discover the conversation id agy just created
				// (agy -p never prints it). Retry briefly since agy may flush its
				// SQLite DB a moment after the process closes. A continuation run
				// reuses the provided id (already set on details).
				if (!isContinuation && !details.conversationId && snapshot) {
					for (let attempt = 0; attempt < DISCOVERY_POLL_ATTEMPTS; attempt++) {
						const found = newConversationId(CONVERSATIONS_DIR, snapshot);
						if (found) {
							details.conversationId = found;
							break;
						}
						await sleep(DISCOVERY_POLL_MS);
					}
				}

				const text = out.trim();

				// Aborted: return a distinct result so the caller knows it was
				// cancelled, not a silent success.
				if (outcome.aborted) {
					return {
						content: [
							{
								type: "text",
								text: text
									? `agy was aborted. Partial output:\n\n${text}`
									: "agy was aborted before producing output.",
							},
						],
						details,
					};
				}

				// Timeout: distinct from a genuine non-zero exit (the watchdog
				// killed the tree because the configured cap elapsed).
				if (outcome.timedOut) {
					const note = `agy exceeded the ${timeoutMin}m timeout and was killed`;
					return {
						content: [
							{ type: "text", text: text ? `${text}\n\n[${note}]` : note },
						],
						details,
					};
				}

				// Non-zero exit: surface the failure even when partial text
				// exists, instead of returning silent success.
				if (outcome.exitCode !== 0) {
					const note = details.stderr.trim()
						? `agy exited with status ${outcome.exitCode}: ${details.stderr.trim()}`
						: `agy exited with status ${outcome.exitCode}`;
					return {
						content: [
							{ type: "text", text: text ? `${text}\n\n[${note}]` : note },
						],
						details,
					};
				}

				// Success. Clear the last partial status line (claude-bridge
				// idiom) so the running-tail preview doesn't linger under the final
				// answer, then append a conversation footer so the orchestrating model
				// can see (and thread) the id without inspecting details.
				onUpdate?.({
					content: [{ type: "text", text: "" }],
					details: { ...details },
				});
				const footer = details.conversationId
					? `\n\n[agy conversationId: ${details.conversationId} — pass as conversationId to continue this conversation]`
					: "";

				return {
					content: [{ type: "text", text: text + footer }],
					details,
				};
			} catch (err) {
				if (statusInterval) clearInterval(statusInterval);
				details.durationMs = Date.now() - start;
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `failed to run agy: ${msg}` }],
					details,
				};
			}
		},
	});
}

function emptyDetails(model: string | null, resolvedModel: string | null): AgyDetails {
	return {
		model,
		resolvedModel,
		conversationId: null,
		exitCode: 0,
		aborted: false,
		timedOut: false,
		durationMs: 0,
		stderr: "",
	};
}
