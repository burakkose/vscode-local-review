# vscode-local-review

A small VS Code extension for reviewing local code changes before you push them.

It gives you a PR-style review loop inside VS Code: start a local review, leave comments on changed files, hand the review notes to an AI agent, then import the agent's replies back into the editor.

## What it does

- Shows local git changes in a review view.
- Lets you add line comments and review-wide comments.
- Exports review notes for an AI agent.
- Imports agent replies and new findings.
- Keeps review state outside your repo, in VS Code extension storage.
- Supports multiple local review sessions.

## Basic workflow

1. Run **Local Review: New Review**.
2. Pick the repo folder and base ref.
3. Add comments from the gutter, selection, or **Active Review** view.
4. Run **Local Review: Copy Agent Skill** once and paste it into your agent.
5. Run **Local Review: Trigger Review Round**.
6. Let the agent make changes and write replies.
7. Review the imported replies in VS Code.

The extension uses a simple file-based handoff. It writes `prompt.md` and `prompt.json`; the agent writes `responses.json`. See [PROTOCOL.md](./PROTOCOL.md) if you want the exact file format.

## Main commands

| Command | Default key | What it does |
| --- | --- | --- |
| **Local Review: New Review** | - | Starts a review for a folder and base ref. |
| **Local Review: Switch Review** | - | Opens another saved local review. |
| **Local Review: Add Comment on Current Line or Selection** | `Ctrl+Alt+R` | Adds a file comment. |
| **Local Review: Add Review-Wide Comment** | - | Adds a comment for the whole review. |
| **Local Review: Trigger Review Round** | `Ctrl+Alt+Shift+R` | Refreshes the prompt and hands it to the agent. |
| **Local Review: Copy Agent Skill** | - | Copies the one-time instructions for the agent. |
| **Local Review: Import Agent Replies Now** | - | Re-imports `responses.json` manually. |
| **Local Review: Show All Changes in One Pane** | - | Opens one combined diff view. |

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `localReview.handoffMode` | `clipboard` | Use `clipboard`, `vscode-terminal`, or `none`. |
| `localReview.defaultBaseRef` | `""` | Optional default base ref. |
| `localReview.useMergeBase` | `true` | Diff against `merge-base(base, HEAD)` when possible. |
| `localReview.includeUntracked` | `true` | Include untracked files. |
| `localReview.autoImportResponses` | `true` | Watch and import agent replies automatically. |
| `localReview.author` | `"You"` | Display name for your comments. |
| `localReview.agentAuthor` | `"Agent"` | Display name for imported replies. |
| `localReview.promptHeader` | `""` | Extra text added to generated prompts. |

## Install from source

```sh
git clone https://github.com/burakkose/vscode-local-review.git
cd vscode-local-review
npm install
npm run package
code --install-extension ./vscode-local-review-0.1.0.vsix --force
```

Reload VS Code after installing. You should see a **Local Review** activity-bar icon with **Reviews** and **Active Review** views.

## Development

```sh
npm install
npm run compile
```

Open the repo in VS Code and press `F5` to launch an Extension Development Host.

Useful checks:

```sh
npm run format:check
npm run lint
npm test
```

## License

MIT
