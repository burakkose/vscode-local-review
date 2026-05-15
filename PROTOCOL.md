# Local Code Review Protocol — v1

A small filesystem protocol for bidirectional code review collaboration between a VS Code extension (the **host**) and any AI agent (the **agent**).

## Goals

- **Agent-agnostic.** The agent can be Copilot CLI, Claude, ChatGPT, Cursor, an in-IDE chat, anything that can read/write files. The protocol does not assume a specific agent host or transport.
- **Terminal-agnostic.** The agent may run in VS Code's integrated terminal, tmux, ssh, external terminal, anywhere. The host does not push input into the agent's terminal.
- **Bidirectional.** Both sides can comment, reply, change status, and the other side observes the change.
- **No workspace pollution.** Nothing the protocol exchanges lives in the user's repo.
- **Crash-safe.** Either side can crash mid-write without corrupting the other side's view.

## Files

Per workspace, the host exposes a stable directory (typically under VS Code's per-extension global storage, hashed by workspace folder URI). Three protocol files live there; the host also writes `SKILL.md` for convenience.

```
<protocol-root>/
  prompt.md         — host writes; agent reads
  prompt.json       — host writes; machine-readable sidecar
  responses.json    — agent writes; host watches
  SKILL.md          — host generates; user pastes into agent (one-time)
```

The host advertises `<protocol-root>/responses.json` as the canonical reply path inside `prompt.md` so the agent never has to compute the path itself.

## `prompt.md`

Markdown. Refreshed by the host on each round trigger. Contains:

1. **Header** — workspace name and absolute path; base ref + base SHA; HEAD SHA; review start time; last refresh time.
2. **Instructions** (optional) — author-supplied per-project guidance.
3. **Open comments** — one section per still-open comment, in stable order. Each section includes:
   - **Comment ID** — the stable UUID the agent must use when replying.
   - **File path + line range** — workspace-relative POSIX, 1-based inclusive.
   - **Side** — `right` (current/new file) or `left` (base file).
   - **Code excerpt** — captured at comment creation time (not regenerated).
   - **Diff hunk(s)** — surrounding context derived from `git diff baseSha -- file`, when available.
   - **Conversation** — `[user]` and `[you]` (agent) messages in chronological order.
4. **Resolved comments** (context only).
5. **Reply protocol reminder** — if the host knows the agent has been primed with `SKILL.md`, this is a one-line pointer; otherwise a fully self-contained instruction with schema and rules.

## `prompt.json`

Same data as `prompt.md` in machine-readable form. Always written when `includeJsonSidecar` is on. Stable schema:

```json
{
  "version": 1,
  "workspace": "myproject",
  "workspacePath": "/abs/path",
  "baseRef": "origin/main",
  "baseSha": "0123abcd…",
  "headSha": "fedc4321…",
  "startedAt": "2026-…",
  "lastRefreshedAt": "2026-…",
  "responsesPath": "/abs/path/to/responses.json",
  "instructions": null,
  "comments": [
    {
      "id": "uuid",
      "number": 1,
      "file": "src/foo.ts",
      "oldFile": null,
      "side": "right",
      "startLine": 42,
      "endLine": 50,
      "status": "open",
      "origin": "user",
      "excerpt": "…",
      "diffHunks": [{ "oldStart": 38, "oldLines": 7, "newStart": 38, "newLines": 9, "body": "@@…@@\n-…\n+…" }],
      "messages": [
        { "author": "You", "origin": "user", "body": "rename to fooBar", "createdAt": "2026-…" }
      ]
    }
  ],
  "resolvedComments": []
}
```

`origin` is `"user"` for human-authored, `"agent"` for agent-authored.

## `responses.json`

Written by the agent. Watched by the host. Replaced as a whole each time (do not attempt to append; JSON arrays cannot be appended). Re-writing the same content is safe — the host dedupes by content hash.

```json
{
  "version": 1,
  "agent": "Copilot CLI",
  "replies": [
    {
      "commentId": "<id from prompt>",
      "body": "Done — renamed at line 47, added null guard. See tests/auth.test.ts.",
      "status": "resolved"
    }
  ],
  "newThreads": [
    {
      "file": "src/auth.ts",
      "side": "right",
      "startLine": 10,
      "endLine": 12,
      "body": "While addressing comment 2 I noticed this can throw if username is null. Want me to guard?",
      "status": "open"
    }
  ]
}
```

### `replies[]` rules

- `commentId` (required) — must match a comment ID from the latest `prompt.md` / `prompt.json`. Comments not currently in the prompt (resolved, deleted, missing) are skipped with an error.
- `body` (required) — markdown is OK. Be specific (line numbers, file paths, what changed).
- `status` (optional) — `"resolved"` flips the thread to resolved; `"open"` flips to open; omit to leave unchanged.
- `author` (optional) — overrides the per-file `agent` field for this entry.

### `newThreads[]` rules

- The agent can proactively start new threads (anchored to a file/line range). Shown in the host UI as agent-authored threads, distinguishable from user threads.
- `file` (required) — workspace-relative POSIX path.
- `side` (optional, default `"right"`) — `"right"` is the working file, `"left"` is the base file at `baseSha`.
- `startLine` (required, 1-based), `endLine` (optional, default `startLine`).
- `body` (required), `status` (optional, default `"open"`), `author` (optional).

## Dedup model

Each entry the agent writes is hashed by the host:

- Replies: `sha1("reply\0" + commentId + "\0" + author + "\0" + body + "\0" + status)`
- New threads: `sha1("thread\0" + file + "\0" + side + "\0" + startLine + "-" + endLine + "\0" + author + "\0" + body)`

Hashes already imported are kept in the host's persistent state. The agent can rewrite the file freely (incrementally as it finishes each comment, or as one final write) without producing duplicate entries.

## Round semantics

- A "round" is one host-initiated request for the agent to address comments.
- Each round, the host regenerates `prompt.md` / `prompt.json` to include only **still-open** comments (resolved / deleted ones are dropped from the active list and only mentioned in the "Resolved" appendix).
- The full conversation history (user comments + previous agent replies) is preserved in each thread, so the agent always has context for push-back.
- The host signals "new round available" by overwriting `prompt.md`. Triggers (clipboard text, terminal injection, etc.) are convenience layers — the file mtime is the source of truth.

## Concurrency

The two sides own different files; conflicts are impossible. Within each side:

- The host writes its own `review.json` state atomically (write `.tmp` → rename).
- The host updates `prompt.md` / `prompt.json` with regular writes; partial reads are tolerated by the agent (it reads the file fully before parsing; mtime-based watchers debounce to coalesce events).
- The agent writes `responses.json` as a complete file each time. The host watcher debounces and retries on transient parse failures (so the agent doesn't need atomic-write tooling).

If two host instances (e.g. two VS Code windows on the same workspace) run simultaneously, they share `review.json`. The host's self-watcher reloads on external change, but simultaneous mutations are last-writer-wins for the same comment.

## Versioning

The `version` field is `1` for the schema described here. Future schema changes will bump the integer; older hosts that can't speak the newer schema will refuse the file with an error rather than silently misinterpret it.

## Non-goals

- The protocol does not specify how the agent is invoked. The host may copy a trigger to the clipboard, type into a VS Code terminal, or write a marker file for an external watcher — these are local UX choices.
- The protocol does not include diffs of the agent's edits; observe them through normal git tooling.
- The protocol does not transport the workspace itself. Both sides assume the same workspace on the same machine.
