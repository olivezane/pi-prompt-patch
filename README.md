# pi-prompt-patch

Edit Pi's system prompt in your editor; the change is stored as a small, line-anchored patch
that keeps applying after Pi upgrades.

```bash
pi install git:github.com/olivezane/pi-prompt-patch
```

## Commands

- `/prompt-patch` — open the prompt in the editor. Saving writes the difference as ops to
  `~/.pi/agent/prompt-patch/system-prompt-patch.json`. When the existing patch still applies,
  the editor starts from the patched prompt, so edits build on each other; when it no longer
  applies, you get a warning and the default prompt instead.
- `/prompt-show` — scroll through the exact system prompt the next message will send
  (read-only pager: arrows, PgUp/PgDn, Home/End, esc).

## What it does with a patch

- Ops are applied to the prompt Pi builds for each message. Every op must match exactly once
  (unless `"all": true`); one failing op rejects the whole patch, Pi's default prompt is used,
  and a warning names the broken anchor.
- A fingerprint of the stable parts (the untagged preamble plus `<docs>`) is kept in a state
  file. When a Pi upgrade changes it, you get one notice per change telling you to re-check
  the patch — the patch itself usually keeps working.
- `<project_context>`, `<cwd>`, and `<skills>` are never patched: they differ per project.
  `/prompt-patch` hides the first two behind a placeholder line, so you cannot accidentally
  edit text that comes from `AGENTS.md` or skill files. Anchors also stay out of `<docs>`,
  whose paths change with each release.

## Patch file

```json
{
  "ops": [
    { "find": ["line one", "line two"], "replace": ["line one", "line two (edited)"] },
    { "find": "text to drop" },
    { "find": "repeated text", "replace": "x", "all": true }
  ]
}
```

`find`/`replace` take a string or an array of lines (joined with `\n`); a missing `replace`
deletes. Generated ops use line arrays and carry a few lines of context.

Data lives in `~/.pi/agent/prompt-patch/`; set `PI_SYSTEM_PROMPT_PATCH_DIR` to point elsewhere
(e.g. a project-local directory). Patch files written by older installs next to a loose extension
in `~/.pi/agent/extensions/` keep working until you move them.

Run `/reload` after installing so the commands show up.

## Development

```bash
bun test/main.ts
```

The test drives the extension through a fake Pi: normal apply, broken anchors, delete ops,
invalid JSON, upgrade notices, editor round-trips, hidden sections, the read-only pager, and a
fuzz round-trip over random edits.
