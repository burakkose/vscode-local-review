import * as vscode from 'vscode';
import { CommentStore, ThreadStatus, Side, LastAgentInfo } from './store';
import { hashReply, hashNewThread, hashNewReviewThread } from './hashing';
import { normalizeRepoPath } from './pathSafety';

export interface AgentReply {
    commentId: string; // = thread id from prompt.json
    body: string;
    author?: string; // optional per-reply author
    status?: ThreadStatus; // optional status change
}

export interface AgentNewThread {
    file?: string | null;
    scope?: 'file' | 'review';
    side?: Side; // default 'right'
    startLine?: number;
    endLine?: number;
    body: string;
    author?: string;
    status?: ThreadStatus;
}

export interface AgentNewReviewComment {
    body: string;
    author?: string;
    status?: ThreadStatus;
}

export interface AgentResponseFile {
    version?: number;
    agent?: string; // default author for entries that don't specify
    agentId?: string;
    agentKind?: string;
    replies?: AgentReply[];
    newThreads?: AgentNewThread[];
    newReviewComments?: AgentNewReviewComment[];
}

export interface ImportResult {
    repliesImported: number;
    newThreadsImported: number;
    skipped: number;
    errors: string[];
    appliedThreadIds: string[];
    parseFailed: boolean; // true if the JSON itself failed to parse (likely mid-write)
    fileMissing: boolean;
    lastAgent?: LastAgentInfo;
}

const SCHEMA_VERSION = 1;

export class ResponseImporter {
    constructor(
        private readonly store: CommentStore,
        private readonly defaultAuthor: () => string,
    ) {}

    async importFromFile(uri: vscode.Uri): Promise<ImportResult> {
        const result: ImportResult = {
            repliesImported: 0,
            newThreadsImported: 0,
            skipped: 0,
            errors: [],
            appliedThreadIds: [],
            parseFailed: false,
            fileMissing: false,
        };
        let raw: Uint8Array;
        try {
            raw = await vscode.workspace.fs.readFile(uri);
        } catch (e: any) {
            if (e?.code === 'FileNotFound' || /EntryNotFound/.test(e?.name ?? '')) {
                result.fileMissing = true;
                return result;
            }
            result.errors.push(`Failed to read ${uri.fsPath}: ${e?.message ?? e}`);
            return result;
        }
        let parsed: AgentResponseFile;
        try {
            parsed = JSON.parse(new TextDecoder().decode(raw));
        } catch (e: any) {
            result.errors.push(`responses.json is not valid JSON: ${e?.message ?? e}`);
            result.parseFailed = true;
            return result;
        }
        if (parsed.version && parsed.version !== SCHEMA_VERSION) {
            result.errors.push(`responses.json version ${parsed.version} is unsupported (expected ${SCHEMA_VERSION}).`);
            return result;
        }
        const fallbackAuthor = parsed.agent || this.defaultAuthor() || 'Agent';
        const lastAgent = agentInfoFromResponse(parsed, fallbackAuthor);

        if (Array.isArray(parsed.replies)) {
            for (let i = 0; i < parsed.replies.length; i++) {
                const r = parsed.replies[i]!;
                if (typeof r?.commentId !== 'string' || typeof r?.body !== 'string' || !r.body.trim()) {
                    result.errors.push(`replies[${i}] missing commentId or body.`);
                    continue;
                }
                if (!this.store.findThread(r.commentId)) {
                    result.errors.push(
                        `replies[${i}]: commentId '${r.commentId}' not found in current review (perhaps deleted, or this responses.json is stale).`,
                    );
                    continue;
                }
                const status = r.status === 'resolved' || r.status === 'open' ? r.status : undefined;
                const author = (r.author && r.author.trim()) || fallbackAuthor;
                const hash = hashReply(r.commentId, author, r.body, status);
                try {
                    const created = await this.store.addAgentReply(r.commentId, r.body, author, hash, status);
                    if (created) {
                        result.repliesImported++;
                        if (!result.appliedThreadIds.includes(r.commentId)) result.appliedThreadIds.push(r.commentId);
                    } else {
                        result.skipped++;
                    }
                } catch (e: any) {
                    result.errors.push(`replies[${i}]: failed to import: ${e?.message ?? e}`);
                }
            }
        }

        if (Array.isArray(parsed.newThreads)) {
            for (let i = 0; i < parsed.newThreads.length; i++) {
                const n = parsed.newThreads[i]!;
                if (n?.scope === 'review' || n?.file === null) {
                    await this.importReviewComment(n, fallbackAuthor, result, `newThreads[${i}]`);
                    continue;
                }
                if (
                    typeof n?.file !== 'string' ||
                    typeof n?.startLine !== 'number' ||
                    typeof n?.body !== 'string' ||
                    !n.body.trim()
                ) {
                    result.errors.push(`newThreads[${i}] missing file, startLine, or body.`);
                    continue;
                }
                const file = normalizeRepoPath(n.file);
                if (!file) {
                    result.errors.push(`newThreads[${i}] has an unsafe file path.`);
                    continue;
                }
                const side: Side = n.side === 'left' ? 'left' : 'right';
                const start = Math.max(1, Math.floor(n.startLine));
                const end = Math.max(start, n.endLine ? Math.floor(n.endLine) : start);
                const status = n.status === 'resolved' ? 'resolved' : 'open';
                const author = (n.author && n.author.trim()) || fallbackAuthor;
                const hash = hashNewThread(file, side, start, end, author, n.body);
                try {
                    const created = await this.store.addAgentThread(
                        { file, startLine: start, endLine: end, side, excerpt: '' },
                        n.body,
                        author,
                        hash,
                        status,
                    );
                    if (created) {
                        result.newThreadsImported++;
                        if (!result.appliedThreadIds.includes(created.id)) result.appliedThreadIds.push(created.id);
                    } else {
                        result.skipped++;
                    }
                } catch (e: any) {
                    result.errors.push(`newThreads[${i}]: failed to import: ${e?.message ?? e}`);
                }
            }
        }
        if (Array.isArray(parsed.newReviewComments)) {
            for (let i = 0; i < parsed.newReviewComments.length; i++) {
                await this.importReviewComment(
                    parsed.newReviewComments[i],
                    fallbackAuthor,
                    result,
                    `newReviewComments[${i}]`,
                );
            }
        }
        if (result.repliesImported > 0 || result.newThreadsImported > 0) {
            try {
                await this.store.attributeImportToCurrentRound(result.repliesImported, result.newThreadsImported);
            } catch {
                /* ignore */
            }
        }
        const setLastAgent = (this.store as unknown as { setLastAgent?: (agent: LastAgentInfo) => Promise<void> })
            .setLastAgent;
        if (lastAgent && setLastAgent) {
            try {
                await setLastAgent.call(this.store, lastAgent);
                result.lastAgent = lastAgent;
            } catch (e: any) {
                result.errors.push(`failed to record last agent: ${e?.message ?? e}`);
            }
        }
        return result;
    }

    private async importReviewComment(
        n: AgentNewReviewComment | AgentNewThread | undefined,
        fallbackAuthor: string,
        result: ImportResult,
        label: string,
    ): Promise<void> {
        if (typeof n?.body !== 'string' || !n.body.trim()) {
            result.errors.push(`${label} missing body.`);
            return;
        }
        const status = n.status === 'resolved' ? 'resolved' : 'open';
        const author = (n.author && n.author.trim()) || fallbackAuthor;
        const hash = hashNewReviewThread(author, n.body);
        try {
            const created = await this.store.addAgentThread({ scope: 'review' }, n.body, author, hash, status);
            if (created) {
                result.newThreadsImported++;
                if (!result.appliedThreadIds.includes(created.id)) result.appliedThreadIds.push(created.id);
            } else {
                result.skipped++;
            }
        } catch (e: any) {
            result.errors.push(`${label}: failed to import: ${e?.message ?? e}`);
        }
    }
}

function agentInfoFromResponse(parsed: AgentResponseFile, fallbackAuthor: string): LastAgentInfo | undefined {
    if (
        !(typeof parsed.agent === 'string' && parsed.agent.trim()) &&
        !(typeof parsed.agentId === 'string' && parsed.agentId.trim()) &&
        !(typeof parsed.agentKind === 'string' && parsed.agentKind.trim())
    )
        return undefined;
    const name = (typeof parsed.agent === 'string' && parsed.agent.trim()) || fallbackAuthor.trim();
    if (!name) return undefined;
    return {
        name,
        id: typeof parsed.agentId === 'string' && parsed.agentId.trim() ? parsed.agentId.trim() : undefined,
        kind: typeof parsed.agentKind === 'string' && parsed.agentKind.trim() ? parsed.agentKind.trim() : undefined,
        lastSeenAt: new Date().toISOString(),
    };
}

export { hashReply, hashNewThread, hashNewReviewThread } from './hashing';
