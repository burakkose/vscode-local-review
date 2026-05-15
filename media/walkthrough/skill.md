# 2. Teach your agent the protocol (one-time setup)

The extension talks to your agent over a small filesystem protocol — three stable absolute paths per review. The agent needs to learn them once.

## What to do

1. In the Review view, click the `⋮` menu → **Copy Agent Skill** (or run `Local Review: Copy Agent Skill` from the command palette).
2. A markdown document is now in your clipboard, with the actual absolute file paths for your current review baked in.
3. Open your AI agent — whatever you use:
   - GitHub Copilot CLI in a terminal (tmux, ssh, integrated, anywhere)
   - Claude desktop / claude code
   - ChatGPT / Cursor / an in-IDE chat
   - Anything else that can read and write files
4. **Paste the skill into the agent's chat** as your first message.

The agent now knows:

- Where to **read** the review prompt (absolute path to `prompt.md`).
- Where to **write** its replies (absolute path to `responses.json`).
- The JSON schema for `replies[]` and `newThreads[]`.
- That it must NEVER write review state into your workspace.

## After this

Every subsequent round needs only the word **"review"** in your agent. The trigger text the extension copies for you is e.g. `review (round 3 at /abs/path/...)`.

> If your repo has a file at `.local-review/instructions.md` (or `.local-review.md`), its contents are appended to the skill as a project-specific addendum. Good place for "always run `npm test`", "use Result not exceptions", etc.

> Need to teach a new agent later? Just run **Copy Agent Skill** again.
