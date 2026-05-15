import * as vscode from 'vscode';
import * as path from 'path';
import { Git, ChangedFile, DiffHunk } from './git';
import { CommentStore, ReviewThread, Side, isFileThread } from './store';
import { BaseContentProvider, BASE_SCHEME, EMPTY_SCHEME, baseUri, emptyUri } from './contentProvider';
import { mapRangeThroughHunks } from './lineMapping';

const ACTIVE_CONTEXT_KEY = 'localReview.active';

/** Public API surface used by extension.ts and the tree provider. */
export interface SessionViewData {
    readonly isActive: boolean;
    readonly baseRef?: string;
    readonly baseSha?: string;
    readonly headSha?: string;
    readonly changedFiles: ReadonlyArray<ChangedFile>;
}

export type ViewMode = { kind: 'overall' } | { kind: 'round'; n: number; sha: string };

export type CommentVisibilityFilter = 'all' | 'open' | 'resolved';

export class ReviewSession implements vscode.Disposable {
    private controller: vscode.CommentController | undefined;
    private commentingFiles = new Set<string>(); // includes both new and old paths for renames
    private vsThreads = new Map<string, vscode.CommentThread>();
    private changedFiles: ChangedFile[] = []; // canonical: vs baseSha
    private viewFiles: ChangedFile[] = []; // what the tree currently shows (per viewMode)
    private viewMode: ViewMode = { kind: 'overall' };
    private commentFilter: CommentVisibilityFilter = 'all';
    private readonly disposables: vscode.Disposable[] = [];
    private autoRefreshDisposables: vscode.Disposable[] = [];
    private autoRefreshTimer: NodeJS.Timeout | undefined;
    private readonly commentingRangeCache = new Map<
        string,
        { version: number; lineCount: number; ranges: vscode.Range[] }
    >();

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(
        private git: Git,
        private store: CommentStore,
        private readonly provider: BaseContentProvider,
        private workspaceUri: vscode.Uri,
    ) {
        this.disposables.push(this._onDidChange);
        // Re-attach auto-refresh whenever its settings change.
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (
                    e.affectsConfiguration('localReview.autoRefresh') ||
                    e.affectsConfiguration('localReview.autoRefreshDelayMs')
                ) {
                    if (this.isActive) this.attachAutoRefresh();
                }
            }),
        );
        // Sticky line anchoring: shift gutter threads when the user edits files.
        this.disposables.push(vscode.workspace.onDidChangeTextDocument(e => this.onDocumentChanged(e)));
    }

    get isActive(): boolean {
        return !!this.controller;
    }
    get baseRef(): string | undefined {
        return this.store.getState().baseRef;
    }
    get baseSha(): string | undefined {
        return this.store.getState().baseSha;
    }
    get headSha(): string | undefined {
        return this.store.getState().headSha;
    }
    get changedFileList(): ReadonlyArray<ChangedFile> {
        return this.viewFiles;
    }
    /** Files changed in the canonical review (vs baseSha) — regardless of view mode. */
    get overallChangedFiles(): ReadonlyArray<ChangedFile> {
        return this.changedFiles;
    }
    getViewMode(): ViewMode {
        return this.viewMode;
    }
    setCommentFilter(mode: CommentVisibilityFilter): void {
        if (this.commentFilter === mode) return;
        this.commentFilter = mode;
        this.rerenderAll();
    }

    /** Resolve the diff base SHA for the current view (baseSha if overall, round SHA otherwise). */
    private currentViewBaseSha(): string | undefined {
        if (this.viewMode.kind === 'round') return this.viewMode.sha;
        return this.baseSha;
    }
    private currentViewBaseLabel(): string {
        if (this.viewMode.kind === 'round') return `round ${this.viewMode.n}`;
        return this.baseRef ?? this.baseSha ?? '?';
    }
    get viewData(): SessionViewData {
        return {
            isActive: this.isActive,
            baseRef: this.baseRef,
            baseSha: this.baseSha,
            headSha: this.headSha,
            changedFiles: this.changedFiles,
        };
    }
    get folderUri(): vscode.Uri {
        return this.workspaceUri;
    }

    dispose() {
        this.tearDown();
        for (const d of this.disposables.splice(0)) {
            try {
                d.dispose();
            } catch {
                /* ignore */
            }
        }
    }

    private tearDown() {
        for (const t of this.vsThreads.values()) t.dispose();
        this.vsThreads.clear();
        this.controller?.dispose();
        this.controller = undefined;
        this.commentingFiles.clear();
        this.commentingRangeCache.clear();
        this.changedFiles = [];
        this.detachAutoRefresh();
        void vscode.commands.executeCommand('setContext', ACTIVE_CONTEXT_KEY, false);
        this._onDidChange.fire();
    }

    private detachAutoRefresh() {
        if (this.autoRefreshTimer) {
            clearTimeout(this.autoRefreshTimer);
            this.autoRefreshTimer = undefined;
        }
        for (const d of this.autoRefreshDisposables.splice(0)) {
            try {
                d.dispose();
            } catch {
                /* ignore */
            }
        }
    }

    private attachAutoRefresh() {
        this.detachAutoRefresh();
        const cfg = vscode.workspace.getConfiguration('localReview');
        if (!cfg.get<boolean>('autoRefresh', true)) return;
        const delay = Math.max(250, cfg.get<number>('autoRefreshDelayMs', 1500));

        const trigger = () => {
            if (this.autoRefreshTimer) clearTimeout(this.autoRefreshTimer);
            this.autoRefreshTimer = setTimeout(() => {
                void this.refresh({ silent: true });
            }, delay);
        };

        // Workspace file watcher — fires on save, create, delete.
        try {
            const wsWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(this.workspaceUri, '**/*'),
            );
            this.autoRefreshDisposables.push(
                wsWatcher,
                wsWatcher.onDidChange(trigger),
                wsWatcher.onDidCreate(trigger),
                wsWatcher.onDidDelete(trigger),
            );
        } catch (e) {
            console.warn('[localReview] workspace watcher failed', e);
        }

        // Git state watcher — commits, branch checkouts, stage/unstage.
        try {
            const gitWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(this.workspaceUri, '.git/{HEAD,index,refs/**}'),
            );
            this.autoRefreshDisposables.push(
                gitWatcher,
                gitWatcher.onDidChange(trigger),
                gitWatcher.onDidCreate(trigger),
                gitWatcher.onDidDelete(trigger),
            );
        } catch (e) {
            console.warn('[localReview] git watcher failed', e);
        }

        // Also re-check on window focus — covers external edits while VS Code was unfocused.
        this.autoRefreshDisposables.push(
            vscode.window.onDidChangeWindowState(s => {
                if (s.focused) trigger();
            }),
        );
    }

    // ----- Sticky line anchoring -----

    private stickyPendingPersist = new Map<string, NodeJS.Timeout>();

    private onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
        if (!this.controller || this.vsThreads.size === 0) return;
        if (e.document.uri.scheme !== 'file') return;
        const rel = this.relPathOf(e.document.uri);
        if (!rel) return;
        // Only process threads anchored to this document.
        const docKey = e.document.uri.toString();
        const affected: { thread: vscode.CommentThread; id: string }[] = [];
        for (const [id, vs] of this.vsThreads) {
            if (vs.uri.toString() === docKey) affected.push({ thread: vs, id });
        }
        if (affected.length === 0) return;

        // Process changes in descending order so earlier shifts don't perturb later positions.
        const changes = [...e.contentChanges].sort((a, b) => b.range.start.line - a.range.start.line);

        for (const { thread, id } of affected) {
            const stored = this.store.findThread(id);
            if (!stored || !isFileThread(stored) || !thread.range) continue;
            let startLine = stored.startLine; // 1-based
            let endLine = stored.endLine; // 1-based
            for (const ch of changes) {
                const chStart = ch.range.start.line + 1;
                const chEnd = ch.range.end.line + 1;
                const addedLines = countLines(ch.text);
                const removedLines = chEnd - chStart;
                const delta = addedLines - removedLines;
                if (chEnd < startLine) {
                    startLine += delta;
                    endLine += delta;
                } else if (chStart > endLine) {
                    // change is below; no shift
                } else {
                    // Overlap: keep the thread at the change start, preserving its length where possible.
                    const len = Math.max(0, endLine - startLine);
                    startLine = Math.max(1, chStart);
                    endLine = startLine + len;
                }
            }
            startLine = Math.max(1, startLine);
            endLine = Math.max(startLine, endLine);
            if (startLine !== stored.startLine || endLine !== stored.endLine) {
                thread.range = new vscode.Range(startLine - 1, 0, endLine - 1, 0);
                // Debounce persistence: 500 ms after the last edit on this thread.
                const existing = this.stickyPendingPersist.get(id);
                if (existing) clearTimeout(existing);
                const t = setTimeout(() => {
                    this.stickyPendingPersist.delete(id);
                    void this.store.updateThreadLines(id, startLine, endLine);
                }, 500);
                this.stickyPendingPersist.set(id, t);
            }
        }
    }

    // ----- Round tracking -----

    /**
     * Called when the user triggers a round. Snapshots the working tree
     * (tracked + untracked + index) as a dangling commit and pins it under
     * refs/local-review/<reviewIdOrFolder>/round-N so it survives any agent
     * action — amend, rebase, reset, `git gc --prune=now`.
     */
    async beginRound(reviewId?: string): Promise<number> {
        const open = this.store.threads().filter(t => t.status === 'open').length;
        const headSha = await this.git.headSha();
        let snapshot: { sha: string; ref: string } | undefined;
        try {
            const sha = await this.git.snapshotWorkingTree();
            if (sha) {
                const refSafeId = (reviewId ?? 'default').replace(/[^A-Za-z0-9_-]/g, '_');
                const ref = `refs/local-review/${refSafeId}/round-${(this.store.getState().rounds ?? []).length + 1}`;
                if (await this.git.pinRef(ref, sha)) snapshot = { sha, ref };
            }
        } catch (e) {
            console.warn('[localReview] snapshot failed', e);
        }
        const positionAnchorSha = snapshot?.sha ?? headSha;
        const info = await this.store.startRound(open, this.baseSha, headSha, snapshot, positionAnchorSha);
        return info.n;
    }

    /**
     * Switch this session to a different review / workspace folder. Tears down
     * the old controller and threads, points the session at the new store /
     * folder, and re-hydrates.
     */
    async switchTo(newGit: Git, newStore: CommentStore, newFolder: vscode.Uri): Promise<void> {
        this.tearDown();
        this.git = newGit;
        this.store = newStore;
        this.workspaceUri = newFolder;
        await this.hydrateFromStore();
    }

    /**
     * Initialize a newly-created review with a chosen base ref/sha. Computes
     * the changed-file list, stores the base, sets up the comment controller.
     * Use after `openReview` for a brand-new catalog entry.
     */
    async startWithBase(baseRef: string, baseSha: string): Promise<boolean> {
        if (!(await this.git.isRepo())) {
            vscode.window.showErrorMessage('Local Review: this folder is not a git repository.');
            return false;
        }
        const cfg = vscode.workspace.getConfiguration('localReview');
        const includeUntracked = cfg.get<boolean>('includeUntracked', true);
        let changed: ChangedFile[];
        try {
            changed = await this.git.changedFiles(baseSha, includeUntracked);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Local Review: failed to compute diff: ${e?.message ?? e}`);
            return false;
        }
        const headSha = await this.git.headSha();
        await this.store.setBase(this.workspaceUri.toString(), baseRef, baseSha, headSha);
        this.changedFiles = changed;
        this.viewMode = { kind: 'overall' };
        this.viewFiles = changed;
        this.commentingFiles = this.computeCommentingSet(changed);
        this.setupController();
        await vscode.commands.executeCommand('setContext', ACTIVE_CONTEXT_KEY, true);
        this.provider.refreshAll(changed.map(f => baseUri(f.oldPath ?? f.path, baseSha)));
        this.attachAutoRefresh();
        try {
            await vscode.commands.executeCommand('localReview.activeReview.focus');
        } catch {
            /* ignore */
        }
        this._onDidChange.fire();
        vscode.window.showInformationMessage(
            `Local Review: ${changed.length} changed file(s) vs ${baseRef}. Click any file in the Review view to open its diff.`,
        );
        return true;
    }

    // ----- View mode (overall vs per-round) -----

    /**
     * Switch the file list / diff base used by the Review view.
     * - 'overall' shows files changed since the review's base ref.
     * - { kind: 'round', n } shows files changed since round n's HEAD snapshot
     *   (useful for seeing what the agent changed in that specific round).
     */
    async setViewMode(mode: ViewMode): Promise<void> {
        this.viewMode = mode;
        await this.recomputeViewFiles();
        this._onDidChange.fire();
    }

    /** Recompute viewFiles for the current viewMode. Cheap; cached until next change. */
    private async recomputeViewFiles(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('localReview');
        const includeUntracked = cfg.get<boolean>('includeUntracked', true);
        if (this.viewMode.kind === 'overall') {
            this.viewFiles = this.changedFiles;
            return;
        }
        // Round mode: compute git diff workingTree vs the round's HEAD snapshot.
        try {
            this.viewFiles = await this.git.changedFiles(this.viewMode.sha, includeUntracked);
        } catch (e) {
            console.warn('[localReview] recomputeViewFiles failed', e);
            this.viewFiles = [];
        }
    }

    // ----- Batch operations -----

    async resolveAllInFile(file: string): Promise<number> {
        const targets = this.store.threads().filter(t => isFileThread(t) && t.file === file && t.status === 'open');
        for (const t of targets) await this.store.setThreadStatus(t.id, 'resolved');
        for (const t of targets) {
            const stored = this.store.findThread(t.id);
            if (stored) this.syncThreadVisibility(stored);
        }
        if (targets.length > 0) this._onDidChange.fire();
        return targets.length;
    }

    async deleteAllAgentThreads(): Promise<number> {
        const ids = this.store
            .threads()
            .filter(t => t.origin === 'agent')
            .map(t => t.id);
        for (const id of ids) {
            await this.store.deleteThread(id);
            const vs = this.vsThreads.get(id);
            if (vs) {
                vs.dispose();
                this.vsThreads.delete(id);
            }
        }
        if (ids.length > 0) this._onDidChange.fire();
        return ids.length;
    }

    async resolveAllOpen(): Promise<number> {
        const open = this.store.threads().filter(t => t.status === 'open');
        for (const t of open) await this.store.setThreadStatus(t.id, 'resolved');
        for (const t of open) {
            const stored = this.store.findThread(t.id);
            if (stored) this.syncThreadVisibility(stored);
        }
        if (open.length > 0) this._onDidChange.fire();
        return open.length;
    }

    // ----- Next/prev comment navigation -----

    async navigateComment(direction: 'next' | 'previous'): Promise<void> {
        const ordered = [...this.store.threads()]
            .filter(isFileThread)
            .filter(t => t.status === 'open')
            .sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);
        if (ordered.length === 0) {
            vscode.window.showInformationMessage('Local Review: no open comments.');
            return;
        }
        // Find current position: thread whose location matches the active editor's selection.
        let curIdx = -1;
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const rel = this.relPathOf(editor.document.uri);
            const line = editor.selection.active.line + 1;
            curIdx = ordered.findIndex(t => t.file === rel && t.startLine === line);
            if (curIdx === -1) {
                // No exact match — pick the nearest by file + line.
                const sameFile = ordered.map((t, i) => ({ t, i })).filter(x => x.t.file === rel);
                if (sameFile.length > 0) {
                    if (direction === 'next') {
                        const after = sameFile.find(x => x.t.startLine > line);
                        curIdx = after ? after.i - 1 : sameFile[sameFile.length - 1]!.i;
                    } else {
                        const before = [...sameFile].reverse().find(x => x.t.startLine < line);
                        curIdx = before ? before.i + 1 : sameFile[0]!.i;
                    }
                }
            }
        }
        const next =
            direction === 'next'
                ? ordered[(curIdx + 1 + ordered.length) % ordered.length]!
                : ordered[(curIdx - 1 + ordered.length) % ordered.length]!;
        await this.openThreadLocation(next.id);
    }

    /** Pick a base ref (with multi-step UX) and resolve to an immutable diff base SHA. */
    private async pickBaseRef(): Promise<{ ref: string; sha: string } | undefined> {
        const cfg = vscode.workspace.getConfiguration('localReview');
        const useMergeBase = cfg.get<boolean>('useMergeBase', true);
        const configured = (cfg.get<string>('defaultBaseRef') || '').trim();

        let chosenRef: string | undefined;
        if (configured) {
            if (await this.git.refExists(configured)) chosenRef = configured;
            else
                vscode.window.showWarningMessage(
                    `Local Review: configured base ref '${configured}' not found; falling back to detection.`,
                );
        }

        if (!chosenRef) {
            const candidates = await this.git.candidateBaseRefs();
            const items: (vscode.QuickPickItem & { ref?: string; custom?: boolean })[] = candidates.map(r => ({
                label: r,
                description: r === candidates[0] ? '(detected default)' : undefined,
                ref: r,
            }));
            items.push({ label: '$(edit) Enter custom ref…', custom: true });
            const picked = await vscode.window.showQuickPick(items, {
                title: 'Local Review: pick base ref',
                placeHolder: 'Diff your working tree against this ref',
            });
            if (!picked) return undefined;
            if (picked.custom) {
                const entered = await vscode.window.showInputBox({
                    title: 'Local Review: enter base ref',
                    prompt: 'Branch, tag, or revision (e.g. HEAD~1, v1.2.3)',
                    value: 'HEAD~1',
                });
                if (!entered) return undefined;
                if (!(await this.git.refExists(entered))) {
                    vscode.window.showErrorMessage(`Local Review: ref '${entered}' does not exist.`);
                    return undefined;
                }
                chosenRef = entered;
            } else {
                chosenRef = picked.ref;
            }
        }
        if (!chosenRef) return undefined;

        let sha: string;
        if (useMergeBase) {
            const mb = await this.git.mergeBase(chosenRef);
            sha = mb ?? (await this.git.revParse(chosenRef));
        } else {
            sha = await this.git.revParse(chosenRef);
        }
        return { ref: chosenRef, sha };
    }

    /** Start (or restart) a review. Returns true if it was started. */
    async start(): Promise<boolean> {
        if (!(await this.git.isRepo())) {
            vscode.window.showErrorMessage(
                `Local Review: '${this.workspaceUri.fsPath}' is not inside a git repository.`,
            );
            return false;
        }

        const picked = await this.pickBaseRef();
        if (!picked) return false;

        const headSha = await this.git.headSha();
        const cfg = vscode.workspace.getConfiguration('localReview');
        const includeUntracked = cfg.get<boolean>('includeUntracked', true);
        const maxToOpen = Math.max(0, cfg.get<number>('maxFilesToOpen', 30));

        let changed: ChangedFile[];
        try {
            changed = await this.git.changedFiles(picked.sha, includeUntracked);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Local Review: failed to compute diff: ${e?.message ?? e}`);
            return false;
        }

        if (changed.length === 0) {
            const action = await vscode.window.showInformationMessage(
                `Local Review: no changes vs '${picked.ref}'.`,
                'Pick Different Base',
                `Toggle Untracked (now ${includeUntracked ? 'on' : 'off'})`,
            );
            if (action === 'Pick Different Base') return this.start();
            if (action && action.startsWith('Toggle Untracked')) {
                await cfg.update('includeUntracked', !includeUntracked, vscode.ConfigurationTarget.Workspace);
                return this.start();
            }
            return false;
        }

        const prev = this.store.getState();
        if (prev.baseSha && (prev.baseSha !== picked.sha || prev.folderUri !== this.workspaceUri.toString())) {
            const action = await vscode.window.showWarningMessage(
                `An existing review against '${prev.baseRef ?? prev.baseSha}' has ${prev.threads.length} comment(s). Discard and start a new review against '${picked.ref}'?`,
                { modal: true },
                'Discard and Restart',
            );
            if (action !== 'Discard and Restart') return false;
            await this.store.clear();
        }

        this.tearDown();
        await this.store.setBase(this.workspaceUri.toString(), picked.ref, picked.sha, headSha);
        this.changedFiles = changed;
        this.viewMode = { kind: 'overall' };
        this.viewFiles = changed;
        this.commentingFiles = this.computeCommentingSet(changed);
        this.setupController();
        await vscode.commands.executeCommand('setContext', ACTIVE_CONTEXT_KEY, true);

        for (const t of this.store.threads()) if (isFileThread(t)) this.materializeThread(t);
        this.provider.refreshAll(changed.map(f => baseUri(f.oldPath ?? f.path, picked.sha)));
        await this.openDiffs(changed, picked.sha, picked.ref, maxToOpen);
        this.attachAutoRefresh();

        try {
            await vscode.commands.executeCommand('localReview.activeReview.focus');
        } catch {
            /* ignore */
        }

        this._onDidChange.fire();
        const openedNote =
            maxToOpen === 0
                ? ' — click any file in the Review view to open its diff.'
                : changed.length > maxToOpen
                  ? ` (opened first ${maxToOpen}).`
                  : '.';
        vscode.window.showInformationMessage(
            `Local Review started: ${changed.length} file(s) vs ${picked.ref}${openedNote}`,
        );
        return true;
    }

    private computeCommentingSet(changed: ChangedFile[]): Set<string> {
        const s = new Set<string>();
        for (const f of changed) {
            s.add(f.path);
            if (f.oldPath) s.add(f.oldPath);
        }
        return s;
    }

    async openAllDiffs(): Promise<void> {
        if (!this.isActive) {
            vscode.window.showWarningMessage('Local Review: no active review.');
            return;
        }
        const sha = this.currentViewBaseSha();
        if (!sha) return;
        await this.openDiffs(this.viewFiles, sha, this.currentViewBaseLabel(), this.viewFiles.length);
    }

    /**
     * Open every changed file in a single multi-diff editor (VS Code 1.86+).
     * Similar to GitHub's "Files Changed" tab — one scrollable page, no tab flood.
     * Falls back to a message if the API isn't available.
     */
    async openAllChangesInOnePane(): Promise<void> {
        if (!this.isActive) {
            vscode.window.showWarningMessage('Local Review: no active review.');
            return;
        }
        const sha = this.currentViewBaseSha();
        if (!sha || this.viewFiles.length === 0) {
            vscode.window.showInformationMessage('Local Review: no changes to show.');
            return;
        }
        const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = this.viewFiles.map(f => {
            const left = baseUri(f.oldPath ?? f.path, sha);
            const right =
                f.status === 'D' ? emptyUri(f.path, 'deleted') : vscode.Uri.joinPath(this.workspaceUri, f.path);
            const label = right;
            return [label, left, right];
        });
        const title = `Local Review · ${this.currentViewBaseLabel()} · ${this.viewFiles.length} file${this.viewFiles.length === 1 ? '' : 's'}`;
        try {
            await vscode.commands.executeCommand('vscode.changes', title, resources);
        } catch (e) {
            // Older VS Code: fall back to a clear message + offer the multi-tab option as a backup.
            console.warn('[localReview] vscode.changes not available', e);
            const action = await vscode.window.showWarningMessage(
                'Local Review: multi-diff editor requires VS Code 1.86 or newer. Open each file in its own tab instead?',
                'Open Each',
            );
            if (action === 'Open Each') await this.openAllDiffs();
        }
    }

    async openSingleDiff(filePath: string): Promise<void> {
        // Robust lookup: exact match, then case-insensitive, then trimmed.
        const f = findFile(this.viewFiles, filePath) ?? findFile(this.changedFiles, filePath);
        const sha = this.currentViewBaseSha();
        if (!sha) {
            vscode.window.showWarningMessage('Local Review: no active review.');
            return;
        }
        if (f) {
            await this.openDiff(f, sha, this.currentViewBaseLabel());
            return;
        }
        // File not in changed-set for current view. Still useful actions: open the workspace file
        // (so the user can read comments inline) instead of an unhelpful warning toast.
        const fallbackUri = vscode.Uri.joinPath(this.workspaceUri, filePath);
        try {
            await vscode.workspace.fs.stat(fallbackUri);
            const action = await vscode.window.showInformationMessage(
                `'${filePath}' isn't in the current view's changed set. Open the workspace file instead?`,
                'Open File',
                'Switch View',
            );
            if (action === 'Open File') {
                const doc = await vscode.workspace.openTextDocument(fallbackUri);
                await vscode.window.showTextDocument(doc, { preview: false });
            } else if (action === 'Switch View') {
                await vscode.commands.executeCommand('localReview.selectViewMode');
            }
        } catch {
            vscode.window.showWarningMessage(
                `Local Review: '${filePath}' is not in the active review and not on disk.`,
            );
        }
    }

    private async openDiffs(files: ChangedFile[], baseSha: string, baseLabel: string, max: number) {
        for (const f of files.slice(0, max)) {
            try {
                await this.openDiff(f, baseSha, baseLabel);
            } catch (e) {
                console.warn('[localReview] failed to open diff', f, e);
            }
        }
    }

    private async openDiff(f: ChangedFile, baseSha: string, baseLabel: string) {
        const left = baseUri(f.oldPath ?? f.path, baseSha);
        const right = f.status === 'D' ? emptyUri(f.path, 'deleted') : vscode.Uri.joinPath(this.workspaceUri, f.path);
        const renamed = f.oldPath && f.oldPath !== f.path ? ` (was ${f.oldPath})` : '';
        const statusTag = f.status === 'D' ? ' [deleted]' : f.status === 'A' ? ' [added]' : '';
        const title = `${f.path}${renamed}${statusTag} ↔ ${baseLabel}`;
        await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: false });
    }

    private setupController() {
        if (this.controller) return;
        const controller = vscode.comments.createCommentController('localReview', 'Local Code Review');
        controller.commentingRangeProvider = {
            provideCommentingRanges: doc => {
                const rel = this.relPathOf(doc.uri);
                if (rel && this.commentingFiles.has(rel)) {
                    return this.commentingRangesFor(doc);
                }
                return [];
            },
        };
        controller.options = {
            prompt: 'Review comment for the agent',
            placeHolder: 'e.g. rename to fooBar; handle null',
        };
        this.controller = controller;
        this.disposables.push(controller);
    }

    private commentingRangesFor(doc: vscode.TextDocument): vscode.Range[] {
        const selectionRange = activeSelectionCommentRange(doc);
        const lineRanges = this.cachedLineCommentRanges(doc);
        return selectionRange ? [selectionRange, ...lineRanges] : lineRanges;
    }

    private cachedLineCommentRanges(doc: vscode.TextDocument): vscode.Range[] {
        const key = doc.uri.toString();
        const cached = this.commentingRangeCache.get(key);
        if (cached && cached.version === doc.version && cached.lineCount === doc.lineCount) {
            return cached.ranges;
        }
        const ranges = lineCommentRanges(doc.lineCount);
        if (this.commentingRangeCache.size > 64) this.commentingRangeCache.clear();
        this.commentingRangeCache.set(key, { version: doc.version, lineCount: doc.lineCount, ranges });
        return ranges;
    }

    private relPathOf(uri: vscode.Uri): string | undefined {
        if (uri.scheme === 'file') {
            const rel = path.relative(this.workspaceUri.fsPath, uri.fsPath);
            if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
            return rel.replace(/\\/g, '/');
        }
        if (uri.scheme === BASE_SCHEME || uri.scheme === EMPTY_SCHEME) {
            return uri.path.replace(/^\//, '');
        }
        return undefined;
    }

    private sideOf(uri: vscode.Uri): Side {
        return uri.scheme === BASE_SCHEME ? 'left' : 'right';
    }

    private currentPathFor(rel: string): string {
        const f = this.changedFiles.find(x => x.path === rel || x.oldPath === rel);
        return f ? f.path : rel;
    }

    private oldPathFor(rel: string): string | undefined {
        const f = this.changedFiles.find(x => x.path === rel || x.oldPath === rel);
        if (!f || !f.oldPath || f.oldPath === f.path) return undefined;
        return f.oldPath;
    }

    /** Invoked from the gutter `+` flow on an empty CommentThread. */
    async handleCreateFromReply(reply: vscode.CommentReply): Promise<void> {
        if (!this.controller) {
            vscode.window.showWarningMessage('Local Review: no active review. Run "Local Review: Start Review" first.');
            reply.thread.dispose();
            return;
        }
        const text = reply.text?.trim();
        if (!text) {
            reply.thread.dispose();
            return;
        }
        const uri = reply.thread.uri;
        const rel = this.relPathOf(uri);
        if (!rel || !this.commentingFiles.has(rel)) {
            vscode.window.showWarningMessage('Local Review: this file is not part of the active review.');
            reply.thread.dispose();
            return;
        }
        const range = reply.thread.range;
        if (!range) {
            vscode.window.showWarningMessage('Local Review: cannot resolve comment line range.');
            reply.thread.dispose();
            return;
        }
        const side = this.sideOf(uri);
        const doc = await this.openDocSafe(uri);
        const excerpt = doc ? excerptFromDoc(doc, range.start.line + 1, range.end.line + 1) : '';

        let stored: ReviewThread;
        try {
            stored = await this.store.addThread(
                {
                    file: this.currentPathFor(rel),
                    oldFile: this.oldPathFor(rel),
                    startLine: range.start.line + 1,
                    endLine: range.end.line + 1,
                    side,
                    excerpt,
                },
                text,
                this.author(),
            );
        } catch (e: any) {
            vscode.window.showErrorMessage(`Local Review: failed to save comment: ${e?.message ?? e}`);
            reply.thread.dispose();
            return;
        }

        // Reuse the existing thread (don't dispose + recreate — that flickers and steals focus).
        reply.thread.canReply = true;
        reply.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        this.refreshThreadComments(reply.thread, stored);
        this.applyStatusVisuals(reply.thread, stored);
        this.vsThreads.set(stored.id, reply.thread);
        this._onDidChange.fire();
    }

    async handleReply(reply: vscode.CommentReply): Promise<void> {
        const text = reply.text?.trim();
        if (!text) return;
        const threadId = extractThreadId(reply.thread);
        if (!threadId) {
            vscode.window.showWarningMessage('Local Review: cannot reply to this thread.');
            return;
        }
        try {
            await this.store.addReply(threadId, text, this.author());
        } catch (e: any) {
            vscode.window.showErrorMessage(`Local Review: failed to save reply: ${e?.message ?? e}`);
            return;
        }
        const stored = this.store.findThread(threadId);
        if (stored) this.refreshThreadComments(reply.thread, stored);
        this._onDidChange.fire();
    }

    async deleteThreadCommand(arg: vscode.CommentThread | string | { thread?: ReviewThread }): Promise<void> {
        const threadId = extractThreadId(arg);
        if (!threadId) return;
        try {
            await this.store.deleteThread(threadId);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Local Review: failed to delete: ${e?.message ?? e}`);
            return;
        }
        const vs = this.vsThreads.get(threadId);
        if (vs) {
            vs.dispose();
            this.vsThreads.delete(threadId);
        }
        this._onDidChange.fire();
    }

    async setThreadStatusCommand(
        arg: vscode.CommentThread | string | { thread?: ReviewThread },
        status: 'open' | 'resolved',
    ): Promise<void> {
        const threadId = extractThreadId(arg);
        if (!threadId) return;
        try {
            await this.store.setThreadStatus(threadId, status);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Local Review: failed to update: ${e?.message ?? e}`);
            return;
        }
        const stored = this.store.findThread(threadId);
        if (stored) this.syncThreadVisibility(stored);
        this._onDidChange.fire();
    }

    async replyToThreadCommand(arg: vscode.CommentThread | string | { thread?: ReviewThread }): Promise<void> {
        const threadId = extractThreadId(arg);
        if (!threadId) return;
        const thread = this.store.findThread(threadId);
        if (!thread) {
            vscode.window.showWarningMessage('Local Review: that comment no longer exists.');
            return;
        }
        const body = await vscode.window.showInputBox({
            title: isFileThread(thread)
                ? `Reply to ${thread.file}:${thread.startLine}`
                : 'Reply to review-wide comment',
            prompt: 'Add a reply to this review thread.',
        });
        if (!body) return;
        try {
            await this.store.addReply(threadId, body, this.author());
        } catch (e: any) {
            vscode.window.showErrorMessage(`Local Review: failed to save reply: ${e?.message ?? e}`);
            return;
        }
        const stored = this.store.findThread(threadId);
        const vs = this.vsThreads.get(threadId);
        if (stored && vs) this.refreshThreadComments(vs, stored);
        this._onDidChange.fire();
    }

    async openThreadLocation(threadId: string): Promise<void> {
        const t = await this.reanchorThreadFromStoredPosition(threadId);
        if (!t) return;
        if (!isFileThread(t)) {
            await vscode.commands.executeCommand('localReview.activeReview.focus');
            vscode.window.showInformationMessage('Local Review: this is a review-wide comment with no file location.');
            return;
        }
        const baseSha = this.baseSha;
        let uri: vscode.Uri;
        if (t.side === 'left' && baseSha) {
            uri = baseUri(t.oldFile ?? t.file, baseSha);
        } else {
            const f = this.changedFiles.find(x => x.path === t.file);
            uri = f?.status === 'D' ? emptyUri(t.file, 'deleted') : vscode.Uri.joinPath(this.workspaceUri, t.file);
        }
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, { preview: false });
            const start = new vscode.Position(Math.max(0, t.startLine - 1), 0);
            const end = new vscode.Position(Math.max(0, t.endLine - 1), 0);
            editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
            editor.selection = new vscode.Selection(start, end);
            const vs = this.vsThreads.get(threadId);
            if (vs) vs.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        } catch (e: any) {
            vscode.window.showErrorMessage(`Local Review: cannot open ${t.file}: ${e?.message ?? e}`);
        }
    }

    async addCommentFromSelection(): Promise<void> {
        if (!this.isActive) {
            const action = await vscode.window.showWarningMessage(
                'Local Review: start a review first.',
                'Start Review',
            );
            if (action === 'Start Review') await vscode.commands.executeCommand('localReview.start');
            return;
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('Local Review: no active editor.');
            return;
        }
        const rel = this.relPathOf(editor.document.uri);
        if (!rel || !this.commentingFiles.has(rel)) {
            const action = await vscode.window.showWarningMessage(
                'Local Review: this file is not part of the active review.',
                'Open Changed Files',
            );
            if (action === 'Open Changed Files') await this.openAllDiffs();
            return;
        }
        const sel = editor.selection;
        const startLine = sel.start.line + 1;
        const endLine = (sel.isEmpty ? sel.start.line : sel.end.line) + 1;
        const body = await vscode.window.showInputBox({
            title: `Review comment on ${rel}:${startLine === endLine ? startLine : `${startLine}-${endLine}`}`,
            prompt: 'What should the agent change? (Use the gutter + button for multi-line comments.)',
        });
        if (!body) return;
        try {
            const stored = await this.store.addThread(
                {
                    file: this.currentPathFor(rel),
                    oldFile: this.oldPathFor(rel),
                    startLine,
                    endLine,
                    side: this.sideOf(editor.document.uri),
                    excerpt: excerptFromDoc(editor.document, startLine, endLine),
                },
                body,
                this.author(),
            );
            this.materializeThread(stored);
            this._onDidChange.fire();
        } catch (e: any) {
            vscode.window.showErrorMessage(`Local Review: failed to save comment: ${e?.message ?? e}`);
        }
    }

    async addReviewComment(): Promise<void> {
        if (!this.isActive) {
            const action = await vscode.window.showWarningMessage(
                'Local Review: start a review first.',
                'Start Review',
            );
            if (action === 'Start Review') await vscode.commands.executeCommand('localReview.start');
            return;
        }
        const body = await vscode.window.showInputBox({
            title: 'Add review-wide comment',
            prompt: 'Use this for feedback that is not tied to a specific file or line.',
        });
        if (!body) return;
        try {
            await this.store.addReviewThread(body, this.author());
            await vscode.commands.executeCommand('localReview.activeReview.focus');
            this._onDidChange.fire();
        } catch (e: any) {
            vscode.window.showErrorMessage(`Local Review: failed to save review comment: ${e?.message ?? e}`);
        }
    }

    /** End the review. Always confirms (so the user doesn't lose work accidentally). */
    async end(): Promise<void> {
        const threads = this.store.threads().length;
        const message =
            threads > 0
                ? `End review and discard ${threads} comment(s)? Export the prompt first if you want to keep them.`
                : 'End the active review?';
        const action = await vscode.window.showWarningMessage(message, { modal: true }, 'End Review');
        if (action !== 'End Review') return;
        await this.store.clear();
        this.tearDown();
        vscode.window.showInformationMessage('Local Review ended.');
    }

    /**
     * Re-render the gutter UI for the given thread IDs against the latest store
     * state. Used after external mutations (e.g. agent reply imports) so the
     * agent's reply shows up in the comment widget without restarting the review.
     */
    refreshThreads(ids: string[]): void {
        for (const id of ids) {
            const stored = this.store.findThread(id);
            const vs = this.vsThreads.get(id);
            if (stored) {
                this.syncThreadVisibility(stored);
                const visible = this.vsThreads.get(id);
                if (visible) visible.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
            } else if (!stored && vs) {
                vs.dispose();
                this.vsThreads.delete(id);
            }
        }
        this._onDidChange.fire();
    }

    /** Re-render every gutter thread + materialize any new ones. Used after external store changes. */
    rerenderAll(): void {
        if (!this.controller) return;
        const seen = new Set<string>();
        for (const t of this.store.threads()) {
            if (!isFileThread(t)) continue;
            if (!this.threadPassesCommentFilter(t)) continue;
            seen.add(t.id);
            const vs = this.vsThreads.get(t.id);
            if (vs) {
                this.refreshThreadComments(vs, t);
                this.applyStatusVisuals(vs, t);
            } else {
                // Newly-appeared thread (e.g. agent newThread imported elsewhere).
                this.commentingFiles.add(t.file);
                this.materializeThread(t);
            }
        }
        for (const id of [...this.vsThreads.keys()]) {
            if (!seen.has(id)) {
                const vs = this.vsThreads.get(id);
                vs?.dispose();
                this.vsThreads.delete(id);
            }
        }
        this._onDidChange.fire();
    }

    /** Re-detect changed files and update head SHA without losing comments. */
    async refresh(opts: { silent?: boolean } = {}): Promise<void> {
        const baseSha = this.baseSha;
        if (!baseSha) {
            if (!opts.silent) vscode.window.showWarningMessage('Local Review: no active review to refresh.');
            return;
        }
        const cfg = vscode.workspace.getConfiguration('localReview');
        const includeUntracked = cfg.get<boolean>('includeUntracked', true);
        try {
            const changed = await this.git.changedFiles(baseSha, includeUntracked);
            const headSha = await this.git.headSha();
            const changeKey = signatureOf(changed) + '|' + headSha;
            const prevKey = signatureOf(this.changedFiles) + '|' + (this.store.getState().headSha ?? '');
            const nothingChanged = changeKey === prevKey;
            this.changedFiles = changed;
            this.commentingFiles = this.computeCommentingSet(changed);
            for (const t of this.store.threads()) if (isFileThread(t)) this.commentingFiles.add(t.file);
            const remappedThreads = await this.reanchorThreadsFromStoredPositions();
            if (!nothingChanged) {
                await this.store.updateHead(headSha);
                this.provider.refreshAll(changed.map(f => baseUri(f.oldPath ?? f.path, baseSha)));
                // Also refresh viewFiles for the current view mode.
                await this.recomputeViewFiles();
                this._onDidChange.fire();
            } else {
                // Still recompute view files in case e.g. round mode files changed under us.
                await this.recomputeViewFiles();
            }
            if (remappedThreads > 0) this._onDidChange.fire();
            if (!opts.silent) {
                vscode.window.showInformationMessage(
                    nothingChanged
                        ? `Local Review: up to date (${changed.length} changed file(s)).`
                        : `Local Review refreshed: ${changed.length} changed file(s).`,
                );
            }
        } catch (e: any) {
            if (!opts.silent) vscode.window.showErrorMessage(`Local Review: refresh failed: ${e?.message ?? e}`);
            else console.warn('[localReview] silent refresh failed', e);
        }
    }

    /**
     * Returns hunks for every file that has at least one open or resolved comment
     * (so the exporter can include surrounding diff context).
     */
    async hunksForCommentedFiles(contextLines = 3): Promise<Map<string, DiffHunk[]>> {
        const baseSha = this.baseSha;
        const out = new Map<string, DiffHunk[]>();
        if (!baseSha) return out;
        const files = new Set<string>(
            this.store
                .threads()
                .filter(isFileThread)
                .map(t => t.file),
        );
        for (const file of files) {
            try {
                const hunks = await this.git.fileHunks(baseSha, file, contextLines);
                if (hunks.length > 0) out.set(file, hunks);
            } catch {
                /* ignore per-file failures */
            }
        }
        return out;
    }

    private async reanchorThreadsFromStoredPositions(): Promise<number> {
        const hunkCache = new Map<string, DiffHunk[]>();
        let changed = 0;
        for (const thread of this.store.threads()) {
            if (!isFileThread(thread)) continue;
            const before = `${thread.startLine}:${thread.endLine}`;
            const updated = await this.reanchorThread(thread, hunkCache);
            if (updated && isFileThread(updated) && `${updated.startLine}:${updated.endLine}` !== before) {
                changed++;
            }
        }
        return changed;
    }

    private async reanchorThreadFromStoredPosition(threadId: string): Promise<ReviewThread | undefined> {
        const thread = this.store.findThread(threadId);
        if (!thread) return undefined;
        if (!isFileThread(thread)) return thread;
        return (await this.reanchorThread(thread, new Map())) ?? this.store.findThread(threadId);
    }

    private async reanchorThread(
        thread: ReviewThread,
        hunkCache: Map<string, DiffHunk[]>,
    ): Promise<ReviewThread | undefined> {
        if (!isFileThread(thread)) return thread;
        if (thread.side !== 'right') return thread;
        if (!thread.anchorSha || !thread.anchorStartLine || !thread.anchorEndLine) return thread;
        const file = thread.anchorFile ?? thread.file;
        const current = this.changedFiles.find(f => f.path === thread.file);
        if (current?.status === 'D') return thread;

        const cacheKey = `${thread.anchorSha}\0${file}`;
        let hunks = hunkCache.get(cacheKey);
        if (!hunks) {
            hunks = await this.git.fileHunks(thread.anchorSha, file, 0);
            hunkCache.set(cacheKey, hunks);
        }
        if (hunks.length === 0) return thread;

        const mapped = mapRangeThroughHunks(
            { startLine: thread.anchorStartLine, endLine: thread.anchorEndLine },
            hunks,
        );
        const doc = await this.openDocSafe(vscode.Uri.joinPath(this.workspaceUri, thread.file));
        const clamped = clampLineRange(mapped.startLine, mapped.endLine, doc?.lineCount);
        if (clamped.startLine === thread.startLine && clamped.endLine === thread.endLine) return thread;

        const pending = this.stickyPendingPersist.get(thread.id);
        if (pending) {
            clearTimeout(pending);
            this.stickyPendingPersist.delete(thread.id);
        }
        await this.store.updateThreadRange(thread.id, {
            startLine: clamped.startLine,
            endLine: clamped.endLine,
            startChar: thread.startChar,
            endChar: thread.endChar,
        });
        const updated = this.store.findThread(thread.id);
        if (updated) {
            const vs = this.vsThreads.get(thread.id);
            if (vs) vs.range = rangeFromThread(updated);
            return updated;
        }
        return undefined;
    }

    private threadPassesCommentFilter(thread: ReviewThread): boolean {
        if (this.commentFilter === 'open') return thread.status === 'open';
        if (this.commentFilter === 'resolved') return thread.status === 'resolved';
        return true;
    }

    private syncThreadVisibility(thread: ReviewThread): void {
        const vs = this.vsThreads.get(thread.id);
        if (!this.threadPassesCommentFilter(thread)) {
            if (vs) {
                vs.dispose();
                this.vsThreads.delete(thread.id);
            }
            return;
        }
        if (vs) {
            this.refreshThreadComments(vs, thread);
            this.applyStatusVisuals(vs, thread);
        } else {
            this.materializeThread(thread);
        }
    }

    private materializeThread(thread: ReviewThread) {
        if (!isFileThread(thread)) return;
        if (!this.threadPassesCommentFilter(thread)) return;
        if (!this.controller) this.setupController();
        const baseSha = this.baseSha;
        let uri: vscode.Uri;
        if (thread.side === 'left' && baseSha) {
            uri = baseUri(thread.oldFile ?? thread.file, baseSha);
        } else {
            const f = this.changedFiles.find(x => x.path === thread.file);
            uri =
                f?.status === 'D'
                    ? emptyUri(thread.file, 'deleted')
                    : vscode.Uri.joinPath(this.workspaceUri, thread.file);
        }
        const vs = this.controller!.createCommentThread(uri, rangeFromThread(thread), []);
        vs.canReply = true;
        vs.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        this.vsThreads.set(thread.id, vs);
        this.refreshThreadComments(vs, thread);
        this.applyStatusVisuals(vs, thread);
    }

    private refreshThreadComments(vs: vscode.CommentThread, thread: ReviewThread) {
        vs.comments = thread.comments.map(c => {
            const isAgent = c.origin === 'agent';
            return {
                author: { name: isAgent ? `🤖 ${c.author}` : c.author },
                body: new vscode.MarkdownString(c.body),
                mode: vscode.CommentMode.Preview,
                contextValue: `${thread.id}:${c.id}`,
                timestamp: parseDate(c.createdAt),
            };
        });
        vs.contextValue = thread.id;
    }

    private applyStatusVisuals(vs: vscode.CommentThread, thread: ReviewThread) {
        const originLabel = thread.origin === 'agent' ? '🤖 agent · ' : '';
        if (thread.status === 'resolved') {
            vs.label = `${originLabel}Resolved`;
            vs.state = vscode.CommentThreadState.Resolved;
        } else {
            vs.label = originLabel || undefined;
            vs.state = vscode.CommentThreadState.Unresolved;
        }
        vs.contextValue = thread.id;
    }

    private async openDocSafe(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
        try {
            return await vscode.workspace.openTextDocument(uri);
        } catch {
            return undefined;
        }
    }

    private author(): string {
        return vscode.workspace.getConfiguration('localReview').get<string>('author') || 'You';
    }

    /** Re-hydrate a previously persisted review without re-running the picker. */
    async hydrateFromStore(): Promise<boolean> {
        const state = this.store.getState();
        if (!state.baseSha) return false;
        // Folder URI mismatch: log a warning but still hydrate. URI normalization may differ
        // across restarts (case, trailing slash), and we don't want to silently drop comments.
        if (state.folderUri && !sameWorkspace(state.folderUri, this.workspaceUri.toString())) {
            console.warn('[localReview] folderUri mismatch; hydrating anyway', {
                stored: state.folderUri,
                current: this.workspaceUri.toString(),
            });
        }
        if (!(await this.git.isRepo())) return false;
        const cfg = vscode.workspace.getConfiguration('localReview');
        const includeUntracked = cfg.get<boolean>('includeUntracked', true);
        try {
            this.changedFiles = await this.git.changedFiles(state.baseSha, includeUntracked);
        } catch (e) {
            console.warn('[localReview] changedFiles failed during hydrate', e);
            this.changedFiles = [];
        }
        this.viewMode = { kind: 'overall' };
        this.viewFiles = this.changedFiles;
        this.commentingFiles = this.computeCommentingSet(this.changedFiles);
        for (const t of state.threads) if (isFileThread(t)) this.commentingFiles.add(t.file);
        this.setupController();
        await vscode.commands.executeCommand('setContext', ACTIVE_CONTEXT_KEY, true);
        for (const t of state.threads) if (isFileThread(t)) this.materializeThread(t);
        this.attachAutoRefresh();
        this._onDidChange.fire();
        return true;
    }
}

function sameWorkspace(a: string, b: string): boolean {
    const norm = (s: string) => s.replace(/\/+$/, '').toLowerCase();
    return norm(a) === norm(b);
}

function extractThreadId(
    arg: vscode.CommentThread | string | { thread?: ReviewThread } | undefined,
): string | undefined {
    if (!arg) return undefined;
    if (typeof arg === 'string') return arg;
    if ('thread' in arg && arg.thread?.id) return arg.thread.id;
    const maybeThread = arg as vscode.CommentThread;
    return typeof maybeThread.contextValue === 'string' ? maybeThread.contextValue : undefined;
}

function excerptFromDoc(doc: vscode.TextDocument, startLine1: number, endLine1: number): string {
    const start = Math.max(0, startLine1 - 1);
    const end = Math.min(doc.lineCount, endLine1);
    const lines: string[] = [];
    for (let i = start; i < end; i++) lines.push(doc.lineAt(i).text);
    return lines.join('\n');
}

function parseDate(s: string): Date | undefined {
    const d = new Date(s);
    return isNaN(d.getTime()) ? undefined : d;
}

function signatureOf(files: ReadonlyArray<ChangedFile>): string {
    return files.map(f => `${f.status}:${f.path}:${f.oldPath ?? ''}`).join('|');
}

/** Robust file lookup: exact match, then forward-slash normalized, then case-insensitive (Windows). */
function findFile(list: ReadonlyArray<ChangedFile>, target: string): ChangedFile | undefined {
    if (!target) return undefined;
    let f = list.find(x => x.path === target);
    if (f) return f;
    const norm = (s: string) => s.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    const nt = norm(target);
    f = list.find(x => norm(x.path) === nt);
    if (f) return f;
    if (process.platform === 'win32') {
        const nl = nt.toLowerCase();
        f = list.find(x => norm(x.path).toLowerCase() === nl);
        if (f) return f;
    }
    return undefined;
}

function countLines(s: string): number {
    if (!s) return 0;
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
    return n;
}

function rangeFromThread(thread: ReviewThread): vscode.Range {
    if (!isFileThread(thread)) return new vscode.Range(0, 0, 0, 0);
    const start = Math.max(0, thread.startLine - 1);
    const end = Math.max(start, thread.endLine - 1);
    return new vscode.Range(start, 0, end, 0);
}

function clampLineRange(
    startLine: number,
    endLine: number,
    lineCount?: number,
): { startLine: number; endLine: number } {
    let start = Math.max(1, Math.floor(startLine));
    let end = Math.max(start, Math.floor(endLine));
    if (typeof lineCount === 'number' && lineCount > 0) {
        start = Math.min(start, lineCount);
        end = Math.min(Math.max(start, end), lineCount);
    }
    return { startLine: start, endLine: end };
}

function lineCommentRanges(lineCount: number): vscode.Range[] {
    const ranges: vscode.Range[] = [];
    for (let line = 0; line < lineCount; line++) {
        ranges.push(new vscode.Range(line, 0, line, 0));
    }
    return ranges;
}

function activeSelectionCommentRange(doc: vscode.TextDocument): vscode.Range | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== doc.uri.toString()) return undefined;
    const sel = editor.selection;
    if (sel.isEmpty || sel.start.line === sel.end.line) return undefined;
    return new vscode.Range(sel.start.line, 0, sel.end.line, sel.end.character);
}
