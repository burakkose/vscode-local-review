import * as assert from 'assert';
import { buildPrompt, buildJsonSidecar, __testing } from '../src/exporter';

const { guessLang, escapeAuthor, truncate, pickFence, formatBody, hunkOverlapsThread } = __testing;

// Minimal store mock for tests
function createMockStore(threads: any[] = [], state: any = {}) {
    return {
        getState() {
            return {
                baseRef: state.baseRef ?? 'origin/main',
                baseSha: state.baseSha ?? 'abc123def456',
                headSha: state.headSha ?? 'fed321cba654',
                startedAt: state.startedAt ?? '2026-01-01T00:00:00.000Z',
                lastRefreshedAt: state.lastRefreshedAt ?? '2026-01-01T01:00:00.000Z',
                threads,
                ...state,
            };
        },
    };
}

function makeThread(overrides: any = {}) {
    return {
        id: overrides.id ?? 'thread-1',
        file: overrides.file ?? 'src/foo.ts',
        oldFile: overrides.oldFile,
        startLine: overrides.startLine ?? 10,
        endLine: overrides.endLine ?? 12,
        side: overrides.side ?? 'right',
        status: overrides.status ?? 'open',
        excerpt: overrides.excerpt ?? 'const foo = bar;',
        comments: overrides.comments ?? [
            { author: 'You', origin: 'user', body: 'Rename this', createdAt: '2026-01-01T00:00:00Z' },
        ],
        origin: overrides.origin ?? 'user',
        createdAt: overrides.createdAt ?? '2026-01-01T00:00:00Z',
    };
}

describe('exporter', () => {
    describe('guessLang', () => {
        it('should detect TypeScript', () => {
            assert.strictEqual(guessLang('src/foo.ts'), 'ts');
        });

        it('should detect TSX', () => {
            assert.strictEqual(guessLang('components/App.tsx'), 'tsx');
        });

        it('should detect Python', () => {
            assert.strictEqual(guessLang('main.py'), 'python');
        });

        it('should detect Go', () => {
            assert.strictEqual(guessLang('main.go'), 'go');
        });

        it('should return empty for unknown extensions', () => {
            assert.strictEqual(guessLang('Makefile'), '');
        });

        it('should return empty for files with no extension', () => {
            assert.strictEqual(guessLang('LICENSE'), '');
        });

        it('should be case-insensitive', () => {
            assert.strictEqual(guessLang('file.PY'), 'python');
            assert.strictEqual(guessLang('file.TS'), 'ts');
        });

        it('should detect shell scripts', () => {
            assert.strictEqual(guessLang('script.sh'), 'bash');
            assert.strictEqual(guessLang('script.bash'), 'bash');
        });

        it('should detect powershell', () => {
            assert.strictEqual(guessLang('script.ps1'), 'powershell');
        });

        it('should detect various C/C++ extensions', () => {
            assert.strictEqual(guessLang('main.c'), 'c');
            assert.strictEqual(guessLang('main.cpp'), 'cpp');
            assert.strictEqual(guessLang('main.cc'), 'cpp');
            assert.strictEqual(guessLang('main.h'), 'cpp');
        });
    });

    describe('escapeAuthor', () => {
        it('should escape asterisks', () => {
            assert.strictEqual(escapeAuthor('user*name'), 'user\\*name');
        });

        it('should escape underscores', () => {
            assert.strictEqual(escapeAuthor('user_name'), 'user\\_name');
        });

        it('should escape backticks', () => {
            assert.strictEqual(escapeAuthor('user`name'), 'user\\`name');
        });

        it('should leave normal names unchanged', () => {
            assert.strictEqual(escapeAuthor('John Doe'), 'John Doe');
        });
    });

    describe('truncate', () => {
        it('should leave short strings unchanged', () => {
            assert.strictEqual(truncate('hello', 10), 'hello');
        });

        it('should truncate long strings with ellipsis', () => {
            const result = truncate('a'.repeat(20), 10);
            assert.strictEqual(result.length, 10);
            assert.ok(result.endsWith('…'));
        });

        it('should collapse whitespace to single space', () => {
            assert.strictEqual(truncate('hello\n  world', 50), 'hello world');
        });

        it('should handle empty string', () => {
            assert.strictEqual(truncate('', 10), '');
        });
    });

    describe('pickFence', () => {
        it('should return 3 backticks for content without backticks', () => {
            assert.strictEqual(pickFence('normal content'), '```');
        });

        it('should return 4 backticks when content has triple backticks', () => {
            assert.strictEqual(pickFence('here is ``` some code'), '````');
        });

        it('should return more backticks for longer runs', () => {
            assert.strictEqual(pickFence('`````'), '``````');
        });
    });

    describe('formatBody', () => {
        it('should return single-line text unchanged', () => {
            assert.strictEqual(formatBody('hello world'), 'hello world');
        });

        it('should blockquote multi-line text', () => {
            const result = formatBody('line1\nline2\nline3');
            assert.strictEqual(result, '> line1\n> line2\n> line3');
        });

        it('should return _(empty)_ for blank input', () => {
            assert.strictEqual(formatBody(''), '_(empty)_');
            assert.strictEqual(formatBody('   '), '_(empty)_');
        });

        it('should normalize CRLF to LF', () => {
            const result = formatBody('line1\r\nline2');
            assert.strictEqual(result, '> line1\n> line2');
        });

        it('should trim trailing whitespace', () => {
            assert.strictEqual(formatBody('hello   '), 'hello');
        });
    });

    describe('hunkOverlapsThread', () => {
        it('should detect overlap when thread is inside hunk', () => {
            const hunk = { oldStart: 5, oldLines: 10, newStart: 5, newLines: 10, body: '' };
            const thread = { startLine: 7, endLine: 9, side: 'right' as const } as any;
            assert.strictEqual(hunkOverlapsThread(hunk, thread), true);
        });

        it('should detect no overlap when thread is after hunk', () => {
            const hunk = { oldStart: 5, oldLines: 3, newStart: 5, newLines: 3, body: '' };
            const thread = { startLine: 20, endLine: 22, side: 'right' as const } as any;
            assert.strictEqual(hunkOverlapsThread(hunk, thread), false);
        });

        it('should detect no overlap when thread is before hunk', () => {
            const hunk = { oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, body: '' };
            const thread = { startLine: 1, endLine: 3, side: 'right' as const } as any;
            assert.strictEqual(hunkOverlapsThread(hunk, thread), false);
        });

        it('should use old side for left-side threads', () => {
            const hunk = { oldStart: 5, oldLines: 5, newStart: 5, newLines: 10, body: '' };
            const thread = { startLine: 7, endLine: 9, side: 'left' as const } as any;
            assert.strictEqual(hunkOverlapsThread(hunk, thread), true);
        });

        it('should handle boundary overlap (thread starts at hunk end)', () => {
            const hunk = { oldStart: 5, oldLines: 3, newStart: 5, newLines: 3, body: '' };
            // Hunk covers new lines 5-7
            const thread = { startLine: 7, endLine: 8, side: 'right' as const } as any;
            assert.strictEqual(hunkOverlapsThread(hunk, thread), true);
        });
    });

    describe('buildPrompt', () => {
        it('should generate header with workspace info', () => {
            const store = createMockStore([]);
            const prompt = buildPrompt(store as any, {
                workspaceName: 'my-project',
                workspaceFsPath: '/home/user/my-project',
            });
            assert.ok(prompt.includes('# Code Review Feedback'));
            assert.ok(prompt.includes('my-project'));
            assert.ok(prompt.includes('/home/user/my-project'));
        });

        it('should show "no comments" message when no threads exist', () => {
            const store = createMockStore([]);
            const prompt = buildPrompt(store as any);
            assert.ok(prompt.includes('_No comments._'));
        });

        it('should show "all resolved" when only resolved threads exist', () => {
            const store = createMockStore([makeThread({ status: 'resolved' })]);
            const prompt = buildPrompt(store as any);
            assert.ok(prompt.includes('_All comments are marked resolved'));
        });

        it('should include open comment details', () => {
            const thread = makeThread();
            const store = createMockStore([thread]);
            const prompt = buildPrompt(store as any);
            assert.ok(prompt.includes('## Comment 1'));
            assert.ok(prompt.includes('src/foo.ts:10-12'));
            assert.ok(prompt.includes('thread-1'));
            assert.ok(prompt.includes('Rename this'));
        });

        it('should include code excerpt in fenced block', () => {
            const thread = makeThread({ excerpt: 'const x = 1;' });
            const store = createMockStore([thread]);
            const prompt = buildPrompt(store as any);
            assert.ok(prompt.includes('```ts'));
            assert.ok(prompt.includes('const x = 1;'));
        });

        it('should include round number when provided', () => {
            const store = createMockStore([makeThread()]);
            const prompt = buildPrompt(store as any, { roundNumber: 3 });
            assert.ok(prompt.includes('Round: **3**'));
        });

        it('should include full protocol when skill not primed', () => {
            const store = createMockStore([makeThread()]);
            const prompt = buildPrompt(store as any, { skillPrimed: false, responsesPath: '/tmp/responses.json' });
            assert.ok(prompt.includes('How to reply'));
            assert.ok(prompt.includes('"version": 1'));
        });

        it('should include short reminder when skill is primed', () => {
            const store = createMockStore([makeThread()]);
            const prompt = buildPrompt(store as any, { skillPrimed: true, responsesPath: '/tmp/responses.json' });
            assert.ok(prompt.includes('## Action and reply'));
            assert.ok(prompt.includes('Inspect the current workspace files before editing'));
            assert.ok(!prompt.includes('How to reply'));
        });

        it('should show rename tag for files with oldFile', () => {
            const thread = makeThread({ oldFile: 'src/old.ts', file: 'src/new.ts' });
            const store = createMockStore([thread]);
            const prompt = buildPrompt(store as any);
            assert.ok(prompt.includes('was `src/old.ts`'));
        });

        it('should mark left-side comments', () => {
            const thread = makeThread({ side: 'left' });
            const store = createMockStore([thread]);
            const prompt = buildPrompt(store as any);
            assert.ok(prompt.includes('commenting on the base side'));
        });

        it('should mark agent-originated threads', () => {
            const thread = makeThread({ origin: 'agent' });
            const store = createMockStore([thread]);
            const prompt = buildPrompt(store as any);
            assert.ok(prompt.includes('thread originally created by you'));
        });

        it('should include resolved comments section for context', () => {
            const open = makeThread({ id: 'open-1' });
            const resolved = makeThread({ id: 'resolved-1', status: 'resolved', file: 'src/bar.ts' });
            const store = createMockStore([open, resolved]);
            const prompt = buildPrompt(store as any);
            assert.ok(prompt.includes('Resolved comments'));
            assert.ok(prompt.includes('src/bar.ts'));
        });

        it('should handle multiple open comments numbered sequentially', () => {
            const t1 = makeThread({ id: 't1', file: 'a.ts', startLine: 1, endLine: 1 });
            const t2 = makeThread({ id: 't2', file: 'b.ts', startLine: 5, endLine: 5 });
            const store = createMockStore([t1, t2]);
            const prompt = buildPrompt(store as any);
            assert.ok(prompt.includes('## Comment 1'));
            assert.ok(prompt.includes('## Comment 2'));
        });

        it('should use forward-slash path for responsesPath on Windows', () => {
            const store = createMockStore([makeThread()]);
            const prompt = buildPrompt(store as any, { responsesPath: 'C:\\Users\\foo\\responses.json' });
            assert.ok(prompt.includes('C:/Users/foo/responses.json'));
            assert.ok(!prompt.includes('C:\\Users'));
        });

        it('should include instructions section when headerOverride provided', () => {
            const store = createMockStore([makeThread()]);
            const prompt = buildPrompt(store as any, { headerOverride: 'Always use camelCase' });
            assert.ok(prompt.includes('## Instructions'));
            assert.ok(prompt.includes('Always use camelCase'));
        });

        it('should include diff hunks when hunks context is provided', () => {
            const thread = makeThread({ file: 'src/foo.ts', startLine: 5, endLine: 10 });
            const store = createMockStore([thread]);
            const hunks = new Map([
                [
                    'src/foo.ts',
                    [
                        {
                            oldStart: 3,
                            oldLines: 10,
                            newStart: 3,
                            newLines: 12,
                            body: '@@ -3,10 +3,12 @@\n context\n+added',
                        },
                    ],
                ],
            ]);
            const prompt = buildPrompt(store as any, { hunks });
            assert.ok(prompt.includes('Relevant diff hunk(s):'));
            assert.ok(prompt.includes('@@ -3,10 +3,12 @@'));
        });

        it('should not include diff hunks section when no hunks overlap', () => {
            const thread = makeThread({ file: 'src/foo.ts', startLine: 100, endLine: 105 });
            const store = createMockStore([thread]);
            const hunks = new Map([
                ['src/foo.ts', [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, body: '@@ -1,3 +1,3 @@\n ctx' }]],
            ]);
            const prompt = buildPrompt(store as any, { hunks });
            assert.ok(!prompt.includes('Relevant diff hunk(s):'));
        });

        it('should not include diff hunks for files not in the hunks map', () => {
            const thread = makeThread({ file: 'src/bar.ts' });
            const store = createMockStore([thread]);
            const hunks = new Map([
                ['src/other.ts', [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, body: '@@ ...' }]],
            ]);
            const prompt = buildPrompt(store as any, { hunks });
            assert.ok(!prompt.includes('Relevant diff hunk(s):'));
        });

        it('should handle empty excerpt gracefully', () => {
            const thread = makeThread({ excerpt: '' });
            const store = createMockStore([thread]);
            const prompt = buildPrompt(store as any);
            assert.ok(!prompt.includes('Code at the time of review:'));
        });

        it('should handle single-line range display', () => {
            const thread = makeThread({ startLine: 42, endLine: 42 });
            const store = createMockStore([thread]);
            const prompt = buildPrompt(store as any);
            assert.ok(prompt.includes(':42`'));
            assert.ok(!prompt.includes(':42-42'));
        });

        it('should handle multi-line range display', () => {
            const thread = makeThread({ startLine: 10, endLine: 20 });
            const store = createMockStore([thread]);
            const prompt = buildPrompt(store as any);
            assert.ok(prompt.includes(':10-20'));
        });

        it('should display agent conversation messages correctly', () => {
            const thread = makeThread({
                comments: [
                    { author: 'You', origin: 'user', body: 'Fix this', createdAt: '2026-01-01T00:00:00Z' },
                    { author: 'Agent', origin: 'agent', body: 'Done', createdAt: '2026-01-01T00:01:00Z' },
                ],
            });
            const store = createMockStore([thread]);
            const prompt = buildPrompt(store as any);
            assert.ok(prompt.includes('[user]'));
            assert.ok(prompt.includes('[you]'));
        });

        it('should escape special characters in responses path placeholder', () => {
            const store = createMockStore([makeThread()]);
            const prompt = buildPrompt(store as any, { skillPrimed: false });
            assert.ok(prompt.includes('<absolute path injected by extension>'));
        });

        it('should include review-wide comments without file line locations', () => {
            const thread = {
                id: 'general-1',
                scope: 'review',
                status: 'open',
                origin: 'user',
                excerpt: 'overall context',
                comments: [
                    {
                        author: 'You',
                        origin: 'user',
                        body: 'Please assess the overall error handling.',
                        createdAt: '2026-01-01',
                    },
                ],
                createdAt: '2026-01-01',
            };
            const prompt = buildPrompt(createMockStore([thread]) as any);
            assert.ok(prompt.includes('## Comment 1 — Review-wide'));
            assert.ok(prompt.includes('Comment ID (use this in your reply): `general-1`'));
            assert.ok(!prompt.includes('general-1:'));
        });
    });

    describe('buildJsonSidecar', () => {
        it('should return valid JSON', () => {
            const store = createMockStore([makeThread()]);
            const json = buildJsonSidecar(store as any, { workspaceName: 'test-proj' });
            const parsed = JSON.parse(json);
            assert.strictEqual(parsed.version, 1);
            assert.strictEqual(parsed.workspace, 'test-proj');
        });

        it('should include open comments in comments array', () => {
            const thread = makeThread({ id: 'my-id', status: 'open' });
            const store = createMockStore([thread]);
            const json = buildJsonSidecar(store as any);
            const parsed = JSON.parse(json);
            assert.strictEqual(parsed.comments.length, 1);
            assert.strictEqual(parsed.comments[0].id, 'my-id');
            assert.strictEqual(parsed.comments[0].status, 'open');
        });

        it('should include resolved comments in resolvedComments array', () => {
            const thread = makeThread({ id: 'resolved-id', status: 'resolved' });
            const store = createMockStore([thread]);
            const json = buildJsonSidecar(store as any);
            const parsed = JSON.parse(json);
            assert.strictEqual(parsed.comments.length, 0);
            assert.strictEqual(parsed.resolvedComments.length, 1);
            assert.strictEqual(parsed.resolvedComments[0].id, 'resolved-id');
        });

        it('should include messages with author and origin', () => {
            const thread = makeThread({
                comments: [
                    { author: 'Dev', origin: 'user', body: 'Fix this', createdAt: '2026-01-01T00:00:00Z' },
                    { author: 'Agent', origin: 'agent', body: 'Done', createdAt: '2026-01-01T00:01:00Z' },
                ],
            });
            const store = createMockStore([thread]);
            const json = buildJsonSidecar(store as any);
            const parsed = JSON.parse(json);
            const messages = parsed.comments[0].messages;
            assert.strictEqual(messages.length, 2);
            assert.strictEqual(messages[0].author, 'Dev');
            assert.strictEqual(messages[0].origin, 'user');
            assert.strictEqual(messages[1].author, 'Agent');
            assert.strictEqual(messages[1].origin, 'agent');
        });

        it('should include responsesPath', () => {
            const store = createMockStore([]);
            const json = buildJsonSidecar(store as any, { responsesPath: '/abs/responses.json' });
            const parsed = JSON.parse(json);
            assert.strictEqual(parsed.responsesPath, '/abs/responses.json');
        });

        it('should include file metadata', () => {
            const thread = makeThread({ file: 'src/auth.ts', startLine: 42, endLine: 50, side: 'right' });
            const store = createMockStore([thread]);
            const json = buildJsonSidecar(store as any);
            const parsed = JSON.parse(json);
            const comment = parsed.comments[0];
            assert.strictEqual(comment.file, 'src/auth.ts');
            assert.strictEqual(comment.startLine, 42);
            assert.strictEqual(comment.endLine, 50);
            assert.strictEqual(comment.side, 'right');
        });

        it('should represent review-wide comments with null file metadata', () => {
            const thread = {
                id: 'general-1',
                scope: 'review',
                status: 'open',
                origin: 'user',
                comments: [{ author: 'You', origin: 'user', body: 'Overall note', createdAt: '2026-01-01' }],
                createdAt: '2026-01-01',
            };
            const parsed = JSON.parse(buildJsonSidecar(createMockStore([thread]) as any));
            assert.strictEqual(parsed.comments[0].scope, 'review');
            assert.strictEqual(parsed.comments[0].file, null);
            assert.strictEqual(parsed.comments[0].startLine, null);
            assert.deepStrictEqual(parsed.comments[0].diffHunks, []);
        });
    });
});
