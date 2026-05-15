import * as assert from 'assert';

// We need to mock vscode.workspace.fs and the CommentStore
// The vscode mock is loaded via setup.ts. Let's import the module.

// Mock store for testing ResponseImporter
class MockStore {
    private threads: any[] = [];
    private importedHashes: string[] = [];
    private rounds: any[] = [];
    lastAgent: any;

    addThread(thread: any) {
        this.threads.push(thread);
    }

    findThread(id: string): any {
        return this.threads.find((t: any) => t.id === id);
    }

    async addAgentReply(
        threadId: string,
        body: string,
        author: string,
        dedupeHash: string,
        newStatus?: string,
    ): Promise<any> {
        if (!this.findThread(threadId)) return undefined;
        if (this.importedHashes.includes(dedupeHash)) return undefined;
        this.importedHashes.push(dedupeHash);
        const thread = this.findThread(threadId);
        if (newStatus) thread.status = newStatus;
        return { id: 'reply-' + Date.now(), threadId, body, author, origin: 'agent' };
    }

    async addAgentThread(
        meta: any,
        body: string,
        author: string,
        dedupeHash: string,
        _initialStatus?: string,
    ): Promise<any> {
        if (this.importedHashes.includes(dedupeHash)) return undefined;
        this.importedHashes.push(dedupeHash);
        const t = { id: 'new-thread-' + Date.now(), ...meta, body, author };
        this.threads.push(t);
        return t;
    }

    async attributeImportToCurrentRound(_replies: number, _threads: number): Promise<void> {
        // no-op for tests
    }

    async setLastAgent(agent: any): Promise<void> {
        this.lastAgent = agent;
    }

    getImportedHashes() {
        return this.importedHashes;
    }
}

describe('responseImporter', () => {
    let ResponseImporter: any;
    let vscode: any;

    before(() => {
        // The vscode mock is already loaded via setup.ts
        vscode = require('vscode'); // eslint-disable-line @typescript-eslint/no-var-requires
        const mod = require('../src/responseImporter'); // eslint-disable-line @typescript-eslint/no-var-requires
        ResponseImporter = mod.ResponseImporter;
    });

    function createImporter(store: MockStore, defaultAuthor = 'Agent') {
        return new ResponseImporter(store, () => defaultAuthor);
    }

    describe('importFromFile', () => {
        it('should handle file not found', async () => {
            const store = new MockStore();
            const importer = createImporter(store);

            // Override vscode.workspace.fs.readFile to throw FileNotFound
            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () => {
                const err: any = new Error('not found');
                err.code = 'FileNotFound';
                throw err;
            };

            try {
                const uri = { fsPath: '/nonexistent/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.fileMissing, true);
                assert.strictEqual(result.repliesImported, 0);
                assert.strictEqual(result.newThreadsImported, 0);
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should handle EntryNotFound error', async () => {
            const store = new MockStore();
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () => {
                const err: any = new Error('not found');
                err.name = 'EntryNotFound (FileSystemError)';
                throw err;
            };

            try {
                const uri = { fsPath: '/nonexistent/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.fileMissing, true);
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should handle read error that is not file-not-found', async () => {
            const store = new MockStore();
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () => {
                throw new Error('permission denied');
            };

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.fileMissing, false);
                assert.ok(result.errors.length > 0);
                assert.ok(result.errors[0].includes('permission denied'));
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should handle invalid JSON', async () => {
            const store = new MockStore();
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () => new TextEncoder().encode('not json{{{');

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.parseFailed, true);
                assert.ok(result.errors.length > 0);
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should reject unsupported version', async () => {
            const store = new MockStore();
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(JSON.stringify({ version: 99, replies: [] }));

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.ok(result.errors[0].includes('unsupported'));
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should import a valid reply', async () => {
            const store = new MockStore();
            store.addThread({ id: 'thread-1', status: 'open', comments: [] });
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(
                    JSON.stringify({
                        version: 1,
                        agent: 'TestBot',
                        replies: [{ commentId: 'thread-1', body: 'Done — fixed it.', status: 'resolved' }],
                    }),
                );

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.repliesImported, 1);
                assert.strictEqual(result.skipped, 0);
                assert.strictEqual(result.errors.length, 0);
                assert.ok(result.appliedThreadIds.includes('thread-1'));
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should skip duplicate replies (same content hash)', async () => {
            const store = new MockStore();
            store.addThread({ id: 'thread-1', status: 'open', comments: [] });
            const importer = createImporter(store);

            const data = JSON.stringify({
                version: 1,
                agent: 'Bot',
                replies: [{ commentId: 'thread-1', body: 'Done', status: 'resolved' }],
            });

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () => new TextEncoder().encode(data);

            try {
                const uri = { fsPath: '/path/responses.json' };
                // First import
                const r1 = await importer.importFromFile(uri);
                assert.strictEqual(r1.repliesImported, 1);

                // Second import — same content → skipped
                const r2 = await importer.importFromFile(uri);
                assert.strictEqual(r2.repliesImported, 0);
                assert.strictEqual(r2.skipped, 1);
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should report error for reply with unknown commentId', async () => {
            const store = new MockStore();
            // No threads in store
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(
                    JSON.stringify({
                        version: 1,
                        replies: [{ commentId: 'nonexistent', body: 'reply' }],
                    }),
                );

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.repliesImported, 0);
                assert.ok(result.errors.length > 0);
                assert.ok(result.errors[0].includes('nonexistent'));
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should report error for reply missing body', async () => {
            const store = new MockStore();
            store.addThread({ id: 'thread-1', status: 'open', comments: [] });
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(
                    JSON.stringify({
                        version: 1,
                        replies: [{ commentId: 'thread-1' }],
                    }),
                );

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.repliesImported, 0);
                assert.ok(result.errors[0].includes('missing commentId or body'));
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should report error for reply with empty body', async () => {
            const store = new MockStore();
            store.addThread({ id: 'thread-1', status: 'open', comments: [] });
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(
                    JSON.stringify({
                        version: 1,
                        replies: [{ commentId: 'thread-1', body: '   ' }],
                    }),
                );

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.repliesImported, 0);
                assert.ok(result.errors[0].includes('missing commentId or body'));
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should import a new thread', async () => {
            const store = new MockStore();
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(
                    JSON.stringify({
                        version: 1,
                        agent: 'Bot',
                        newThreads: [{ file: 'src/auth.ts', startLine: 10, endLine: 12, body: 'Found an issue here.' }],
                    }),
                );

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.newThreadsImported, 1);
                assert.strictEqual(result.errors.length, 0);
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should reject new threads with unsafe file paths', async () => {
            const store = new MockStore();
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(
                    JSON.stringify({
                        version: 1,
                        newThreads: [
                            { file: '../outside.ts', startLine: 1, body: 'escape' },
                            { file: '/absolute.ts', startLine: 1, body: 'absolute' },
                            { file: 'C:\\temp\\x.ts', startLine: 1, body: 'windows absolute' },
                            { file: 'src/bad\nname.ts', startLine: 1, body: 'control char' },
                        ],
                    }),
                );

            try {
                const result = await importer.importFromFile({ fsPath: '/path/responses.json' });
                assert.strictEqual(result.newThreadsImported, 0);
                assert.strictEqual(result.errors.length, 4);
                assert.ok(result.errors.every((e: string) => e.includes('unsafe file path')));
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should normalize backslash file separators in new threads', async () => {
            const store = new MockStore();
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(
                    JSON.stringify({
                        version: 1,
                        newThreads: [{ file: 'src\\auth.ts', startLine: 10, body: 'Found an issue here.' }],
                    }),
                );

            try {
                const result = await importer.importFromFile({ fsPath: '/path/responses.json' });
                assert.strictEqual(result.newThreadsImported, 1);
                assert.strictEqual(store.findThread(result.appliedThreadIds[0]).file, 'src/auth.ts');
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should import review-wide comments and remember last agent', async () => {
            const store = new MockStore();
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(
                    JSON.stringify({
                        version: 1,
                        agent: 'Copilot',
                        agentId: 'session-1',
                        agentKind: 'cli',
                        newReviewComments: [{ body: 'The overall retry strategy needs one owner.', status: 'open' }],
                    }),
                );

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.newThreadsImported, 1);
                assert.strictEqual(result.errors.length, 0);
                assert.strictEqual(store.lastAgent.name, 'Copilot');
                assert.strictEqual(store.lastAgent.id, 'session-1');
                assert.strictEqual(store.findThread(result.appliedThreadIds[0]).scope, 'review');
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should accept file-null newThreads as review-wide comments', async () => {
            const store = new MockStore();
            const importer = createImporter(store);
            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(
                    JSON.stringify({
                        version: 1,
                        agent: 'Bot',
                        newThreads: [{ file: null, body: 'This belongs to the whole review.' }],
                    }),
                );
            try {
                const result = await importer.importFromFile({ fsPath: '/path/responses.json' });
                assert.strictEqual(result.newThreadsImported, 1);
                assert.strictEqual(store.findThread(result.appliedThreadIds[0]).scope, 'review');
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should report errors for invalid review-wide comments', async () => {
            const store = new MockStore();
            const importer = createImporter(store);
            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(JSON.stringify({ version: 1, newReviewComments: [{ body: '   ' }] }));
            try {
                const result = await importer.importFromFile({ fsPath: '/path/responses.json' });
                assert.strictEqual(result.newThreadsImported, 0);
                assert.ok(result.errors[0].includes('missing body'));
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should skip duplicate new threads', async () => {
            const store = new MockStore();
            const importer = createImporter(store);

            const data = JSON.stringify({
                version: 1,
                agent: 'Bot',
                newThreads: [{ file: 'src/a.ts', startLine: 5, body: 'Issue' }],
            });

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () => new TextEncoder().encode(data);

            try {
                const uri = { fsPath: '/path/responses.json' };
                const r1 = await importer.importFromFile(uri);
                assert.strictEqual(r1.newThreadsImported, 1);

                const r2 = await importer.importFromFile(uri);
                assert.strictEqual(r2.newThreadsImported, 0);
                assert.strictEqual(r2.skipped, 1);
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should report error for new thread missing file', async () => {
            const store = new MockStore();
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(
                    JSON.stringify({
                        version: 1,
                        newThreads: [{ startLine: 5, body: 'missing file' }],
                    }),
                );

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.newThreadsImported, 0);
                assert.ok(result.errors[0].includes('missing file, startLine, or body'));
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should report error for new thread missing startLine', async () => {
            const store = new MockStore();
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(
                    JSON.stringify({
                        version: 1,
                        newThreads: [{ file: 'a.ts', body: 'no line' }],
                    }),
                );

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.newThreadsImported, 0);
                assert.ok(result.errors[0].includes('missing file, startLine, or body'));
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should use default author from agent field', async () => {
            const store = new MockStore();
            store.addThread({ id: 't-1', status: 'open', comments: [] });
            const importer = createImporter(store, 'Fallback');

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(
                    JSON.stringify({
                        version: 1,
                        agent: 'CustomBot',
                        replies: [{ commentId: 't-1', body: 'done' }],
                    }),
                );

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.repliesImported, 1);
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should use fallback default author when agent field is missing', async () => {
            const store = new MockStore();
            store.addThread({ id: 't-1', status: 'open', comments: [] });
            const importer = createImporter(store, 'MyAgent');

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(
                    JSON.stringify({
                        version: 1,
                        replies: [{ commentId: 't-1', body: 'done' }],
                    }),
                );

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.repliesImported, 1);
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should handle left-side new threads', async () => {
            const store = new MockStore();
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(
                    JSON.stringify({
                        version: 1,
                        newThreads: [{ file: 'a.ts', side: 'left', startLine: 3, body: 'base issue' }],
                    }),
                );

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.newThreadsImported, 1);
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should clamp negative startLine to 1', async () => {
            const store = new MockStore();
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(
                    JSON.stringify({
                        version: 1,
                        newThreads: [{ file: 'a.ts', startLine: -5, body: 'clamped' }],
                    }),
                );

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.newThreadsImported, 1);
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should handle empty replies and newThreads arrays', async () => {
            const store = new MockStore();
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(JSON.stringify({ version: 1, replies: [], newThreads: [] }));

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.repliesImported, 0);
                assert.strictEqual(result.newThreadsImported, 0);
                assert.strictEqual(result.errors.length, 0);
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should handle missing replies and newThreads fields', async () => {
            const store = new MockStore();
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () => new TextEncoder().encode(JSON.stringify({ version: 1 }));

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.repliesImported, 0);
                assert.strictEqual(result.newThreadsImported, 0);
                assert.strictEqual(result.errors.length, 0);
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should handle per-reply author override', async () => {
            const store = new MockStore();
            store.addThread({ id: 't-1', status: 'open', comments: [] });
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(
                    JSON.stringify({
                        version: 1,
                        agent: 'DefaultBot',
                        replies: [{ commentId: 't-1', body: 'done', author: 'SpecialBot' }],
                    }),
                );

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.repliesImported, 1);
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should handle new thread with resolved status', async () => {
            const store = new MockStore();
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(
                    JSON.stringify({
                        version: 1,
                        newThreads: [
                            { file: 'a.ts', startLine: 1, endLine: 5, body: 'resolved issue', status: 'resolved' },
                        ],
                    }),
                );

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.newThreadsImported, 1);
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should accept version 1 explicitly', async () => {
            const store = new MockStore();
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(JSON.stringify({ version: 1, replies: [], newThreads: [] }));

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.parseFailed, false);
                assert.strictEqual(result.errors.length, 0);
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });

        it('should accept missing version field (treated as v1)', async () => {
            const store = new MockStore();
            const importer = createImporter(store);

            const origReadFile = vscode.workspace.fs.readFile;
            vscode.workspace.fs.readFile = async () =>
                new TextEncoder().encode(JSON.stringify({ replies: [], newThreads: [] }));

            try {
                const uri = { fsPath: '/path/responses.json' };
                const result = await importer.importFromFile(uri);
                assert.strictEqual(result.parseFailed, false);
                assert.strictEqual(result.errors.length, 0);
            } finally {
                vscode.workspace.fs.readFile = origReadFile;
            }
        });
    });
});
