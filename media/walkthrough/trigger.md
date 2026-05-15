# 4. Trigger a round → agent responds

Once you've added some comments, hand them off to your agent.

## Step by step

1. Press **Ctrl+Alt+Shift+R** (or **Cmd+Alt+Shift+R** on Mac).
2. The extension:
   - **Snapshots** the working tree as a pinned git ref (survives amend/rebase/GC).
   - Regenerates `prompt.md` with every open comment, conversation history, surrounding diff hunks.
   - Copies a short trigger to your clipboard, e.g. `review (round 3 at /abs/path/to/prompt.md)`.
3. **Paste the trigger into your agent.** If the agent skill is installed, that one line is enough.
4. The agent reads `prompt.md`, edits files in your workspace, writes `responses.json`.
5. As the agent writes, the extension watches — replies appear in your gutter within a second, attributed to 🤖.

## Per-round diff (inspect what the agent did)

After a round, click the **diff** icon at the top of the Review view → **Round N changes**. The file list shrinks to what changed since round N's snapshot. Click a file to see exactly that round's edits as a diff editor. Snapshots use `git stash create -u` + `git update-ref refs/local-review/round-N` so they survive `git commit --amend`, `git rebase`, `git reset`, `git gc --prune=now` — anything.

## Bidirectional

The agent can also start **new threads** to flag things proactively (`newThreads[]` in `responses.json`). They show up in your gutter as 🤖-attributed threads, separate from your own.

## Iterate

Reply to a thread in the gutter to push back. Resolve when satisfied. Trigger another round. The agent sees the full conversation history every time, so it remembers what you discussed.
