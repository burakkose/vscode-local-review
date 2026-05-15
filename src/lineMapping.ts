import { DiffHunk } from './git';

export interface LineRange {
    startLine: number;
    endLine: number;
}

export function mapRangeThroughHunks(range: LineRange, hunks: ReadonlyArray<DiffHunk>): LineRange {
    const startLine = mapLineThroughHunks(range.startLine, hunks);
    const endLine = mapLineThroughHunks(range.endLine, hunks);
    return { startLine, endLine: Math.max(startLine, endLine) };
}

export function mapLineThroughHunks(line: number, hunks: ReadonlyArray<DiffHunk>): number {
    let mapped = Math.max(1, Math.floor(line));
    for (const hunk of [...hunks].sort((a, b) => a.oldStart - b.oldStart)) {
        if (hunk.oldLines === 0) {
            if (line > hunk.oldStart) mapped += hunk.newLines;
            continue;
        }
        const oldEnd = hunk.oldStart + hunk.oldLines - 1;
        if (line < hunk.oldStart) break;
        if (line > oldEnd) {
            mapped += hunk.newLines - hunk.oldLines;
            continue;
        }
        return mapLineInsideHunk(line, hunk);
    }
    return Math.max(1, mapped);
}

function mapLineInsideHunk(oldLine: number, hunk: DiffHunk): number {
    let oldCursor = hunk.oldStart;
    let newCursor = hunk.newStart;
    const lines = hunk.body.split(/\r?\n/).slice(1);

    for (const line of lines) {
        if (line.startsWith(' ')) {
            if (oldCursor === oldLine) return Math.max(1, newCursor);
            oldCursor++;
            newCursor++;
        } else if (line.startsWith('-')) {
            if (oldCursor === oldLine) return Math.max(1, newCursor);
            oldCursor++;
        } else if (line.startsWith('+')) {
            newCursor++;
        }
    }

    return Math.max(1, newCursor);
}
