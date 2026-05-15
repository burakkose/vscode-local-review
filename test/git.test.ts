import * as assert from 'assert';
import { __testing, Git, GitError } from '../src/git';

const { parseNameStatusZ, parseUnifiedHunks } = __testing;

// Mock for child_process.execFile to test Git class
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cp = require('child_process');

function _createMockGit(responses: Map<string, { stdout?: string; error?: any }>) {
    const mockExecFile = (
        _cmd: string,
        args: string[],
        _opts: any,
        cb?: (err: any, result: { stdout: string; stderr: string }) => void,
    ) => {
        const key = args.join(' ');
        for (const [pattern, response] of responses) {
            if (key.includes(pattern)) {
                if (cb) {
                    if (response.error) {
                        cb(response.error, { stdout: '', stderr: response.error.stderr || '' });
                    } else {
                        cb(null, { stdout: response.stdout || '', stderr: '' });
                    }
                    return;
                }
            }
        }
        if (cb) cb(null, { stdout: '', stderr: '' });
    };

    const orig = cp.execFile;
    cp.execFile = mockExecFile;

    return {
        restore() {
            cp.execFile = orig;
        },
    };
}

describe('git', () => {
    describe('parseNameStatusZ', () => {
        it('should parse a simple modification', () => {
            const input = 'M\0src/foo.ts\0';
            const result = parseNameStatusZ(input);
            assert.deepStrictEqual(result, [{ status: 'M', path: 'src/foo.ts' }]);
        });

        it('should parse an addition', () => {
            const input = 'A\0src/new.ts\0';
            const result = parseNameStatusZ(input);
            assert.deepStrictEqual(result, [{ status: 'A', path: 'src/new.ts' }]);
        });

        it('should parse a deletion', () => {
            const input = 'D\0src/old.ts\0';
            const result = parseNameStatusZ(input);
            assert.deepStrictEqual(result, [{ status: 'D', path: 'src/old.ts' }]);
        });

        it('should parse a rename with old and new paths', () => {
            const input = 'R100\0src/old.ts\0src/new.ts\0';
            const result = parseNameStatusZ(input);
            assert.deepStrictEqual(result, [{ status: 'R', path: 'src/new.ts', oldPath: 'src/old.ts' }]);
        });

        it('should parse a copy with old and new paths', () => {
            const input = 'C100\0src/original.ts\0src/copy.ts\0';
            const result = parseNameStatusZ(input);
            assert.deepStrictEqual(result, [{ status: 'C', path: 'src/copy.ts', oldPath: 'src/original.ts' }]);
        });

        it('should parse multiple files', () => {
            const input = 'M\0src/a.ts\0A\0src/b.ts\0D\0src/c.ts\0';
            const result = parseNameStatusZ(input);
            assert.strictEqual(result.length, 3);
            assert.strictEqual(result[0]!.status, 'M');
            assert.strictEqual(result[0]!.path, 'src/a.ts');
            assert.strictEqual(result[1]!.status, 'A');
            assert.strictEqual(result[1]!.path, 'src/b.ts');
            assert.strictEqual(result[2]!.status, 'D');
            assert.strictEqual(result[2]!.path, 'src/c.ts');
        });

        it('should handle mixed renames and modifications', () => {
            const input = 'R090\0old/path.ts\0new/path.ts\0M\0src/other.ts\0';
            const result = parseNameStatusZ(input);
            assert.strictEqual(result.length, 2);
            assert.deepStrictEqual(result[0], { status: 'R', path: 'new/path.ts', oldPath: 'old/path.ts' });
            assert.deepStrictEqual(result[1], { status: 'M', path: 'src/other.ts' });
        });

        it('should handle empty input', () => {
            const result = parseNameStatusZ('');
            assert.deepStrictEqual(result, []);
        });

        it('should handle paths with spaces', () => {
            const input = 'M\0src/my file.ts\0';
            const result = parseNameStatusZ(input);
            assert.deepStrictEqual(result, [{ status: 'M', path: 'src/my file.ts' }]);
        });

        it('should handle paths with unicode characters', () => {
            const input = 'A\0src/日本語.ts\0';
            const result = parseNameStatusZ(input);
            assert.deepStrictEqual(result, [{ status: 'A', path: 'src/日本語.ts' }]);
        });

        it('should handle type change status', () => {
            const input = 'T\0src/link.ts\0';
            const result = parseNameStatusZ(input);
            assert.deepStrictEqual(result, [{ status: 'T', path: 'src/link.ts' }]);
        });

        it('should handle unmerged status', () => {
            const input = 'U\0src/conflict.ts\0';
            const result = parseNameStatusZ(input);
            assert.deepStrictEqual(result, [{ status: 'U', path: 'src/conflict.ts' }]);
        });

        it('should skip incomplete rename entries gracefully', () => {
            // A rename with only one path token (malformed)
            const input = 'R100\0src/old.ts\0';
            const result = parseNameStatusZ(input);
            // The second token is missing, so it skips the entry
            assert.strictEqual(result.length, 0);
        });
    });

    describe('parseUnifiedHunks', () => {
        it('should parse a single hunk', () => {
            const diff = `diff --git a/file.ts b/file.ts
index abc..def 100644
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 line1
+added
 line2
 line3`;
            const hunks = parseUnifiedHunks(diff);
            assert.strictEqual(hunks.length, 1);
            assert.strictEqual(hunks[0]!.oldStart, 1);
            assert.strictEqual(hunks[0]!.oldLines, 3);
            assert.strictEqual(hunks[0]!.newStart, 1);
            assert.strictEqual(hunks[0]!.newLines, 4);
            assert.ok(hunks[0]!.body.includes('+added'));
        });

        it('should parse multiple hunks', () => {
            const diff = `@@ -1,3 +1,2 @@
 context
-removed
 context2
@@ -10,2 +9,3 @@
 line10
+inserted
 line11`;
            const hunks = parseUnifiedHunks(diff);
            assert.strictEqual(hunks.length, 2);
            assert.strictEqual(hunks[0]!.oldStart, 1);
            assert.strictEqual(hunks[0]!.oldLines, 3);
            assert.strictEqual(hunks[0]!.newStart, 1);
            assert.strictEqual(hunks[0]!.newLines, 2);
            assert.strictEqual(hunks[1]!.oldStart, 10);
            assert.strictEqual(hunks[1]!.newStart, 9);
            assert.strictEqual(hunks[1]!.newLines, 3);
        });

        it('should handle a deletion-only hunk', () => {
            const diff = `@@ -5,3 +5 @@
-deleted1
-deleted2
 context`;
            const hunks = parseUnifiedHunks(diff);
            assert.strictEqual(hunks.length, 1);
            assert.strictEqual(hunks[0]!.oldStart, 5);
            assert.strictEqual(hunks[0]!.oldLines, 3);
            assert.strictEqual(hunks[0]!.newStart, 5);
            assert.strictEqual(hunks[0]!.newLines, 1);
        });

        it('should handle hunk with no line count (implicit 1)', () => {
            const diff = `@@ -7 +7,2 @@
 context
+new`;
            const hunks = parseUnifiedHunks(diff);
            assert.strictEqual(hunks.length, 1);
            assert.strictEqual(hunks[0]!.oldStart, 7);
            assert.strictEqual(hunks[0]!.oldLines, 1);
            assert.strictEqual(hunks[0]!.newLines, 2);
        });

        it('should handle empty input', () => {
            const hunks = parseUnifiedHunks('');
            assert.deepStrictEqual(hunks, []);
        });

        it('should include the @@ header in the body', () => {
            const diff = `@@ -1,2 +1,2 @@
-old
+new
 ctx`;
            const hunks = parseUnifiedHunks(diff);
            assert.ok(hunks[0]!.body.startsWith('@@ -1,2 +1,2 @@'));
        });

        it('should handle "No newline at end of file" markers', () => {
            const diff = `@@ -1,2 +1,2 @@
-old
+new
\\ No newline at end of file`;
            const hunks = parseUnifiedHunks(diff);
            assert.strictEqual(hunks.length, 1);
            assert.ok(hunks[0]!.body.includes('\\ No newline'));
        });

        it('should handle Windows line endings (CRLF)', () => {
            const diff = '@@ -1,2 +1,3 @@\r\n context\r\n+added\r\n context2\r\n';
            const hunks = parseUnifiedHunks(diff);
            assert.strictEqual(hunks.length, 1);
            assert.strictEqual(hunks[0]!.oldStart, 1);
            assert.strictEqual(hunks[0]!.newLines, 3);
        });

        it('should skip malformed @@ lines', () => {
            const diff = `@@ this is not a valid header @@
some content
@@ -1,2 +1,2 @@
-old
+new`;
            const hunks = parseUnifiedHunks(diff);
            assert.strictEqual(hunks.length, 1);
            assert.strictEqual(hunks[0]!.oldStart, 1);
        });

        it('should handle hunk with function context after @@', () => {
            const diff = `@@ -10,3 +10,4 @@ function foo() {
 line10
+added
 line11
 line12`;
            const hunks = parseUnifiedHunks(diff);
            assert.strictEqual(hunks.length, 1);
            assert.strictEqual(hunks[0]!.oldStart, 10);
            assert.strictEqual(hunks[0]!.newLines, 4);
        });
    });

    describe('Git class', () => {
        it('should construct with a cwd', () => {
            const git = new Git('/some/path');
            assert.ok(git);
        });

        it('should expose GitError with stderr', () => {
            const err = new GitError('git failed: something', 'something');
            assert.strictEqual(err.message, 'git failed: something');
            assert.strictEqual(err.stderr, 'something');
            assert.ok(err instanceof Error);
        });

        it('GitError should work without stderr', () => {
            const err = new GitError('git failed');
            assert.strictEqual(err.message, 'git failed');
            assert.strictEqual(err.stderr, undefined);
        });
    });
});
