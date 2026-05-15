import * as vscode from 'vscode';
import { CommentStore, LastAgentInfo, ReviewThread, isFileThread } from './store';
import { ChangedFile, FileStatus } from './git';
import { ReviewCatalog, ReviewMeta } from './catalog';

type LayoutMode = 'compact' | 'tree' | 'flat';
export type FilterMode = 'all' | 'open' | 'resolved';

export interface ActiveReviewInfo {
    repoName?: string;
    repoPath?: string;
    branch?: string;
    upstream?: string;
    baseRef?: string;
    baseSha?: string;
    headSha?: string;
    changedFileCount: number;
    threadCount: number;
    openCount: number;
    round?: number;
    viewModeLabel: string;
    lastAgent?: LastAgentInfo;
}

class FileNode {
    readonly kind = 'file' as const;
    constructor(
        public readonly path: string,
        public readonly basename: string,
        public readonly status: FileStatus | undefined,
        public readonly threads: ReviewThread[],
        public readonly inChangedSet: boolean,
    ) {}
    countOpen(): number {
        return this.threads.filter(t => t.status === 'open').length;
    }
}

class FolderNode {
    readonly kind = 'folder' as const;
    constructor(
        public readonly segment: string,
        public readonly fullPath: string,
        public readonly folders: FolderNode[],
        public readonly files: FileNode[],
    ) {}
    countOpen(): number {
        let n = this.files.reduce((acc, f) => acc + f.countOpen(), 0);
        for (const sub of this.folders) n += sub.countOpen();
        return n;
    }
    countFiles(): number {
        let n = this.files.length;
        for (const sub of this.folders) n += sub.countFiles();
        return n;
    }
}

class ThreadNode {
    readonly kind = 'thread' as const;
    constructor(public readonly thread: ReviewThread) {}
}

class MessageNode {
    readonly kind = 'message' as const;
    constructor(
        public readonly thread: ReviewThread,
        public readonly index: number,
    ) {}
}

class HeaderNode {
    readonly kind = 'header' as const;
    constructor(
        public readonly text: string,
        public readonly stats?: string,
        public readonly cmd?: string,
        public readonly icon = 'git-pull-request',
    ) {}
}

class InfoNode {
    readonly kind = 'info' as const;
    constructor(
        public readonly label: string,
        public readonly value: string | undefined,
        public readonly icon = 'info',
        public readonly tooltip?: string,
        public readonly cmd?: string,
    ) {}
}

class CatalogReviewNode {
    readonly kind = 'catalogReview' as const;
    constructor(
        public readonly meta: ReviewMeta,
        public readonly isActive: boolean,
        public readonly inCurrentWorkspace: boolean,
    ) {}
}

class ReviewPickerNode {
    readonly kind = 'reviewPicker' as const;
    constructor(
        public readonly current: ReviewMeta | undefined,
        public readonly totalReviews: number,
    ) {}
}

class SectionNode {
    readonly kind = 'section' as const;
    constructor(
        public readonly title: string,
        public readonly children: Node[],
        public readonly description?: string,
    ) {}
}

type Node =
    | HeaderNode
    | InfoNode
    | FolderNode
    | FileNode
    | ThreadNode
    | MessageNode
    | CatalogReviewNode
    | ReviewPickerNode
    | SectionNode;

export interface ReviewCatalogTreeContext {
    getCatalog(): ReviewCatalog;
    getActiveReviewId(): string | undefined;
    getShowOtherWorkspaces(): boolean;
    getCurrentWorkspaceFolderUris(): string[];
}

export interface ActiveReviewTreeContext {
    getChangedFiles(): ReadonlyArray<ChangedFile>;
    getBaseRefLabel(): string | undefined;
    getLayoutMode(): LayoutMode;
    getCurrentRound(): number | undefined;
    getViewModeLabel(): string;
    getActiveReview?(): ReviewMeta | undefined;
    getReviewInfo?(): ActiveReviewInfo | undefined;
}

export interface TreeContext extends ReviewCatalogTreeContext, ActiveReviewTreeContext {}

export class ReviewCatalogTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;
    private readonly subs: vscode.Disposable[] = [];

    constructor(
        private readonly ctx: ReviewCatalogTreeContext,
        externalEvents: vscode.Event<void>,
    ) {
        this.subs.push(externalEvents(() => this.refresh()));
        this.subs.push(ctx.getCatalog().onDidChange(() => this.refresh()));
    }

    refresh(): void {
        this._onDidChange.fire();
    }

    dispose(): void {
        for (const d of this.subs.splice(0)) d.dispose();
        this._onDidChange.dispose();
    }

    getTreeItem(n: Node): vscode.TreeItem {
        return treeItemForNode(n);
    }

    getChildren(n?: Node): Node[] {
        if (!n) return this.rootNodes();
        if (n.kind === 'section') return n.children;
        return [];
    }

    private rootNodes(): Node[] {
        const catalog = this.ctx.getCatalog();
        const reviews = catalog.listActive();
        if (reviews.length === 0) {
            return [new HeaderNode('No reviews yet', 'Start a new review to begin', 'localReview.newReview', 'add')];
        }

        const activeId = this.ctx.getActiveReviewId();
        const wsFolders = this.ctx.getCurrentWorkspaceFolderUris();
        const inWs = (m: ReviewMeta) => wsFolders.some(w => sameUri(m.workspaceFolder, w));
        const showOther = this.ctx.getShowOtherWorkspaces();
        const current = reviews.filter(inWs).sort(compareLastActive);
        const other = reviews.filter(r => !inWs(r)).sort(compareLastActive);
        const nodes: Node[] = [];

        if (current.length > 0) {
            nodes.push(
                new SectionNode(
                    'Current workspace',
                    current.map(r => new CatalogReviewNode(r, r.id === activeId, true)),
                    `${current.length}`,
                ),
            );
        }

        if (showOther) {
            if (other.length > 0) {
                nodes.push(
                    new SectionNode(
                        'Other workspaces',
                        other.map(r => new CatalogReviewNode(r, r.id === activeId, false)),
                        `${other.length}`,
                    ),
                );
            }
        } else if (other.length > 0) {
            nodes.push(
                new HeaderNode(
                    `${other.length} review${other.length === 1 ? '' : 's'} hidden`,
                    'Toggle workspace filter to show all',
                    'localReview.toggleShowOtherWorkspaces',
                    'filter',
                ),
            );
        }

        if (nodes.length === 0) {
            nodes.push(
                new HeaderNode(
                    'No reviews in this workspace',
                    'Toggle filter or create a review',
                    undefined,
                    'comment',
                ),
            );
        }
        return nodes;
    }
}

export class ActiveReviewTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;
    private readonly subs: vscode.Disposable[] = [];
    private filter: FilterMode = 'all';
    private searchText = '';

    constructor(
        private readonly getStore: () => CommentStore | undefined,
        private readonly ctx: ActiveReviewTreeContext,
        externalEvents: vscode.Event<void>,
    ) {
        this.subs.push(externalEvents(() => this.refresh()));
        this.subs.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('localReview.fileTreeStyle')) this.refresh();
            }),
        );
    }

    refresh(): void {
        this._onDidChange.fire();
    }

    dispose(): void {
        for (const d of this.subs.splice(0)) d.dispose();
        this._onDidChange.dispose();
    }

    getFilter(): FilterMode {
        return this.filter;
    }

    setFilter(mode: FilterMode): void {
        if (this.filter !== mode) {
            this.filter = mode;
            this.refresh();
        }
    }

    setSearch(text: string): void {
        if (this.searchText !== text) {
            this.searchText = text;
            this.refresh();
        }
    }

    getTreeItem(n: Node): vscode.TreeItem {
        return treeItemForNode(n);
    }

    getChildren(n?: Node): Node[] {
        if (!n) return this.rootNodes();
        if (n.kind === 'folder') return [...n.folders, ...n.files];
        if (n.kind === 'file') return n.threads.map(t => new ThreadNode(t));
        if (n.kind === 'thread') return n.thread?.comments?.map((_, i) => new MessageNode(n.thread, i)) ?? [];
        if (n.kind === 'section') return n.children;
        return [];
    }

    private rootNodes(): Node[] {
        const store = this.getStore();
        const activeReview = this.ctx.getActiveReview?.();
        if (!store || !activeReview) {
            return [
                new HeaderNode(
                    'No active review',
                    'Open or create a review from the Reviews pane',
                    'localReview.switchReview',
                    'comment-discussion',
                ),
            ];
        }

        const state =
            typeof (store as unknown as { getState?: () => ReturnType<CommentStore['getState']> }).getState ===
            'function'
                ? store.getState()
                : { threads: store.threads() };
        const info = this.ctx.getReviewInfo?.() ?? {
            baseRef: this.ctx.getBaseRefLabel(),
            changedFileCount: this.ctx.getChangedFiles().length,
            threadCount: state.threads.length,
            openCount: state.threads.filter(t => t.status === 'open').length,
            round: this.ctx.getCurrentRound(),
            viewModeLabel: this.ctx.getViewModeLabel(),
            lastAgent: 'lastAgent' in state ? state.lastAgent : undefined,
        };
        const nodes: Node[] = [new SectionNode('Review details', detailsNodes(activeReview, info), undefined)];
        const changed = this.ctx.getChangedFiles();
        const roundTag = info.round ? ` · round ${info.round}` : '';
        const filterTag = this.filter === 'all' ? '' : ` · filter: ${this.filter}`;
        const searchTag = this.searchText ? ` · search: ${this.searchText}` : '';
        nodes.push(
            new HeaderNode(
                `Showing: ${info.viewModeLabel}`,
                `${info.changedFileCount} file(s) · ${info.openCount} open / ${info.threadCount} comment(s)${roundTag}${filterTag}${searchTag}`,
                'localReview.selectViewMode',
                'diff',
            ),
        );

        const reviewThreads = state.threads.filter(t => !isFileThread(t) && this.passesFilter(t));
        if (reviewThreads.length > 0) {
            reviewThreads.sort(compareThreads);
            nodes.push(
                new SectionNode(
                    'Review-wide comments',
                    reviewThreads.map(t => new ThreadNode(t)),
                    `${reviewThreads.filter(t => t.status === 'open').length} open`,
                ),
            );
        }

        const fileNodes = this.fileNodes(store, changed);
        if (fileNodes.length === 0) {
            nodes.push(
                new HeaderNode(
                    'No changed files',
                    state.threads.length === 0
                        ? 'Add a review comment or refresh changes'
                        : 'No file comments match the current filter',
                    undefined,
                    'file',
                ),
            );
            return nodes;
        }

        const layout = this.ctx.getLayoutMode();
        if (layout === 'flat') {
            fileNodes.sort((a, b) => a.path.localeCompare(b.path));
            nodes.push(...fileNodes);
        } else {
            const root = buildFolderTree(fileNodes, layout === 'compact');
            nodes.push(...root.folders, ...root.files);
        }
        return nodes;
    }

    private fileNodes(store: CommentStore, changed: ReadonlyArray<ChangedFile>): FileNode[] {
        const threadsByFile = new Map<string, ReviewThread[]>();
        for (const t of store.threads()) {
            if (!isFileThread(t) || !this.passesFilter(t)) continue;
            let arr = threadsByFile.get(t.file);
            if (!arr) {
                arr = [];
                threadsByFile.set(t.file, arr);
            }
            arr.push(t);
        }

        const fileNodes: FileNode[] = [];
        const seen = new Set<string>();
        for (const f of changed) {
            seen.add(f.path);
            const ts = (threadsByFile.get(f.path) ?? []).slice().sort(compareThreads);
            fileNodes.push(new FileNode(f.path, basename(f.path), f.status, ts, true));
        }
        for (const [file, ts] of threadsByFile) {
            if (seen.has(file)) continue;
            fileNodes.push(new FileNode(file, basename(file), undefined, ts.slice().sort(compareThreads), false));
        }
        return fileNodes;
    }

    private passesFilter(t: ReviewThread): boolean {
        if (this.filter === 'open' && t.status !== 'open') return false;
        if (this.filter === 'resolved' && t.status !== 'resolved') return false;
        if (this.searchText) {
            const needle = this.searchText.toLowerCase();
            const file = isFileThread(t) ? t.file : 'review-wide';
            const haystack = [file, ...t.comments.map(c => c.body), ...t.comments.map(c => c.author)]
                .join(' ')
                .toLowerCase();
            if (!haystack.includes(needle)) return false;
        }
        return true;
    }
}

/** Compatibility export for older tests/consumers; new code should use ActiveReviewTreeProvider. */
export class CommentTreeProvider extends ActiveReviewTreeProvider {
    private readonly compatCtx: TreeContext;

    constructor(getStore: () => CommentStore | undefined, ctx: TreeContext, externalEvents: vscode.Event<void>) {
        const compatCtx = ctx;
        super(
            getStore,
            {
                ...ctx,
                getActiveReview: () => {
                    const id = ctx.getActiveReviewId();
                    return id ? ctx.getCatalog().find(id) : undefined;
                },
            },
            externalEvents,
        );
        this.compatCtx = compatCtx;
    }

    override getChildren(n?: Node): Node[] {
        if (n) return super.getChildren(n);
        const active = this.compatCtx.getActiveReviewId();
        const activeReview = active ? this.compatCtx.getCatalog().find(active) : undefined;
        const reviews = this.compatCtx.getCatalog().listActive();
        const nodes: Node[] = [new ReviewPickerNode(activeReview, reviews.length)];
        const wsFolders = this.compatCtx.getCurrentWorkspaceFolderUris();
        const inWs = (m: ReviewMeta) => wsFolders.some(w => sameUri(m.workspaceFolder, w));
        const showOther = this.compatCtx.getShowOtherWorkspaces();
        const visibleReviews = reviews.filter(r => showOther || inWs(r)).sort(compareLastActive);
        if (visibleReviews.length > 1 || !activeReview) {
            nodes.push(
                new SectionNode(
                    'Reviews',
                    visibleReviews.map(r => new CatalogReviewNode(r, r.id === active, inWs(r))),
                ),
            );
        }
        if (activeReview) nodes.push(...super.getChildren(undefined));
        return nodes;
    }
}

function treeItemForNode(n: Node): vscode.TreeItem {
    if (n.kind === 'header') {
        const item = new vscode.TreeItem(n.text, vscode.TreeItemCollapsibleState.None);
        item.description = n.stats;
        item.iconPath = new vscode.ThemeIcon(n.icon);
        item.contextValue = 'reviewHeader';
        if (n.cmd) item.command = { command: n.cmd, title: n.text };
        item.tooltip = n.stats;
        return item;
    }
    if (n.kind === 'info') {
        const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
        item.description = n.value;
        item.tooltip = n.tooltip ?? n.value;
        item.iconPath = new vscode.ThemeIcon(n.icon);
        item.contextValue = 'reviewInfo';
        if (n.cmd) item.command = { command: n.cmd, title: n.label };
        return item;
    }
    if (n.kind === 'section') {
        const item = new vscode.TreeItem(n.title, vscode.TreeItemCollapsibleState.Expanded);
        item.description = n.description ?? `${n.children.length}`;
        item.contextValue = 'reviewSection';
        return item;
    }
    if (n.kind === 'reviewPicker') {
        const cur = n.current;
        const item = new vscode.TreeItem(
            cur ? `Review: ${cur.name}` : 'No active review',
            vscode.TreeItemCollapsibleState.None,
        );
        item.description = cur
            ? `${cur.baseRef ?? '?'} · ${cur.openCount}/${cur.threadCount} comments · click to switch`
            : 'Click to pick or create one';
        item.iconPath = new vscode.ThemeIcon(cur ? 'comment-discussion' : 'add');
        item.command = {
            command: cur ? 'localReview.switchReview' : 'localReview.newReview',
            title: 'Switch / new',
        };
        item.contextValue = 'reviewPicker';
        return item;
    }
    if (n.kind === 'catalogReview') {
        const item = new vscode.TreeItem(n.meta.name, vscode.TreeItemCollapsibleState.None);
        const parts: string[] = [];
        if (n.meta.baseRef) parts.push(n.meta.baseRef);
        parts.push(`${n.meta.openCount}/${n.meta.threadCount}`);
        if (n.meta.rounds) parts.push(`r${n.meta.rounds}`);
        if (n.meta.lastAgent?.name) parts.push(`agent ${n.meta.lastAgent.name}`);
        if (!n.inCurrentWorkspace) parts.push('other workspace');
        item.description = parts.join(' · ');
        item.tooltip = [
            n.meta.workspaceFolderFsPath,
            n.meta.baseRef ? `Base: ${n.meta.baseRef}` : undefined,
            n.meta.lastAgent ? `Last agent: ${formatAgent(n.meta.lastAgent)}` : undefined,
            `Last active: ${n.meta.lastActiveAt}`,
        ]
            .filter(Boolean)
            .join('\n');
        item.iconPath = new vscode.ThemeIcon(n.isActive ? 'check' : 'comment-discussion');
        item.command = {
            command: 'localReview.openCatalogReview',
            title: 'Open this review',
            arguments: [n.meta.id],
        };
        item.contextValue = `catalogReview${n.isActive ? 'Active' : ''}`;
        return item;
    }
    if (n.kind === 'folder') {
        const open = n.countOpen();
        const files = n.countFiles();
        const item = new vscode.TreeItem(n.segment, vscode.TreeItemCollapsibleState.Expanded);
        const parts: string[] = [`${files} file${files === 1 ? '' : 's'}`];
        if (open > 0) parts.push(`${open} open`);
        item.description = parts.join(' · ');
        item.tooltip = n.fullPath;
        item.iconPath = vscode.ThemeIcon.Folder;
        item.contextValue = 'reviewFolder';
        return item;
    }
    if (n.kind === 'file') {
        const open = n.countOpen();
        const resolved = n.threads.length - open;
        const item = new vscode.TreeItem(n.basename, vscode.TreeItemCollapsibleState.Expanded);
        const parts: string[] = [];
        if (n.status) parts.push(statusLabel(n.status));
        if (open > 0) parts.push(`${open} open`);
        if (resolved > 0) parts.push(`${resolved} resolved`);
        item.description = parts.join(' · ') || undefined;
        item.tooltip = n.path;
        item.iconPath = statusIcon(n.status);
        item.command = {
            command: n.inChangedSet ? 'localReview.openChangedFile' : 'localReview.openFileFromTree',
            title: 'Open',
            arguments: [n.path],
        };
        item.contextValue = n.inChangedSet ? 'reviewFile' : 'reviewFileExternal';
        return item;
    }
    if (n.kind === 'message') {
        const comment = n.thread.comments[n.index];
        const first = firstLine(comment?.body ?? '');
        const item = new vscode.TreeItem(`${comment?.author ?? 'Unknown'}: ${first || '(empty)'}`);
        item.description = comment?.origin === 'agent' ? 'agent reply' : 'user';
        item.tooltip = comment?.body;
        item.iconPath = new vscode.ThemeIcon(comment?.origin === 'agent' ? 'hubot' : 'comment');
        item.contextValue = 'reviewMessage';
        return item;
    }

    const t = n.thread;
    const first = firstLine(t.comments[0]?.body ?? '');
    const label = isLineLikeThread(t)
        ? `L${t.startLine === t.endLine ? t.startLine : `${t.startLine}-${t.endLine}`}: ${first || '(no text)'}`
        : `Review: ${first || '(no text)'}`;
    const item = new vscode.TreeItem(
        label,
        t.comments.length > 1 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.tooltip = t.comments.map(c => `${c.author}: ${c.body}`).join('\n\n');
    item.iconPath = new vscode.ThemeIcon(
        t.origin === 'agent'
            ? t.status === 'resolved'
                ? 'check'
                : 'hubot'
            : t.status === 'resolved'
              ? 'check'
              : 'comment',
    );
    const tag = t.origin === 'agent' ? 'agent' : '';
    const reply = t.comments.length > 1 ? `${t.comments.length} replies` : '';
    item.description = [tag, t.status === 'resolved' ? 'resolved' : '', reply].filter(Boolean).join(' · ') || undefined;
    item.contextValue = t.status === 'resolved' ? 'reviewThreadResolved' : 'reviewThread';
    item.command = { command: 'localReview.openThreadLocation', title: 'Go to comment', arguments: [t.id] };
    return item;
}

function detailsNodes(activeReview: ReviewMeta, info: ActiveReviewInfo): Node[] {
    const nodes: Node[] = [
        new InfoNode('Review', activeReview.name, 'comment-discussion', activeReview.id, 'localReview.statusMenu'),
        new InfoNode(
            'Repository',
            info.repoName ?? basenamePath(activeReview.workspaceFolderFsPath),
            'repo',
            info.repoPath ?? activeReview.workspaceFolderFsPath,
        ),
    ];
    nodes.push(new InfoNode('Branch', info.branch ?? '(detached or unknown)', 'git-branch'));
    nodes.push(new InfoNode('Upstream', info.upstream ?? '(no upstream)', 'cloud'));
    nodes.push(
        new InfoNode('Base', info.baseRef ?? activeReview.baseRef ?? '(not started)', 'git-compare', info.baseSha),
    );
    nodes.push(new InfoNode('HEAD', shortSha(info.headSha), 'git-commit'));
    nodes.push(new InfoNode('Comments', `${info.openCount} open / ${info.threadCount} total`, 'comment'));
    nodes.push(new InfoNode('Files', `${info.changedFileCount} changed`, 'files'));
    nodes.push(new InfoNode('Latest round', info.round ? `Round ${info.round}` : 'None yet', 'history'));
    nodes.push(new InfoNode('Last agent', info.lastAgent ? formatAgent(info.lastAgent) : 'None yet', 'hubot'));
    return nodes;
}

interface BuildNode {
    children: Map<string, BuildNode>;
    files: FileNode[];
}

function buildFolderTree(files: FileNode[], compact: boolean): { folders: FolderNode[]; files: FileNode[] } {
    const root: BuildNode = { children: new Map(), files: [] };
    for (const f of files) {
        const parts = f.path.split('/');
        parts.pop();
        let cur = root;
        for (const seg of parts) {
            let next = cur.children.get(seg);
            if (!next) {
                next = { children: new Map(), files: [] };
                cur.children.set(seg, next);
            }
            cur = next;
        }
        cur.files.push(f);
    }
    return materialize(root, '', compact);
}

function materialize(
    node: BuildNode,
    parentPath: string,
    compact: boolean,
): { folders: FolderNode[]; files: FileNode[] } {
    const subFolderNames = [...node.children.keys()].sort((a, b) => a.localeCompare(b));
    const folders: FolderNode[] = [];
    for (const name of subFolderNames) {
        let child = node.children.get(name)!;
        const segs = [name];
        let fullPath = parentPath ? `${parentPath}/${name}` : name;
        if (compact) {
            while (child.files.length === 0 && child.children.size === 1) {
                const onlyName = child.children.keys().next().value!;
                segs.push(onlyName);
                fullPath = `${fullPath}/${onlyName}`;
                child = child.children.get(onlyName)!;
            }
        }
        const inner = materialize(child, fullPath, compact);
        folders.push(new FolderNode(segs.join('/'), fullPath, inner.folders, inner.files));
    }
    folders.sort((a, b) => a.segment.localeCompare(b.segment));
    const filesOut = [...node.files].sort((a, b) => a.basename.localeCompare(b.basename));
    return { folders, files: filesOut };
}

function compareLastActive(a: ReviewMeta, b: ReviewMeta): number {
    return b.lastActiveAt.localeCompare(a.lastActiveAt);
}

function compareThreads(a: ReviewThread, b: ReviewThread): number {
    if (isLineLikeThread(a) && isLineLikeThread(b)) return a.startLine - b.startLine || a.id.localeCompare(b.id);
    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function isLineLikeThread(t: ReviewThread): t is ReviewThread & { startLine: number; endLine: number } {
    return isFileThread(t) || (typeof (t as any).startLine === 'number' && typeof (t as any).endLine === 'number');
}

function basename(p: string): string {
    const i = p.lastIndexOf('/');
    return i < 0 ? p : p.slice(i + 1);
}

function basenamePath(p: string): string {
    const normalized = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return basename(normalized) || normalized;
}

function statusLabel(s: FileStatus): string {
    switch (s) {
        case 'A':
            return 'added';
        case 'M':
            return 'modified';
        case 'D':
            return 'deleted';
        case 'R':
            return 'renamed';
        case 'C':
            return 'copied';
        case 'T':
            return 'type-changed';
        default:
            return String(s);
    }
}

function statusIcon(s: FileStatus | undefined): vscode.ThemeIcon {
    switch (s) {
        case 'A':
            return new vscode.ThemeIcon('diff-added');
        case 'M':
            return new vscode.ThemeIcon('diff-modified');
        case 'D':
            return new vscode.ThemeIcon('diff-removed');
        case 'R':
        case 'C':
            return new vscode.ThemeIcon('diff-renamed');
        case 'T':
            return new vscode.ThemeIcon('symbol-type-parameter');
        default:
            return new vscode.ThemeIcon('file');
    }
}

function sameUri(a: string, b: string): boolean {
    const norm = (s: string) => (s ?? '').replace(/\/+$/, '').toLowerCase();
    return norm(a) === norm(b);
}

function firstLine(s: string): string {
    return (s.split(/\r?\n/)[0] ?? '').trim();
}

function shortSha(sha: string | undefined): string | undefined {
    return sha ? sha.slice(0, 12) : undefined;
}

function formatAgent(agent: LastAgentInfo): string {
    const parts = [agent.name];
    if (agent.kind) parts.push(agent.kind);
    if (agent.id) parts.push(agent.id);
    return parts.join(' · ');
}
