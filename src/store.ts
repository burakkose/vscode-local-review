import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { normalizeRepoPath } from './pathSafety';

export type ThreadStatus = 'open' | 'resolved';
export type Side = 'left' | 'right';
export type Origin = 'user' | 'agent';
export type ThreadScope = 'file' | 'review';

export interface LastAgentInfo {
    name: string;
    id?: string;
    kind?: string;
    lastSeenAt: string;
}

export interface ReviewComment {
    id: string;
    threadId: string;
    body: string;
    author: string;
    origin: Origin;
    createdAt: string;
}

interface BaseReviewThread {
    id: string;
    scope: ThreadScope;
    status: ThreadStatus;
    comments: ReviewComment[];
    origin: Origin; // who created the thread initially
    createdAt: string;
}

export interface FileReviewThread extends BaseReviewThread {
    scope: 'file';
    file: string; // workspace-relative POSIX (current path for renames)
    oldFile?: string; // base-side path if different (renamed/copied)
    startLine: number; // 1-based, inclusive (line in the side's file)
    endLine: number; // 1-based, inclusive
    /** 0-based character offset within startLine (optional; precise word-level anchor). */
    startChar?: number;
    /** 0-based character offset within endLine (exclusive at the end). */
    endChar?: number;
    /** Immutable tree-ish whose line numbers the anchor fields refer to. */
    anchorSha?: string;
    /** File path at anchorSha. Defaults to file for older state. */
    anchorFile?: string;
    /** 1-based line range at anchorSha, used to remap after agent edits. */
    anchorStartLine?: number;
    anchorEndLine?: number;
    side: Side;
    excerpt: string; // captured at thread creation time
    /** Captured selected text when comment anchors to a sub-line range. */
    excerptSelection?: string;
}

export interface ReviewWideThread extends BaseReviewThread {
    scope: 'review';
    excerpt?: string;
}

export type ReviewThread = FileReviewThread | ReviewWideThread;
export type FileThreadInput = Omit<
    FileReviewThread,
    'id' | 'comments' | 'createdAt' | 'status' | 'origin' | 'scope'
> & {
    scope?: 'file';
};
export type ReviewWideThreadInput = Pick<ReviewWideThread, 'scope' | 'excerpt'>;

export interface ReviewState {
    folderUri?: string;
    baseRef?: string;
    baseSha?: string;
    headSha?: string;
    startedAt?: string;
    lastRefreshedAt?: string;
    threads: ReviewThread[];
    /** Hashes of imported agent payloads (replies + new threads) for dedupe. */
    importedHashes?: string[];
    /** Per-round metadata (latest is current). */
    rounds?: RoundInfo[];
    /** Most recent agent identity seen in a valid responses.json import. */
    lastAgent?: LastAgentInfo;
}

export interface RoundInfo {
    n: number;
    triggeredAt: string;
    openCountAtTrigger: number;
    baseShaAtTrigger?: string;
    headShaAtTrigger?: string;
    /** SHA of a pinned working-tree snapshot (git stash create -u), survives amend/rebase/reset/GC. */
    snapshotSha?: string;
    /** Git ref name pinning the snapshot (e.g. refs/local-review/round-3). */
    snapshotRef?: string;
    repliesReceived: number;
    newThreadsReceived: number;
}

function emptyState(): ReviewState {
    return { threads: [] };
}

export function isFileThread(t: ReviewThread): t is FileReviewThread {
    return t.scope === 'file' || (t.scope !== 'review' && typeof (t as { file?: unknown }).file === 'string');
}

export function isReviewWideThread(t: ReviewThread): t is ReviewWideThread {
    return t.scope === 'review';
}

export type StoreEvent =
    | { kind: 'changed'; reason: 'local' | 'external' | 'load' }
    | { kind: 'persistFailed'; error: Error };

/**
 * Persistent JSON-backed store of review state.
 *
 * Concurrency model:
 *  - Within a single VS Code window, all in-memory mutations are sync (no
 *    awaits between mutate and persist call) and writes are serialized through
 *    `writeChain`.
 *  - The on-disk file is updated *atomically* (write .tmp + rename) so external
 *    readers never observe a torn JSON.
 *  - A self-watcher detects external mutations (e.g. another VS Code window on
 *    the same workspace) and reloads. Self-induced events are filtered by
 *    comparing a content hash with `lastWrittenHash`.
 */
export class CommentStore implements vscode.Disposable {
    private state: ReviewState = emptyState();
    private readonly storageUri: vscode.Uri;
    private readonly backupUri: vscode.Uri;
    private readonly _onDidChange = new vscode.EventEmitter<StoreEvent>();
    readonly onDidChange = this._onDidChange.event;
    private writeChain: Promise<void> = Promise.resolve();
    private corruptOnLoad = false;
    private lastWrittenHash?: string;
    private watcherDisposable?: vscode.Disposable;
    private lastLoadInfo: { existed: boolean; size?: number; error?: string; loadedAt: string } = {
        existed: false,
        loadedAt: '',
    };

    /**
     * Constructor accepts either a pre-resolved per-review path bundle (new style,
     * used with the catalog) or a VS Code ExtensionContext (legacy compatibility).
     */
    constructor(arg: { state: vscode.Uri; stateBak: vscode.Uri } | vscode.ExtensionContext) {
        if ('state' in arg && 'stateBak' in arg) {
            this.storageUri = arg.state;
            this.backupUri = arg.stateBak;
        } else {
            const base =
                (arg as vscode.ExtensionContext).storageUri ?? (arg as vscode.ExtensionContext).globalStorageUri;
            this.storageUri = vscode.Uri.joinPath(base, 'review.json');
            this.backupUri = vscode.Uri.joinPath(base, 'review.json.bak');
        }
    }

    getStorageUri(): vscode.Uri {
        return this.storageUri;
    }
    getBackupUri(): vscode.Uri {
        return this.backupUri;
    }
    getLastLoadInfo() {
        return this.lastLoadInfo;
    }

    dispose(): void {
        this.watcherDisposable?.dispose();
        this._onDidChange.dispose();
    }

    /** Load state from disk. Distinguishes "no file yet" from "file is corrupt". */
    async load(): Promise<{ corrupt: boolean; existed: boolean; size?: number }> {
        this.corruptOnLoad = false;
        let buf: Uint8Array | undefined;
        try {
            buf = await vscode.workspace.fs.readFile(this.storageUri);
        } catch (e: any) {
            if (isNotFoundError(e)) {
                this.state = emptyState();
                this.lastLoadInfo = { existed: false, loadedAt: new Date().toISOString() };
                this._onDidChange.fire({ kind: 'changed', reason: 'load' });
                return { corrupt: false, existed: false };
            }
            this.corruptOnLoad = true;
            console.error('[localReview] failed to read store', e);
            this.state = emptyState();
            this.lastLoadInfo = { existed: true, error: String(e?.message ?? e), loadedAt: new Date().toISOString() };
            this._onDidChange.fire({ kind: 'changed', reason: 'load' });
            return { corrupt: true, existed: true };
        }
        try {
            const parsed = JSON.parse(new TextDecoder().decode(buf)) as Partial<ReviewState>;
            this.state = normalizeState(parsed);
            this.lastLoadInfo = { existed: true, size: buf.length, loadedAt: new Date().toISOString() };
        } catch (e) {
            console.error('[localReview] store JSON is corrupt', e);
            this.corruptOnLoad = true;
            this.state = emptyState();
            this.lastLoadInfo = {
                existed: true,
                size: buf.length,
                error: String((e as Error)?.message ?? e),
                loadedAt: new Date().toISOString(),
            };
        }
        this._onDidChange.fire({ kind: 'changed', reason: 'load' });
        return { corrupt: this.corruptOnLoad, existed: true, size: buf.length };
    }

    /** Restore state from the .bak file (manual recovery). */
    async restoreFromBackup(): Promise<boolean> {
        try {
            const buf = await vscode.workspace.fs.readFile(this.backupUri);
            const parsed = JSON.parse(new TextDecoder().decode(buf)) as Partial<ReviewState>;
            this.state = normalizeState(parsed);
            this.corruptOnLoad = false;
            await this.persist();
            return true;
        } catch {
            return false;
        }
    }

    isCorruptOnLoad(): boolean {
        return this.corruptOnLoad;
    }

    /** Watch our own file for external mutations (e.g. another VS Code window). */
    attachExternalWatcher(): void {
        if (this.watcherDisposable) return;
        const dir = vscode.Uri.joinPath(this.storageUri, '..');
        const fname = path.posix.basename(this.storageUri.path);
        let watcher: vscode.FileSystemWatcher;
        try {
            watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, fname));
        } catch (e) {
            console.warn('[localReview] could not attach store watcher', e);
            return;
        }
        const onChanged = async () => {
            try {
                const buf = await vscode.workspace.fs.readFile(this.storageUri);
                const text = new TextDecoder().decode(buf);
                if (this.hashOf(text) === this.lastWrittenHash) return; // self
                await this.load();
                this._onDidChange.fire({ kind: 'changed', reason: 'external' });
            } catch {
                /* file may have been deleted; ignore */
            }
        };
        this.watcherDisposable = vscode.Disposable.from(
            watcher,
            watcher.onDidChange(onChanged),
            watcher.onDidCreate(onChanged),
        );
    }

    private hashOf(content: string): string {
        return crypto.createHash('sha1').update(content).digest('hex');
    }

    private async atomicWrite(content: Uint8Array): Promise<void> {
        const dir = vscode.Uri.joinPath(this.storageUri, '..');
        await vscode.workspace.fs.createDirectory(dir);
        // Best-effort backup: copy current file (if any) to .bak BEFORE overwriting.
        try {
            await vscode.workspace.fs.copy(this.storageUri, this.backupUri, { overwrite: true });
        } catch (e: any) {
            if (!isNotFoundError(e)) console.warn('[localReview] backup copy failed', e);
        }
        const tmp = vscode.Uri.joinPath(
            dir,
            `${path.posix.basename(this.storageUri.path)}.tmp.${process.pid}.${Date.now()}`,
        );
        await vscode.workspace.fs.writeFile(tmp, content);
        try {
            await vscode.workspace.fs.rename(tmp, this.storageUri, { overwrite: true });
        } catch (e) {
            try {
                await vscode.workspace.fs.delete(tmp);
            } catch {
                /* ignore */
            }
            throw e;
        }
    }

    /** Persist state. Resolves on success; rejects on failure (and emits a `persistFailed` event). */
    private persist(): Promise<void> {
        if (this.corruptOnLoad) {
            return Promise.reject(new Error('Refusing to overwrite corrupt review.json — clear the review first.'));
        }
        const json = JSON.stringify(this.state, null, 2);
        const hash = this.hashOf(json);
        this.lastWrittenHash = hash;
        const next = this.writeChain.then(async () => {
            await this.atomicWrite(new TextEncoder().encode(json));
            this._onDidChange.fire({ kind: 'changed', reason: 'local' });
        });
        this.writeChain = next.catch(err => {
            console.error('[localReview] persist failed', err);
            this._onDidChange.fire({
                kind: 'persistFailed',
                error: err instanceof Error ? err : new Error(String(err)),
            });
        });
        return next;
    }

    getState(): Readonly<ReviewState> {
        return this.state;
    }
    threads(): ReadonlyArray<ReviewThread> {
        return this.state.threads;
    }
    findThread(id: string): ReviewThread | undefined {
        return this.state.threads.find(t => t.id === id);
    }

    isActive(): boolean {
        return !!this.state.baseSha;
    }

    async forceReplace(state: ReviewState): Promise<void> {
        this.corruptOnLoad = false;
        this.state = normalizeState(state);
        await this.persist();
    }

    async setBase(folderUri: string, baseRef: string, baseSha: string, headSha: string): Promise<void> {
        this.state.folderUri = folderUri;
        this.state.baseRef = baseRef;
        this.state.baseSha = baseSha;
        this.state.headSha = headSha;
        this.state.startedAt = new Date().toISOString();
        this.state.lastRefreshedAt = this.state.startedAt;
        await this.persist();
    }

    async updateHead(headSha: string): Promise<void> {
        this.state.headSha = headSha;
        this.state.lastRefreshedAt = new Date().toISOString();
        await this.persist();
    }

    async addThread(meta: FileThreadInput, body: string, author: string): Promise<FileReviewThread> {
        const safeMeta = normalizeFileThreadInput(meta);
        const now = new Date().toISOString();
        const t: FileReviewThread = {
            ...safeMeta,
            scope: 'file',
            id: randomUUID(),
            origin: 'user',
            status: 'open',
            createdAt: now,
            comments: [],
        };
        t.comments.push({
            id: randomUUID(),
            threadId: t.id,
            body,
            author,
            origin: 'user',
            createdAt: now,
        });
        this.state.threads.push(t);
        await this.persist();
        return t;
    }

    async addReviewThread(body: string, author: string, excerpt?: string): Promise<ReviewWideThread> {
        const now = new Date().toISOString();
        const t: ReviewWideThread = {
            id: randomUUID(),
            scope: 'review',
            origin: 'user',
            status: 'open',
            createdAt: now,
            excerpt,
            comments: [],
        };
        t.comments.push({
            id: randomUUID(),
            threadId: t.id,
            body,
            author,
            origin: 'user',
            createdAt: now,
        });
        this.state.threads.push(t);
        await this.persist();
        return t;
    }

    async addReply(threadId: string, body: string, author: string): Promise<ReviewComment | undefined> {
        const t = this.findThread(threadId);
        if (!t) return undefined;
        const c: ReviewComment = {
            id: randomUUID(),
            threadId,
            body,
            author,
            origin: 'user',
            createdAt: new Date().toISOString(),
        };
        t.comments.push(c);
        await this.persist();
        return c;
    }

    /** Apply an agent reply to an existing thread, idempotently (dedupeHash). */
    async addAgentReply(
        threadId: string,
        body: string,
        author: string,
        dedupeHash: string,
        newStatus?: ThreadStatus,
    ): Promise<ReviewComment | undefined> {
        const t = this.findThread(threadId);
        if (!t) return undefined;
        const seen = this.state.importedHashes ?? [];
        if (seen.includes(dedupeHash)) return undefined;
        const c: ReviewComment = {
            id: randomUUID(),
            threadId,
            body,
            author,
            origin: 'agent',
            createdAt: new Date().toISOString(),
        };
        t.comments.push(c);
        if (newStatus && t.status !== newStatus) t.status = newStatus;
        this.state.importedHashes = [...seen, dedupeHash];
        await this.persist();
        return c;
    }

    /** Apply an agent-initiated thread (proactive comment), idempotently. */
    async addAgentThread(
        meta: FileThreadInput | ReviewWideThreadInput,
        body: string,
        author: string,
        dedupeHash: string,
        initialStatus: ThreadStatus = 'open',
    ): Promise<ReviewThread | undefined> {
        const seen = this.state.importedHashes ?? [];
        if (seen.includes(dedupeHash)) return undefined;
        const now = new Date().toISOString();
        const t: ReviewThread =
            meta.scope === 'review'
                ? {
                      id: randomUUID(),
                      scope: 'review',
                      origin: 'agent',
                      status: initialStatus,
                      createdAt: now,
                      excerpt: meta.excerpt,
                      comments: [],
                  }
                : {
                      ...normalizeFileThreadInput(meta),
                      scope: 'file',
                      id: randomUUID(),
                      origin: 'agent',
                      status: initialStatus,
                      createdAt: now,
                      comments: [],
                  };
        t.comments.push({
            id: randomUUID(),
            threadId: t.id,
            body,
            author,
            origin: 'agent',
            createdAt: now,
        });
        this.state.threads.push(t);
        this.state.importedHashes = [...seen, dedupeHash];
        await this.persist();
        return t;
    }

    async editComment(commentId: string, body: string): Promise<void> {
        for (const t of this.state.threads) {
            const c = t.comments.find(x => x.id === commentId);
            if (c) {
                c.body = body;
                await this.persist();
                return;
            }
        }
    }

    async deleteComment(commentId: string): Promise<void> {
        for (const t of this.state.threads) {
            const i = t.comments.findIndex(x => x.id === commentId);
            if (i >= 0) {
                t.comments.splice(i, 1);
                if (t.comments.length === 0) {
                    this.state.threads = this.state.threads.filter(x => x.id !== t.id);
                }
                await this.persist();
                return;
            }
        }
    }

    async deleteThread(threadId: string): Promise<void> {
        const before = this.state.threads.length;
        this.state.threads = this.state.threads.filter(t => t.id !== threadId);
        if (this.state.threads.length !== before) await this.persist();
    }

    async setThreadStatus(threadId: string, status: ThreadStatus): Promise<void> {
        const t = this.findThread(threadId);
        if (t && t.status !== status) {
            t.status = status;
            await this.persist();
        }
    }

    /** Update the line/char range of an existing thread (used by sticky anchoring). */
    async updateThreadRange(
        threadId: string,
        range: { startLine: number; endLine: number; startChar?: number; endChar?: number },
    ): Promise<void> {
        const t = this.findThread(threadId);
        if (!t) return;
        if (!isFileThread(t)) return;
        if (
            t.startLine === range.startLine &&
            t.endLine === range.endLine &&
            t.startChar === range.startChar &&
            t.endChar === range.endChar
        )
            return;
        t.startLine = range.startLine;
        t.endLine = range.endLine;
        t.startChar = range.startChar;
        t.endChar = range.endChar;
        await this.persist();
    }

    /** Backwards-compat shim — line-only update. */
    async updateThreadLines(threadId: string, startLine: number, endLine: number): Promise<void> {
        const t = this.findThread(threadId);
        if (!t) return;
        if (!isFileThread(t)) return;
        return this.updateThreadRange(threadId, { startLine, endLine, startChar: t.startChar, endChar: t.endChar });
    }

    async setLastAgent(agent: LastAgentInfo): Promise<void> {
        const next = normalizeLastAgent(agent);
        if (!next) return;
        const cur = this.state.lastAgent;
        if (
            cur?.name === next.name &&
            cur?.id === next.id &&
            cur?.kind === next.kind &&
            cur?.lastSeenAt === next.lastSeenAt
        )
            return;
        this.state.lastAgent = next;
        await this.persist();
    }

    /** Record the start of a new review round. Returns the new round's metadata. */
    async startRound(
        openCountAtTrigger: number,
        baseSha?: string,
        headSha?: string,
        snapshot?: { sha: string; ref: string },
        positionAnchorSha?: string,
    ): Promise<RoundInfo> {
        const rounds = this.state.rounds ?? [];
        const n = rounds.length + 1;
        const info: RoundInfo = {
            n,
            triggeredAt: new Date().toISOString(),
            openCountAtTrigger,
            baseShaAtTrigger: baseSha,
            headShaAtTrigger: headSha,
            snapshotSha: snapshot?.sha,
            snapshotRef: snapshot?.ref,
            repliesReceived: 0,
            newThreadsReceived: 0,
        };
        if (positionAnchorSha) {
            for (const t of this.state.threads) {
                if (!isFileThread(t)) continue;
                t.anchorSha = positionAnchorSha;
                t.anchorFile = t.file;
                t.anchorStartLine = t.startLine;
                t.anchorEndLine = t.endLine;
            }
        }
        rounds.push(info);
        this.state.rounds = rounds;
        await this.persist();
        return info;
    }

    /** Attribute imported entries to the current (latest) round. */
    async attributeImportToCurrentRound(replies: number, newThreads: number): Promise<void> {
        const rounds = this.state.rounds;
        if (!rounds || rounds.length === 0) return;
        const cur = rounds[rounds.length - 1]!;
        cur.repliesReceived += replies;
        cur.newThreadsReceived += newThreads;
        await this.persist();
    }

    currentRound(): RoundInfo | undefined {
        const rs = this.state.rounds;
        return rs && rs.length > 0 ? rs[rs.length - 1] : undefined;
    }

    async clear(): Promise<void> {
        this.corruptOnLoad = false;
        this.state = emptyState();
        await this.persist();
    }
}

function normalizeState(state: Partial<ReviewState> | undefined): ReviewState {
    const parsed = state ?? {};
    return {
        ...parsed,
        threads: Array.isArray(parsed.threads) ? parsed.threads.map(normalizeThread) : [],
        importedHashes: Array.isArray(parsed.importedHashes)
            ? parsed.importedHashes.filter((x: unknown): x is string => typeof x === 'string')
            : undefined,
        rounds: Array.isArray(parsed.rounds) ? parsed.rounds.map(normalizeRound) : undefined,
        lastAgent: normalizeLastAgent(parsed.lastAgent),
    };
}

/** Backfill default values for fields added in newer schema versions. */
function normalizeThread(t: any): ReviewThread {
    const origin: Origin = t.origin === 'agent' ? 'agent' : 'user';
    const comments = Array.isArray(t.comments)
        ? t.comments.map((c: any) => ({
              id: c.id ?? randomUUID(),
              threadId: c.threadId ?? t.id,
              body: typeof c.body === 'string' ? c.body : '',
              author: c.author ?? 'You',
              origin: (c.origin === 'agent' ? 'agent' : 'user') as Origin,
              createdAt: c.createdAt ?? new Date().toISOString(),
          }))
        : [];
    const status: ThreadStatus = t.status === 'resolved' ? 'resolved' : 'open';
    const base = {
        id: t.id ?? randomUUID(),
        status,
        comments,
        origin,
        createdAt: t.createdAt ?? new Date().toISOString(),
    };
    const file = normalizeRepoPath(t.file);
    if (t.scope === 'review' || !file) {
        return {
            ...base,
            scope: 'review',
            excerpt: typeof t.excerpt === 'string' ? t.excerpt : undefined,
        };
    }
    return {
        ...base,
        scope: 'file',
        file,
        oldFile: normalizeRepoPath(t.oldFile),
        startLine: typeof t.startLine === 'number' ? t.startLine : 1,
        endLine: typeof t.endLine === 'number' ? t.endLine : typeof t.startLine === 'number' ? t.startLine : 1,
        startChar: typeof t.startChar === 'number' ? t.startChar : undefined,
        endChar: typeof t.endChar === 'number' ? t.endChar : undefined,
        anchorSha: typeof t.anchorSha === 'string' ? t.anchorSha : undefined,
        anchorFile: normalizeRepoPath(t.anchorFile),
        anchorStartLine: typeof t.anchorStartLine === 'number' ? t.anchorStartLine : undefined,
        anchorEndLine: typeof t.anchorEndLine === 'number' ? t.anchorEndLine : undefined,
        side: t.side === 'left' ? 'left' : 'right',
        excerpt: typeof t.excerpt === 'string' ? t.excerpt : '',
        excerptSelection: typeof t.excerptSelection === 'string' ? t.excerptSelection : undefined,
    };
}

function normalizeFileThreadInput(meta: FileThreadInput | ReviewWideThreadInput): FileThreadInput {
    if (meta.scope === 'review') {
        throw new Error('Expected a file-scoped thread.');
    }
    const file = normalizeRepoPath(meta.file);
    if (!file) {
        throw new Error(`Invalid review thread file path '${String(meta.file)}'.`);
    }
    return {
        ...meta,
        file,
        oldFile: normalizeRepoPath(meta.oldFile),
        anchorFile: normalizeRepoPath(meta.anchorFile),
    };
}

function normalizeRound(r: any): RoundInfo {
    return {
        n: typeof r?.n === 'number' ? r.n : 1,
        triggeredAt: typeof r?.triggeredAt === 'string' ? r.triggeredAt : new Date().toISOString(),
        openCountAtTrigger: typeof r?.openCountAtTrigger === 'number' ? r.openCountAtTrigger : 0,
        baseShaAtTrigger: typeof r?.baseShaAtTrigger === 'string' ? r.baseShaAtTrigger : undefined,
        headShaAtTrigger: typeof r?.headShaAtTrigger === 'string' ? r.headShaAtTrigger : undefined,
        snapshotSha: typeof r?.snapshotSha === 'string' ? r.snapshotSha : undefined,
        snapshotRef: typeof r?.snapshotRef === 'string' ? r.snapshotRef : undefined,
        repliesReceived: typeof r?.repliesReceived === 'number' ? r.repliesReceived : 0,
        newThreadsReceived: typeof r?.newThreadsReceived === 'number' ? r.newThreadsReceived : 0,
    };
}

function normalizeLastAgent(agent: any): LastAgentInfo | undefined {
    if (!agent || typeof agent.name !== 'string' || !agent.name.trim()) return undefined;
    return {
        name: agent.name.trim(),
        id: typeof agent.id === 'string' && agent.id.trim() ? agent.id.trim() : undefined,
        kind: typeof agent.kind === 'string' && agent.kind.trim() ? agent.kind.trim() : undefined,
        lastSeenAt:
            typeof agent.lastSeenAt === 'string' && !Number.isNaN(new Date(agent.lastSeenAt).getTime())
                ? agent.lastSeenAt
                : new Date().toISOString(),
    };
}

/**
 * Best-effort detection of "file/directory does not exist" for any error
 * shape VS Code or Node might throw. We deliberately err on the side of
 * "is not found" only when we're sure, so we don't accidentally swallow
 * permission errors as if the file were missing.
 */
function isNotFoundError(e: any): boolean {
    if (!e) return false;
    if (e instanceof vscode.FileSystemError) {
        // Newer VS Code: e.code === 'FileNotFound'; older: name contains it.
        if (e.code === 'FileNotFound') return true;
        if (/FileNotFound|EntryNotFound|ENOENT/i.test(e.name ?? '')) return true;
    }
    if (e.code === 'FileNotFound' || e.code === 'ENOENT') return true;
    if (typeof e.message === 'string' && /(no such file|cannot find|does not exist|ENOENT)/i.test(e.message))
        return true;
    return false;
}
