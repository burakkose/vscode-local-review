# 1. Start a new review

A **review** in this extension is a saved object — it lives in a central catalog on this machine, **not in your repo**. You can have many reviews, switch between them, even across different git folders, all from one VS Code window.

## Step by step

1. Click the **Local Review** icon in the activity bar (left edge of VS Code — the speech-bubble icon).
2. Click **Start New Review** in the welcome panel (or click the `+` in the Review view title bar).
3. Pick a git folder:
   - Workspace folders are listed first.
   - **Browse for a folder…** lets you pick any git repo on disk (doesn't have to be open in this VS Code window).
4. Pick a base ref. The extension auto-detects `upstream`, `origin/main`, `origin/master`, `main`, `master`, etc. Or pick **Enter custom ref…** for something like `HEAD~3` or `v1.2.3`.
5. Give the review a name. Default is `<repo-name> — <baseRef>`.

That's it. The Review view now shows:

- Your active review at the top (click to switch).
- All changed files (vs `merge-base(base, HEAD)` — PR-style).
- Per-file open / resolved comment counts.

Click any file to open its diff. Nothing is auto-opened; you navigate at your own pace.

> The diff is computed against `git merge-base <base> HEAD`, so upstream commits that don't belong to your work won't pollute the review.
