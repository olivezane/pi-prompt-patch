/**
 * System Prompt Patch
 *
 * Edits Pi's default system prompt through an editor and stores the edits as a
 * line-anchored patch, so customizations survive Pi upgrades.
 *
 * `/prompt-patch` opens the current prompt in the editor: the patched one when the
 * existing patch still applies, the default one otherwise (with a warning). Sections
 * that come from files (`<project_context>` → AGENTS.md, `<skills>`) are swapped for a
 * placeholder line, since a patch cannot touch them. `/prompt-show` shows the same text
 * in a read-only pager, i.e. exactly what the next message sends. On save, the difference against
 * the default prompt is turned into ops in `system-prompt-patch.json` next to this file:
 *
 *   {
 *     "ops": [
 *       { "find": ["line one", "line two"], "replace": ["line one", "line two (edited)"] },
 *       { "find": "text to drop" },                       // no replace: delete
 *       { "find": "repeated text", "replace": "x", "all": true }
 *     ]
 *   }
 *
 * - `find`/`replace` are a string or an array of lines (joined with "\n"); generated
 *   ops use line arrays, hand edits may use either.
 * - Every op must match exactly once, unless `"all": true`.
 * - One failing op rejects the whole patch: Pi's default prompt is used and a
 *   warning explains which anchor broke.
 * - When the base prompt changes (Pi upgrade, or an edited SYSTEM.md), a notice
 *   suggests re-checking the patches. Patches whose anchors still match keep applying.
 *
 * Edits inside `<project_context>`, `<cwd>`, or `<skills>` are refused: those sections
 * differ per project, so their anchors would break everywhere else. Anchors also never
 * reach into `<docs>`, whose paths change with every release.
 *
 * Re-running `/prompt-patch` edits the patched prompt when the current patch still applies,
 * and falls back to the default prompt (with a warning) when it does not; either way the ops
 * are regenerated against the default prompt.
 *
 * The patch file is re-read when its mtime/size changes, so edits apply on the next run.
 * Data lives in `~/.pi/agent/prompt-patch/` (override with `PI_SYSTEM_PROMPT_PATCH_DIR`).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FILE = "system-prompt-patch.json";
const DEFAULT_DIR = join(homedir(), ".pi", "agent", "prompt-patch");
// Older installs kept the patch next to a loose extension in ~/.pi/agent/extensions.
const LEGACY_DIR = join(homedir(), ".pi", "agent", "extensions");

/** Where patches live: env override, then the data dir, then the legacy location if it has a patch. */
function dataDir(): string {
	if (process.env.PI_SYSTEM_PROMPT_PATCH_DIR) return process.env.PI_SYSTEM_PROMPT_PATCH_DIR;
	if (existsSync(join(LEGACY_DIR, FILE)) && !existsSync(join(DEFAULT_DIR, FILE))) return LEGACY_DIR;
	return DEFAULT_DIR;
}

const patchFile = () => join(dataDir(), FILE);
const stateFile = () => join(dataDir(), FILE.replace(/\.json$/, ".state.json"));

type Op = { find?: string | string[]; replace?: string | string[]; all?: boolean };
type Change = { at: number; removed: string[]; added: string[] };

const CONTEXT = 3;

const asText = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value.join("\n") : (value ?? "");

/** Pi-authored prompt text: the untagged preamble plus the `<docs>` section. */
function baseCore(prompt: string): string {
	const cut = prompt.search(/<(tools|rules|docs|addendum|project_context|skills)>/);
	const preamble = cut < 0 ? prompt : prompt.slice(0, cut);
	return `${preamble}\n${/<docs>[\s\S]*?<\/docs>/.exec(prompt)?.[0] ?? ""}`;
}

function piVersion(prompt: string): string {
	return /[/\\]releases[/\\]([^/\\]+)[/\\]/.exec(prompt)?.[1] ?? "unknown";
}

const countOccurrences = (haystack: string, needle: string) =>
	needle ? haystack.split(needle).length - 1 : 0;

// shortcut: cache key is mtime+size, so a same-size rewrite within one mtime tick is missed.
let cache: { stamp: string; ops: Op[] } | undefined;

function loadOps(): { ops: Op[]; error?: string } {
	let stamp: string;
	try {
		const stat = statSync(patchFile());
		stamp = `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return { ops: [] };
	}
	if (cache?.stamp === stamp) return { ops: cache.ops };
	try {
		const ops: unknown = JSON.parse(readFileSync(patchFile(), "utf8")).ops;
		if (!Array.isArray(ops)) return { ops: [], error: `${patchFile()}: "ops" must be an array` };
		cache = { stamp, ops: ops as Op[] };
		return { ops: cache.ops };
	} catch (error) {
		return { ops: [], error: `${patchFile()}: ${(error as Error).message}` };
	}
}

function applyOps(prompt: string, ops: Op[]): string {
	let text = prompt;
	ops.forEach((op, index) => {
		const find = asText(op.find);
		const replace = asText(op.replace);
		const id = `op ${index + 1}`;
		if (!find) throw new Error(`${id}: empty "find"`);
		const hits = countOccurrences(text, find);
		if (hits === 0) throw new Error(`${id}: anchor not found: ${JSON.stringify(find.slice(0, 80))}`);
		if (!op.all && hits > 1) throw new Error(`${id}: anchor matches ${hits} times, expected once`);
		text = op.all ? text.split(find).join(replace) : text.replace(find, () => replace);
	});
	return text;
}

/** Line diff: LCS over the uniquely-trimmed middle. */
function diffLines(before: string[], after: string[]): Change[] {
	let start = 0;
	let endBefore = before.length;
	let endAfter = after.length;
	while (start < endBefore && start < endAfter && before[start] === after[start]) start++;
	while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
		endBefore--;
		endAfter--;
	}
	if (start === endBefore && start === endAfter) return [];

	const a = before.slice(start, endBefore);
	const b = after.slice(start, endAfter);
	const n = a.length;
	const m = b.length;
	// shortcut: quadratic table, so huge middles fall back to one block.
	if (n * m > 4_000_000) return [{ at: start, removed: a, added: b }];

	const width = m + 1;
	const lcs = new Int32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i * width + j] =
				a[i] === b[j]
					? lcs[(i + 1) * width + j + 1] + 1
					: Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
		}
	}

	const changes: Change[] = [];
	let current: Change | undefined;
	let cursor = start;
	let i = 0;
	let j = 0;
	const flush = () => {
		if (current) changes.push(current);
		current = undefined;
	};
	while (i < n || j < m) {
		if (i < n && j < m && a[i] === b[j]) {
			flush();
			i++;
			j++;
			cursor++;
			continue;
		}
		if (!current) current = { at: cursor, removed: [], added: [] };
		if (j >= m || (i < n && lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
			current.removed.push(a[i++]);
			cursor++;
		} else {
			current.added.push(b[j++]);
		}
	}
	flush();
	return changes;
}

function dynamicRanges(lines: string[], tags: string[]): Array<{ tag: string; start: number; end: number }> {
	const ranges: Array<{ tag: string; start: number; end: number }> = [];
	for (const tag of tags) {
		lines.forEach((line, index) => {
			if (line !== `<${tag}>`) return;
			const close = lines.indexOf(`</${tag}>`, index + 1);
			ranges.push({ tag, start: index, end: close < 0 ? lines.length : close + 1 });
		});
	}
	return ranges;
}

const spanOverlaps = (from: number, to: number, start: number, stop: number) =>
	from === to ? from > start && from < stop : from < stop && to > start;

// Edits here are refused; anchors never reach into any of these (they differ per project or per release).
const REFUSED_TAGS = ["project_context", "cwd", "skills"];
const VOLATILE_TAGS = [...REFUSED_TAGS, "docs"];

/** Why an edit inside a volatile section is refused, and where to make it instead. */
function refusal(target: { tag: string; start: number; end: number }, lines: string[]): string {
	const path = lines
		.slice(target.start, target.end)
		.map((line) => /^<project_instructions path="(.*)">$/.exec(line)?.[1])
		.find(Boolean);
	if (target.tag === "project_context") {
		return path
			? `refusing to patch <project_context>: that section embeds ${path}, which differs per project. Edit that file instead.`
			: "refusing to patch <project_context>: that section differs per project. Edit its source file instead.";
	}
	if (target.tag === "cwd")
		return "refusing to patch <cwd>: that is the session's working directory. Change the directory or settings instead.";
	return "refusing to patch <skills>: those come from skill files. Edit those instead.";
}

// Sections that come from files we cannot write (AGENTS.md, skill files) are swapped for a
// placeholder line, so the editor never shows text the patch would refuse to touch.
const HIDE_TAGS = ["project_context", "skills"];
const HIDDEN_PREFIX = "@@ /prompt-patch: ";
const HIDDEN = /^@@ \/prompt-patch: <(\w+)>/;

function hideSections(lines: string[]): { view: string[]; spans: Array<{ tag: string; start: number; end: number }> } {
	const spans = dynamicRanges(lines, HIDE_TAGS).sort((a, b) => a.start - b.start);
	const view: string[] = [];
	let cursor = 0;
	for (const span of spans) {
		if (span.start < cursor) continue;
		view.push(...lines.slice(cursor, span.start));
		view.push(`${HIDDEN_PREFIX}<${span.tag}> hidden; edit its source file instead @@`);
		cursor = span.end;
	}
	view.push(...lines.slice(cursor));
	return { view, spans };
}

/** Put the hidden sections back; the placeholder must survive the edit. */
function restoreSections(view: string[], spans: Array<{ tag: string; start: number; end: number }>, original: string[]): string[] | { error: string } {
	if (spans.length === 0) return view;
	const queue = [...spans];
	const out: string[] = [];
	for (const line of view) {
		const match = HIDDEN.exec(line);
		if (!match) {
			out.push(line);
			continue;
		}
		const span = queue.shift();
		if (!span || span.tag !== match[1])
			return { error: `the <${match[1]}> placeholder was moved or duplicated; leave it where it is` };
		out.push(...original.slice(span.start, span.end));
	}
	if (queue.length > 0) return { error: `the <${queue[0].tag}> placeholder was removed; put it back or edit its source file instead` };
	return out;
}


/** Read-only pager: pi has no viewer component, so we scroll a window ourselves. */
async function viewText(
	ctx: { mode: string; ui: { custom: (factory: (tui: any, theme: any, keybindings: any, done: (value: unknown) => void) => any) => Promise<unknown> } },
	title: string,
	text: string,
): Promise<void> {
	const lines = text.split("\n");
	await ctx.ui.custom((tui: any, theme: any, keybindings: any, done: (value: unknown) => void) => {
		let top = 0;
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		// Header and footer take one row each, plus one spare so the window never scrolls the header off.
		const height = () => Math.max(3, (tui.terminal?.rows ?? 24) - 4);
		const invalidate = () => {
			cachedWidth = undefined;
			cachedLines = undefined;
		};
		return {
			render(width: number): string[] {
				if (cachedLines && cachedWidth === width) return cachedLines;
				const view = height();
				top = Math.max(0, Math.min(top, lines.length - view));
				cachedWidth = width;
				cachedLines = [
					theme.fg("accent", truncateToWidth(`${title} · ${lines.length} lines · ↑/↓ pgUp/pgDn scroll · esc closes`, width)),
					...lines.slice(top, top + view).map((line) => truncateToWidth(line.replace(/\t/g, "    "), width)),
					theme.fg("dim", truncateToWidth(`lines ${top + 1}-${Math.min(lines.length, top + view)} of ${lines.length}`, width)),
				];
				return cachedLines;
			},
			handleInput(data: string): void {
				const page = height() - 1;
				if (keybindings.matches(data, "tui.select.up") || data === "\u001b[A") top -= 1;
				else if (keybindings.matches(data, "tui.select.down") || data === "\u001b[B") top += 1;
				else if (keybindings.matches(data, "tui.select.pageUp") || data === "\u001b[5~") top -= page;
				else if (keybindings.matches(data, "tui.select.pageDown") || data === "\u001b[6~") top += page;
				else if (data === "\u001b[H" || data === "\u001b[1~") top = 0;
				else if (data === "\u001b[F" || data === "\u001b[4~") top = lines.length;
				else if (keybindings.matches(data, "tui.select.cancel") || data === "q" || data === "\r") {
					done(undefined);
					return;
				} else return;
				invalidate();
				tui.requestRender();
			},
			invalidate,
		};
	});
}

/** Turn edited prompt text into verified, uniquely-anchored ops. */
function buildPatch(base: string, edited: string): { ops: Op[] } | { error: string } {
	const before = base.split("\n");
	const changes = diffLines(before, edited.split("\n"));
	if (changes.length === 0) return { error: "no changes" };

	const volatile = dynamicRanges(before, VOLATILE_TAGS);
	for (const change of changes) {
		const end = change.at + change.removed.length;
		const hit = volatile.find((range) => spanOverlaps(change.at, end, range.start, range.end));
		if (hit && REFUSED_TAGS.includes(hit.tag)) return { error: refusal(hit, before) };
	}

	const ops: Op[] = [];
	for (const [index, change] of changes.entries()) {
		const end = change.at + change.removed.length;
		const previousEnd = index === 0 ? 0 : changes[index - 1].at + changes[index - 1].removed.length;
		const nextStart = index + 1 === changes.length ? before.length : changes[index + 1].at;
		let lo = previousEnd;
		let hi = nextStart;
		for (const range of volatile) {
			if (spanOverlaps(change.at, end, range.start, range.end)) continue;
			if (range.end <= change.at) lo = Math.max(lo, range.end);
			else hi = Math.min(hi, range.start);
		}
		const leadMax = change.at - lo;
		const trailMax = hi - end;
		let lead = Math.min(CONTEXT, leadMax);
		let trail = Math.min(CONTEXT, trailMax);
		let find = "";
		let replace = "";
		while (true) {
			find = before.slice(change.at - lead, end + trail).join("\n");
			replace = [
				...before.slice(change.at - lead, change.at),
				...change.added,
				...before.slice(end, end + trail),
			].join("\n");
			if (countOccurrences(base, find) === 1) break;
			if (lead === leadMax && trail === trailMax) break;
			lead = Math.min(lead + 1, leadMax);
			trail = Math.min(trail + 1, trailMax);
		}
		if (countOccurrences(base, find) !== 1) {
			return { error: `edit is not unique in the prompt: ${JSON.stringify(find.slice(0, 80))}` };
		}
		ops.push({ find: find.split("\n"), replace: replace.split("\n") });
	}

	try {
		if (applyOps(base, ops) !== edited) return { error: "generated patch does not reproduce the edit" };
	} catch (error) {
		return { error: `generated patch is invalid: ${(error as Error).message}` };
	}
	return { ops };
}

function noticeBaseChange(prompt: string, ctx: ExtensionContext): void {
	const fingerprint = createHash("sha256").update(baseCore(prompt)).digest("hex");
	let previous: { fingerprint?: string; version?: string } = {};
	try {
		previous = JSON.parse(readFileSync(stateFile(), "utf8"));
	} catch {}
	if (previous.fingerprint === fingerprint) return;
	if (previous.fingerprint) {
		const from = previous.version ?? "earlier";
		ctx.ui.notify(
			`System prompt base changed (${from} -> ${piVersion(prompt)}). Re-check the patches in ${patchFile()}.`,
			"info",
		);
	}
	try {
		writeFileSync(stateFile(), `${JSON.stringify({ fingerprint, version: piVersion(prompt) }, null, 2)}\n`);
	} catch {}
}

export default function systemPromptPatch(pi: ExtensionAPI) {
	let checkedBase = false;
	let lastWarning = "";

	pi.on("before_agent_start", (event, ctx) => {
		const { ops, error } = loadOps();
		if (error) {
			ctx.ui.setStatus("system-prompt-patch", "patch: invalid patch file");
			if (lastWarning !== error) {
				lastWarning = error;
				ctx.ui.notify(`System prompt patch ignored, using default prompt: ${error}`, "warning");
			}
			return;
		}
		if (ops.length === 0) return;

		if (!checkedBase) {
			checkedBase = true;
			noticeBaseChange(event.systemPrompt, ctx);
		}

		let patched: string;
		try {
			patched = applyOps(event.systemPrompt, ops);
		} catch (patchError) {
			const message = `System prompt patch rejected, using default prompt: ${(patchError as Error).message}`;
			ctx.ui.setStatus("system-prompt-patch", `patch: ${ops.length} op(s) NOT applied`);
			if (lastWarning !== message) {
				lastWarning = message;
				ctx.ui.notify(message, "warning");
			}
			return;
		}
		ctx.ui.setStatus("system-prompt-patch", `patch: ${ops.length} op(s) applied`);
		lastWarning = "";
		return { systemPrompt: patched };
	});

	pi.registerCommand("prompt-patch", {
		description: "Edit the system prompt; saves the diff as anchored patch ops",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/prompt-patch needs the interactive UI", "warning");
				return;
			}
			const base = ctx.getSystemPrompt().replace(/\r\n/g, "\n").replace(/\n+$/, "");
			const existing = loadOps();
			if (existing.error) ctx.ui.notify(`Existing patch file ignored: ${existing.error}`, "warning");

			// Edit on top of the patch when it applies, otherwise on top of the default prompt.
			let draft = base;
			let stale = "";
			if (existing.ops.length > 0) {
				try {
					draft = applyOps(base, existing.ops);
				} catch (error) {
					stale = (error as Error).message;
					ctx.ui.notify(`Existing patch does not apply (${stale}); editing the default prompt.`, "warning");
				}
			}

			if (existing.ops.length > 0) {
				const ok = await ctx.ui.confirm(
					"Regenerate patch?",
					stale
						? `Saving replaces the ${existing.ops.length} unusable op(s) with a patch against the default prompt.`
						: `Saving replaces the ${existing.ops.length} current op(s); you are editing the patched prompt.`,
				);
				if (!ok) return;
			}

			const title = stale || draft === base ? "System prompt (default, saved as a patch)" : "System prompt (patched, saved as a patch)";
			const { view, spans } = hideSections(draft.split("\n"));
			const edited = await ctx.ui.editor(title, view.join("\n"));
			if (edited === undefined) return;
			const kept = restoreSections(edited.split("\n"), spans, draft.split("\n"));
			if ("error" in kept) {
				ctx.ui.notify(`Patch not saved: ${kept.error}`, "error");
				return;
			}
			const result = buildPatch(base, kept.join("\n").replace(/\r\n/g, "\n").replace(/\n+$/, ""));
			if ("error" in result) {
				ctx.ui.notify(`Patch not saved: ${result.error}`, "error");
				return;
			}
			mkdirSync(dirname(patchFile()), { recursive: true });
			writeFileSync(patchFile(), `${JSON.stringify({ ops: result.ops }, null, 2)}\n`);
			cache = undefined;
			ctx.ui.notify(
				`Saved ${result.ops.length} patch op(s) to ${patchFile()}; they apply from the next message.`,
				"info",
			);
		},
	});

	pi.registerCommand("prompt-show", {
		description: "View the full system prompt the next message will send",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/prompt-show needs interactive mode", "warning");
				return;
			}
			const base = ctx.getSystemPrompt().replace(/\r\n/g, "\n").replace(/\n+$/, "");
			const { ops, error } = loadOps();
			let text = base;
			if (error) ctx.ui.notify(`Patch file ignored: ${error}`, "warning");
			else if (ops.length > 0) {
				try {
					text = applyOps(base, ops);
				} catch (err) {
					ctx.ui.notify(`Patch does not apply (${(err as Error).message}); showing the default prompt.`, "warning");
				}
			}
			const title = ops.length > 0 && text !== base ? `System prompt (${ops.length} op(s) applied)` : "System prompt (default)";
			await viewText(ctx, title, text);
		},
	});
}
