import * as assert from 'assert';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { reviewPaths, catalogIndexUri } = require('../src/paths');

describe('paths', () => {
    const globalStorage = vscode.Uri.file('/global/storage');

    describe('reviewPaths', () => {
        it('should return all paths rooted under reviews/<id>', () => {
            const paths = reviewPaths(globalStorage, 'abc-123');
            assert.ok(paths.root.path.includes('/reviews/abc-123'));
            assert.ok(paths.state.path.endsWith('/reviews/abc-123/state.json'));
            assert.ok(paths.stateBak.path.endsWith('/reviews/abc-123/state.json.bak'));
            assert.ok(paths.promptMd.path.endsWith('/reviews/abc-123/prompt.md'));
            assert.ok(paths.promptJson.path.endsWith('/reviews/abc-123/prompt.json'));
            assert.ok(paths.responses.path.endsWith('/reviews/abc-123/responses.json'));
            assert.ok(paths.skill.path.endsWith('/reviews/abc-123/SKILL.md'));
        });

        it('should use the provided reviewId', () => {
            const paths = reviewPaths(globalStorage, 'my-review');
            assert.ok(paths.root.path.includes('/reviews/my-review'));
        });

        it('should preserve the scheme from globalStorage', () => {
            const customStorage = vscode.Uri.from({ scheme: 'vscode-remote', path: '/remote/storage' });
            const paths = reviewPaths(customStorage, 'test-id');
            assert.strictEqual(paths.root.scheme, 'vscode-remote');
        });

        it('should handle IDs with special characters', () => {
            const paths = reviewPaths(globalStorage, 'a-b-c-d-e-f');
            assert.ok(paths.root.path.includes('/reviews/a-b-c-d-e-f'));
        });

        it('should reject IDs that could escape review storage', () => {
            assert.throws(() => reviewPaths(globalStorage, '../outside'), /Invalid review id/);
            assert.throws(() => reviewPaths(globalStorage, 'nested/review'), /Invalid review id/);
            assert.throws(() => reviewPaths(globalStorage, 'bad\\review'), /Invalid review id/);
        });
    });

    describe('catalogIndexUri', () => {
        it('should point to reviews/index.json', () => {
            const uri = catalogIndexUri(globalStorage);
            assert.ok(uri.path.endsWith('/reviews/index.json'));
        });

        it('should use the base scheme', () => {
            const uri = catalogIndexUri(globalStorage);
            assert.strictEqual(uri.scheme, 'file');
        });
    });
});
