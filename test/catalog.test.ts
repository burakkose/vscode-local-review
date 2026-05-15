import * as assert from 'assert';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ReviewCatalog } = require('../src/catalog');

describe('ReviewCatalog', () => {
    let catalog: any;
    let fsStore: Map<string, Uint8Array>;
    const globalStorage = vscode.Uri.file('/global/storage');

    beforeEach(() => {
        fsStore = new Map();
        // Mock filesystem backed by in-memory map
        vscode.workspace.fs.readFile = async (uri: any) => {
            const data = fsStore.get(uri.path);
            if (!data) {
                const err: any = new Error('File not found');
                err.code = 'FileNotFound';
                throw err;
            }
            return data;
        };
        vscode.workspace.fs.writeFile = async (uri: any, content: Uint8Array) => {
            fsStore.set(uri.path, content);
        };
        vscode.workspace.fs.createDirectory = async () => {};
        vscode.workspace.fs.delete = async (uri: any) => {
            for (const key of fsStore.keys()) {
                if (key.startsWith(uri.path)) fsStore.delete(key);
            }
        };
        catalog = new ReviewCatalog(globalStorage);
    });

    afterEach(() => {
        catalog.dispose();
        // Restore defaults
        vscode.workspace.fs.readFile = async () => new Uint8Array();
        vscode.workspace.fs.writeFile = async () => {};
        vscode.workspace.fs.createDirectory = async () => {};
        vscode.workspace.fs.delete = async () => {};
    });

    describe('load', () => {
        it('should start with empty index when no file exists', async () => {
            await catalog.load();
            assert.deepStrictEqual(catalog.list(), []);
        });

        it('should load existing index from disk', async () => {
            const existing = {
                version: 1,
                reviews: [
                    {
                        id: 'r1',
                        name: 'Review 1',
                        workspaceFolder: 'file:///workspace',
                        workspaceFolderFsPath: '/workspace',
                        archived: false,
                        createdAt: '2024-01-01T00:00:00.000Z',
                        lastActiveAt: '2024-01-01T00:00:00.000Z',
                        threadCount: 5,
                        openCount: 3,
                        rounds: 1,
                    },
                ],
                lastActiveByWorkspace: {},
            };
            const indexPath = '/global/storage/reviews/index.json';
            fsStore.set(indexPath, new TextEncoder().encode(JSON.stringify(existing)));
            await catalog.load();
            assert.strictEqual(catalog.list().length, 1);
            assert.strictEqual(catalog.list()[0].name, 'Review 1');
        });

        it('should handle corrupt JSON gracefully', async () => {
            const indexPath = '/global/storage/reviews/index.json';
            fsStore.set(indexPath, new TextEncoder().encode('not valid json {{'));
            await catalog.load();
            assert.deepStrictEqual(catalog.list(), []);
        });

        it('should ignore catalog entries with unsafe review ids', async () => {
            const existing = {
                version: 1,
                reviews: [
                    {
                        id: '../../outside',
                        name: 'Unsafe',
                        workspaceFolder: 'file:///workspace',
                        workspaceFolderFsPath: '/workspace',
                        archived: false,
                    },
                    {
                        id: 'safe-review',
                        name: 'Safe',
                        workspaceFolder: 'file:///workspace',
                        workspaceFolderFsPath: '/workspace',
                        archived: false,
                    },
                ],
                lastActiveByWorkspace: { 'file:///workspace': '../../outside' },
                lastActiveGlobal: '../../outside',
            };
            fsStore.set('/global/storage/reviews/index.json', new TextEncoder().encode(JSON.stringify(existing)));
            await catalog.load();
            assert.strictEqual(catalog.list().length, 1);
            assert.strictEqual(catalog.list()[0].id, 'safe-review');
            assert.strictEqual(catalog.lastActiveFor('file:///workspace'), undefined);
            assert.strictEqual(catalog.lastActiveGlobal(), undefined);
        });
    });

    describe('create', () => {
        it('should create a new review and persist', async () => {
            await catalog.load();
            const meta = await catalog.create(vscode.Uri.file('/my/project'), 'My Review', 'main');
            assert.strictEqual(meta.name, 'My Review');
            assert.strictEqual(meta.baseRef, 'main');
            assert.strictEqual(meta.archived, false);
            assert.ok(meta.id);
            assert.strictEqual(catalog.list().length, 1);
        });

        it('should set the new review as last active', async () => {
            await catalog.load();
            const meta = await catalog.create(vscode.Uri.file('/my/project'), 'R1');
            const lastActive = catalog.lastActiveGlobal();
            assert.strictEqual(lastActive?.id, meta.id);
        });
    });

    describe('find/filter', () => {
        beforeEach(async () => {
            await catalog.load();
            await catalog.create(vscode.Uri.file('/project-a'), 'Review A');
            await catalog.create(vscode.Uri.file('/project-b'), 'Review B');
        });

        it('should find by id', () => {
            const all = catalog.list();
            const found = catalog.find(all[0].id);
            assert.strictEqual(found?.name, 'Review A');
        });

        it('should return undefined for unknown id', () => {
            assert.strictEqual(catalog.find('nonexistent'), undefined);
        });

        it('should list active reviews (non-archived)', () => {
            assert.strictEqual(catalog.listActive().length, 2);
        });

        it('should filter by workspace folder', () => {
            const byWorkspace = catalog.findByWorkspace('file:///project-a');
            assert.strictEqual(byWorkspace.length, 1);
            assert.strictEqual(byWorkspace[0].name, 'Review A');
        });

        it('should be case-insensitive for workspace URI matching', () => {
            const byWorkspace = catalog.findByWorkspace('FILE:///PROJECT-A');
            assert.strictEqual(byWorkspace.length, 1);
        });
    });

    describe('updateStats', () => {
        it('should update thread/open counts', async () => {
            await catalog.load();
            const meta = await catalog.create(vscode.Uri.file('/proj'), 'R');
            await catalog.updateStats(meta.id, {
                threadCount: 10,
                openCount: 5,
                rounds: 2,
                lastAgent: {
                    name: 'Copilot',
                    kind: 'cli',
                    id: 's1',
                    lastSeenAt: '2024-01-01T00:00:00.000Z',
                },
            });
            const updated = catalog.find(meta.id);
            assert.strictEqual(updated?.threadCount, 10);
            assert.strictEqual(updated?.openCount, 5);
            assert.strictEqual(updated?.rounds, 2);
            assert.strictEqual(updated?.lastAgent?.name, 'Copilot');
        });

        it('should ignore unknown id', async () => {
            await catalog.load();
            await catalog.updateStats('no-such-id', { threadCount: 99 });
            // No error thrown
        });
    });

    describe('rename', () => {
        it('should rename a review', async () => {
            await catalog.load();
            const meta = await catalog.create(vscode.Uri.file('/proj'), 'Old Name');
            await catalog.rename(meta.id, 'New Name');
            assert.strictEqual(catalog.find(meta.id)?.name, 'New Name');
        });
    });

    describe('archive', () => {
        it('should archive a review', async () => {
            await catalog.load();
            const meta = await catalog.create(vscode.Uri.file('/proj'), 'R');
            await catalog.archive(meta.id, true);
            assert.strictEqual(catalog.find(meta.id)?.archived, true);
            assert.strictEqual(catalog.listActive().length, 0);
        });

        it('should unarchive a review', async () => {
            await catalog.load();
            const meta = await catalog.create(vscode.Uri.file('/proj'), 'R');
            await catalog.archive(meta.id, true);
            await catalog.archive(meta.id, false);
            assert.strictEqual(catalog.find(meta.id)?.archived, false);
            assert.strictEqual(catalog.listActive().length, 1);
        });
    });

    describe('delete', () => {
        it('should remove a review from the index', async () => {
            await catalog.load();
            const meta = await catalog.create(vscode.Uri.file('/proj'), 'R');
            await catalog.delete(meta.id);
            assert.strictEqual(catalog.list().length, 0);
        });

        it('should clear lastActiveGlobal if deleted', async () => {
            await catalog.load();
            const meta = await catalog.create(vscode.Uri.file('/proj'), 'R');
            await catalog.delete(meta.id);
            assert.strictEqual(catalog.lastActiveGlobal(), undefined);
        });
    });

    describe('setActive', () => {
        it('should update last active for a workspace', async () => {
            await catalog.load();
            const _m1 = await catalog.create(vscode.Uri.file('/proj'), 'R1');
            const _m2 = await catalog.create(vscode.Uri.file('/proj'), 'R2');
            await catalog.setActive(_m1.id, 'file:///proj');
            const lastActive = catalog.lastActiveFor('file:///proj');
            assert.strictEqual(lastActive?.id, _m1.id);
            // Global should still point to m2 since setActive was for specific workspace
            // Actually setActive updates global too per source code
            assert.strictEqual(catalog.lastActiveGlobal()?.id, _m1.id);
        });
    });

    describe('pathsFor', () => {
        it('should return paths for a review meta', async () => {
            await catalog.load();
            const meta = await catalog.create(vscode.Uri.file('/proj'), 'R');
            const paths = catalog.pathsFor(meta);
            assert.ok(paths.root.path.includes(meta.id));
            assert.ok(paths.state.path.endsWith('state.json'));
        });
    });

    describe('normalize (via load with partial data)', () => {
        it('should fill in defaults for missing fields', async () => {
            const partial = {
                version: 1,
                reviews: [{ id: 'r1' }],
                lastActiveByWorkspace: {},
            };
            const indexPath = '/global/storage/reviews/index.json';
            fsStore.set(indexPath, new TextEncoder().encode(JSON.stringify(partial)));
            await catalog.load();
            const r = catalog.find('r1');
            assert.strictEqual(r?.name, '(untitled)');
            assert.strictEqual(r?.archived, false);
            assert.strictEqual(r?.threadCount, 0);
            assert.strictEqual(r?.openCount, 0);
            assert.strictEqual(r?.rounds, 0);
            assert.strictEqual(r?.workspaceFolder, '');
        });
    });
});
