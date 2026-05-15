import * as assert from 'assert';
import { hashReply, hashNewThread } from '../src/hashing';

describe('hashing', () => {
    describe('hashReply', () => {
        it('should produce a 40-char hex string (SHA-1)', () => {
            const hash = hashReply('comment-1', 'Agent', 'Done', 'resolved');
            assert.strictEqual(hash.length, 40);
            assert.ok(/^[a-f0-9]+$/.test(hash));
        });

        it('should produce deterministic output', () => {
            const h1 = hashReply('id-1', 'Bot', 'Fixed it', 'resolved');
            const h2 = hashReply('id-1', 'Bot', 'Fixed it', 'resolved');
            assert.strictEqual(h1, h2);
        });

        it('should differ when commentId changes', () => {
            const h1 = hashReply('id-1', 'Agent', 'body', undefined);
            const h2 = hashReply('id-2', 'Agent', 'body', undefined);
            assert.notStrictEqual(h1, h2);
        });

        it('should differ when author changes', () => {
            const h1 = hashReply('id', 'AgentA', 'body', undefined);
            const h2 = hashReply('id', 'AgentB', 'body', undefined);
            assert.notStrictEqual(h1, h2);
        });

        it('should differ when body changes', () => {
            const h1 = hashReply('id', 'Agent', 'body1', undefined);
            const h2 = hashReply('id', 'Agent', 'body2', undefined);
            assert.notStrictEqual(h1, h2);
        });

        it('should differ when status changes', () => {
            const h1 = hashReply('id', 'Agent', 'body', 'resolved');
            const h2 = hashReply('id', 'Agent', 'body', 'open');
            assert.notStrictEqual(h1, h2);
        });

        it('should handle undefined status vs empty string', () => {
            const h1 = hashReply('id', 'Agent', 'body', undefined);
            const h2 = hashReply('id', 'Agent', 'body', undefined);
            assert.strictEqual(h1, h2);
        });

        it('should handle special characters in body', () => {
            const hash = hashReply('id', 'Agent', 'Done — fixed\nSee `foo.ts`', 'resolved');
            assert.strictEqual(hash.length, 40);
        });

        it('should handle empty body', () => {
            const hash = hashReply('id', 'Agent', '', undefined);
            assert.strictEqual(hash.length, 40);
        });
    });

    describe('hashNewThread', () => {
        it('should produce a 40-char hex string (SHA-1)', () => {
            const hash = hashNewThread('src/foo.ts', 'right', 10, 12, 'Agent', 'Found an issue');
            assert.strictEqual(hash.length, 40);
            assert.ok(/^[a-f0-9]+$/.test(hash));
        });

        it('should produce deterministic output', () => {
            const h1 = hashNewThread('file.ts', 'right', 1, 5, 'Bot', 'msg');
            const h2 = hashNewThread('file.ts', 'right', 1, 5, 'Bot', 'msg');
            assert.strictEqual(h1, h2);
        });

        it('should differ when file changes', () => {
            const h1 = hashNewThread('a.ts', 'right', 1, 1, 'Agent', 'body');
            const h2 = hashNewThread('b.ts', 'right', 1, 1, 'Agent', 'body');
            assert.notStrictEqual(h1, h2);
        });

        it('should differ when side changes', () => {
            const h1 = hashNewThread('f.ts', 'right', 1, 1, 'Agent', 'body');
            const h2 = hashNewThread('f.ts', 'left', 1, 1, 'Agent', 'body');
            assert.notStrictEqual(h1, h2);
        });

        it('should differ when line range changes', () => {
            const h1 = hashNewThread('f.ts', 'right', 1, 5, 'Agent', 'body');
            const h2 = hashNewThread('f.ts', 'right', 1, 6, 'Agent', 'body');
            assert.notStrictEqual(h1, h2);
        });

        it('should differ when author changes', () => {
            const h1 = hashNewThread('f.ts', 'right', 1, 1, 'A', 'body');
            const h2 = hashNewThread('f.ts', 'right', 1, 1, 'B', 'body');
            assert.notStrictEqual(h1, h2);
        });

        it('should differ when body changes', () => {
            const h1 = hashNewThread('f.ts', 'right', 1, 1, 'Agent', 'body1');
            const h2 = hashNewThread('f.ts', 'right', 1, 1, 'Agent', 'body2');
            assert.notStrictEqual(h1, h2);
        });

        it('should handle paths with forward slashes (POSIX)', () => {
            const hash = hashNewThread('src/deep/nested/file.ts', 'right', 1, 1, 'Agent', 'x');
            assert.strictEqual(hash.length, 40);
        });

        it('should handle unicode in file paths', () => {
            const hash = hashNewThread('src/日本語/file.ts', 'right', 1, 1, 'Agent', 'x');
            assert.strictEqual(hash.length, 40);
        });
    });
});
