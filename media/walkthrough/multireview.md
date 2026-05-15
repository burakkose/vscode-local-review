# 6. Multiple reviews

Reviews live in a central catalog on this machine (`~/.vscode-server/data/User/globalStorage/...`). You can have many reviews — across different git folders — all switchable from one VS Code window.

## What you see

The Review view shows two things at the top:

1. **The active review** — name, base ref, comment counts.
2. **All reviews** — every review in the catalog (with a filter for "just this workspace" vs "all").

## Common actions

- **Switch** — click any review in the list (or use `Local Review: Switch Review` in the command palette).
- **Filter** — toolbar button `$(filter-filled)` toggles between "this workspace only" and "all".
- **Rename** — right-click any review → Rename.
- **Archive** — right-click → Archive. Hides it from normal view; not deleted.
- **Delete** — right-click → Delete. Removes all comments, rounds, and protocol files (the workspace itself is untouched).

## When to create new reviews

- **One per feature branch** — independent review state for each branch.
- **One per worktree** — if you maintain multiple worktrees of the same repo.
- **One per "review session"** — e.g. start a fresh review when you start addressing reviewer feedback, so you can show the cycle separately.

## What about workspaces that aren't open

A review remembers its workspace folder URI. If you switch to a review whose workspace isn't in your current VS Code window's workspace folders, the comments will still show in the tree but the gutter won't appear (because the file isn't open). Open that folder in this window — or in a new window — to interact with the diff.
