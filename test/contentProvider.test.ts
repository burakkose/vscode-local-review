import * as assert from 'assert';

/* eslint-disable @typescript-eslint/no-var-requires */
const vscode = require('vscode');
const {
    BaseContentProvider,
    EmptyContentProvider,
    baseUri,
    emptyUri,
    BASE_SCHEME,
    EMPTY_SCHEME,
} = require('../src/contentProvider');
/* eslint-enable @typescript-eslint/no-var-requires */

describe('contentProvider', () => {
    describe('baseUri', () => {
        it('should create a URI with the base scheme', () => {
            const uri = baseUri('src/main.ts', 'abc123');
            assert.strictEqual(uri.scheme, BASE_SCHEME);
        });

        it('should encode the SHA in the query', () => {
            const uri = baseUri('src/main.ts', 'deadbeef');
            assert.ok(uri.query.includes('sha=deadbeef'));
        });

        it('should set the path with leading slash', () => {
            const uri = baseUri('src/main.ts', 'abc');
            assert.strictEqual(uri.path, '/src/main.ts');
        });

        it('should strip leading slashes from the path', () => {
            const uri = baseUri('///foo/bar.ts', 'abc');
            assert.strictEqual(uri.path, '/foo/bar.ts');
        });

        it('should handle special characters in SHA', () => {
            const uri = baseUri('file.ts', 'abc+def/ghi');
            assert.ok(uri.query.includes(encodeURIComponent('abc+def/ghi')));
        });
    });

    describe('emptyUri', () => {
        it('should create a URI with the empty scheme', () => {
            const uri = emptyUri('src/deleted.ts', 'deleted');
            assert.strictEqual(uri.scheme, EMPTY_SCHEME);
        });

        it('should encode the label in the query', () => {
            const uri = emptyUri('file.ts', 'my label');
            assert.ok(uri.query.includes('label=' + encodeURIComponent('my label')));
        });

        it('should set the path with leading slash', () => {
            const uri = emptyUri('src/file.ts', 'x');
            assert.strictEqual(uri.path, '/src/file.ts');
        });
    });

    describe('EmptyContentProvider', () => {
        it('should always return empty string', () => {
            const provider = new EmptyContentProvider();
            assert.strictEqual(provider.provideTextDocumentContent(), '');
        });
    });

    describe('BaseContentProvider', () => {
        let provider: any;
        let mockGit: any;

        beforeEach(() => {
            mockGit = {
                showFile: async (sha: string, relPath: string) => `content of ${relPath}@${sha}`,
            };
            provider = new BaseContentProvider(mockGit);
        });

        it('should provide content from git showFile', async () => {
            const uri = baseUri('src/main.ts', 'abc123');
            const content = await provider.provideTextDocumentContent(uri);
            assert.strictEqual(content, 'content of src/main.ts@abc123');
        });

        it('should return empty string if SHA is missing from query', async () => {
            const uri = vscode.Uri.from({ scheme: BASE_SCHEME, path: '/file.ts', query: '' });
            const content = await provider.provideTextDocumentContent(uri);
            assert.strictEqual(content, '');
        });

        it('should return empty string if path is empty', async () => {
            const uri = vscode.Uri.from({ scheme: BASE_SCHEME, path: '/', query: 'sha=abc' });
            const content = await provider.provideTextDocumentContent(uri);
            assert.strictEqual(content, '');
        });

        it('should return empty string if showFile returns null', async () => {
            mockGit.showFile = async () => null;
            const uri = baseUri('missing.ts', 'abc');
            const content = await provider.provideTextDocumentContent(uri);
            assert.strictEqual(content, '');
        });

        it('should use setGit to swap the underlying git instance', async () => {
            const newGit = { showFile: async () => 'new content' };
            provider.setGit(newGit);
            const uri = baseUri('file.ts', 'xyz');
            const content = await provider.provideTextDocumentContent(uri);
            assert.strictEqual(content, 'new content');
        });

        it('should dispose without error', () => {
            provider.dispose();
        });
    });
});
