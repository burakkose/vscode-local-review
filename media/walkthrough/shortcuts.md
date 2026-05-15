# Shortcuts & commands reference

## Keyboard

| Action | Windows / Linux | Mac |
|---|---|---|
| Add comment on selection | `Ctrl+Alt+R` | `Cmd+Alt+R` |
| Trigger review round | `Ctrl+Alt+Shift+R` | `Cmd+Alt+Shift+R` |
| Jump to next open comment | `Ctrl+Alt+J` | `Cmd+Alt+J` |
| Jump to previous open comment | `Ctrl+Alt+K` | `Cmd+Alt+K` |

## Commands (`Ctrl+Shift+P` → "Local Review:")

**Review lifecycle**
- `New Review` — pick a folder + base ref, create a new entry in the catalog.
- `Switch Review` — picker for all reviews.
- `Rename Review`, `Archive Review`, `Delete Review` (right-click in tree, too).

**In an active review**
- `Trigger Review Round` — refresh prompt, copy trigger, snapshot working tree.
- `Copy Agent Skill (One-Time Setup)` — paste into your agent.
- `Import Agent Replies Now` — force re-read of responses.json.
- `Switch View (Overall / per-Round)` — change which diff is shown.
- `Show All Changes in One Pane` — multi-diff editor (1.86+).
- `Add Comment on Current Line or Selection` — `Ctrl+Alt+R`.
- `Jump to Next / Previous Open Comment` — `Ctrl+Alt+J/K`.
- `Refresh` — re-detect changed files vs the same base.
- `Search Comments…`, filter by All / Open / Resolved.
- `Resolve All Open / In This File`, `Delete All Agent Threads`.
- `Show Round History` — switch view to a specific round.
- `Copy Prompt Body`, `Open prompt.md`, `Open SKILL.md`, `Reveal Session Folder`.
- `Show Diagnostics`, `Restore From Backup`.
- `End Active Review` (close but keep in catalog).

## Settings (`Ctrl+,` → "Local Review")

- `localReview.handoffMode` — clipboard (default) / vscode-terminal / none.
- `localReview.fileTreeStyle` — compact / tree / flat.
- `localReview.useMergeBase` — PR-style diff (default `true`).
- `localReview.includeUntracked`, `localReview.includeJsonSidecar`.
- `localReview.autoRefresh`, `localReview.autoRefreshDelayMs`.
- `localReview.autoImportResponses` — watch responses.json.
- `localReview.author`, `localReview.agentAuthor`.
- `localReview.defaultBaseRef`, `localReview.triggerTemplate`, `localReview.promptHeader`.

## Status bar

`Review: <name>: <open>/<total> · R<round> · view R<n>` — click for the full quick-action menu.
