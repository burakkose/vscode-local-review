import * as assert from 'assert';
import { mapLineThroughHunks, mapRangeThroughHunks } from '../src/lineMapping';

function hunk(oldStart: number, oldLines: number, newStart: number, newLines: number, body: string) {
    return { oldStart, oldLines, newStart, newLines, body };
}

describe('lineMapping', () => {
    describe('mapLineThroughHunks', () => {
        it('should return the same line when no hunks exist', () => {
            assert.strictEqual(mapLineThroughHunks(5, []), 5);
        });

        it('should return 1 for line 0 or negative inputs', () => {
            assert.strictEqual(mapLineThroughHunks(0, []), 1);
            assert.strictEqual(mapLineThroughHunks(-1, []), 1);
        });

        it('should not shift lines before the first hunk', () => {
            const hunks = [hunk(3, 1, 3, 3, '@@ -3 +3,3 @@\n line3\n+inserted-a\n+inserted-b')];
            assert.strictEqual(mapLineThroughHunks(2, hunks), 2);
        });

        it('should shift lines after an insertion hunk', () => {
            const hunks = [hunk(3, 1, 3, 3, '@@ -3 +3,3 @@\n line3\n+inserted-a\n+inserted-b')];
            assert.strictEqual(mapLineThroughHunks(4, hunks), 6);
        });

        it('should shift lines after a deletion hunk', () => {
            const hunks = [hunk(2, 2, 2, 1, '@@ -2,2 +2 @@\n line2\n-line3')];
            assert.strictEqual(mapLineThroughHunks(4, hunks), 3);
        });

        it('should map lines inside a replacement hunk correctly', () => {
            const hunks = [hunk(5, 2, 5, 2, '@@ -5,2 +5,2 @@\n-old\n+new\n context')];
            assert.strictEqual(mapLineThroughHunks(5, hunks), 5);
            assert.strictEqual(mapLineThroughHunks(6, hunks), 6);
        });

        it('should handle pure insertion hunks (oldLines=0)', () => {
            // A pure insertion at line 5 adding 3 lines
            const hunks = [hunk(5, 0, 6, 3, '@@ -5,0 +6,3 @@\n+new-a\n+new-b\n+new-c')];
            // Lines before the insertion point are unaffected
            assert.strictEqual(mapLineThroughHunks(5, hunks), 5);
            // Lines after the insertion point shift by 3
            assert.strictEqual(mapLineThroughHunks(6, hunks), 9);
        });

        it('should handle multiple hunks cumulatively', () => {
            const hunks = [
                hunk(3, 1, 3, 2, '@@ -3 +3,2 @@\n-old\n+new-a\n+new-b'),
                hunk(10, 2, 11, 1, '@@ -10,2 +11 @@\n-line-a\n-line-b\n+merged'),
            ];
            // Before first hunk
            assert.strictEqual(mapLineThroughHunks(2, hunks), 2);
            // After first hunk (+1 net from 1→2)
            assert.strictEqual(mapLineThroughHunks(5, hunks), 6);
            // After second hunk (-1 net from 2→1, cumulative = +1-1 = 0)
            assert.strictEqual(mapLineThroughHunks(12, hunks), 12);
        });

        it('should handle a line falling exactly on deleted content', () => {
            const hunks = [hunk(10, 3, 10, 1, '@@ -10,3 +10 @@\n-old-a\n-old-b\n-old-c\n+new')];
            // Line 10 maps to the start of the replacement
            assert.strictEqual(mapLineThroughHunks(10, hunks), 10);
            // Line 11 is deleted — maps to start of new content (cursor hasn't advanced past + lines yet)
            assert.strictEqual(mapLineThroughHunks(11, hunks), 10);
        });

        it('should floor fractional line numbers', () => {
            assert.strictEqual(mapLineThroughHunks(3.7, []), 3);
        });

        it('should handle context lines inside a hunk', () => {
            // Hunk with context-deletion-addition-context pattern
            const hunks = [hunk(5, 4, 5, 4, '@@ -5,4 +5,4 @@\n context\n-old1\n-old2\n+new1\n+new2\n context2')];
            // Line 5 is context — maps 1:1
            assert.strictEqual(mapLineThroughHunks(5, hunks), 5);
            // Line 6 is the first deleted line — maps to where the addition starts
            assert.strictEqual(mapLineThroughHunks(6, hunks), 6);
        });

        it('should handle fallback when target line exceeds hunk body', () => {
            // A hunk that claims oldLines=3 but the body only has entries for 2 old lines
            // This triggers the fallback return at the end of mapLineInsideHunk
            const hunks = [hunk(5, 3, 5, 3, '@@ -5,3 +5,3 @@\n context\n-old')];
            // Line 7 is within the hunk range (5 to 5+3-1=7) but the body doesn't cover it fully
            const result = mapLineThroughHunks(7, hunks);
            assert.ok(result >= 1);
        });

        it('should handle a hunk with only additions after context', () => {
            // The target old line is the last context line, followed only by additions
            const hunks = [hunk(3, 2, 3, 5, '@@ -3,2 +3,5 @@\n context1\n context2\n+add1\n+add2\n+add3')];
            // Line 4 is the second context line
            assert.strictEqual(mapLineThroughHunks(4, hunks), 4);
        });
    });

    describe('mapRangeThroughHunks', () => {
        it('should map both start and end of a range', () => {
            const hunks = [hunk(3, 1, 3, 3, '@@ -3 +3,3 @@\n line3\n+inserted-a\n+inserted-b')];
            const result = mapRangeThroughHunks({ startLine: 4, endLine: 6 }, hunks);
            assert.deepStrictEqual(result, { startLine: 6, endLine: 8 });
        });

        it('should collapse a range that spans deleted content', () => {
            const hunks = [hunk(10, 3, 10, 1, '@@ -10,3 +10 @@\n-old-a\n-old-b\n-old-c\n+new')];
            const result = mapRangeThroughHunks({ startLine: 10, endLine: 12 }, hunks);
            assert.deepStrictEqual(result, { startLine: 10, endLine: 10 });
        });

        it('should ensure endLine >= startLine', () => {
            const hunks = [hunk(5, 3, 5, 1, '@@ -5,3 +5 @@\n-a\n-b\n-c\n+x')];
            const result = mapRangeThroughHunks({ startLine: 5, endLine: 7 }, hunks);
            assert.ok(result.endLine >= result.startLine);
        });

        it('should handle an empty hunk list', () => {
            const result = mapRangeThroughHunks({ startLine: 10, endLine: 20 }, []);
            assert.deepStrictEqual(result, { startLine: 10, endLine: 20 });
        });

        it('should handle single-line range', () => {
            const hunks = [hunk(3, 1, 3, 3, '@@ -3 +3,3 @@\n line3\n+inserted-a\n+inserted-b')];
            const result = mapRangeThroughHunks({ startLine: 4, endLine: 4 }, hunks);
            assert.strictEqual(result.startLine, result.endLine);
        });
    });
});
