import * as vscode from 'vscode';
import * as path from 'path';
import { Git } from './git';
import { CommentStore, LastAgentInfo, ReviewState, StoreEvent } from './store';
import { BaseContentProvider, EmptyContentProvider, BASE_SCHEME, EMPTY_SCHEME } from './contentProvider';
import { ReviewSession, ViewMode } from './session';
import { ActiveReviewInfo, ActiveReviewTreeProvider, FilterMode, ReviewCatalogTreeProvider } from './treeProvider';
import { buildPrompt, buildJsonSidecar } from './exporter';
import { ResponseImporter, ImportResult } from './responseImporter';
import { ReviewPaths } from './paths';
import { buildAgentSkill } from './agentSkill';
import { ReviewCatalog, ReviewMeta } from './catalog';
import { containsControlChars, normalizeRepoPath } from './pathSafety';

// Module-level state — there is exactly one active review per VS Code window.
let extContext: vscode.ExtensionContext | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let catalog: ReviewCatalog | undefined;
let baseProvider: BaseContentProvider | undefined;
let session: ReviewSession | undefined;
let store: CommentStore | undefined;
let importer: ResponseImporter | undefined;
let tree: ActiveReviewTreeProvider | undefined;
let reviewCatalogTree: ReviewCatalogTreeProvider | undefined;
let activeReview: ReviewMeta | undefined;
let activeGit: Git | undefined;
let activePaths: ReviewPaths | undefined;
let activeGitInfo: Pick<ActiveReviewInfo, 'repoName' | 'repoPath' | 'branch' | 'upstream'> | undefined;
let responseWatcherDisposable: vscode.Disposable | undefined;
let parseFailRetry: NodeJS.Timeout | undefined;
let watcherDebounce: NodeJS.Timeout | undefined;
let nextBusyId = 1;
const busyActions: { id: number; label: string }[] = [];

let externalChangeEmitter: vscode.EventEmitter<void> | undefined;
const SKILL_INSTALLED_KEY_PREFIX = 'localReview.skillInstalled.';
const FILTER_KEY = 'localReview.filter';
const SHOW_OTHER_WORKSPACES_KEY = 'localReview.showOtherWorkspaces';
const PARSE_FAIL_RETRY_MS = 600;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    extContext = context;
    outputChannel = vscode.window.createOutputChannel('Local Review');
    context.subscriptions.push(outputChannel);
    externalChangeEmitter = new vscode.EventEmitter<void>();
    context.subscriptions.push(externalChangeEmitter);

    catalog = new ReviewCatalog(context.globalStorageUri);
    context.subscriptions.push(catalog);
    await catalog.load();

    baseProvider = new BaseContentProvider(makeStubGit());
    const emptyProvider = new EmptyContentProvider();
    context.subscriptions.push(
        baseProvider,
        vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, baseProvider),
        vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, emptyProvider),
    );

    reviewCatalogTree = new ReviewCatalogTreeProvider(
        {
            getCatalog: () => catalog!,
            getActiveReviewId: () => activeReview?.id,
            getShowOtherWorkspaces: () => !!extContext?.workspaceState.get<boolean>(SHOW_OTHER_WORKSPACES_KEY, false),
            getCurrentWorkspaceFolderUris: () => (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.toString()),
        },
        externalChangeEmitter.event,
    );
    tree = new ActiveReviewTreeProvider(
        () => store,
        {
            getChangedFiles: () => session?.changedFileList ?? [],
            getBaseRefLabel: () => activeReview?.baseRef ?? session?.baseRef,
            getLayoutMode: () => {
                const v = vscode.workspace.getConfiguration('localReview').get<string>('fileTreeStyle', 'compact');
                return v === 'flat' || v === 'tree' || v === 'compact' ? (v as any) : 'compact';
            },
            getCurrentRound: () => store?.currentRound()?.n,
            getViewModeLabel: () => viewModeLabel(),
            getActiveReview: () => activeReview,
            getReviewInfo: () => currentActiveReviewInfo(),
        },
        externalChangeEmitter.event,
    );
    context.subscriptions.push(
        reviewCatalogTree,
        tree,
        vscode.window.registerTreeDataProvider('localReview.reviews', reviewCatalogTree),
        vscode.window.registerTreeDataProvider('localReview.activeReview', tree),
    );
    const lastFilter = context.workspaceState.get<FilterMode>(FILTER_KEY);
    if (lastFilter) tree.setFilter(lastFilter);

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    context.subscriptions.push(statusBar);
    refreshStatusBar();

    // Try to restore the last-used review for the current workspace, then the last-used globally.
    const initial = await pickInitialReview();
    if (initial) {
        await openReview(initial, { silent: true });
    } else {
        outputChannel.appendLine('[activate] no active review; waiting for the user to pick or create one.');
    }

    // Migrate from v0.8 per-workspace storage if applicable.
    void maybeMigrateFromLegacyStorage(context);

    registerCommands(context);

    // First-run walkthrough.
    const seen = context.globalState.get<boolean>('localReview.seenWalkthrough.v9');
    if (!seen) {
        await context.globalState.update('localReview.seenWalkthrough.v9', true);
        setTimeout(() => {
            void showUsageCommand();
        }, 800);
    }
}

export function deactivate(): void {
    statusBar?.dispose();
}

function makeStubGit(): Git {
    return new Git(process.cwd());
}

// ----- Initial review resolution + open/switch -----

async function pickInitialReview(): Promise<ReviewMeta | undefined> {
    if (!catalog) return undefined;
    const folders = vscode.workspace.workspaceFolders ?? [];
    // Prefer the workspace folder containing the active editor.
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const preferred = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : folders[0];
    if (preferred) {
        const last = catalog.lastActiveFor(preferred.uri.toString());
        if (last && !last.archived) return last;
    }
    for (const f of folders) {
        const last = catalog.lastActiveFor(f.uri.toString());
        if (last && !last.archived) return last;
    }
    const global = catalog.lastActiveGlobal();
    if (global && !global.archived) return global;
    return undefined;
}

/** Tear down any current session and attach a new one for `meta`. */
async function openReview(meta: ReviewMeta, opts: { silent?: boolean } = {}): Promise<boolean> {
    if (!catalog || !baseProvider) return false;

    // Verify the folder exists.
    const folderUri = vscode.Uri.parse(meta.workspaceFolder);
    try {
        await vscode.workspace.fs.stat(folderUri);
    } catch {
        const action = await vscode.window.showWarningMessage(
            `Local Review: workspace folder for review '${meta.name}' is missing:\n${folderUri.fsPath}\nKeep the review or delete it?`,
            'Keep',
            'Delete Review',
        );
        if (action === 'Delete Review') {
            await catalog.delete(meta.id);
            refreshTreeAndStatus();
        }
        return false;
    }

    const paths = catalog.pathsFor(meta);
    await vscode.workspace.fs.createDirectory(paths.root);

    // Build / rebuild the per-review components.
    const git = new Git(folderUri.fsPath);
    const newStore = new CommentStore({ state: paths.state, stateBak: paths.stateBak });
    const loadResult = await newStore.load();
    outputChannel?.appendLine(
        `[openReview] ${meta.name} (${meta.id}): existed=${loadResult.existed} size=${loadResult.size ?? 0}B ` +
            `corrupt=${loadResult.corrupt} threads=${newStore.threads().length} rounds=${(newStore.getState().rounds ?? []).length}`,
    );
    if (loadResult.corrupt) {
        const action = await vscode.window.showErrorMessage(
            `Local Review: '${meta.name}' state could not be parsed.`,
            'Restore From Backup',
            'Discard',
            'Keep As-Is',
        );
        if (action === 'Restore From Backup') {
            const ok = await newStore.restoreFromBackup();
            vscode.window.showInformationMessage(ok ? 'Restored from backup.' : 'No backup available.');
        } else if (action === 'Discard') {
            await newStore.forceReplace({ threads: [] });
        }
    }
    newStore.attachExternalWatcher();

    // Tear down previous session/importer/store.
    detachResponseWatcher();
    if (session) session.dispose();
    if (store) store.dispose();

    store = newStore;
    activeReview = meta;
    activeGit = git;
    activePaths = paths;
    activeGitInfo = undefined;

    // Rebuild the base content provider with the new git.
    baseProvider.setGit(git);

    session = new ReviewSession(git, store, baseProvider, folderUri);
    session.setCommentFilter(tree?.getFilter() ?? 'all');
    extContext?.subscriptions.push(session);
    importer = new ResponseImporter(
        store,
        () => vscode.workspace.getConfiguration('localReview').get<string>('agentAuthor') || 'Agent',
    );

    // Wire store/session change handlers (these are session-lifetime, not extension-lifetime).
    const persistHandler = store.onDidChange(async (e: StoreEvent) => {
        if (e.kind === 'persistFailed') {
            void vscode.window.showErrorMessage(`Local Review: failed to persist comments: ${e.error.message}`);
        } else if (e.kind === 'changed' && e.reason === 'external') {
            session?.rerenderAll();
        }
        refreshTreeAndStatus();
        // Keep catalog stats fresh.
        if (catalog && activeReview && store) {
            const s = store.getState();
            await catalog.updateStats(activeReview.id, {
                threadCount: s.threads.length,
                openCount: s.threads.filter(t => t.status === 'open').length,
                rounds: (s.rounds ?? []).length,
                baseRef: s.baseRef ?? activeReview.baseRef,
                baseSha: s.baseSha ?? activeReview.baseSha,
                lastAgent: s.lastAgent ?? activeReview.lastAgent,
            });
        }
    });
    const sessionChangeHandler = session.onDidChange(() => {
        void refreshActiveGitInfo();
        refreshTreeAndStatus();
    });
    extContext?.subscriptions.push(persistHandler, sessionChangeHandler);

    // Hydrate if state already has a base; otherwise the user will call Start to pick one.
    if (store.getState().baseSha) {
        await session.hydrateFromStore();
    }

    setupResponseWatcher(paths.responses);
    await catalog.setActive(meta.id, meta.workspaceFolder);
    void refreshActiveGitInfo();
    refreshTreeAndStatus();

    if (!opts.silent) {
        vscode.window.showInformationMessage(
            `Local Review: opened '${meta.name}'${meta.baseRef ? ` (vs ${meta.baseRef})` : ''}.`,
        );
    }
    return true;
}

function detachResponseWatcher() {
    if (responseWatcherDisposable) {
        responseWatcherDisposable.dispose();
        responseWatcherDisposable = undefined;
    }
    if (watcherDebounce) {
        clearTimeout(watcherDebounce);
        watcherDebounce = undefined;
    }
    if (parseFailRetry) {
        clearTimeout(parseFailRetry);
        parseFailRetry = undefined;
    }
}

function setupResponseWatcher(responsesUri: vscode.Uri) {
    detachResponseWatcher();
    try {
        const dir = vscode.Uri.joinPath(responsesUri, '..');
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(dir, path.posix.basename(responsesUri.path)),
        );
        const trigger = () => {
            const cfg = vscode.workspace.getConfiguration('localReview');
            if (!cfg.get<boolean>('autoImportResponses', true)) return;
            if (watcherDebounce) clearTimeout(watcherDebounce);
            watcherDebounce = setTimeout(() => {
                void withLocalReviewStatus('Importing replies', () => importResponsesCommand({ explicit: false }));
            }, 350);
        };
        responseWatcherDisposable = vscode.Disposable.from(
            watcher,
            watcher.onDidCreate(trigger),
            watcher.onDidChange(trigger),
        );
    } catch (e) {
        outputChannel?.appendLine(`Could not watch responses.json: ${e}`);
    }
}

// ----- Status bar + tree refresh -----

function refreshTreeAndStatus() {
    reviewCatalogTree?.refresh();
    tree?.refresh();
    refreshStatusBar();
}

function currentActiveReviewInfo(): ActiveReviewInfo | undefined {
    if (!activeReview) return undefined;
    const state = store?.getState();
    const threads = state?.threads ?? [];
    return {
        repoName: activeGitInfo?.repoName,
        repoPath: activeGitInfo?.repoPath ?? activeReview.workspaceFolderFsPath,
        branch: activeGitInfo?.branch,
        upstream: activeGitInfo?.upstream,
        baseRef: state?.baseRef ?? activeReview.baseRef,
        baseSha: state?.baseSha ?? activeReview.baseSha,
        headSha: state?.headSha,
        changedFileCount: session?.changedFileList.length ?? 0,
        threadCount: threads.length,
        openCount: threads.filter(t => t.status === 'open').length,
        round: store?.currentRound()?.n,
        viewModeLabel: viewModeLabel(),
        lastAgent: state?.lastAgent ?? activeReview.lastAgent,
    };
}

async function refreshActiveGitInfo(): Promise<void> {
    if (!activeGit || !activeReview) {
        activeGitInfo = undefined;
        refreshTreeAndStatus();
        return;
    }
    const repoPath = await activeGit.repoRoot().catch(() => activeReview?.workspaceFolderFsPath ?? '');
    const [branch, upstream] = await Promise.all([activeGit.currentBranch(), activeGit.upstreamBranch()]);
    activeGitInfo = {
        repoPath,
        repoName: path.basename(repoPath || activeReview.workspaceFolderFsPath),
        branch,
        upstream,
    };
    refreshTreeAndStatus();
}

function currentBusyLabel(): string | undefined {
    return busyActions[busyActions.length - 1]?.label;
}

async function withLocalReviewStatus<T>(label: string, fn: () => T | Thenable<T>): Promise<T> {
    const id = nextBusyId++;
    busyActions.push({ id, label });
    refreshStatusBar();
    try {
        return await Promise.resolve(fn());
    } finally {
        const index = busyActions.findIndex(a => a.id === id);
        if (index >= 0) busyActions.splice(index, 1);
        refreshStatusBar();
    }
}

function refreshStatusBar() {
    if (!statusBar) return;
    const busy = currentBusyLabel();
    if (!activeReview) {
        statusBar.text = busy ? `$(sync~spin) Local Review: ${busy}` : '$(comment-discussion) Local Review';
        statusBar.tooltip = busy ? `Running: ${busy}` : 'No active review — click to pick or create one';
        statusBar.command = 'localReview.openReviewMenu';
        statusBar.show();
        return;
    }
    const open = (store?.threads() ?? []).filter(t => t.status === 'open').length;
    const total = (store?.threads() ?? []).length;
    const round = store?.currentRound()?.n;
    const roundTag = round ? ` · R${round}` : '';
    const viewMode = session?.getViewMode();
    const viewTag = viewMode?.kind === 'round' ? ` · view R${viewMode.n}` : '';
    const baseText = `${activeReview.name}: ${open}/${total}${roundTag}${viewTag}`;
    statusBar.text = busy ? `$(sync~spin) ${busy} · ${baseText}` : `$(comment-discussion) ${baseText}`;
    statusBar.tooltip = [
        busy ? `Running: ${busy}` : undefined,
        `Review: ${activeReview.name}`,
        `Folder: ${activeReview.workspaceFolderFsPath}`,
        activeGitInfo?.branch ? `Branch: ${activeGitInfo.branch}` : undefined,
        activeGitInfo?.upstream ? `Upstream: ${activeGitInfo.upstream}` : undefined,
        activeReview.baseRef ? `Base: ${activeReview.baseRef}` : undefined,
        store?.getState().lastAgent ? `Last agent: ${formatAgent(store.getState().lastAgent!)}` : undefined,
        round ? `Round ${round}` : undefined,
        viewMode?.kind === 'round' ? `Showing round ${viewMode.n} diff` : undefined,
        'Click for actions',
    ]
        .filter(Boolean)
        .join('\n');
    statusBar.command = 'localReview.openReviewMenu';
    statusBar.show();
}

function viewModeLabel(): string {
    const mode = session?.getViewMode();
    if (!mode || mode.kind === 'overall') return `Overall (vs ${activeReview?.baseRef ?? session?.baseRef ?? '?'})`;
    return `Round ${mode.n} changes`;
}

// ----- Command registration -----

function registerCommands(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('localReview.newReview', () => newReviewCommand()),
        vscode.commands.registerCommand('localReview.switchReview', () => switchReviewCommand()),
        vscode.commands.registerCommand('localReview.openCatalogReview', (arg: any) =>
            openCatalogReviewCommand(reviewIdFromArg(arg)),
        ),
        vscode.commands.registerCommand('localReview.deleteReview', (arg?: any) =>
            deleteReviewCommand(reviewIdFromArg(arg)),
        ),
        vscode.commands.registerCommand('localReview.renameReview', (arg?: any) =>
            renameReviewCommand(reviewIdFromArg(arg)),
        ),
        vscode.commands.registerCommand('localReview.archiveReview', (arg?: any) =>
            archiveReviewCommand(reviewIdFromArg(arg)),
        ),
        vscode.commands.registerCommand('localReview.toggleShowOtherWorkspaces', () =>
            toggleShowOtherWorkspacesCommand(),
        ),
        vscode.commands.registerCommand('localReview.openReviewMenu', () => openReviewMenuCommand()),

        // Per-review actions (forwarded to active session/store).
        vscode.commands.registerCommand('localReview.start', () => newReviewCommand()),
        vscode.commands.registerCommand('localReview.end', () => endReviewCommand()),
        vscode.commands.registerCommand('localReview.refresh', () =>
            withLocalReviewStatus('Refreshing', () => session?.refresh()),
        ),
        vscode.commands.registerCommand('localReview.openChangedFile', (arg: any) =>
            withLocalReviewStatus('Opening diff', () => {
                const file = filePathFromArg(arg);
                return file ? session?.openSingleDiff(file) : undefined;
            }),
        ),
        vscode.commands.registerCommand('localReview.addComment', () => session?.addCommentFromSelection()),
        vscode.commands.registerCommand('localReview.addReviewComment', () => session?.addReviewComment()),
        vscode.commands.registerCommand('localReview.createThread', (reply: vscode.CommentReply) =>
            session?.handleCreateFromReply(reply),
        ),
        vscode.commands.registerCommand('localReview.replyComment', (reply: vscode.CommentReply) =>
            session?.handleReply(reply),
        ),
        vscode.commands.registerCommand('localReview.replyToThread', (arg: any) => session?.replyToThreadCommand(arg)),
        vscode.commands.registerCommand('localReview.deleteThread', (arg: vscode.CommentThread | string) =>
            session?.deleteThreadCommand(arg),
        ),
        vscode.commands.registerCommand('localReview.resolveThread', (arg: any) =>
            session?.setThreadStatusCommand(arg, 'resolved'),
        ),
        vscode.commands.registerCommand('localReview.unresolveThread', (arg: any) =>
            session?.setThreadStatusCommand(arg, 'open'),
        ),
        vscode.commands.registerCommand('localReview.openThreadLocation', (id: string) =>
            session?.openThreadLocation(id),
        ),
        vscode.commands.registerCommand('localReview.openFileFromTree', (file: string) =>
            openFileFromTreeCommand(file),
        ),
        vscode.commands.registerCommand('localReview.copyAgentSkill', () =>
            withLocalReviewStatus('Copying agent skill', () => copyAgentSkillCommand()),
        ),
        vscode.commands.registerCommand('localReview.openSkillFile', () => openSkillFileCommand()),
        vscode.commands.registerCommand('localReview.copyTrigger', () => copyTriggerCommand()),
        vscode.commands.registerCommand('localReview.requestReview', () =>
            withLocalReviewStatus('Preparing review round', () => requestReviewCommand()),
        ),
        vscode.commands.registerCommand('localReview.copyPrompt', () =>
            withLocalReviewStatus('Copying prompt', () => copyPromptCommand()),
        ),
        vscode.commands.registerCommand('localReview.openPromptFile', () =>
            withLocalReviewStatus('Opening prompt', () => openPromptFileCommand()),
        ),
        vscode.commands.registerCommand('localReview.openSessionFolder', () => openSessionFolderCommand()),
        vscode.commands.registerCommand('localReview.importResponses', () =>
            withLocalReviewStatus('Importing replies', () => importResponsesCommand({ explicit: true })),
        ),
        vscode.commands.registerCommand('localReview.statusMenu', () => statusMenuCommand()),
        vscode.commands.registerCommand('localReview.filterAll', () => setFilterCommand('all')),
        vscode.commands.registerCommand('localReview.filterOpen', () => setFilterCommand('open')),
        vscode.commands.registerCommand('localReview.filterResolved', () => setFilterCommand('resolved')),
        vscode.commands.registerCommand('localReview.searchComments', () => searchCommentsCommand()),
        vscode.commands.registerCommand('localReview.clearSearch', () => clearSearchCommand()),
        vscode.commands.registerCommand('localReview.resolveAllInFile', (arg: any) => {
            const f = filePathFromArg(arg);
            return resolveAllInFileCommand(f);
        }),
        vscode.commands.registerCommand('localReview.resolveAllOpen', () => resolveAllOpenCommand()),
        vscode.commands.registerCommand('localReview.deleteAllAgentThreads', () => deleteAllAgentThreadsCommand()),
        vscode.commands.registerCommand('localReview.nextComment', () => session?.navigateComment('next')),
        vscode.commands.registerCommand('localReview.previousComment', () => session?.navigateComment('previous')),
        vscode.commands.registerCommand('localReview.showRoundHistory', () => showRoundHistoryCommand()),
        vscode.commands.registerCommand('localReview.showDiagnostics', () => showDiagnosticsCommand()),
        vscode.commands.registerCommand('localReview.restoreFromBackup', () => restoreFromBackupCommand()),
        vscode.commands.registerCommand('localReview.selectViewMode', () => selectViewModeCommand()),
        vscode.commands.registerCommand('localReview.viewOverall', () => session?.setViewMode({ kind: 'overall' })),
        vscode.commands.registerCommand('localReview.showAllChanges', () =>
            withLocalReviewStatus('Opening changes', () => session?.openAllChangesInOnePane()),
        ),
        vscode.commands.registerCommand('localReview.showUsage', () => showUsageCommand()),
        vscode.commands.registerCommand('localReview.cycleFilter', () => cycleFilterCommand()),
    );
}

// ----- New review / switch -----

async function newReviewCommand() {
    if (!catalog) return;
    // Step 1: pick a folder to review.
    const folder = await pickTargetFolder();
    if (!folder) return;
    // Step 2: pick a base ref by spinning up a temporary Git client for that folder.
    const git = new Git(folder.fsPath);
    if (!(await git.isRepo())) {
        vscode.window.showErrorMessage(`Local Review: ${folder.fsPath} is not a git repository.`);
        return;
    }
    const refResult = await pickBaseRefForFolder(git);
    if (!refResult) return;
    // Step 3: ask for a name (suggest a sensible default).
    const defaultName = `${path.basename(folder.fsPath)} — ${refResult.ref}`;
    const name = await vscode.window.showInputBox({
        title: 'Local Review: name this review',
        prompt: 'Used in the picker and the activity bar.',
        value: defaultName,
    });
    if (!name) return;
    // Step 4: create catalog entry + open it.
    const meta = await catalog.create(folder, name, refResult.ref);
    const ok = await openReview(meta);
    if (!ok) return;
    // Step 5: set base in store + initial change detection.
    await session?.startWithBase(refResult.ref, refResult.sha);
    refreshTreeAndStatus();
}

async function pickTargetFolder(): Promise<vscode.Uri | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    type Item = vscode.QuickPickItem & { uri?: vscode.Uri; pick?: 'browse' };
    const items: Item[] = folders.map(f => ({
        label: `$(folder) ${f.name}`,
        description: f.uri.fsPath,
        uri: f.uri,
    }));
    items.push({ label: '$(folder-opened) Browse for a folder…', pick: 'browse' });
    const picked = await vscode.window.showQuickPick(items, {
        title: 'Local Review: pick a workspace folder to review',
        placeHolder: 'Workspace folders shown first; browse for any other git repo on disk.',
    });
    if (!picked) return undefined;
    if (picked.uri) return picked.uri;
    const uris = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        title: 'Pick a git repository folder',
    });
    return uris?.[0];
}

async function pickBaseRefForFolder(git: Git): Promise<{ ref: string; sha: string } | undefined> {
    const cfg = vscode.workspace.getConfiguration('localReview');
    const useMergeBase = cfg.get<boolean>('useMergeBase', true);
    const candidates = await git.candidateBaseRefs();
    type Item = vscode.QuickPickItem & { ref?: string; custom?: boolean };
    const items: Item[] = candidates.map((r, i) => ({
        label: r,
        description: i === 0 ? '(detected default)' : undefined,
        ref: r,
    }));
    items.push({ label: '$(edit) Enter custom ref…', custom: true });
    const picked = await vscode.window.showQuickPick(items, {
        title: 'Local Review: pick a base ref',
        placeHolder: 'Diff working tree against this ref',
    });
    if (!picked) return undefined;
    let ref = picked.ref;
    if (picked.custom) {
        const entered = await vscode.window.showInputBox({
            title: 'Enter base ref',
            value: 'HEAD~1',
        });
        if (!entered) return undefined;
        if (!(await git.refExists(entered))) {
            vscode.window.showErrorMessage(`Ref '${entered}' does not exist.`);
            return undefined;
        }
        ref = entered;
    }
    if (!ref) return undefined;
    const sha = useMergeBase ? ((await git.mergeBase(ref)) ?? (await git.revParse(ref))) : await git.revParse(ref);
    return { ref, sha };
}

async function openCatalogReviewCommand(id: string | undefined): Promise<void> {
    if (!catalog) return;
    if (!id) return;
    const meta = catalog.find(id);
    if (!meta) {
        vscode.window.showWarningMessage('Local Review: that review no longer exists.');
        return;
    }
    if (meta.id === activeReview?.id) return; // already active
    await openReview(meta);
}

async function switchReviewCommand() {
    if (!catalog) return;
    const reviews = catalog.listActive();
    if (reviews.length === 0) {
        const action = await vscode.window.showInformationMessage('No reviews yet.', 'New Review');
        if (action === 'New Review') await newReviewCommand();
        return;
    }
    const currentWorkspaces = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.toString());
    const inWs = (m: ReviewMeta) => currentWorkspaces.some(w => sameUri(m.workspaceFolder, w));
    const ordered = [...reviews].sort((a, b) => {
        const aIn = inWs(a) ? 0 : 1,
            bIn = inWs(b) ? 0 : 1;
        if (aIn !== bIn) return aIn - bIn;
        return b.lastActiveAt.localeCompare(a.lastActiveAt);
    });
    type Item = vscode.QuickPickItem & { meta?: ReviewMeta; action?: 'new' };
    const items: Item[] = ordered.map(m => ({
        label: `${m.id === activeReview?.id ? '$(check) ' : '$(comment-discussion) '}${m.name}`,
        description: [
            m.baseRef ?? '?',
            `${m.openCount}/${m.threadCount} comments`,
            `round ${m.rounds}`,
            m.lastAgent ? `agent ${m.lastAgent.name}` : undefined,
        ]
            .filter(Boolean)
            .join(' · '),
        detail: `${inWs(m) ? '' : '[other workspace] '}${m.workspaceFolderFsPath}`,
        meta: m,
    }));
    items.push({ label: '$(add) New review…', action: 'new' });
    const picked = await vscode.window.showQuickPick(items, {
        title: `Local Review: switch (${reviews.length} review${reviews.length === 1 ? '' : 's'})`,
        placeHolder: 'Pick a review to switch to',
    });
    if (!picked) return;
    if (picked.action === 'new') {
        await newReviewCommand();
        return;
    }
    if (picked.meta && picked.meta.id !== activeReview?.id) await openReview(picked.meta);
}

async function deleteReviewCommand(id?: string) {
    if (!catalog) return;
    const target = id ? catalog.find(id) : activeReview;
    if (!target) return;
    const action = await vscode.window.showWarningMessage(
        `Delete review '${target.name}'? This removes all comments, rounds, and protocol files. The workspace itself is untouched.`,
        { modal: true },
        'Delete',
    );
    if (action !== 'Delete') return;
    // Drop pinned snapshot refs if this is the active review (we have git in hand).
    if (target.id === activeReview?.id && activeGit && store) {
        const rounds = store.getState().rounds ?? [];
        for (const r of rounds) if (r.snapshotRef) await activeGit.unpinRef(r.snapshotRef);
    }
    const wasActive = target.id === activeReview?.id;
    await catalog.delete(target.id);
    if (wasActive) {
        await closeActiveReview();
        const next = await pickInitialReview();
        if (next) await openReview(next);
    }
    refreshTreeAndStatus();
}

async function renameReviewCommand(id?: string) {
    if (!catalog) return;
    const target = id ? catalog.find(id) : activeReview;
    if (!target) return;
    const next = await vscode.window.showInputBox({
        title: `Rename review '${target.name}'`,
        value: target.name,
    });
    if (!next || next === target.name) return;
    await catalog.rename(target.id, next);
    if (target.id === activeReview?.id) activeReview = { ...activeReview, name: next };
    refreshTreeAndStatus();
}

async function archiveReviewCommand(id?: string) {
    if (!catalog) return;
    const target = id ? catalog.find(id) : activeReview;
    if (!target) return;
    const willArchive = !target.archived;
    await catalog.archive(target.id, willArchive);
    if (target.id === activeReview?.id && willArchive) {
        await closeActiveReview();
    }
    refreshTreeAndStatus();
}

async function endReviewCommand() {
    if (!activeReview || !session) {
        vscode.window.showInformationMessage('Local Review: no active review.');
        return;
    }
    const open = (store?.threads() ?? []).length;
    const action = await vscode.window.showWarningMessage(
        `End review '${activeReview.name}'?\n${open} comment(s) will be archived (the review is kept in the catalog and can be reopened).`,
        { modal: true },
        'End',
    );
    if (action !== 'End') return;
    await closeActiveReview();
    refreshTreeAndStatus();
}

async function closeActiveReview() {
    if (session) {
        session.dispose();
        session = undefined;
    }
    if (store) {
        store.dispose();
        store = undefined;
    }
    detachResponseWatcher();
    activeReview = undefined;
    activeGit = undefined;
    activePaths = undefined;
    activeGitInfo = undefined;
}

async function toggleShowOtherWorkspacesCommand() {
    const cur = !!extContext?.workspaceState.get<boolean>(SHOW_OTHER_WORKSPACES_KEY, false);
    await extContext?.workspaceState.update(SHOW_OTHER_WORKSPACES_KEY, !cur);
    refreshTreeAndStatus();
}

async function openReviewMenuCommand() {
    if (!activeReview) {
        await switchReviewCommand();
        return;
    }
    await statusMenuCommand();
}

// ----- Migration from v0.8 -----

async function maybeMigrateFromLegacyStorage(context: vscode.ExtensionContext) {
    if (!catalog) return;
    if (context.globalState.get<boolean>('localReview.migratedFromV8')) return;
    try {
        // The v0.8 store was keyed by workspace storage; if there's no workspace folder,
        // nothing to migrate. If there IS, look for review.json.
        const folders = vscode.workspace.workspaceFolders ?? [];
        for (const f of folders) {
            const candidate = vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'review.json');
            try {
                const buf = await vscode.workspace.fs.readFile(candidate);
                const state = JSON.parse(new TextDecoder().decode(buf)) as ReviewState;
                if (state.baseSha) {
                    const meta = await catalog.create(f.uri, `${f.name} — migrated`, state.baseRef);
                    const paths = catalog.pathsFor(meta);
                    await vscode.workspace.fs.createDirectory(paths.root);
                    await vscode.workspace.fs.writeFile(
                        paths.state,
                        new TextEncoder().encode(JSON.stringify(state, null, 2)),
                    );
                    outputChannel?.appendLine(
                        `[migrate] imported v0.8 review for ${f.name} → '${meta.name}' (${meta.id})`,
                    );
                }
            } catch {
                /* not present */
            }
        }
    } catch (e) {
        outputChannel?.appendLine(`[migrate] failed: ${e}`);
    }
    await context.globalState.update('localReview.migratedFromV8', true);
}

// ----- Helpers shared with original v0.8 implementation -----

async function openFileFromTreeCommand(file: string) {
    if (!activeReview) return;
    const safeFile = normalizeRepoPath(file);
    if (!safeFile) {
        vscode.window.showErrorMessage('Local Review: cannot open an unsafe file path.');
        return;
    }
    try {
        const folder = vscode.Uri.parse(activeReview.workspaceFolder);
        const uri = vscode.Uri.joinPath(folder, safeFile);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
    } catch (e: any) {
        vscode.window.showErrorMessage(`Local Review: cannot open ${safeFile}: ${e?.message ?? e}`);
    }
}

interface ExportArtifacts {
    md: string;
    json?: string;
    paths: ReviewPaths;
}

async function refreshExport(): Promise<ExportArtifacts | undefined> {
    if (!session || !store || !activeReview || !activePaths) {
        vscode.window.showWarningMessage('Local Review: no active review.');
        return undefined;
    }
    if (!store.isActive() && store.threads().length === 0) {
        vscode.window.showWarningMessage('Local Review: nothing to export.');
        return undefined;
    }
    const cfg = vscode.workspace.getConfiguration('localReview');
    const includeJson = cfg.get<boolean>('includeJsonSidecar', true);
    const hunks = await session.hunksForCommentedFiles();
    const ctx = {
        workspaceName: activeReview.name,
        workspaceFsPath: activeReview.workspaceFolderFsPath,
        headerOverride: cfg.get<string>('promptHeader') || undefined,
        hunks,
        responsesPath: activePaths.responses.fsPath,
        skillPrimed: skillPrimedForActive(),
        roundNumber: store.currentRound()?.n,
    };
    const md = buildPrompt(store, ctx);
    const json = includeJson ? buildJsonSidecar(store, ctx) : undefined;
    try {
        await vscode.workspace.fs.createDirectory(activePaths.root);
        await vscode.workspace.fs.writeFile(activePaths.promptMd, new TextEncoder().encode(md));
        if (json) await vscode.workspace.fs.writeFile(activePaths.promptJson, new TextEncoder().encode(json));
    } catch (e: any) {
        vscode.window.showErrorMessage(`Local Review: failed to write prompt: ${e?.message ?? e}`);
        return undefined;
    }
    return { md, json, paths: activePaths };
}

function skillPrimedForActive(): boolean {
    if (!extContext || !activeReview) return false;
    return !!extContext.workspaceState.get<boolean>(SKILL_INSTALLED_KEY_PREFIX + activeReview.id);
}
async function markSkillPrimedForActive() {
    if (!extContext || !activeReview) return;
    await extContext.workspaceState.update(SKILL_INSTALLED_KEY_PREFIX + activeReview.id, true);
}

async function copyAgentSkillCommand() {
    if (!activePaths || !activeReview) {
        vscode.window.showWarningMessage('Local Review: no active review.');
        return;
    }
    const projectInstructions = await readProjectInstructions(vscode.Uri.parse(activeReview.workspaceFolder));
    const skill = buildAgentSkill(activePaths, {
        workspaceName: activeReview.name,
        workspacePath: activeReview.workspaceFolderFsPath,
        projectInstructions,
    });
    try {
        await vscode.workspace.fs.createDirectory(activePaths.root);
        await vscode.workspace.fs.writeFile(activePaths.skill, new TextEncoder().encode(skill));
    } catch {
        /* ignore */
    }
    await vscode.env.clipboard.writeText(skill);
    await markSkillPrimedForActive();
    const projTag = projectInstructions ? ' (with project-specific appendix)' : '';
    const action = await vscode.window.showInformationMessage(
        `Agent skill copied${projTag}. Paste into your agent ONCE; after that, "review" triggers each round.`,
        'Open SKILL.md',
    );
    if (action === 'Open SKILL.md') await openSkillFileCommand();
}

async function readProjectInstructions(folder: vscode.Uri): Promise<string | undefined> {
    const candidates = ['.local-review/instructions.md', '.local-review.md'];
    for (const rel of candidates) {
        try {
            const buf = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, rel));
            const text = new TextDecoder().decode(buf).trim();
            if (text) return text;
        } catch {
            /* not present */
        }
    }
    return undefined;
}

async function openSkillFileCommand() {
    if (!activePaths) return;
    try {
        await vscode.workspace.fs.stat(activePaths.skill);
    } catch {
        await copyAgentSkillCommand();
        return;
    }
    const doc = await vscode.workspace.openTextDocument(activePaths.skill);
    await vscode.window.showTextDocument(doc, { preview: false });
}

async function openPromptFileCommand() {
    const out = await refreshExport();
    if (!out) return;
    const doc = await vscode.workspace.openTextDocument(out.paths.promptMd);
    await vscode.window.showTextDocument(doc, { preview: false });
}

async function openSessionFolderCommand() {
    if (!activePaths) return;
    await vscode.workspace.fs.createDirectory(activePaths.root);
    await vscode.commands.executeCommand('revealFileInOS', activePaths.root);
}

async function copyPromptCommand() {
    const out = await refreshExport();
    if (!out) return;
    await vscode.env.clipboard.writeText(out.md);
    const open = (store?.threads() ?? []).filter(t => t.status === 'open').length;
    vscode.window.showInformationMessage(`Copied review prompt to clipboard (${open} open comment(s)).`);
}

function defaultTriggerTemplate(skillPrimed: boolean): string {
    if (skillPrimed) return 'review (round {round} at {absPath})';
    return 'Address code review round {round} at "{absPath}". Write replies to "{responsesPath}" using the JSON schema documented at the bottom of the prompt — use the comment IDs listed there.';
}
function renderTemplate(tmpl: string, p: ReviewPaths): string {
    return tmpl
        .replace(/\{absPath\}/g, posix(p.promptMd.fsPath))
        .replace(/\{path\}/g, posix(p.promptMd.fsPath))
        .replace(/\{responsesPath\}/g, posix(p.responses.fsPath))
        .replace(/\{jsonPath\}/g, posix(p.promptJson.fsPath));
}
function posix(p: string): string {
    return p.replace(/\\/g, '/');
}

async function copyTriggerCommand() {
    if (!activePaths) return;
    const cfg = vscode.workspace.getConfiguration('localReview');
    const skillPrimed = skillPrimedForActive();
    const tmpl = (cfg.get<string>('triggerTemplate') || '').trim() || defaultTriggerTemplate(skillPrimed);
    const text = renderTemplate(tmpl, activePaths);
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage('Trigger copied. Paste into your agent.');
}

async function requestReviewCommand() {
    if (!session || !activeReview) {
        const action = await vscode.window.showWarningMessage('No active review.', 'New Review');
        if (action === 'New Review') await newReviewCommand();
        return;
    }
    const roundN = await session.beginRound(activeReview.id);
    const out = await refreshExport();
    if (!out) return;
    const cfg = vscode.workspace.getConfiguration('localReview');
    const mode = cfg.get<string>('handoffMode', 'clipboard');
    const skillPrimed = skillPrimedForActive();
    const tmpl = (cfg.get<string>('triggerTemplate') || '').trim() || defaultTriggerTemplate(skillPrimed);
    const text = renderTemplate(tmpl, out.paths).replace(/\{round\}/g, String(roundN));
    if (mode === 'vscode-terminal') {
        if (containsTerminalControlChars(text)) {
            vscode.window.showErrorMessage(
                'Local Review: terminal handoff text contains unsafe control characters. Copy the trigger instead.',
            );
            return;
        }
        const term = pickTargetTerminal();
        if (!term) {
            vscode.window.showWarningMessage('Local Review: no VS Code terminal found.');
            return;
        }
        term.show(false);
        term.sendText(text, false);
        vscode.window.showInformationMessage(
            'Local Review: trigger inserted in the terminal. Review it, then press Enter.',
        );
        return;
    }
    if (mode === 'none') {
        vscode.window.showInformationMessage(`Local Review: prompt refreshed at ${out.paths.promptMd.fsPath}`);
        return;
    }
    await vscode.env.clipboard.writeText(text);
    if (!skillPrimed) {
        const action = await vscode.window.showInformationMessage(
            'Local Review: trigger copied. Tip: use the Copy Agent Skill toolbar button once so future rounds need only "review".',
            'Open Prompt',
        );
        if (action === 'Open Prompt') await openPromptFileCommand();
    } else {
        vscode.window.showInformationMessage(`Local Review: trigger copied (round ${roundN}). Paste into your agent.`);
    }
}

function pickTargetTerminal(): vscode.Terminal | undefined {
    const cfg = vscode.workspace.getConfiguration('localReview');
    const strategy = cfg.get<string>('terminalStrategy', 'active');
    const pattern = cfg.get<string>('terminalNamePattern', '');
    if (strategy === 'named' && pattern) {
        try {
            const re = new RegExp(pattern);
            return vscode.window.terminals.find(t => re.test(t.name));
        } catch {
            return undefined;
        }
    }
    if (strategy === 'new' && activeReview) {
        return vscode.window.createTerminal({ cwd: activeReview.workspaceFolderFsPath });
    }
    return vscode.window.activeTerminal ?? vscode.window.terminals[vscode.window.terminals.length - 1];
}

function containsTerminalControlChars(text: string): boolean {
    return containsControlChars(text);
}

async function importResponsesCommand(opts: { explicit: boolean }): Promise<void> {
    if (!importer || !session || !activePaths) {
        if (opts.explicit) vscode.window.showWarningMessage('Local Review: no active review.');
        return;
    }
    let result: ImportResult;
    try {
        result = await importer.importFromFile(activePaths.responses);
    } catch (e: any) {
        if (opts.explicit) vscode.window.showErrorMessage(`Import failed: ${e?.message ?? e}`);
        return;
    }
    session.refreshThreads(result.appliedThreadIds);
    reportImportResult(result, opts.explicit);
}

function reportImportResult(r: ImportResult, explicit: boolean) {
    if (r.fileMissing) {
        if (explicit)
            vscode.window.showInformationMessage('Local Review: no responses.json yet. Trigger a review round first.');
        return;
    }
    if (r.parseFailed && r.repliesImported === 0 && r.newThreadsImported === 0) {
        if (parseFailRetry) clearTimeout(parseFailRetry);
        parseFailRetry = setTimeout(() => {
            void withLocalReviewStatus('Importing replies', () => importResponsesCommand({ explicit: false }));
        }, PARSE_FAIL_RETRY_MS);
        if (explicit)
            vscode.window.showInformationMessage('Local Review: responses.json was being written; will retry shortly.');
        return;
    }
    if (r.errors.length > 0) {
        const summary = `Local Review: imported ${r.repliesImported} reply, ${r.newThreadsImported} new thread, ${r.skipped} dupe(s), ${r.errors.length} error(s).`;
        vscode.window.showWarningMessage(summary, 'Show Errors').then(action => {
            if (action === 'Show Errors' && outputChannel) {
                outputChannel.show(true);
                outputChannel.appendLine(`Import from ${activePaths?.responses.fsPath}`);
                for (const e of r.errors) outputChannel.appendLine('  - ' + e);
            }
        });
        return;
    }
    const total = r.repliesImported + r.newThreadsImported;
    if (total === 0 && !explicit) return;
    if (total === 0) {
        vscode.window.showInformationMessage('Local Review: no new entries.');
        return;
    }
    const parts: string[] = [];
    if (r.repliesImported) parts.push(`${r.repliesImported} ${r.repliesImported === 1 ? 'reply' : 'replies'}`);
    if (r.newThreadsImported)
        parts.push(`${r.newThreadsImported} new ${r.newThreadsImported === 1 ? 'thread' : 'threads'}`);
    const dupeTag = r.skipped ? ` (skipped ${r.skipped} duplicate(s))` : '';
    vscode.window.showInformationMessage(`Local Review: imported ${parts.join(' + ')}${dupeTag}.`);
}

// ----- Status / quick action menu -----

async function statusMenuCommand() {
    if (!activeReview) {
        await switchReviewCommand();
        return;
    }
    const skillPrimed = skillPrimedForActive();
    const items: (vscode.QuickPickItem & { cmd?: string })[] = [
        {
            label: `$(comment-discussion) Active: ${activeReview.name}`,
            detail: 'Switch / rename / delete',
            cmd: 'localReview.switchReview',
        },
        { label: '', kind: vscode.QuickPickItemKind.Separator } as any,
        { label: '$(send) Trigger review round', cmd: 'localReview.requestReview' },
        skillPrimed
            ? { label: '$(book) Re-copy agent skill', cmd: 'localReview.copyAgentSkill' }
            : { label: '$(book) Copy agent skill (one-time setup)', cmd: 'localReview.copyAgentSkill' },
        { label: '$(arrow-down) Import agent replies now', cmd: 'localReview.importResponses' },
        { label: '', kind: vscode.QuickPickItemKind.Separator } as any,
        { label: `$(diff) View: ${viewModeLabel()}`, cmd: 'localReview.selectViewMode' },
        { label: '$(comment) Add comment on current line/selection', cmd: 'localReview.addComment' },
        { label: '$(comment-discussion) Add review-wide comment', cmd: 'localReview.addReviewComment' },
        { label: '$(arrow-down) Jump to next open comment', cmd: 'localReview.nextComment' },
        { label: '$(arrow-up) Jump to previous open comment', cmd: 'localReview.previousComment' },
        { label: '$(refresh) Refresh changed files', cmd: 'localReview.refresh' },
        { label: '', kind: vscode.QuickPickItemKind.Separator } as any,
        { label: `$(filter) Filter: ${tree?.getFilter() ?? 'all'}`, cmd: 'localReview.cycleFilter' },
        { label: '$(search) Search comments...', cmd: 'localReview.searchComments' },
        { label: '$(history) Round history', cmd: 'localReview.showRoundHistory' },
        { label: '', kind: vscode.QuickPickItemKind.Separator } as any,
        { label: '$(check-all) Resolve all open comments', cmd: 'localReview.resolveAllOpen' },
        { label: '$(trash) Delete all 🤖 agent threads', cmd: 'localReview.deleteAllAgentThreads' },
        { label: '', kind: vscode.QuickPickItemKind.Separator } as any,
        { label: '$(clippy) Copy prompt body to clipboard', cmd: 'localReview.copyPrompt' },
        { label: '$(file) Open prompt.md', cmd: 'localReview.openPromptFile' },
        { label: '$(file) Open SKILL.md', cmd: 'localReview.openSkillFile' },
        { label: '$(folder-opened) Reveal session folder in OS', cmd: 'localReview.openSessionFolder' },
        { label: '$(info) Show diagnostics', cmd: 'localReview.showDiagnostics' },
        { label: '$(history) Restore from backup', cmd: 'localReview.restoreFromBackup' },
        { label: '$(book) Show usage documentation', cmd: 'localReview.showUsage' },
        { label: '', kind: vscode.QuickPickItemKind.Separator } as any,
        { label: '$(edit) Rename this review', cmd: 'localReview.renameReview' },
        { label: '$(archive) Archive this review', cmd: 'localReview.archiveReview' },
        { label: '$(close) End review (close, keep in catalog)', cmd: 'localReview.end' },
        { label: '$(trash) Delete this review', cmd: 'localReview.deleteReview' },
    ];
    const picked = await vscode.window.showQuickPick(items, {
        title: `Local Review · ${activeReview.name}`,
    });
    if (picked?.cmd) await vscode.commands.executeCommand(picked.cmd);
}

async function setFilterCommand(mode: FilterMode) {
    if (!tree) return;
    session?.setCommentFilter(mode);
    tree.setFilter(mode);
    await extContext?.workspaceState.update(FILTER_KEY, mode);
}

async function searchCommentsCommand() {
    if (!tree) return;
    const text = await vscode.window.showInputBox({
        title: 'Search comments',
        prompt: 'Filter comments containing this text (file path, author, or body). Leave empty to clear.',
    });
    if (text === undefined) return;
    tree.setSearch(text.trim());
}

async function clearSearchCommand() {
    tree?.setSearch('');
}

async function cycleFilterCommand() {
    if (!tree) return;
    const order: FilterMode[] = ['all', 'open', 'resolved'];
    const next = order[(order.indexOf(tree.getFilter()) + 1) % order.length]!;
    await setFilterCommand(next);
    vscode.window.showInformationMessage(`Filter: ${next}`);
}

async function resolveAllInFileCommand(file: string | undefined) {
    if (!session || !file) return;
    const n = await session.resolveAllInFile(file);
    vscode.window.showInformationMessage(
        n === 0 ? `No open comments in ${file}.` : `Resolved ${n} comment(s) in ${file}.`,
    );
}

async function resolveAllOpenCommand() {
    if (!session || !store) return;
    const n = store.threads().filter(t => t.status === 'open').length;
    if (n === 0) {
        vscode.window.showInformationMessage('No open comments to resolve.');
        return;
    }
    const action = await vscode.window.showWarningMessage(
        `Resolve all ${n} open comment(s)?`,
        { modal: true },
        'Resolve All',
    );
    if (action !== 'Resolve All') return;
    const k = await session.resolveAllOpen();
    vscode.window.showInformationMessage(`Resolved ${k} comment(s).`);
}

async function deleteAllAgentThreadsCommand() {
    if (!session || !store) return;
    const n = store.threads().filter(t => t.origin === 'agent').length;
    if (n === 0) {
        vscode.window.showInformationMessage('No agent threads to delete.');
        return;
    }
    const action = await vscode.window.showWarningMessage(
        `Delete all ${n} agent-authored thread(s)?`,
        { modal: true },
        'Delete All',
    );
    if (action !== 'Delete All') return;
    const k = await session.deleteAllAgentThreads();
    vscode.window.showInformationMessage(`Deleted ${k} agent thread(s).`);
}

async function showRoundHistoryCommand() {
    if (!store) return;
    const rounds = store.getState().rounds ?? [];
    if (rounds.length === 0) {
        vscode.window.showInformationMessage('No rounds yet.');
        return;
    }
    type Item = vscode.QuickPickItem & { round?: number };
    const items: Item[] = rounds
        .map(r => ({
            label: `$(history) Round ${r.n}`,
            description: `${r.openCountAtTrigger} open · ${r.repliesReceived} reply, ${r.newThreadsReceived} new thread`,
            detail: `Triggered ${r.triggeredAt}${r.snapshotSha ? ` · snapshot ${r.snapshotSha.slice(0, 12)} (pinned)` : r.headShaAtTrigger ? ` · HEAD ${r.headShaAtTrigger.slice(0, 12)}` : ''}`,
            round: r.n,
        }))
        .reverse();
    const picked = await vscode.window.showQuickPick(items, {
        title: `Round history (${rounds.length} round${rounds.length === 1 ? '' : 's'})`,
    });
    if (!picked?.round || !session) return;
    const r = rounds.find(x => x.n === picked.round);
    if (r && (r.snapshotSha || r.headShaAtTrigger)) {
        await session.setViewMode({ kind: 'round', n: r.n, sha: r.snapshotSha ?? r.headShaAtTrigger! });
        vscode.window.showInformationMessage(`Showing round ${r.n} changes.`);
    }
}

async function showDiagnosticsCommand() {
    if (!outputChannel) return;
    outputChannel.show(true);
    outputChannel.appendLine('====== Local Review diagnostics ======');
    outputChannel.appendLine(`GlobalStorage:    ${extContext?.globalStorageUri.fsPath}`);
    outputChannel.appendLine(`Catalog reviews:  ${catalog?.list().length ?? 0}`);
    outputChannel.appendLine(
        `Active review:    ${activeReview ? `'${activeReview.name}' (${activeReview.id})` : '(none)'}`,
    );
    if (activeReview && activePaths) {
        outputChannel.appendLine(`  Folder:         ${activeReview.workspaceFolderFsPath}`);
        outputChannel.appendLine(`  Folder URI:     ${activeReview.workspaceFolder}`);
        outputChannel.appendLine(`  State:          ${activePaths.state.fsPath}`);
        outputChannel.appendLine(`  Backup:         ${activePaths.stateBak.fsPath}`);
        outputChannel.appendLine(`  Responses:      ${activePaths.responses.fsPath}`);
        if (store) {
            const s = store.getState();
            const load = store.getLastLoadInfo();
            outputChannel.appendLine(
                `  Last load:      existed=${load.existed} size=${load.size ?? 0}B error=${load.error ?? '-'}`,
            );
            outputChannel.appendLine(`  Base ref/sha:   ${s.baseRef ?? '-'} / ${s.baseSha ?? '-'}`);
            outputChannel.appendLine(`  Last agent:     ${s.lastAgent ? formatAgent(s.lastAgent) : '-'}`);
            outputChannel.appendLine(
                `  Threads/Open:   ${s.threads.length} / ${s.threads.filter(t => t.status === 'open').length}`,
            );
            outputChannel.appendLine(`  Rounds:         ${(s.rounds ?? []).length}`);
            try {
                const stat = await vscode.workspace.fs.stat(activePaths.state);
                outputChannel.appendLine(
                    `  State on disk:  ${stat.size}B, mtime=${new Date(stat.mtime).toISOString()}`,
                );
            } catch (e: any) {
                outputChannel.appendLine(`  State on disk:  MISSING (${e?.message ?? e})`);
            }
        }
    }
    outputChannel.appendLine('All catalog reviews:');
    for (const r of catalog?.list() ?? []) {
        outputChannel.appendLine(
            `  [${r.archived ? 'archived' : 'active'}] ${r.name} (${r.id}) — ${r.workspaceFolderFsPath} — ${r.openCount}/${r.threadCount} comments`,
        );
    }
    outputChannel.appendLine('======================================');
}

async function restoreFromBackupCommand() {
    if (!store || !session) return;
    const action = await vscode.window.showWarningMessage(
        'Restore the active review from .bak? This overwrites the current state.',
        { modal: true },
        'Restore',
    );
    if (action !== 'Restore') return;
    const ok = await store.restoreFromBackup();
    if (ok) {
        session.rerenderAll();
        vscode.window.showInformationMessage(`Restored ${store.threads().length} thread(s) from backup.`);
    } else {
        vscode.window.showErrorMessage('Backup not available or unreadable.');
    }
}

async function selectViewModeCommand() {
    if (!session || !store) return;
    const rounds = store.getState().rounds ?? [];
    const cur = session.getViewMode();
    type Item = vscode.QuickPickItem & { mode?: ViewMode };
    const items: Item[] = [
        {
            label: '$(diff) Overall changes',
            description: `vs ${activeReview?.baseRef ?? '?'}`,
            detail: 'Files changed since the review base ref.',
            mode: { kind: 'overall' },
            picked: cur.kind === 'overall',
        },
    ];
    for (const r of [...rounds].reverse()) {
        const sha = r.snapshotSha ?? r.headShaAtTrigger;
        if (!sha) continue;
        items.push({
            label: `$(history) Round ${r.n} changes`,
            description: `since ${r.snapshotSha ? 'snapshot' : 'HEAD'} ${sha.slice(0, 12)} (${r.triggeredAt.slice(0, 10)})`,
            detail: `What changed since round ${r.n} was triggered${r.snapshotSha ? ' (pinned snapshot — survives amend/rebase/GC)' : ''}.`,
            mode: { kind: 'round', n: r.n, sha },
            picked: cur.kind === 'round' && cur.n === r.n,
        });
    }
    if (items.length === 1) {
        const action = await vscode.window.showInformationMessage('No rounds yet.', 'Trigger Round');
        if (action === 'Trigger Round') await requestReviewCommand();
        return;
    }
    const picked = await vscode.window.showQuickPick(items, { title: 'Which diff to show?' });
    if (!picked?.mode) return;
    await session.setViewMode(picked.mode);
}

async function showUsageCommand() {
    if (!extContext) return;
    try {
        await vscode.commands.executeCommand(
            'workbench.action.openWalkthrough',
            { category: `${extContext.extension.id}#localReview.gettingStarted` },
            false,
        );
    } catch {
        const readme = vscode.Uri.joinPath(extContext.extensionUri, 'README.md');
        try {
            await vscode.commands.executeCommand('markdown.showPreview', readme);
        } catch {
            const doc = await vscode.workspace.openTextDocument(readme);
            await vscode.window.showTextDocument(doc);
        }
    }
}

function sameUri(a: string, b: string): boolean {
    const norm = (s: string) => (s ?? '').replace(/\/+$/, '').toLowerCase();
    return norm(a) === norm(b);
}

function reviewIdFromArg(arg: any): string | undefined {
    if (typeof arg === 'string') return arg;
    if (typeof arg?.id === 'string') return arg.id;
    if (typeof arg?.meta?.id === 'string') return arg.meta.id;
    return undefined;
}

function filePathFromArg(arg: any): string | undefined {
    if (typeof arg === 'string') return normalizeRepoPath(arg);
    if (typeof arg?.path === 'string') return normalizeRepoPath(arg.path);
    if (typeof arg?.file === 'string') return normalizeRepoPath(arg.file);
    return undefined;
}

function formatAgent(agent: LastAgentInfo): string {
    return [agent.name, agent.kind, agent.id].filter(Boolean).join(' · ');
}
