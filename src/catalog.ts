import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { reviewPaths, catalogIndexUri, ReviewPaths } from './paths';
import { normalizeReviewId } from './pathSafety';
import type { LastAgentInfo } from './store';

export interface ReviewMeta {
    id: string;
    name: string;
    /** Workspace folder this review targets (absolute folder URI string). */
    workspaceFolder: string;
    workspaceFolderFsPath: string;
    baseRef?: string;
    baseSha?: string;
    archived: boolean;
    createdAt: string;
    lastActiveAt: string;
    threadCount: number;
    openCount: number;
    rounds: number;
    lastAgent?: LastAgentInfo;
}

export interface CatalogIndex {
    version: 1;
    reviews: ReviewMeta[];
    /** Last-active review id keyed by workspace folder URI string. */
    lastActiveByWorkspace: Record<string, string>;
    /** Globally last-active review id (used when no workspace match). */
    lastActiveGlobal?: string;
}

function emptyIndex(): CatalogIndex {
    return { version: 1, reviews: [], lastActiveByWorkspace: {} };
}

/**
 * Owns the global reviews catalog. All reviews live under
 * `<globalStorage>/reviews/<id>/` and the index lists them.
 */
export class ReviewCatalog implements vscode.Disposable {
    private index: CatalogIndex = emptyIndex();
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;
    private writeChain: Promise<void> = Promise.resolve();

    constructor(private readonly globalStorage: vscode.Uri) {}

    dispose(): void {
        this._onDidChange.dispose();
    }

    async load(): Promise<void> {
        try {
            const buf = await vscode.workspace.fs.readFile(catalogIndexUri(this.globalStorage));
            const parsed = JSON.parse(new TextDecoder().decode(buf)) as Partial<CatalogIndex>;
            const reviews = Array.isArray(parsed.reviews)
                ? parsed.reviews.map(normalize).filter((r): r is ReviewMeta => !!r)
                : [];
            const reviewIds = new Set(reviews.map(r => r.id));
            this.index = {
                version: 1,
                reviews,
                lastActiveByWorkspace: normalizeLastActiveByWorkspace(parsed.lastActiveByWorkspace, reviewIds),
                lastActiveGlobal: normalizeLastActiveReviewId(parsed.lastActiveGlobal, reviewIds),
            };
        } catch {
            this.index = emptyIndex();
        }
        this._onDidChange.fire();
    }

    private async persist(): Promise<void> {
        const json = JSON.stringify(this.index, null, 2);
        const next = this.writeChain.then(async () => {
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.globalStorage, 'reviews'));
            await vscode.workspace.fs.writeFile(catalogIndexUri(this.globalStorage), new TextEncoder().encode(json));
            this._onDidChange.fire();
        });
        this.writeChain = next.catch(err => console.error('[localReview] catalog persist failed', err));
        return next;
    }

    list(): ReadonlyArray<ReviewMeta> {
        return this.index.reviews;
    }
    listActive(): ReadonlyArray<ReviewMeta> {
        return this.index.reviews.filter(r => !r.archived);
    }
    find(id: string): ReviewMeta | undefined {
        return this.index.reviews.find(r => r.id === id);
    }
    findByWorkspace(folderUri: string): ReadonlyArray<ReviewMeta> {
        return this.index.reviews.filter(r => sameUri(r.workspaceFolder, folderUri) && !r.archived);
    }
    lastActiveFor(folderUri: string): ReviewMeta | undefined {
        const id = this.index.lastActiveByWorkspace[normalizeUri(folderUri)];
        return id ? this.find(id) : undefined;
    }
    lastActiveGlobal(): ReviewMeta | undefined {
        return this.index.lastActiveGlobal ? this.find(this.index.lastActiveGlobal) : undefined;
    }

    async create(workspaceFolderUri: vscode.Uri, name: string, baseRef?: string): Promise<ReviewMeta> {
        const meta: ReviewMeta = {
            id: randomUUID(),
            name,
            workspaceFolder: workspaceFolderUri.toString(),
            workspaceFolderFsPath: workspaceFolderUri.fsPath,
            baseRef,
            archived: false,
            createdAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
            threadCount: 0,
            openCount: 0,
            rounds: 0,
        };
        this.index.reviews.push(meta);
        this.index.lastActiveByWorkspace[normalizeUri(meta.workspaceFolder)] = meta.id;
        this.index.lastActiveGlobal = meta.id;
        await vscode.workspace.fs.createDirectory(reviewPaths(this.globalStorage, meta.id).root);
        await this.persist();
        return meta;
    }

    pathsFor(meta: ReviewMeta): ReviewPaths {
        return reviewPaths(this.globalStorage, meta.id);
    }

    async updateStats(
        id: string,
        patch: Partial<
            Pick<
                ReviewMeta,
                'threadCount' | 'openCount' | 'rounds' | 'baseRef' | 'baseSha' | 'name' | 'lastActiveAt' | 'lastAgent'
            >
        >,
    ): Promise<void> {
        const r = this.find(id);
        if (!r) return;
        Object.assign(r, patch);
        r.lastActiveAt = patch.lastActiveAt ?? new Date().toISOString();
        await this.persist();
    }

    async setActive(id: string, workspaceFolderUri?: string): Promise<void> {
        if (workspaceFolderUri) this.index.lastActiveByWorkspace[normalizeUri(workspaceFolderUri)] = id;
        this.index.lastActiveGlobal = id;
        const r = this.find(id);
        if (r) r.lastActiveAt = new Date().toISOString();
        await this.persist();
    }

    async rename(id: string, name: string): Promise<void> {
        const r = this.find(id);
        if (!r) return;
        r.name = name;
        await this.persist();
    }

    async archive(id: string, archived: boolean): Promise<void> {
        const r = this.find(id);
        if (!r) return;
        r.archived = archived;
        await this.persist();
    }

    async delete(id: string): Promise<void> {
        const r = this.find(id);
        if (!r) return;
        this.index.reviews = this.index.reviews.filter(x => x.id !== id);
        for (const [k, v] of Object.entries(this.index.lastActiveByWorkspace)) {
            if (v === id) delete this.index.lastActiveByWorkspace[k];
        }
        if (this.index.lastActiveGlobal === id) this.index.lastActiveGlobal = undefined;
        try {
            await vscode.workspace.fs.delete(reviewPaths(this.globalStorage, id).root, {
                recursive: true,
                useTrash: false,
            });
        } catch (e) {
            console.warn('[localReview] could not delete review folder', e);
        }
        await this.persist();
    }
}

function normalize(r: any): ReviewMeta | undefined {
    if (!r || typeof r !== 'object') return undefined;
    const id = typeof r?.id === 'string' ? normalizeReviewId(r.id) : randomUUID();
    if (!id) return undefined;
    return {
        id,
        name: typeof r.name === 'string' ? r.name : '(untitled)',
        workspaceFolder: r.workspaceFolder ?? '',
        workspaceFolderFsPath: r.workspaceFolderFsPath ?? '',
        baseRef: r.baseRef,
        baseSha: r.baseSha,
        archived: !!r.archived,
        createdAt: r.createdAt ?? new Date().toISOString(),
        lastActiveAt: r.lastActiveAt ?? new Date().toISOString(),
        threadCount: typeof r.threadCount === 'number' ? r.threadCount : 0,
        openCount: typeof r.openCount === 'number' ? r.openCount : 0,
        rounds: typeof r.rounds === 'number' ? r.rounds : 0,
        lastAgent: normalizeLastAgent(r.lastAgent),
    };
}

function normalizeLastActiveByWorkspace(input: unknown, reviewIds: Set<string>): Record<string, string> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const safe: Record<string, string> = {};
    for (const [workspace, rawId] of Object.entries(input)) {
        const id = normalizeLastActiveReviewId(rawId, reviewIds);
        if (id) safe[normalizeUri(workspace)] = id;
    }
    return safe;
}

function normalizeLastActiveReviewId(input: unknown, reviewIds: Set<string>): string | undefined {
    const id = normalizeReviewId(input);
    return id && reviewIds.has(id) ? id : undefined;
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

function sameUri(a: string, b: string): boolean {
    return normalizeUri(a) === normalizeUri(b);
}
function normalizeUri(u: string): string {
    return (u ?? '').replace(/\/+$/, '').toLowerCase();
}
