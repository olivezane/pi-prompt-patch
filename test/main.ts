/**
 * Self-check for ../extensions/system-prompt-patch.ts. Run: bun test/main.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "sp-patch-"));
process.env.PI_SYSTEM_PROMPT_PATCH_DIR = dir;
const { default: factory } = await import("../extensions/system-prompt-patch.ts");

const PATCH = join(dir, "system-prompt-patch.json");
const STATE = join(dir, "system-prompt-patch.state.json");

const PATCH_KEY = "system-prompt-patch";
let PROMPT = [
	"You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.",
	"<tools>",
	"- read: read files",
	"</tools>",
	"<rules>",
	"- Be concise in your responses",
	"- Show file paths clearly when working with files",
	"</rules>",
	"<docs>",
	"- Main documentation: /opt/pi/install/releases/1.5.2/node_modules/pkg/README.md",
	"</docs>",
	"<cwd>",
	"/tmp/project",
	"</cwd>",
].join("\n");

let notes: Array<{ message: string; type: string }> = [];
let status: Record<string, string | undefined> = {};
const handlers: Record<string, (event: any, ctx: any) => any> = {};
const commands: Record<string, { handler: (args: string, ctx: any) => any }> = {};

function session() {
	notes = [];
	status = {};
	factory({
		on: (event: string, handler: any) => (handlers[event] = handler),
		registerCommand: (name: string, command: any) => (commands[name] = command),
	} as never);
	const ctx = {
		ui: {
			notify: (message: string, type = "info") => notes.push({ message, type }),
			setStatus: (key: string, text?: string) => (status[key] = text),
		},
	};
	return (prompt = PROMPT) => handlers.before_agent_start({ systemPrompt: prompt, systemPromptOptions: {} }, ctx);
}

async function writePatch(content: unknown) {
	await Bun.sleep(5); // bust the mtime+size cache
	writeFileSync(PATCH, typeof content === "string" ? content : JSON.stringify(content));
}

async function editPrompt(edited: string, opts: { confirm?: boolean; base?: string; keep?: boolean } = {}) {
	notes = [];
	let prefill = "";
	let title = "";
	const ctx = {
		hasUI: true,
		getSystemPrompt: () => opts.base ?? PROMPT,
		ui: {
			confirm: async () => opts.confirm ?? true,
			editor: async (promptTitle: string, text: string) => {
				title = promptTitle;
				prefill = text;
				return opts.keep ? text : edited;
			},
			notify: (message: string, type = "info") => notes.push({ message, type }),
			setStatus: () => {},
		},
	};
	await commands["prompt-patch"].handler("", ctx);
	const last = notes.at(-1);
	return { type: last?.type ?? "none", message: last?.message ?? "", prefill, title, notes: notes.slice() };
}

const patch = (ops: unknown[]) => ({ ops });

// 1. No patch file: untouched prompt, no noise.
assert.equal(session()(), undefined);
assert.equal(notes.length, 0);

// 2. Clean patch applies and is reported.
await writePatch(patch([{ find: "- Be concise in your responses", replace: "- Be concise\n- New rule" }]));
let run = session();
assert.match(run()!.systemPrompt, /- New rule/);
assert.equal(status[PATCH_KEY], "patch: 1 op(s) applied");
assert.equal(notes.filter((n) => n.type === "warning").length, 0);
assert.ok(existsSync(STATE), "first patched run records the base prompt fingerprint");

// 3. Missing anchor: whole patch rejected, default prompt kept, warning shown.
await writePatch(
	patch([
		{ find: "- Be concise in your responses", replace: "- Be concise!" },
		{ find: "text pi never had", replace: "x" },
	]),
);
run = session();
assert.equal(run(), undefined);
assert.equal(status[PATCH_KEY], "patch: 2 op(s) NOT applied");
assert.match(notes.at(-1)!.message, /op 2: anchor not found/);
assert.equal(notes.at(-1)!.type, "warning");
run();
assert.equal(notes.filter((n) => n.type === "warning").length, 1, "the same warning is not repeated per session");

// 4. Ambiguous anchor needs "all": true.
await writePatch(patch([{ find: "coding", replace: "coding" }]));
run = session();
assert.equal(run(), undefined);
assert.match(notes.at(-1)!.message, /anchor matches \d+ times/);
await writePatch(patch([{ find: "coding", replace: "Coding", all: true }]));
assert.match(session()()!.systemPrompt, /Coding assistant.*Coding agent harness/);

// 5. Delete op.
await writePatch(patch([{ find: ["<cwd>", "/tmp/project", "</cwd>"] }]));
assert.doesNotMatch(session()()!.systemPrompt, /\/tmp\/project/);

// 6. Invalid patch file: warning, default prompt.
await writePatch("{ not json");
assert.equal(session()(), undefined);
assert.equal(status[PATCH_KEY], "patch: invalid patch file");
assert.match(notes.at(-1)!.message, /using default prompt/);
assert.match(readFileSync(PATCH, "utf8"), /not json/);

// 7. Base prompt change is announced once per fingerprint.
await writePatch(patch([{ find: "- Be concise in your responses", replace: "- Be concise." }]));
const upgraded = PROMPT.replace("Help users inspect files", "Help users inspect and edit files");
assert.ok(session()(upgraded)!.systemPrompt.includes("Be concise."));
assert.equal(notes.filter((n) => n.type === "info").length, 1);
assert.match(notes.at(-1)!.message, /1\.5\.2/);
assert.equal(session()(upgraded)!.systemPrompt.includes("Be concise."), true);
assert.equal(notes.filter((n) => n.type === "info").length, 0);

// 8. /prompt-patch: editing the default prompt writes ops that reproduce the edit.
session();
const edited = PROMPT.replace(
	"- Show file paths clearly when working with files",
	"- Show file paths clearly when working with files\n- Prefer small, focused diffs",
);
let result = await editPrompt(`${edited}\n`);
assert.equal(result.type, "info");
assert.match(result.message, /Saved 1 patch op\(s\)/);
assert.equal(JSON.parse(readFileSync(PATCH, "utf8")).ops.length, 1);
assert.equal(session()()!.systemPrompt, edited);

// 9. Two distant edits become two ops and still reproduce the edit.
const twoEdits = PROMPT
	.replace("You are a coding assistant", "You are a meticulous coding assistant")
	.replace("- read: read files", "- read: read files and images");
result = await editPrompt(twoEdits);
assert.match(result.message, /Saved 2 patch op\(s\)/);
assert.equal(session()()!.systemPrompt, twoEdits);

// 10. Editing inside a per-project section is refused and keeps the old patch.
const before = readFileSync(PATCH, "utf8");
result = await editPrompt(PROMPT.replace("/tmp/project", "/home/me/other-project"));
assert.equal(result.type, "error");
assert.match(result.message, /refusing to patch <cwd>/);
assert.equal(readFileSync(PATCH, "utf8"), before);

// 10b. AGENTS.md content is replaced by a placeholder, so it cannot be edited by accident.
const agentsBase = [
	"You are a coding assistant.",
	"<project_context>",
	'<project_instructions path="/home/me/AGENTS.md">',
	"- keep it short",
	"</project_instructions>",
	"</project_context>",
	"<cwd>",
	"/tmp/p",
	"</cwd>",
].join("\n");
result = await editPrompt(agentsBase, { base: agentsBase, keep: true });
assert.equal(result.type, "error");
assert.match(result.message, /no changes/);
assert.doesNotMatch(result.prefill, /keep it short/);
assert.match(result.prefill, /@@ \/prompt-patch: <project_context> hidden; edit its source file instead @@/);

// 10c. Editing around the placeholder saves a patch that leaves the section intact.
const agentsEdited = result.prefill.replace("You are a coding assistant.", "You are a coding assistant. Be kind.");
result = await editPrompt(agentsEdited, { base: agentsBase });
assert.equal(result.type, "info");
assert.equal(
	session()(agentsBase)!.systemPrompt,
	agentsBase.replace("You are a coding assistant.", "You are a coding assistant. Be kind."),
);

// 10d. Deleting the placeholder is refused instead of silently dropping the section.
result = await editPrompt(result.prefill.replace(/^@@ \/prompt-patch: <project_context>.*\n?/m, ""), { base: agentsBase });
assert.equal(result.type, "error");
assert.match(result.message, /<project_context> placeholder was removed/);

// 11. Cancelling the confirm keeps the old patch.
const prior = readFileSync(PATCH, "utf8");
result = await editPrompt(PROMPT.replace("modify code.", "modify code safely."), { confirm: false });
assert.ok(!result.notes.some((n) => /Saved/.test(n.message)));
assert.equal(readFileSync(PATCH, "utf8"), prior);

// 12. Anchors stay out of <docs>: the patch survives a release that rewrites the docs path.
const ruleEdit = PROMPT.replace("- Show file paths clearly when working with files", "- Show file paths clearly");
result = await editPrompt(ruleEdit);
assert.equal(result.type, "info", result.message);
const saved = readFileSync(PATCH, "utf8");
assert.doesNotMatch(saved, /Main documentation|<docs>/);
const newer = PROMPT.replace("releases/1.5.2/", "releases/9.9.9/");
assert.equal(session()(newer)!.systemPrompt, ruleEdit.replace("releases/1.5.2/", "releases/9.9.9/"));

// 13. Fuzz: random edits in the pi-authored region round-trip through the command and a run.
let seed = 42;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
for (let round = 0; round < 25; round++) {
	const lines = PROMPT.split("\n");
	const at = 2 + Math.floor(random() * 6); // inside <tools>/<rules>, never the dynamic sections
	const mode = Math.floor(random() * 3);
	if (mode === 0) lines[at] = `${lines[at]} v${round}`;
	else if (mode === 1) lines.splice(at, 0, `inserted line ${round}`);
	else lines.splice(at, 1);
	const target = lines.join("\n");
	result = await editPrompt(target);
	assert.equal(result.type, "info", `round ${round}: ${result.message}`);
	assert.equal(session()()!.systemPrompt, target, `round ${round} round-trip`);
}

// 14. An applied patch is the starting point for the next edit.
const v1 = PROMPT.replace("- Be concise in your responses", "- Be terse");
await writePatch(patch([{ find: "- Be concise in your responses", replace: "- Be terse" }]));
const v2 = v1.replace("- Be terse", "- Be terse\n- Prefer tiny diffs");
result = await editPrompt(v2);
assert.equal(result.prefill, v1);
assert.match(result.title, /patched/);
assert.match(result.message, /Saved \d+ patch op\(s\)/);
const finalPrompt = v2;
assert.equal(session()()!.systemPrompt, finalPrompt);

// 15. A patch that no longer applies falls back to the default prompt and warns.
await writePatch(patch([{ find: "gone in a pi upgrade", replace: "x" }]));
const v3 = PROMPT.replace("modify code.", "modify code, tests, and docs.");
result = await editPrompt(v3);
assert.equal(result.prefill, PROMPT);
assert.match(result.title, /default/);
assert.ok(result.notes.some((n) => n.type === "warning" && /does not apply/.test(n.message)));
assert.equal(session()()!.systemPrompt, v3);

async function showPrompt(base = PROMPT) {
	notes = [];
	let component: any;
	const rows: string[] = [];
	const draw = () => rows.splice(0, rows.length, ...component.render(80));
	await commands["prompt-show"].handler("", {
		mode: "tui",
		hasUI: true,
		getSystemPrompt: () => base,
		ui: {
			custom: async (factory: any) => {
				const tui = { terminal: { rows: 12, columns: 80 }, requestRender: () => {} };
				const theme = { fg: (_color: string, value: string) => value };
				const keybindings = { matches: () => false };
				let settle = () => {};
				const finished = new Promise<void>((resolve) => (settle = resolve));
				component = factory(tui, theme, keybindings, () => settle());
				draw();
				settle();
				return finished;
			},
			notify: (message: string, type = "info") => notes.push({ message, type }),
			setStatus: () => {},
		},
	});
	const key = (data: string) => {
		component.handleInput(data);
		draw();
	};
	return { rows, key, notes: notes.slice() };
}

// 16. /prompt-show shows the patched prompt in a read-only pager (no editor, no placeholder).
session();
await writePatch(patch([{ find: "- Be concise in your responses", replace: "- Be crisp" }]));
const shown = await showPrompt();
assert.match(shown.rows.join("\n"), /- Be crisp/);
assert.match(shown.rows[0], /1 op\(s\) applied/);
assert.doesNotMatch(shown.rows.join("\n"), /prompt-patch: </);

// 17. Arrow keys scroll the window, and the footer reports it.
const total = PROMPT.split("\n").length;
const view = 12 - 4; // fake terminal of 12 rows, minus header/footer/spacer
assert.match(shown.rows.at(-1)!, new RegExp(`lines 1-${view} of ${total}`));
shown.key("\u001b[B");
shown.key("\u001b[B");
assert.match(shown.rows.at(-1)!, new RegExp(`lines 3-${view + 2} of ${total}`));

// 18. A patch that no longer applies shows the default prompt and warns.
await writePatch(patch([{ find: "gone in an upgrade", replace: "x" }]));
const shownDefault = await showPrompt();
assert.match(shownDefault.rows[0], /default/);
assert.match(shownDefault.rows.join("\n"), /- Be concise in your responses/);
assert.ok(shownDefault.notes.some((n) => n.type === "warning" && /does not apply/.test(n.message)));

console.log("system-prompt-patch: all checks passed");
