# 5. Inspect what changed

There are two ways to look at the diff:

## A. Overall — what's in scope for the entire review

This is the default. Shows files changed since the review's base ref (e.g. `origin/main`). The full review scope.

## B. Per-round — what changed in a specific round

After each round, the extension pins a snapshot of the working tree (via `git stash create -u` + `git update-ref refs/local-review/round-N`). Showing "Round N changes" diffs against that snapshot — i.e. what changed since you triggered that round. Usually that's the agent's edits.

## Switching views

- Click the **$(diff)** icon at the top of the Review view → picker.
- Or click the `Showing: ...` header inside the tree.
- Or run `Local Review: Switch View` from the command palette.

The status bar shows the current view: `Review: 5/12 · R3 · view R3`.

## See all changes in one scrollable page

Click the **$(diff-multiple)** icon → opens a multi-diff editor. Every changed file stacked vertically in one tab, like GitHub's "Files Changed" view. Requires VS Code 1.86+.

## Why per-round snapshots are reliable

The snapshot is captured via `git stash create -u`, which creates a commit object representing the EXACT working tree at trigger time (tracked + untracked + index). Then `git update-ref refs/local-review/<id>/round-<n>` pins it so `git gc` can't reclaim it.

This means:

- Agent commits → snapshot still works.
- Agent amends, rebases, resets → snapshot still works.
- You run `git gc --prune=now` → snapshot still works (the ref keeps it alive).
- You can `git diff refs/local-review/<id>/round-3` yourself in any terminal.

When you delete the round (via "Delete Review" or "Show Round History → Delete"), the ref is dropped and normal GC reclaims the space.
