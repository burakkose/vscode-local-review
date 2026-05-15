# 3. Add comments — like a GitHub PR

Open any changed file from the Review view. Two ways to comment:

## A. Gutter `+` (preferred, multi-line, markdown)

1. Hover over any line — a blue `+` appears in the left gutter.
2. Click it. A comment widget opens at the bottom of the editor.
3. Type your comment (markdown is fine — lists, code blocks, etc.). Click **Add Comment**.

You can comment on either side of the diff: **right** (your edits — most common) or **left** (the base version — useful for things being removed/renamed).

## B. Keybinding (quick single-line)

1. Select a range in any file.
2. Press **Ctrl+Alt+R** (or **Cmd+Alt+R** on Mac).
3. Type in the input box.

## On any comment thread

- **Reply** — click into the thread, type at the bottom, submit. The agent sees the full conversation in the next round.
- **Resolve** (✓) — thread collapses but stays visible. Marks it addressed.
- **Unresolve** (○) — re-open.
- **Delete** (🗑) — remove the thread entirely.

## Tree view

The Review view in the activity bar shows all comments grouped by file. Click a thread to jump to it. Filter by All / Open / Resolved using the toolbar icons. Search using the magnifier.

## Storage

Comments are stored in the extension's per-review folder on this machine — **never in your repo**. Nothing to gitignore.
