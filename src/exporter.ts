import { isFileThread, type CommentStore, type FileReviewThread, type ReviewThread } from './store';
import type { DiffHunk } from './git';

export interface PromptContext {
    workspaceName?: string;
    workspaceFsPath?: string;
    headerOverride?: string;
    /** Per-file diff hunks keyed by repo-relative POSIX path. */
    hunks?: Map<string, DiffHunk[]>;
    /** Absolute filesystem path the agent should write its replies to. */
    responsesPath?: string;
    /** Whether the agent has been primed with the SKILL document. Affects how much protocol detail to inline. */
    skillPrimed?: boolean;
    /** Current round number (latest started). */
    roundNumber?: number;
}

/** Builds the markdown prompt that gets fed to the AI agent. */
export function buildPrompt(store: CommentStore, ctx: PromptContext = {}): string {
    const state = store.getState();
    const lines: string[] = [];
    lines.push('# Code Review Feedback');
    lines.push('');
    if (ctx.roundNumber !== undefined) lines.push(`- Round: **${ctx.roundNumber}**`);
    if (ctx.workspaceName) lines.push(`- Workspace: \`${ctx.workspaceName}\``);
    if (ctx.workspaceFsPath) lines.push(`- Workspace path: \`${ctx.workspaceFsPath}\``);
    if (state.baseRef) {
        lines.push(`- Base ref: \`${state.baseRef}\` (sha \`${shortSha(state.baseSha)}\`)`);
    }
    if (state.headSha) {
        lines.push(`- HEAD when reviewed: \`${shortSha(state.headSha)}\` (plus uncommitted changes)`);
    }
    if (state.startedAt) lines.push(`- Review started: ${state.startedAt}`);
    if (state.lastRefreshedAt && state.lastRefreshedAt !== state.startedAt) {
        lines.push(`- Last refreshed:  ${state.lastRefreshedAt}`);
    }
    lines.push('');
    if (ctx.headerOverride && ctx.headerOverride.trim()) {
        lines.push('## Instructions');
        lines.push('');
        lines.push(ctx.headerOverride.trim());
        lines.push('');
    }
    const open = state.threads.filter(t => t.status === 'open');
    const resolved = state.threads.filter(t => t.status === 'resolved');
    if (open.length === 0 && resolved.length === 0) {
        lines.push('_No comments._');
        return lines.join('\n');
    }
    if (open.length === 0) {
        lines.push('_All comments are marked resolved; nothing to address._');
        return lines.join('\n');
    }
    appendAgentTask(lines);

    let n = 1;
    for (const t of open) {
        lines.push('---');
        lines.push('');
        const originTag = t.origin === 'agent' ? ' [thread originally created by you]' : '';
        if (isFileThread(t)) {
            const range = t.startLine === t.endLine ? `${t.startLine}` : `${t.startLine}-${t.endLine}`;
            const sideTag = t.side === 'left' ? ' (commenting on the base side)' : '';
            const renameTag = t.oldFile && t.oldFile !== t.file ? ` (was \`${t.oldFile}\`)` : '';
            lines.push(`## Comment ${n} — \`${t.file}:${range}\`${renameTag}${sideTag}${originTag}`);
        } else {
            lines.push(`## Comment ${n} — Review-wide${originTag}`);
        }
        lines.push('');
        lines.push(`Comment ID (use this in your reply): \`${t.id}\``);
        lines.push('');

        if (isFileThread(t) && t.excerpt && t.excerpt.trim().length > 0) {
            lines.push('Code at the time of review:');
            lines.push('');
            const lang = guessLang(t.file);
            const fence = pickFence(t.excerpt);
            lines.push(`${fence}${lang}`);
            lines.push(t.excerpt);
            lines.push(fence);
            lines.push('');
        }

        const relevant = isFileThread(t) ? hunksOverlapping(ctx.hunks?.get(t.file) ?? [], t) : [];
        if (relevant.length > 0) {
            lines.push('Relevant diff hunk(s):');
            lines.push('');
            for (const h of relevant) {
                const fence = pickFence(h.body);
                lines.push(`${fence}diff`);
                lines.push(h.body);
                lines.push(fence);
                lines.push('');
            }
        }

        lines.push('Conversation:');
        lines.push('');
        for (const c of t.comments) {
            const tag = c.origin === 'agent' ? '[you]' : '[user]';
            lines.push(`**${escapeAuthor(c.author)} ${tag}:**`);
            lines.push('');
            lines.push(formatBody(c.body));
            lines.push('');
        }
        n++;
    }

    if (resolved.length > 0) {
        lines.push('---');
        lines.push('');
        lines.push('## Resolved comments (for context only — do not act on these)');
        lines.push('');
        for (const t of resolved) {
            if (isFileThread(t)) {
                const range = t.startLine === t.endLine ? `${t.startLine}` : `${t.startLine}-${t.endLine}`;
                lines.push(`- \`${t.file}:${range}\` — ${truncate(t.comments[0]?.body ?? '', 120)}`);
            } else {
                lines.push(`- Review-wide — ${truncate(t.comments[0]?.body ?? '', 120)}`);
            }
        }
    }

    appendProtocolReminder(lines, ctx, open);
    return lines.join('\n');
}

function appendProtocolReminder(lines: string[], ctx: PromptContext, open: ReviewThread[]) {
    if (open.length === 0) return;
    const responses = ctx.responsesPath ? posix(ctx.responsesPath) : '<absolute path injected by extension>';
    lines.push('');
    lines.push('---');
    lines.push('');
    if (ctx.skillPrimed) {
        // Short reminder when the agent already has the SKILL.
        lines.push('## Action and reply');
        lines.push('');
        lines.push('- Inspect the current workspace files before editing; line numbers and excerpts may be stale.');
        lines.push('- Make focused changes for actionable comments, then run targeted validation when practical.');
        lines.push(
            '- Reply to every addressed or intentionally-open comment ID. Use `resolved` only when the concern is fixed or definitively answered.',
        );
        lines.push(
            `Write your replies to \`${responses}\` per the schema in your local-review skill. Comment IDs are listed in each section above.`,
        );
        lines.push('Use `newReviewComments[]` only for rare review-wide findings that are not tied to a file/line.');
        return;
    }
    lines.push("## How to reply (so your replies show up in the user's review view)");
    lines.push('');
    lines.push(`Write a JSON file to this absolute path on the user's machine:`);
    lines.push('');
    lines.push('```');
    lines.push(responses);
    lines.push('```');
    lines.push('');
    lines.push('Schema:');
    lines.push('');
    lines.push('```json');
    lines.push(
        JSON.stringify(
            {
                version: 1,
                agent: 'your-agent-name',
                replies: [
                    {
                        commentId: '<id from a comment above>',
                        body: 'Done — renamed at line 47, added null guard.',
                        status: 'resolved',
                    },
                ],
                newThreads: [
                    {
                        file: 'src/auth.ts',
                        side: 'right',
                        startLine: 10,
                        endLine: 12,
                        body: 'I noticed this can throw if username is null. Want me to add a guard?',
                        status: 'open',
                    },
                ],
                newReviewComments: [
                    {
                        body: 'Review-wide note that is not tied to a specific file or line.',
                        status: 'open',
                    },
                ],
            },
            null,
            2,
        ),
    );
    lines.push('```');
    lines.push('');
    lines.push('Rules:');
    lines.push(
        '- `replies[]`: address an existing comment. Use `status: "resolved"` only when the requested concern is fixed or definitively answered; use `"open"` for partial fixes, blockers, failed validation, or needed input; omit to leave unchanged.',
    );
    lines.push(
        "- `newThreads[]`: optional and rare; use only for substantive issues found while addressing existing comments. It shows up as a new thread in the user's gutter, attributed to you.",
    );
    lines.push(
        '- `newReviewComments[]`: optional and rare; use only for substantive issues found while addressing existing comments when the issue is not tied to a specific file or line.',
    );
    lines.push('- `side` is `"right"` (your edits / current file) or `"left"` (the base file). Lines are 1-based.');
    lines.push(
        '- The replies file is **outside the repo on purpose** — never write review state inside the workspace. Create parent directories if needed.',
    );
    lines.push('- Replies and threads are deduped by content hash, so re-writing the same content is safe.');
    lines.push(
        "- The user's extension watches this file and imports new entries live; you can write incrementally as you finish each comment.",
    );
}

function appendAgentTask(lines: string[]) {
    lines.push('## Agent task');
    lines.push('');
    lines.push(
        '- Review all open comments before editing. If comments overlap, make one coherent change and reply to each relevant comment ID.',
    );
    lines.push(
        '- Use excerpts, line numbers, and diff hunks as context only. Open the current workspace files and locate the current code before changing it.',
    );
    lines.push(
        '- Keep changes focused on the review comments; avoid unrelated refactors, formatting sweeps, or speculative improvements.',
    );
    lines.push(
        '- If a comment is a question, invalid, already handled, or unsafe to fix, explain that in the reply and leave it open unless it is definitively answered.',
    );
    lines.push(
        '- Run targeted validation when practical for files you changed, and mention the validation result or that it was not run.',
    );
    lines.push('');
}

/** A machine-readable sidecar describing the same review. */
export function buildJsonSidecar(store: CommentStore, ctx: PromptContext = {}): string {
    const s = store.getState();
    const open = s.threads.filter(t => t.status === 'open');
    const resolved = s.threads.filter(t => t.status === 'resolved');
    const out = {
        version: 1 as const,
        workspace: ctx.workspaceName,
        workspacePath: ctx.workspaceFsPath,
        baseRef: s.baseRef,
        baseSha: s.baseSha,
        headSha: s.headSha,
        startedAt: s.startedAt,
        lastRefreshedAt: s.lastRefreshedAt,
        responsesPath: ctx.responsesPath,
        instructions: ctx.headerOverride,
        comments: open.map((t, i) => threadJson(t, i + 1, ctx)),
        resolvedComments: resolved.map((t, i) => threadJson(t, i + 1, ctx)),
    };
    return JSON.stringify(out, null, 2);
}

function threadJson(t: ReviewThread, n: number, ctx: PromptContext) {
    if (!isFileThread(t)) {
        return {
            id: t.id,
            number: n,
            scope: 'review' as const,
            file: null,
            oldFile: null,
            side: null,
            startLine: null,
            endLine: null,
            status: t.status,
            origin: t.origin,
            excerpt: t.excerpt ?? '',
            diffHunks: [],
            messages: t.comments.map(c => ({
                author: c.author,
                origin: c.origin,
                body: c.body,
                createdAt: c.createdAt,
            })),
        };
    }
    return {
        id: t.id,
        number: n,
        scope: 'file' as const,
        file: t.file,
        oldFile: t.oldFile ?? null,
        side: t.side,
        startLine: t.startLine,
        endLine: t.endLine,
        status: t.status,
        origin: t.origin,
        excerpt: t.excerpt,
        diffHunks: (ctx.hunks?.get(t.file) ?? []).filter(h => hunkOverlapsThread(h, t)),
        messages: t.comments.map(c => ({
            author: c.author,
            origin: c.origin,
            body: c.body,
            createdAt: c.createdAt,
        })),
    };
}

function hunkOverlapsThread(h: DiffHunk, t: ReviewThread): boolean {
    if (!isFileThread(t) && !isLineLikeThread(t)) return false;
    return hunkOverlapsFileThread(h, t);
}

function hunkOverlapsFileThread(
    h: DiffHunk,
    t: FileReviewThread | (ReviewThread & { startLine: number; endLine: number; side?: string }),
): boolean {
    const start = t.side === 'left' ? h.oldStart : h.newStart;
    const lines = t.side === 'left' ? h.oldLines : h.newLines;
    const end = start + Math.max(0, lines - 1);
    return !(t.endLine < start || t.startLine > end);
}

function hunksOverlapping(hunks: DiffHunk[], t: FileReviewThread): DiffHunk[] {
    return hunks.filter(h => hunkOverlapsFileThread(h, t));
}

function isLineLikeThread(t: ReviewThread): t is ReviewThread & { startLine: number; endLine: number; side?: string } {
    return typeof (t as any).startLine === 'number' && typeof (t as any).endLine === 'number';
}

function pickFence(content: string): string {
    let max = 2;
    const re = /`+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        if (m[0].length > max) max = m[0].length;
    }
    return '`'.repeat(Math.max(3, max + 1));
}

function formatBody(body: string): string {
    const trimmed = body.replace(/\r\n/g, '\n').replace(/\s+$/, '');
    if (!trimmed) return '_(empty)_';
    if (!trimmed.includes('\n')) return trimmed;
    return trimmed
        .split('\n')
        .map(l => '> ' + l)
        .join('\n');
}

function escapeAuthor(name: string): string {
    return name.replace(/[*_`]/g, '\\$&');
}

function truncate(s: string, max: number): string {
    const oneLine = s.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

function shortSha(sha?: string): string {
    if (!sha) return '?';
    return sha.length > 12 ? sha.slice(0, 12) : sha;
}

function posix(p: string): string {
    return p.replace(/\\/g, '/');
}

const LANG_BY_EXT: Record<string, string> = {
    ts: 'ts',
    tsx: 'tsx',
    js: 'js',
    jsx: 'jsx',
    mjs: 'js',
    cjs: 'js',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    cs: 'csharp',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    c: 'c',
    h: 'cpp',
    hpp: 'cpp',
    md: 'md',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    sh: 'bash',
    bash: 'bash',
    ps1: 'powershell',
    rb: 'ruby',
    php: 'php',
    kt: 'kotlin',
    swift: 'swift',
    scala: 'scala',
    sql: 'sql',
    html: 'html',
    css: 'css',
    scss: 'scss',
    toml: 'toml',
    xml: 'xml',
};

function guessLang(file: string): string {
    const dot = file.lastIndexOf('.');
    if (dot < 0) return '';
    const ext = file.slice(dot + 1).toLowerCase();
    return LANG_BY_EXT[ext] ?? '';
}

export const __testing = { guessLang, escapeAuthor, truncate, pickFence, formatBody, hunkOverlapsThread };
