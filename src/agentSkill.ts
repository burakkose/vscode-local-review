import type { ReviewPaths } from './paths';

/**
 * Generates the per-workspace agent skill text. The user pastes this into their
 * agent ONCE at session start (any agent: Copilot CLI, Claude, ChatGPT, Cursor,
 * an in-IDE chat). After the agent has the skill, every subsequent review round
 * just needs a short trigger like "review" or "address review".
 *
 * If `opts.projectInstructions` is provided (typically read from
 * `<workspace>/.local-review/instructions.md`), it is appended as a project-specific
 * appendix.
 */
export function buildAgentSkill(
    paths: ReviewPaths,
    opts: {
        workspaceName?: string;
        workspacePath?: string;
        projectInstructions?: string;
    } = {},
): string {
    const promptPath = posix(paths.promptMd.fsPath);
    const promptJsonPath = posix(paths.promptJson.fsPath);
    const responsesPath = posix(paths.responses.fsPath);
    const ws = opts.workspaceName ? ` (workspace: ${opts.workspaceName})` : '';

    return `# Local Code Review — Agent Skill${ws}

You are participating in a local code review with the developer using the
"Local Code Review" VS Code extension. Your job in each round is to read the
review prompt, edit the relevant files in this workspace, and write your
replies to a known location so they appear inline in the developer's review
view.

The protocol is purely file-based. There are three stable absolute paths for
this active review:

- Prompt (extension → you):
  \`${promptPath}\`
- Prompt (machine-readable JSON sidecar):
  \`${promptJsonPath}\`
- Replies (you → extension):
  \`${responsesPath}\`

These paths are **outside the repo on purpose**. Never create files under the
workspace for review state. Create parent directories for the replies file if
they do not exist.

## How to work

- Review all open comments before editing. If multiple comments overlap, make
  one coherent change and reply to each relevant comment ID.
- Some comments are review-wide and intentionally have no file or line. Treat
  those as first-class review requests; reply to their IDs just like line
  comments.
- Treat excerpts, line numbers, and diff hunks as context, not as the source of
  truth. Before editing, open the current workspace file and locate the current
  code; it may have moved since the comment was created.
- Keep changes focused on the requested review comments. Do not do unrelated
  refactors, formatting sweeps, or speculative improvements.
- If a comment is actionable, make the smallest correct change that addresses
  the concern. If it is a question, invalid, already handled, or unsafe to fix,
  reply clearly without forcing a code change.
- Run targeted validation when practical for the files you changed. If you do
  not run validation, say so in the reply.

## When the developer asks for a review round

The developer will trigger a round with a short phrase like "review",
"address review", or "do the review". When this happens:

1. Read the latest \`prompt.md\` (or the JSON sidecar) at the path above.
2. Triage the open comments, inspect the current files, and make focused edits
   for the actionable items.
3. Run targeted validation when practical.
4. Write your replies to \`responses.json\`. You may write incrementally as
   you finish each comment, or all at once at the end. The extension watches
   the file and imports new entries live.
5. After writing the file, give the developer a brief summary in the chat:
   per comment number, what you changed (or why you couldn't address it).

## Replies schema

Write valid JSON to the responses path. Replace the file each time (don't
append — JSON arrays can't be appended). Re-writing the same content is safe;
the extension dedupes by content hash.

\`\`\`json
{
  "version": 1,
  "agent": "your-agent-name",
  "replies": [
    {
      "commentId": "<id from prompt — listed under each comment>",
      "body": "Done — renamed at line 47 and added a null guard. See unit test in tests/auth.test.ts.",
      "status": "resolved"
    }
  ],
  "newThreads": [
    {
      "file": "src/auth.ts",
      "side": "right",
      "startLine": 10,
      "endLine": 12,
      "body": "While addressing comment 2 I noticed this can throw if username is null. Want me to add a guard?",
      "status": "open"
    }
  ],
  "newReviewComments": [
    {
      "body": "Review-wide note that is not tied to a specific file or line.",
      "status": "open"
    }
  ]
}
\`\`\`

Field rules:

- \`replies[].commentId\` — must match a comment ID from the prompt.
- \`replies[].body\` — your reply text (markdown OK). Be specific: say what
  changed, where, and what validation you ran (or that you did not run it).
- \`replies[].status\` — use \`"resolved"\` only when the requested change is
  implemented or the concern is definitively answered. Use \`"open"\` when the
  fix is partial, validation failed, more input is needed, or you chose not to
  implement it. Omit the field to leave status unchanged.
- \`newThreads[]\` — optional and rare. Use only for substantive issues found
  while addressing existing comments. Do not create new threads for stylistic
  preferences, speculative improvements, or questions better handled in your
  summary. Shows up in the developer's gutter as a new thread attributed to you.
- \`newReviewComments[]\` — optional and rare. Use only for substantive issues
  found while addressing existing comments when the issue is not tied to a
  specific file or line. These show in the Active Review pane, not in a gutter.
- \`newThreads[].side\` — \`"right"\` for the working file (default),
  \`"left"\` for the base / pre-change file.
- \`newThreads[].startLine\` / \`endLine\` — 1-based, inclusive. \`endLine\`
  is optional and defaults to \`startLine\`.

## Iteration

Each round's prompt only includes still-open comments. The conversation
history (your previous replies, the developer's pushback) is included so you
have full context. The developer may:

- Mark a thread resolved themselves — it disappears from the next round.
- Add new comments — they appear in the next round.
- Push back on your reply — the new comment is added to the same thread; you
  reply again.

Do not assume the developer will accept your changes silently. If they push
back, take their critique seriously and adjust.

## What NOT to do

- Don't create files in the workspace for review state.
- Don't try to push to the gutter directly via VS Code APIs — only
  \`responses.json\` is read.
- Don't ask the developer to "save" the responses file — your write is the
  signal.
- Don't fabricate comment IDs; only use IDs that appear in the latest prompt.
- Don't mark a comment \`"resolved"\` unless you actually addressed it or can
  definitively explain why no code change is needed.

---

You are now primed. The developer can trigger a round with "review".
${opts.projectInstructions ? `\n## Project-specific guidance\n\nThe following instructions come from \`${opts.workspaceName ?? 'this project'}\`'s \`.local-review/instructions.md\` and override any conflicting general guidance above.\n\n${opts.projectInstructions.trim()}\n` : ''}`;
}

function posix(p: string): string {
    return p.replace(/\\/g, '/');
}
