import * as assert from 'assert';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ActiveReviewTreeProvider, CommentTreeProvider, ReviewCatalogTreeProvider } = require('../src/treeProvider');

// Minimal mock for ReviewCatalog
function createMockCatalog(reviews: any[] = []) {
    let activeGlobal: string | undefined;
    const emitter = new vscode.EventEmitter();
    return {
        list: () => reviews,
        listActive: () => reviews.filter((r: any) => !r.archived),
        find: (id: string) => reviews.find((r: any) => r.id === id),
        findByWorkspace: (_uri: string) => reviews,
        lastActiveFor: () => undefined,
        lastActiveGlobal: () => (activeGlobal ? reviews.find((r: any) => r.id === activeGlobal) : undefined),
        onDidChange: emitter.event,
        dispose: () => emitter.dispose(),
        setActiveGlobal: (id: string) => {
            activeGlobal = id;
        },
    };
}

// Minimal mock for CommentStore
function createMockStore(threads: any[] = []) {
    const emitter = new vscode.EventEmitter();
    return {
        threads: () => threads,
        getState: () => ({ threads }),
        onDidChange: emitter.event,
        dispose: () => emitter.dispose(),
    };
}

function createMockContext(
    options: {
        changedFiles?: any[];
        baseRef?: string;
        layout?: string;
        round?: number;
        viewMode?: string;
        catalog?: any;
        activeReviewId?: string;
        showOther?: boolean;
        workspaceFolders?: string[];
        activeReview?: any;
        reviewInfo?: any;
    } = {},
) {
    return {
        getChangedFiles: () => options.changedFiles ?? [],
        getBaseRefLabel: () => options.baseRef,
        getLayoutMode: () => options.layout ?? 'flat',
        getCurrentRound: () => options.round,
        getViewModeLabel: () => options.viewMode ?? 'Overall',
        getCatalog: () => options.catalog ?? createMockCatalog(),
        getActiveReviewId: () => options.activeReviewId,
        getShowOtherWorkspaces: () => options.showOther ?? true,
        getCurrentWorkspaceFolderUris: () => options.workspaceFolders ?? ['file:///workspace'],
        getActiveReview: () => options.activeReview,
        getReviewInfo: () => options.reviewInfo,
    };
}

describe('CommentTreeProvider', () => {
    let provider: any;
    let eventEmitter: any;

    afterEach(() => {
        provider?.dispose();
        eventEmitter?.dispose();
    });

    describe('basic operations', () => {
        it('should create without error', () => {
            eventEmitter = new vscode.EventEmitter();
            const ctx = createMockContext();
            provider = new CommentTreeProvider(() => undefined, ctx, eventEmitter.event);
            assert.ok(provider);
        });

        it('should show review picker when no active review', () => {
            eventEmitter = new vscode.EventEmitter();
            const ctx = createMockContext();
            provider = new CommentTreeProvider(() => undefined, ctx, eventEmitter.event);
            const roots = provider.getChildren(undefined);
            assert.ok(roots.length >= 1);
            assert.strictEqual(roots[0].kind, 'reviewPicker');
        });

        it('should show catalog section when multiple reviews exist', () => {
            eventEmitter = new vscode.EventEmitter();
            const reviews = [
                {
                    id: 'r1',
                    name: 'R1',
                    workspaceFolder: 'file:///ws',
                    archived: false,
                    lastActiveAt: '2024-01-01',
                    baseRef: 'main',
                    openCount: 1,
                    threadCount: 2,
                    rounds: 1,
                    workspaceFolderFsPath: '/ws',
                },
                {
                    id: 'r2',
                    name: 'R2',
                    workspaceFolder: 'file:///ws',
                    archived: false,
                    lastActiveAt: '2024-01-02',
                    baseRef: 'dev',
                    openCount: 0,
                    threadCount: 5,
                    rounds: 2,
                    workspaceFolderFsPath: '/ws',
                },
            ];
            const catalog = createMockCatalog(reviews);
            const ctx = createMockContext({ catalog });
            provider = new CommentTreeProvider(() => undefined, ctx, eventEmitter.event);
            const roots = provider.getChildren(undefined);
            const sections = roots.filter((n: any) => n.kind === 'section');
            assert.ok(sections.length > 0);
        });

        it('should include file nodes when active review exists', () => {
            eventEmitter = new vscode.EventEmitter();
            const reviews = [
                {
                    id: 'r1',
                    name: 'R1',
                    workspaceFolder: 'file:///ws',
                    archived: false,
                    lastActiveAt: '2024-01-01',
                    baseRef: 'main',
                    openCount: 1,
                    threadCount: 2,
                    rounds: 1,
                    workspaceFolderFsPath: '/ws',
                },
            ];
            const catalog = createMockCatalog(reviews);
            const store = createMockStore([
                {
                    id: 't1',
                    file: 'src/app.ts',
                    startLine: 5,
                    endLine: 5,
                    status: 'open',
                    comments: [{ body: 'Fix this' }],
                },
            ]);
            const ctx = createMockContext({
                catalog,
                activeReviewId: 'r1',
                changedFiles: [{ path: 'src/app.ts', status: 'M' }],
                baseRef: 'main',
            });
            provider = new CommentTreeProvider(() => store, ctx, eventEmitter.event);
            const roots = provider.getChildren(undefined);
            const files = roots.filter((n: any) => n.kind === 'file');
            assert.strictEqual(files.length, 1);
            assert.strictEqual(files[0].path, 'src/app.ts');
        });
    });

    describe('filter', () => {
        it('should default to all filter', () => {
            eventEmitter = new vscode.EventEmitter();
            const ctx = createMockContext();
            provider = new CommentTreeProvider(() => undefined, ctx, eventEmitter.event);
            assert.strictEqual(provider.getFilter(), 'all');
        });

        it('should set and apply filter', () => {
            eventEmitter = new vscode.EventEmitter();
            const reviews = [
                {
                    id: 'r1',
                    name: 'R1',
                    workspaceFolder: 'file:///ws',
                    archived: false,
                    lastActiveAt: '2024-01-01',
                    baseRef: 'main',
                    openCount: 2,
                    threadCount: 3,
                    rounds: 1,
                    workspaceFolderFsPath: '/ws',
                },
            ];
            const catalog = createMockCatalog(reviews);
            const threads = [
                { id: 't1', file: 'a.ts', startLine: 1, endLine: 1, status: 'open', comments: [{ body: 'open' }] },
                {
                    id: 't2',
                    file: 'a.ts',
                    startLine: 5,
                    endLine: 5,
                    status: 'resolved',
                    comments: [{ body: 'resolved' }],
                },
            ];
            const store = createMockStore(threads);
            const ctx = createMockContext({
                catalog,
                activeReviewId: 'r1',
                changedFiles: [{ path: 'a.ts', status: 'M' }],
                baseRef: 'main',
            });
            provider = new CommentTreeProvider(() => store, ctx, eventEmitter.event);

            provider.setFilter('open');
            assert.strictEqual(provider.getFilter(), 'open');
            const roots = provider.getChildren(undefined);
            const files = roots.filter((n: any) => n.kind === 'file');
            // Only the open thread should be visible
            if (files.length > 0) {
                assert.strictEqual(files[0].threads.length, 1);
                assert.strictEqual(files[0].threads[0].status, 'open');
            }
        });

        it('should apply resolved filter', () => {
            eventEmitter = new vscode.EventEmitter();
            const reviews = [
                {
                    id: 'r1',
                    name: 'R1',
                    workspaceFolder: 'file:///ws',
                    archived: false,
                    lastActiveAt: '2024-01-01',
                    baseRef: 'main',
                    openCount: 1,
                    threadCount: 2,
                    rounds: 1,
                    workspaceFolderFsPath: '/ws',
                },
            ];
            const catalog = createMockCatalog(reviews);
            const threads = [
                { id: 't1', file: 'a.ts', startLine: 1, endLine: 1, status: 'open', comments: [{ body: 'open' }] },
                { id: 't2', file: 'a.ts', startLine: 5, endLine: 5, status: 'resolved', comments: [{ body: 'done' }] },
            ];
            const store = createMockStore(threads);
            const ctx = createMockContext({
                catalog,
                activeReviewId: 'r1',
                changedFiles: [{ path: 'a.ts', status: 'M' }],
                baseRef: 'main',
            });
            provider = new CommentTreeProvider(() => store, ctx, eventEmitter.event);

            provider.setFilter('resolved');
            const roots = provider.getChildren(undefined);
            const files = roots.filter((n: any) => n.kind === 'file');
            if (files.length > 0) {
                assert.ok(files[0].threads.every((t: any) => t.status === 'resolved'));
            }
        });
    });

    describe('search', () => {
        it('should filter threads by search text', () => {
            eventEmitter = new vscode.EventEmitter();
            const reviews = [
                {
                    id: 'r1',
                    name: 'R1',
                    workspaceFolder: 'file:///ws',
                    archived: false,
                    lastActiveAt: '2024-01-01',
                    baseRef: 'main',
                    openCount: 2,
                    threadCount: 2,
                    rounds: 1,
                    workspaceFolderFsPath: '/ws',
                },
            ];
            const catalog = createMockCatalog(reviews);
            const threads = [
                {
                    id: 't1',
                    file: 'a.ts',
                    startLine: 1,
                    endLine: 1,
                    status: 'open',
                    comments: [{ body: 'bug in auth' }],
                },
                { id: 't2', file: 'b.ts', startLine: 1, endLine: 1, status: 'open', comments: [{ body: 'nice code' }] },
            ];
            const store = createMockStore(threads);
            const ctx = createMockContext({
                catalog,
                activeReviewId: 'r1',
                changedFiles: [
                    { path: 'a.ts', status: 'M' },
                    { path: 'b.ts', status: 'M' },
                ],
                baseRef: 'main',
            });
            provider = new CommentTreeProvider(() => store, ctx, eventEmitter.event);

            provider.setSearch('auth');
            const roots = provider.getChildren(undefined);
            const files = roots.filter((n: any) => n.kind === 'file');
            // Only the file with 'auth' in comments should have threads
            const withThreads = files.filter((f: any) => f.threads.length > 0);
            assert.strictEqual(withThreads.length, 1);
            assert.strictEqual(withThreads[0].path, 'a.ts');
        });
    });

    describe('getTreeItem', () => {
        beforeEach(() => {
            eventEmitter = new vscode.EventEmitter();
            const ctx = createMockContext();
            provider = new CommentTreeProvider(() => undefined, ctx, eventEmitter.event);
        });

        it('should render header node', () => {
            const node = { kind: 'header', text: 'Title', stats: '5 files', cmd: 'some.command' };
            const item = provider.getTreeItem(node);
            assert.ok(item.label?.includes('Title') || item.label === 'Title');
            assert.strictEqual(item.description, '5 files');
        });

        it('should render reviewPicker node with current review', () => {
            const node = {
                kind: 'reviewPicker',
                current: { name: 'My Review', baseRef: 'main', openCount: 3, threadCount: 10 },
                totalReviews: 2,
            };
            const item = provider.getTreeItem(node);
            assert.ok(item.label?.includes('My Review'));
        });

        it('should render reviewPicker node without current', () => {
            const node = { kind: 'reviewPicker', current: undefined, totalReviews: 0 };
            const item = provider.getTreeItem(node);
            assert.ok(item.label?.includes('No active review'));
        });

        it('should render file node with status', () => {
            const node = {
                kind: 'file',
                path: 'src/app.ts',
                basename: 'app.ts',
                status: 'M',
                threads: [{ status: 'open' }, { status: 'resolved' }],
                inChangedSet: true,
                countOpen: () => 1,
            };
            const item = provider.getTreeItem(node);
            assert.ok(item.label === 'app.ts');
            assert.ok(item.description?.includes('modified'));
        });

        it('should render file node for added status', () => {
            const node = {
                kind: 'file',
                path: 'new.ts',
                basename: 'new.ts',
                status: 'A',
                threads: [],
                inChangedSet: true,
                countOpen: () => 0,
            };
            const item = provider.getTreeItem(node);
            assert.ok(item.description?.includes('added'));
        });

        it('should render file node for deleted status', () => {
            const node = {
                kind: 'file',
                path: 'old.ts',
                basename: 'old.ts',
                status: 'D',
                threads: [],
                inChangedSet: true,
                countOpen: () => 0,
            };
            const item = provider.getTreeItem(node);
            assert.ok(item.description?.includes('deleted'));
        });

        it('should render file node for renamed status', () => {
            const node = {
                kind: 'file',
                path: 'renamed.ts',
                basename: 'renamed.ts',
                status: 'R',
                threads: [],
                inChangedSet: true,
                countOpen: () => 0,
            };
            const item = provider.getTreeItem(node);
            assert.ok(item.description?.includes('renamed'));
        });

        it('should render file node for copied status', () => {
            const node = {
                kind: 'file',
                path: 'copy.ts',
                basename: 'copy.ts',
                status: 'C',
                threads: [],
                inChangedSet: true,
                countOpen: () => 0,
            };
            const item = provider.getTreeItem(node);
            assert.ok(item.description?.includes('copied'));
        });

        it('should render file node for type-changed status', () => {
            const node = {
                kind: 'file',
                path: 'x.ts',
                basename: 'x.ts',
                status: 'T',
                threads: [],
                inChangedSet: true,
                countOpen: () => 0,
            };
            const item = provider.getTreeItem(node);
            assert.ok(item.description?.includes('type-changed'));
        });

        it('should render file node without status', () => {
            const node = {
                kind: 'file',
                path: 'x.ts',
                basename: 'x.ts',
                status: undefined,
                threads: [{ status: 'open' }],
                inChangedSet: false,
                countOpen: () => 1,
            };
            const item = provider.getTreeItem(node);
            assert.ok(item.description?.includes('1 open'));
        });

        it('should render file node not in changed set with external context value', () => {
            const node = {
                kind: 'file',
                path: 'ext.ts',
                basename: 'ext.ts',
                status: undefined,
                threads: [],
                inChangedSet: false,
                countOpen: () => 0,
            };
            const item = provider.getTreeItem(node);
            assert.strictEqual(item.contextValue, 'reviewFileExternal');
        });

        it('should render folder node', () => {
            const node = {
                kind: 'folder',
                segment: 'src',
                fullPath: 'src',
                folders: [],
                files: [{ threads: [{ status: 'open' }] }],
                countOpen: () => 1,
                countFiles: () => 1,
            };
            const item = provider.getTreeItem(node);
            assert.ok(item.label === 'src');
            assert.ok(item.description?.includes('1 file'));
        });

        it('should render thread node', () => {
            const node = {
                kind: 'thread',
                thread: {
                    startLine: 10,
                    endLine: 15,
                    status: 'open',
                    origin: 'user',
                    comments: [{ body: 'This is a bug' }],
                },
            };
            const item = provider.getTreeItem(node);
            assert.ok(item.label?.includes('L10-15'));
            assert.ok(item.label?.includes('This is a bug'));
        });

        it('should render thread with single line', () => {
            const node = {
                kind: 'thread',
                thread: {
                    startLine: 5,
                    endLine: 5,
                    status: 'resolved',
                    origin: 'agent',
                    comments: [{ body: 'Fixed' }, { body: 'Thanks' }],
                },
            };
            const item = provider.getTreeItem(node);
            assert.ok(item.label?.includes('L5:'));
            assert.ok(item.description?.includes('2 replies'));
        });

        it('should render section node', () => {
            const node = { kind: 'section', title: 'Reviews', children: [{}, {}] };
            const item = provider.getTreeItem(node);
            assert.ok(item.label === 'Reviews');
            assert.ok(item.description?.includes('2'));
        });

        it('should render catalogReview node', () => {
            const node = {
                kind: 'catalogReview',
                meta: {
                    name: 'R1',
                    baseRef: 'main',
                    openCount: 2,
                    threadCount: 5,
                    rounds: 3,
                    workspaceFolderFsPath: '/ws',
                    lastActiveAt: '2024-01-01',
                },
                isActive: true,
                inCurrentWorkspace: true,
            };
            const item = provider.getTreeItem(node);
            assert.ok(item.label === 'R1');
            assert.ok(item.description?.includes('main'));
        });
    });

    describe('getChildren', () => {
        it('should return thread nodes for file node', () => {
            eventEmitter = new vscode.EventEmitter();
            const ctx = createMockContext();
            provider = new CommentTreeProvider(() => undefined, ctx, eventEmitter.event);
            const threads = [{ id: 't1' }, { id: 't2' }];
            const fileNode = { kind: 'file', threads };
            const children = provider.getChildren(fileNode);
            assert.strictEqual(children.length, 2);
            assert.strictEqual(children[0].kind, 'thread');
        });

        it('should return folders and files for folder node', () => {
            eventEmitter = new vscode.EventEmitter();
            const ctx = createMockContext();
            provider = new CommentTreeProvider(() => undefined, ctx, eventEmitter.event);
            const folderNode = {
                kind: 'folder',
                folders: [{ kind: 'folder', segment: 'sub' }],
                files: [{ kind: 'file', path: 'a.ts' }],
            };
            const children = provider.getChildren(folderNode);
            assert.strictEqual(children.length, 2);
        });

        it('should return children for section node', () => {
            eventEmitter = new vscode.EventEmitter();
            const ctx = createMockContext();
            provider = new CommentTreeProvider(() => undefined, ctx, eventEmitter.event);
            const sectionNode = { kind: 'section', children: [{ kind: 'catalogReview' }, { kind: 'catalogReview' }] };
            const children = provider.getChildren(sectionNode);
            assert.strictEqual(children.length, 2);
        });

        it('should return empty for thread node', () => {
            eventEmitter = new vscode.EventEmitter();
            const ctx = createMockContext();
            provider = new CommentTreeProvider(() => undefined, ctx, eventEmitter.event);
            const children = provider.getChildren({ kind: 'thread' });
            assert.strictEqual(children.length, 0);
        });
    });

    describe('tree layout modes', () => {
        function setupWithFiles(layout: string) {
            const eventEmitter2 = new vscode.EventEmitter();
            const reviews = [
                {
                    id: 'r1',
                    name: 'R1',
                    workspaceFolder: 'file:///ws',
                    archived: false,
                    lastActiveAt: '2024-01-01',
                    baseRef: 'main',
                    openCount: 0,
                    threadCount: 0,
                    rounds: 1,
                    workspaceFolderFsPath: '/ws',
                },
            ];
            const catalog = createMockCatalog(reviews);
            const changedFiles = [
                { path: 'src/utils/helpers.ts', status: 'M' },
                { path: 'src/utils/format.ts', status: 'A' },
                { path: 'src/main.ts', status: 'M' },
                { path: 'lib/index.ts', status: 'M' },
            ];
            const ctx = createMockContext({ catalog, activeReviewId: 'r1', changedFiles, baseRef: 'main', layout });
            const p = new CommentTreeProvider(() => createMockStore(), ctx, eventEmitter2.event);
            return {
                provider: p,
                cleanup: () => {
                    p.dispose();
                    eventEmitter2.dispose();
                },
            };
        }

        it('should render flat layout', () => {
            const { provider: p, cleanup } = setupWithFiles('flat');
            try {
                const roots = p.getChildren(undefined);
                const files = roots.filter((n: any) => n.kind === 'file');
                assert.strictEqual(files.length, 4);
                // Files should be sorted alphabetically
                assert.ok(files[0].path.localeCompare(files[1].path) <= 0);
            } finally {
                cleanup();
            }
        });

        it('should render tree layout with folders', () => {
            const { provider: p, cleanup } = setupWithFiles('tree');
            try {
                const roots = p.getChildren(undefined);
                const folders = roots.filter((n: any) => n.kind === 'folder');
                assert.ok(folders.length > 0, 'Should have folder nodes in tree layout');
            } finally {
                cleanup();
            }
        });

        it('should render compact layout (collapses single-child folders)', () => {
            const { provider: p, cleanup } = setupWithFiles('compact');
            try {
                const roots = p.getChildren(undefined);
                const folders = roots.filter((n: any) => n.kind === 'folder');
                // In compact mode, src/utils should be collapsed
                if (folders.length > 0) {
                    const srcFolder = folders.find((f: any) => f.segment.includes('src'));
                    assert.ok(srcFolder, 'Should have a src folder');
                }
            } finally {
                cleanup();
            }
        });
    });

    describe('files not in changed set', () => {
        it('should include files with threads that are not in changed set', () => {
            eventEmitter = new vscode.EventEmitter();
            const reviews = [
                {
                    id: 'r1',
                    name: 'R1',
                    workspaceFolder: 'file:///ws',
                    archived: false,
                    lastActiveAt: '2024-01-01',
                    baseRef: 'main',
                    openCount: 1,
                    threadCount: 1,
                    rounds: 1,
                    workspaceFolderFsPath: '/ws',
                },
            ];
            const catalog = createMockCatalog(reviews);
            const threads = [
                { id: 't1', file: 'other.ts', startLine: 1, endLine: 1, status: 'open', comments: [{ body: 'hi' }] },
            ];
            const store = createMockStore(threads);
            const ctx = createMockContext({
                catalog,
                activeReviewId: 'r1',
                changedFiles: [{ path: 'src/app.ts', status: 'M' }],
                baseRef: 'main',
            });
            provider = new CommentTreeProvider(() => store, ctx, eventEmitter.event);
            const roots = provider.getChildren(undefined);
            const files = roots.filter((n: any) => n.kind === 'file');
            const otherFile = files.find((f: any) => f.path === 'other.ts');
            assert.ok(otherFile, 'Should include file with thread not in changed set');
            assert.strictEqual(otherFile.inChangedSet, false);
        });
    });

    describe('refresh', () => {
        it('should not error when refreshing', () => {
            eventEmitter = new vscode.EventEmitter();
            const ctx = createMockContext();
            provider = new CommentTreeProvider(() => undefined, ctx, eventEmitter.event);
            provider.refresh();
            // No error
        });
    });
});

describe('Split review tree providers', () => {
    let eventEmitter: any;
    let provider: any;

    afterEach(() => {
        provider?.dispose();
        eventEmitter?.dispose();
    });

    it('renders catalog provider empty state', () => {
        eventEmitter = new vscode.EventEmitter();
        provider = new ReviewCatalogTreeProvider(
            {
                getCatalog: () => createMockCatalog([]),
                getActiveReviewId: () => undefined,
                getShowOtherWorkspaces: () => true,
                getCurrentWorkspaceFolderUris: () => ['file:///workspace'],
            },
            eventEmitter.event,
        );
        const roots = provider.getChildren(undefined);
        assert.strictEqual(roots[0].kind, 'header');
        assert.ok(provider.getTreeItem(roots[0]).label?.includes('No reviews'));
    });

    it('groups current and other workspace reviews in catalog provider', () => {
        eventEmitter = new vscode.EventEmitter();
        const reviews = [
            {
                id: 'r1',
                name: 'Current',
                workspaceFolder: 'file:///workspace',
                workspaceFolderFsPath: '/workspace',
                archived: false,
                lastActiveAt: '2024-01-02',
                openCount: 1,
                threadCount: 2,
                rounds: 1,
                baseRef: 'main',
                lastAgent: { name: 'Copilot', lastSeenAt: '2024-01-02T00:00:00Z' },
            },
            {
                id: 'r2',
                name: 'Other',
                workspaceFolder: 'file:///other',
                workspaceFolderFsPath: '/other',
                archived: false,
                lastActiveAt: '2024-01-01',
                openCount: 0,
                threadCount: 1,
                rounds: 0,
            },
        ];
        provider = new ReviewCatalogTreeProvider(
            {
                getCatalog: () => createMockCatalog(reviews),
                getActiveReviewId: () => 'r1',
                getShowOtherWorkspaces: () => true,
                getCurrentWorkspaceFolderUris: () => ['file:///workspace'],
            },
            eventEmitter.event,
        );
        const roots = provider.getChildren(undefined);
        assert.deepStrictEqual(
            roots.map((n: any) => n.title),
            ['Current workspace', 'Other workspaces'],
        );
        const currentReview = provider.getChildren(roots[0])[0];
        const item = provider.getTreeItem(currentReview);
        assert.ok(item.description.includes('agent Copilot'));
        assert.strictEqual(item.contextValue, 'catalogReviewActive');
    });

    it('shows hidden other-workspace count when catalog filter is narrow', () => {
        eventEmitter = new vscode.EventEmitter();
        const reviews = [
            {
                id: 'r1',
                name: 'Other',
                workspaceFolder: 'file:///other',
                workspaceFolderFsPath: '/other',
                archived: false,
                lastActiveAt: '2024-01-01',
                openCount: 0,
                threadCount: 0,
                rounds: 0,
            },
        ];
        provider = new ReviewCatalogTreeProvider(
            {
                getCatalog: () => createMockCatalog(reviews),
                getActiveReviewId: () => undefined,
                getShowOtherWorkspaces: () => false,
                getCurrentWorkspaceFolderUris: () => ['file:///workspace'],
            },
            eventEmitter.event,
        );
        const roots = provider.getChildren(undefined);
        assert.ok(provider.getTreeItem(roots[0]).label?.includes('hidden'));
    });

    it('renders active review details and review-wide comments', () => {
        eventEmitter = new vscode.EventEmitter();
        const activeReview = {
            id: 'r1',
            name: 'Active',
            workspaceFolder: 'file:///workspace',
            workspaceFolderFsPath: '/workspace',
            baseRef: 'main',
            baseSha: 'base-sha',
            openCount: 2,
            threadCount: 2,
            rounds: 3,
        };
        const store = createMockStore([
            {
                id: 'g1',
                scope: 'review',
                status: 'open',
                origin: 'user',
                createdAt: '2024-01-01T00:00:00Z',
                comments: [
                    { author: 'You', origin: 'user', body: 'Overall design concern' },
                    { author: 'Agent', origin: 'agent', body: 'I will address it.' },
                ],
            },
            {
                id: 'f1',
                scope: 'file',
                file: 'src/app.ts',
                startLine: 4,
                endLine: 4,
                side: 'right',
                status: 'open',
                origin: 'user',
                createdAt: '2024-01-02T00:00:00Z',
                comments: [{ author: 'You', origin: 'user', body: 'Fix line' }],
            },
        ]);
        const ctx = createMockContext({
            activeReview,
            changedFiles: [{ path: 'src/app.ts', status: 'M' }],
            reviewInfo: {
                repoName: 'workspace',
                repoPath: '/workspace',
                branch: 'feature',
                upstream: 'origin/feature',
                baseRef: 'main',
                baseSha: 'base-sha',
                headSha: 'abcdef1234567890',
                changedFileCount: 1,
                threadCount: 2,
                openCount: 2,
                round: 3,
                viewModeLabel: 'Overall',
                lastAgent: { name: 'Copilot', kind: 'cli', id: 's1', lastSeenAt: '2024-01-03T00:00:00Z' },
            },
        });
        provider = new ActiveReviewTreeProvider(() => store, ctx, eventEmitter.event);

        const roots = provider.getChildren(undefined);
        const details = roots.find((n: any) => n.kind === 'section' && n.title === 'Review details');
        assert.ok(details);
        const detailItems = provider.getChildren(details);
        assert.ok(detailItems.some((n: any) => n.kind === 'info' && n.label === 'Branch' && n.value === 'feature'));
        assert.ok(
            detailItems.some((n: any) => n.kind === 'info' && n.label === 'Last agent' && n.value.includes('Copilot')),
        );

        const reviewWide = roots.find((n: any) => n.kind === 'section' && n.title === 'Review-wide comments');
        assert.ok(reviewWide);
        const genericThread = provider.getChildren(reviewWide)[0];
        const threadItem = provider.getTreeItem(genericThread);
        assert.ok(threadItem.label.includes('Review: Overall design concern'));
        const messages = provider.getChildren(genericThread);
        assert.strictEqual(messages.length, 2);
        assert.ok(provider.getTreeItem(messages[1]).description.includes('agent'));
    });

    it('filters review-wide comments by status and search', () => {
        eventEmitter = new vscode.EventEmitter();
        const activeReview = { id: 'r1', name: 'Active', workspaceFolderFsPath: '/workspace' };
        const store = createMockStore([
            {
                id: 'g1',
                scope: 'review',
                status: 'resolved',
                origin: 'user',
                createdAt: '2024-01-01T00:00:00Z',
                comments: [{ author: 'You', origin: 'user', body: 'security note' }],
            },
            {
                id: 'g2',
                scope: 'review',
                status: 'open',
                origin: 'user',
                createdAt: '2024-01-02T00:00:00Z',
                comments: [{ author: 'You', origin: 'user', body: 'performance note' }],
            },
        ]);
        provider = new ActiveReviewTreeProvider(
            () => store,
            createMockContext({ activeReview, changedFiles: [], viewMode: 'Overall' }),
            eventEmitter.event,
        );
        provider.setFilter('open');
        provider.setSearch('performance');
        const roots = provider.getChildren(undefined);
        const reviewWide = roots.find((n: any) => n.kind === 'section' && n.title === 'Review-wide comments');
        assert.ok(reviewWide);
        const threads = provider.getChildren(reviewWide);
        assert.strictEqual(threads.length, 1);
        assert.strictEqual(threads[0].thread.id, 'g2');
    });
});
