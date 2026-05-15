import * as assert from 'assert';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CommentStore } = require('../src/store');

describe('CommentStore', () => {
    let store: any;
    let fsStore: Map<string, Uint8Array>;

    beforeEach(() => {
        fsStore = new Map();
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
        vscode.workspace.fs.delete = async () => {};
        vscode.workspace.fs.rename = async (source: any, target: any) => {
            const data = fsStore.get(source.path);
            if (data) {
                fsStore.set(target.path, data);
                fsStore.delete(source.path);
            }
        };
        vscode.workspace.fs.copy = async (source: any, target: any) => {
            const data = fsStore.get(source.path);
            if (data) {
                fsStore.set(target.path, new Uint8Array(data));
            } else {
                const err: any = new Error('File not found');
                err.code = 'FileNotFound';
                throw err;
            }
        };

        const stateUri = vscode.Uri.file('/storage/state.json');
        const stateBakUri = vscode.Uri.file('/storage/state.json.bak');
        store = new CommentStore({ state: stateUri, stateBak: stateBakUri });
    });

    afterEach(() => {
        store.dispose();
        vscode.workspace.fs.readFile = async () => new Uint8Array();
        vscode.workspace.fs.writeFile = async () => {};
        vscode.workspace.fs.createDirectory = async () => {};
        vscode.workspace.fs.delete = async () => {};
        vscode.workspace.fs.rename = async () => {};
        vscode.workspace.fs.copy = async () => {};
    });

    describe('constructor', () => {
        it('should accept state/stateBak paths', () => {
            assert.ok(store.getStorageUri().path.endsWith('/state.json'));
            assert.ok(store.getBackupUri().path.endsWith('/state.json.bak'));
        });

        it('should accept an ExtensionContext-shaped object', () => {
            const ctx = {
                storageUri: vscode.Uri.file('/ext/storage'),
                globalStorageUri: vscode.Uri.file('/ext/global'),
            };
            const s = new CommentStore(ctx);
            assert.ok(s.getStorageUri().path.includes('/ext/storage'));
            s.dispose();
        });

        it('should fallback to globalStorageUri when storageUri is undefined', () => {
            const ctx = {
                storageUri: undefined,
                globalStorageUri: vscode.Uri.file('/ext/global'),
            };
            const s = new CommentStore(ctx);
            assert.ok(s.getStorageUri().path.includes('/ext/global'));
            s.dispose();
        });
    });

    describe('load', () => {
        it('should return empty state when no file exists', async () => {
            const result = await store.load();
            assert.strictEqual(result.existed, false);
            assert.strictEqual(result.corrupt, false);
            assert.deepStrictEqual(store.threads(), []);
        });

        it('should load valid state from disk', async () => {
            const state = {
                threads: [
                    {
                        id: 't1',
                        file: 'src/main.ts',
                        startLine: 5,
                        endLine: 10,
                        side: 'right',
                        status: 'open',
                        excerpt: 'test',
                        comments: [{ id: 'c1', threadId: 't1', body: 'Hello', author: 'User' }],
                    },
                ],
            };
            fsStore.set('/storage/state.json', new TextEncoder().encode(JSON.stringify(state)));
            const result = await store.load();
            assert.strictEqual(result.existed, true);
            assert.strictEqual(result.corrupt, false);
            assert.strictEqual(store.threads().length, 1);
            assert.strictEqual(store.threads()[0].file, 'src/main.ts');
        });

        it('should normalize review-wide threads and last-agent metadata', async () => {
            const state = {
                threads: [
                    {
                        id: 'g1',
                        scope: 'review',
                        status: 'open',
                        origin: 'agent',
                        comments: [{ body: 'Review-wide finding', author: 'Agent' }],
                        createdAt: '2024-01-01T00:00:00.000Z',
                    },
                ],
                importedHashes: ['h1', 42],
                rounds: [{ n: 2, triggeredAt: '2024-01-01T00:00:00.000Z' }],
                lastAgent: { name: ' Copilot ', kind: ' cli ', id: ' s1 ', lastSeenAt: 'bad-date' },
            };
            fsStore.set('/storage/state.json', new TextEncoder().encode(JSON.stringify(state)));
            await store.load();
            const loaded = store.getState();
            assert.strictEqual(loaded.threads[0].scope, 'review');
            assert.strictEqual(loaded.threads[0].comments[0].threadId, 'g1');
            assert.deepStrictEqual(loaded.importedHashes, ['h1']);
            assert.strictEqual(loaded.rounds?.[0].openCountAtTrigger, 0);
            assert.strictEqual(loaded.lastAgent?.name, 'Copilot');
            assert.strictEqual(loaded.lastAgent?.kind, 'cli');
            assert.strictEqual(loaded.lastAgent?.id, 's1');
        });

        it('should downgrade stored threads with unsafe file paths to review-wide threads', async () => {
            const state = {
                threads: [
                    {
                        id: 'unsafe',
                        file: '../outside.ts',
                        startLine: 1,
                        endLine: 1,
                        status: 'open',
                        comments: [{ id: 'c1', threadId: 'unsafe', body: 'Do not escape workspace', author: 'Agent' }],
                    },
                ],
            };
            fsStore.set('/storage/state.json', new TextEncoder().encode(JSON.stringify(state)));
            await store.load();
            assert.strictEqual(store.threads().length, 1);
            assert.strictEqual(store.threads()[0].scope, 'review');
            assert.strictEqual(store.threads()[0].comments[0].body, 'Do not escape workspace');
        });

        it('should handle corrupt JSON', async () => {
            fsStore.set('/storage/state.json', new TextEncoder().encode('{{not json'));
            const result = await store.load();
            assert.strictEqual(result.corrupt, true);
            assert.strictEqual(result.existed, true);
        });

        it('should handle non-FileNotFound errors as corrupt', async () => {
            vscode.workspace.fs.readFile = async () => {
                const err: any = new Error('Permission denied');
                err.code = 'NoPermissions';
                throw err;
            };
            const result = await store.load();
            assert.strictEqual(result.corrupt, true);
            assert.strictEqual(result.existed, true);
        });
    });

    describe('thread operations', () => {
        beforeEach(async () => {
            await store.load();
        });

        it('should add a thread', async () => {
            const t = await store.addThread(
                { file: 'src/app.ts', startLine: 1, endLine: 3, side: 'right', excerpt: 'code' },
                'Nice code!',
                'Alice',
            );
            assert.ok(t.id);
            assert.strictEqual(t.file, 'src/app.ts');
            assert.strictEqual(t.origin, 'user');
            assert.strictEqual(t.status, 'open');
            assert.strictEqual(t.comments.length, 1);
            assert.strictEqual(t.comments[0].body, 'Nice code!');
            assert.strictEqual(store.threads().length, 1);
        });

        it('should reject user threads with unsafe file paths', async () => {
            await assert.rejects(
                () =>
                    store.addThread(
                        { file: '../outside.ts', startLine: 1, endLine: 1, side: 'right', excerpt: '' },
                        'unsafe',
                        'Alice',
                    ),
                /Invalid review thread file path/,
            );
        });

        it('should find a thread by id', async () => {
            const t = await store.addThread(
                { file: 'f.ts', startLine: 1, endLine: 1, side: 'right', excerpt: '' },
                'hi',
                'Bob',
            );
            assert.strictEqual(store.findThread(t.id)?.id, t.id);
        });

        it('should return undefined for unknown thread id', () => {
            assert.strictEqual(store.findThread('nope'), undefined);
        });

        it('should add a reply to a thread', async () => {
            const t = await store.addThread(
                { file: 'f.ts', startLine: 1, endLine: 1, side: 'right', excerpt: '' },
                'first',
                'A',
            );
            const reply = await store.addReply(t.id, 'response', 'B');
            assert.ok(reply);
            assert.strictEqual(reply?.body, 'response');
            assert.strictEqual(store.findThread(t.id)!.comments.length, 2);
        });

        it('should return undefined when replying to nonexistent thread', async () => {
            const reply = await store.addReply('fake', 'hi', 'X');
            assert.strictEqual(reply, undefined);
        });

        it('should delete a thread', async () => {
            const t = await store.addThread(
                { file: 'f.ts', startLine: 1, endLine: 1, side: 'right', excerpt: '' },
                'hi',
                'A',
            );
            await store.deleteThread(t.id);
            assert.strictEqual(store.threads().length, 0);
        });

        it('should set thread status', async () => {
            const t = await store.addThread(
                { file: 'f.ts', startLine: 1, endLine: 1, side: 'right', excerpt: '' },
                'hi',
                'A',
            );
            await store.setThreadStatus(t.id, 'resolved');
            assert.strictEqual(store.findThread(t.id)!.status, 'resolved');
        });

        it('should not persist when status unchanged', async () => {
            const t = await store.addThread(
                { file: 'f.ts', startLine: 1, endLine: 1, side: 'right', excerpt: '' },
                'hi',
                'A',
            );
            // Already open — calling again should be a no-op
            await store.setThreadStatus(t.id, 'open');
            assert.strictEqual(store.findThread(t.id)!.status, 'open');
        });

        it('should edit a comment', async () => {
            const t = await store.addThread(
                { file: 'f.ts', startLine: 1, endLine: 1, side: 'right', excerpt: '' },
                'original',
                'A',
            );
            await store.editComment(t.comments[0].id, 'edited');
            assert.strictEqual(store.findThread(t.id)!.comments[0].body, 'edited');
        });

        it('should delete a comment and remove thread if empty', async () => {
            const t = await store.addThread(
                { file: 'f.ts', startLine: 1, endLine: 1, side: 'right', excerpt: '' },
                'only comment',
                'A',
            );
            await store.deleteComment(t.comments[0].id);
            assert.strictEqual(store.threads().length, 0);
        });

        it('should delete a comment but keep thread if other comments exist', async () => {
            const t = await store.addThread(
                { file: 'f.ts', startLine: 1, endLine: 1, side: 'right', excerpt: '' },
                'first',
                'A',
            );
            await store.addReply(t.id, 'second', 'B');
            await store.deleteComment(t.comments[0].id);
            assert.strictEqual(store.threads().length, 1);
            assert.strictEqual(store.findThread(t.id)!.comments.length, 1);
        });
    });

    describe('agent operations', () => {
        beforeEach(async () => {
            await store.load();
        });

        it('should add an agent reply with dedupe', async () => {
            const t = await store.addThread(
                { file: 'f.ts', startLine: 1, endLine: 1, side: 'right', excerpt: '' },
                'q',
                'User',
            );
            const reply = await store.addAgentReply(t.id, 'answer', 'Agent', 'hash1');
            assert.ok(reply);
            assert.strictEqual(reply?.origin, 'agent');
            // Duplicate should be ignored
            const dup = await store.addAgentReply(t.id, 'answer again', 'Agent', 'hash1');
            assert.strictEqual(dup, undefined);
            assert.strictEqual(store.findThread(t.id)!.comments.length, 2);
        });

        it('should update status when agent resolves', async () => {
            const t = await store.addThread(
                { file: 'f.ts', startLine: 1, endLine: 1, side: 'right', excerpt: '' },
                'q',
                'User',
            );
            await store.addAgentReply(t.id, 'done', 'Agent', 'h1', 'resolved');
            assert.strictEqual(store.findThread(t.id)!.status, 'resolved');
        });

        it('should add an agent thread with dedupe', async () => {
            const t = await store.addAgentThread(
                { file: 'f.ts', startLine: 1, endLine: 1, side: 'right', excerpt: 'code' },
                'Found an issue',
                'Agent',
                'hash-new',
            );
            assert.ok(t);
            assert.strictEqual(t?.origin, 'agent');
            assert.strictEqual(store.threads().length, 1);
            // Duplicate
            const dup = await store.addAgentThread(
                { file: 'f.ts', startLine: 1, endLine: 1, side: 'right', excerpt: 'code' },
                'Same issue',
                'Agent',
                'hash-new',
            );
            assert.strictEqual(dup, undefined);
            assert.strictEqual(store.threads().length, 1);
        });

        it('should reject agent file threads with unsafe file paths', async () => {
            await assert.rejects(
                () =>
                    store.addAgentThread(
                        { file: '../outside.ts', startLine: 1, endLine: 1, side: 'right', excerpt: '' },
                        'unsafe',
                        'Agent',
                        'hash-unsafe',
                    ),
                /Invalid review thread file path/,
            );
            assert.strictEqual(store.threads().length, 0);
        });

        it('should return undefined for agent reply to nonexistent thread', async () => {
            const result = await store.addAgentReply('fake-id', 'reply', 'Agent', 'h1');
            assert.strictEqual(result, undefined);
        });

        it('should add review-wide user and agent threads', async () => {
            const userThread = await store.addReviewThread('Please check the overall API shape', 'User');
            assert.strictEqual(userThread.scope, 'review');
            assert.strictEqual(userThread.comments[0].body, 'Please check the overall API shape');

            const agentThread = await store.addAgentThread(
                { scope: 'review' },
                'I noticed the review summary is missing validation guidance.',
                'Agent',
                'hash-review-wide',
            );
            assert.ok(agentThread);
            assert.strictEqual(agentThread?.scope, 'review');
            assert.strictEqual(store.threads().length, 2);
        });

        it('should record last agent metadata', async () => {
            await store.setLastAgent({
                name: 'Copilot CLI',
                kind: 'copilot',
                id: 'session-123',
                lastSeenAt: '2024-01-01T00:00:00.000Z',
            });
            assert.deepStrictEqual(store.getState().lastAgent, {
                name: 'Copilot CLI',
                kind: 'copilot',
                id: 'session-123',
                lastSeenAt: '2024-01-01T00:00:00.000Z',
            });
        });
    });

    describe('setBase / updateHead', () => {
        beforeEach(async () => {
            await store.load();
        });

        it('should set base info', async () => {
            await store.setBase('file:///proj', 'main', 'sha1', 'sha2');
            const state = store.getState();
            assert.strictEqual(state.folderUri, 'file:///proj');
            assert.strictEqual(state.baseRef, 'main');
            assert.strictEqual(state.baseSha, 'sha1');
            assert.strictEqual(state.headSha, 'sha2');
            assert.ok(state.startedAt);
        });

        it('should be active after setBase', async () => {
            assert.strictEqual(store.isActive(), false);
            await store.setBase('file:///p', 'main', 's1', 's2');
            assert.strictEqual(store.isActive(), true);
        });

        it('should update head SHA', async () => {
            await store.setBase('file:///p', 'main', 's1', 's2');
            await store.updateHead('new-head');
            assert.strictEqual(store.getState().headSha, 'new-head');
        });
    });

    describe('updateThreadRange', () => {
        beforeEach(async () => {
            await store.load();
        });

        it('should update range', async () => {
            const t = await store.addThread(
                { file: 'f.ts', startLine: 1, endLine: 3, side: 'right', excerpt: '' },
                'hi',
                'A',
            );
            await store.updateThreadRange(t.id, { startLine: 5, endLine: 8, startChar: 2, endChar: 10 });
            const updated = store.findThread(t.id);
            assert.strictEqual(updated!.startLine, 5);
            assert.strictEqual(updated!.endLine, 8);
            assert.strictEqual(updated!.startChar, 2);
            assert.strictEqual(updated!.endChar, 10);
        });

        it('should not persist if range unchanged', async () => {
            const t = await store.addThread(
                { file: 'f.ts', startLine: 5, endLine: 5, side: 'right', excerpt: '' },
                'hi',
                'A',
            );
            // Same range
            await store.updateThreadRange(t.id, { startLine: 5, endLine: 5 });
            assert.strictEqual(store.findThread(t.id)!.startLine, 5);
        });

        it('should handle nonexistent thread', async () => {
            await store.updateThreadRange('nope', { startLine: 1, endLine: 1 });
            // No error
        });
    });

    describe('updateThreadLines', () => {
        it('should update start and end lines preserving chars', async () => {
            await store.load();
            const t = await store.addThread(
                { file: 'f.ts', startLine: 1, endLine: 3, startChar: 4, endChar: 8, side: 'right', excerpt: '' },
                'hi',
                'A',
            );
            await store.updateThreadLines(t.id, 10, 15);
            const updated = store.findThread(t.id);
            assert.strictEqual(updated!.startLine, 10);
            assert.strictEqual(updated!.endLine, 15);
            assert.strictEqual(updated!.startChar, 4);
            assert.strictEqual(updated!.endChar, 8);
        });
    });

    describe('rounds', () => {
        beforeEach(async () => {
            await store.load();
        });

        it('should start a round', async () => {
            const round = await store.startRound(5, 'baseSha', 'headSha');
            assert.strictEqual(round.n, 1);
            assert.strictEqual(round.openCountAtTrigger, 5);
            assert.strictEqual(store.currentRound()?.n, 1);
        });

        it('should increment round numbers', async () => {
            await store.startRound(5);
            const r2 = await store.startRound(3);
            assert.strictEqual(r2.n, 2);
            assert.strictEqual(store.currentRound()?.n, 2);
        });

        it('should anchor threads when positionAnchorSha is provided', async () => {
            const t = await store.addThread(
                { file: 'f.ts', startLine: 10, endLine: 12, side: 'right', excerpt: '' },
                'hi',
                'A',
            );
            await store.startRound(1, undefined, undefined, undefined, 'anchor-sha');
            const updated = store.findThread(t.id);
            assert.strictEqual(updated!.anchorSha, 'anchor-sha');
            assert.strictEqual(updated!.anchorFile, 'f.ts');
            assert.strictEqual(updated!.anchorStartLine, 10);
            assert.strictEqual(updated!.anchorEndLine, 12);
        });

        it('should attribute imports to current round', async () => {
            await store.startRound(0);
            await store.attributeImportToCurrentRound(3, 2);
            const round = store.currentRound();
            assert.strictEqual(round?.repliesReceived, 3);
            assert.strictEqual(round?.newThreadsReceived, 2);
        });

        it('should accumulate across multiple attributions', async () => {
            await store.startRound(0);
            await store.attributeImportToCurrentRound(1, 1);
            await store.attributeImportToCurrentRound(2, 3);
            const round = store.currentRound();
            assert.strictEqual(round?.repliesReceived, 3);
            assert.strictEqual(round?.newThreadsReceived, 4);
        });

        it('should return undefined for currentRound when no rounds', () => {
            assert.strictEqual(store.currentRound(), undefined);
        });

        it('should no-op attributeImportToCurrentRound when no rounds', async () => {
            await store.attributeImportToCurrentRound(5, 5);
            // No error
        });
    });

    describe('clear', () => {
        it('should reset state to empty', async () => {
            await store.load();
            await store.addThread({ file: 'f.ts', startLine: 1, endLine: 1, side: 'right', excerpt: '' }, 'hi', 'A');
            await store.clear();
            assert.deepStrictEqual(store.threads(), []);
            assert.strictEqual(store.isActive(), false);
        });
    });

    describe('forceReplace', () => {
        it('should replace entire state', async () => {
            await store.load();
            const newState = {
                threads: [
                    {
                        id: 'x1',
                        file: 'new.ts',
                        startLine: 1,
                        endLine: 1,
                        side: 'right' as const,
                        status: 'open' as const,
                        excerpt: '',
                        comments: [],
                        origin: 'user' as const,
                        createdAt: new Date().toISOString(),
                    },
                ],
                baseSha: 'forced-sha',
            };
            await store.forceReplace(newState);
            assert.strictEqual(store.threads().length, 1);
            assert.strictEqual(store.getState().baseSha, 'forced-sha');
        });
    });

    describe('corrupt state protection', () => {
        it('should refuse to persist when loaded corrupt', async () => {
            fsStore.set('/storage/state.json', new TextEncoder().encode('bad json'));
            await store.load();
            assert.strictEqual(store.isCorruptOnLoad(), true);
            try {
                await store.addThread(
                    { file: 'f.ts', startLine: 1, endLine: 1, side: 'right', excerpt: '' },
                    'hi',
                    'A',
                );
                assert.fail('should have thrown');
            } catch (e: any) {
                assert.ok(e.message.includes('corrupt'));
            }
        });
    });

    describe('restoreFromBackup', () => {
        it('should restore state from backup file', async () => {
            const state = {
                threads: [
                    {
                        id: 'b1',
                        file: 'backup.ts',
                        startLine: 1,
                        endLine: 1,
                        side: 'right',
                        status: 'open',
                        excerpt: '',
                        comments: [],
                        origin: 'user',
                        createdAt: '2024-01-01',
                    },
                ],
            };
            fsStore.set('/storage/state.json.bak', new TextEncoder().encode(JSON.stringify(state)));
            fsStore.set('/storage/state.json', new TextEncoder().encode('corrupted'));
            await store.load();
            assert.strictEqual(store.isCorruptOnLoad(), true);
            const restored = await store.restoreFromBackup();
            assert.strictEqual(restored, true);
            assert.strictEqual(store.isCorruptOnLoad(), false);
            assert.strictEqual(store.threads().length, 1);
        });

        it('should return false when backup does not exist', async () => {
            await store.load();
            const restored = await store.restoreFromBackup();
            assert.strictEqual(restored, false);
        });
    });

    describe('normalizeThread (via load)', () => {
        it('should fill defaults for missing fields', async () => {
            const state = {
                threads: [
                    {
                        id: 'tid',
                        file: 'x.ts',
                        comments: [{ body: 'hello' }],
                    },
                ],
            };
            fsStore.set('/storage/state.json', new TextEncoder().encode(JSON.stringify(state)));
            await store.load();
            const t = store.threads()[0];
            assert.strictEqual(t.startLine, 1);
            assert.strictEqual(t.endLine, 1);
            assert.strictEqual(t.side, 'right');
            assert.strictEqual(t.status, 'open');
            assert.strictEqual(t.origin, 'user');
            assert.strictEqual(t.excerpt, '');
        });

        it('should preserve existing values', async () => {
            const state = {
                threads: [
                    {
                        id: 'tid',
                        file: 'x.ts',
                        startLine: 5,
                        endLine: 10,
                        startChar: 2,
                        endChar: 8,
                        side: 'left',
                        status: 'resolved',
                        excerpt: 'code',
                        excerptSelection: 'sel',
                        origin: 'agent',
                        anchorSha: 'sha1',
                        anchorFile: 'old.ts',
                        anchorStartLine: 3,
                        anchorEndLine: 7,
                        oldFile: 'renamed.ts',
                        comments: [
                            {
                                id: 'c1',
                                threadId: 'tid',
                                body: 'hi',
                                author: 'Bot',
                                origin: 'agent',
                                createdAt: '2024-01-01',
                            },
                        ],
                    },
                ],
            };
            fsStore.set('/storage/state.json', new TextEncoder().encode(JSON.stringify(state)));
            await store.load();
            const t = store.threads()[0];
            assert.strictEqual(t.startLine, 5);
            assert.strictEqual(t.endLine, 10);
            assert.strictEqual(t.startChar, 2);
            assert.strictEqual(t.endChar, 8);
            assert.strictEqual(t.side, 'left');
            assert.strictEqual(t.status, 'resolved');
            assert.strictEqual(t.origin, 'agent');
            assert.strictEqual(t.excerpt, 'code');
            assert.strictEqual(t.excerptSelection, 'sel');
            assert.strictEqual(t.anchorSha, 'sha1');
            assert.strictEqual(t.anchorFile, 'old.ts');
            assert.strictEqual(t.oldFile, 'renamed.ts');
            assert.strictEqual(t.comments[0].origin, 'agent');
        });
    });

    describe('getLastLoadInfo', () => {
        it('should report load info after loading', async () => {
            await store.load();
            const info = store.getLastLoadInfo();
            assert.strictEqual(info.existed, false);
            assert.ok(info.loadedAt);
        });

        it('should include size for existing files', async () => {
            const data = JSON.stringify({ threads: [] });
            fsStore.set('/storage/state.json', new TextEncoder().encode(data));
            await store.load();
            const info = store.getLastLoadInfo();
            assert.strictEqual(info.existed, true);
            assert.ok(info.size! > 0);
        });
    });

    describe('attachExternalWatcher', () => {
        it('should attach without error', () => {
            store.attachExternalWatcher();
            // calling again should be no-op
            store.attachExternalWatcher();
        });
    });
});
