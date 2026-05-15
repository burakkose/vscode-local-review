import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

export interface ChangedFile {
    status: FileStatus;
    path: string; // current path (post-rename), repo-relative POSIX
    oldPath?: string; // previous path for renames/copies
}

export interface DiffHunk {
    /** 1-based line in old file where this hunk starts. */
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    /** Hunk text including the `@@ ... @@` header line. */
    body: string;
}

export class GitError extends Error {
    constructor(
        message: string,
        public readonly stderr?: string,
    ) {
        super(message);
    }
}

export class Git {
    constructor(private readonly cwd: string) {}

    private async run(args: string[]): Promise<string> {
        try {
            const { stdout } = await exec('git', args, {
                cwd: this.cwd,
                maxBuffer: 200 * 1024 * 1024,
                windowsHide: true,
            });
            return stdout;
        } catch (e: any) {
            const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : undefined;
            const msg = `git ${args.join(' ')} failed${stderr ? ': ' + stderr : ''}`;
            throw new GitError(msg, stderr);
        }
    }

    async isRepo(): Promise<boolean> {
        try {
            await this.run(['rev-parse', '--is-inside-work-tree']);
            return true;
        } catch {
            return false;
        }
    }

    async repoRoot(): Promise<string> {
        return (await this.run(['rev-parse', '--show-toplevel'])).trim();
    }

    async candidateBaseRefs(): Promise<string[]> {
        const tries = ['origin/main', 'origin/master', 'main', 'master', 'develop', 'origin/develop'];
        const valid: string[] = [];
        for (const ref of tries) {
            if (await this.refExists(ref)) valid.push(ref);
        }
        try {
            const upstream = (await this.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
            if (upstream && !valid.includes(upstream)) valid.unshift(upstream);
        } catch {
            /* no upstream */
        }
        return valid;
    }

    async refExists(ref: string): Promise<boolean> {
        try {
            await this.run(['rev-parse', '--verify', '--quiet', '--end-of-options', ref]);
            return true;
        } catch {
            return false;
        }
    }

    async revParse(ref: string): Promise<string> {
        return (await this.run(['rev-parse', '--end-of-options', ref])).trim();
    }

    async headSha(): Promise<string> {
        return (await this.run(['rev-parse', 'HEAD'])).trim();
    }

    async currentBranch(): Promise<string | undefined> {
        try {
            const branch = (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
            return branch && branch !== 'HEAD' ? branch : undefined;
        } catch {
            return undefined;
        }
    }

    async upstreamBranch(): Promise<string | undefined> {
        try {
            const upstream = (await this.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
            return upstream || undefined;
        } catch {
            return undefined;
        }
    }

    /** Best-effort merge-base. Returns the SHA of `git merge-base baseRef HEAD`, or undefined on failure. */
    async mergeBase(baseRef: string): Promise<string | undefined> {
        try {
            return (await this.run(['merge-base', '--end-of-options', baseRef, 'HEAD'])).trim();
        } catch {
            return undefined;
        }
    }

    /**
     * Files changed between `baseSha` and the working tree, plus optional untracked files.
     */
    async changedFiles(baseSha: string, includeUntracked: boolean): Promise<ChangedFile[]> {
        const out = await this.run(['diff', '--name-status', '-z', '--find-renames', '--end-of-options', baseSha]);
        const result = parseNameStatusZ(out);
        if (includeUntracked) {
            const untracked = (await this.run(['ls-files', '--others', '--exclude-standard', '-z']))
                .split('\0')
                .filter(Boolean);
            for (const p of untracked) {
                if (!result.find(f => f.path === p)) result.push({ status: 'A', path: p });
            }
        }
        // Sort for determinism.
        result.sort((a, b) => a.path.localeCompare(b.path));
        return result;
    }

    /**
     * Returns the file contents at `ref`, or undefined if the path doesn't exist there.
     * (Distinct from "exists but is empty".)
     */
    async showFile(ref: string, repoRelPath: string): Promise<string | undefined> {
        try {
            return await this.run(['show', `${ref}:${repoRelPath}`]);
        } catch {
            return undefined;
        }
    }

    /**
     * Capture the current working tree (tracked + untracked + index) as a dangling
     * commit object. Returns its SHA. Use `pinRef` immediately afterwards to keep
     * the snapshot reachable across `git gc`.
     */
    async snapshotWorkingTree(): Promise<string | undefined> {
        try {
            const out = (await this.run(['stash', 'create', '-u'])).trim();
            return out || undefined; // empty when nothing to stash (clean tree)
        } catch (e) {
            console.warn('[localReview] snapshotWorkingTree failed', e);
            return undefined;
        }
    }

    /** Create or update a ref pointing at `sha`. Prevents GC of dangling commits. */
    async pinRef(refName: string, sha: string): Promise<boolean> {
        try {
            await this.run(['update-ref', refName, sha]);
            return true;
        } catch (e) {
            console.warn('[localReview] pinRef failed', e);
            return false;
        }
    }

    /** Delete a previously-created ref. Idempotent: ignores 'not found'. */
    async unpinRef(refName: string): Promise<void> {
        try {
            await this.run(['update-ref', '-d', refName]);
        } catch {
            /* ignore */
        }
    }

    /**
     * Returns the unified diff hunks for one file between `baseSha` and the working tree.
     */
    async fileHunks(baseSha: string, repoRelPath: string, contextLines = 3): Promise<DiffHunk[]> {
        let raw: string;
        try {
            raw = await this.run([
                'diff',
                `--unified=${contextLines}`,
                '--no-color',
                '--no-ext-diff',
                '--end-of-options',
                baseSha,
                '--',
                repoRelPath,
            ]);
        } catch {
            return [];
        }
        return parseUnifiedHunks(raw);
    }
}

function parseNameStatusZ(out: string): ChangedFile[] {
    const tokens = out.split('\0').filter(Boolean);
    const files: ChangedFile[] = [];
    let i = 0;
    while (i < tokens.length) {
        const status = tokens[i]!;
        const code = status[0] as FileStatus;
        if (code === 'R' || code === 'C') {
            const oldPath = tokens[i + 1];
            const newPath = tokens[i + 2];
            if (oldPath && newPath) files.push({ status: code, path: newPath, oldPath });
            i += 3;
        } else {
            const p = tokens[i + 1];
            if (p) files.push({ status: code, path: p });
            i += 2;
        }
    }
    return files;
}

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

function parseUnifiedHunks(raw: string): DiffHunk[] {
    const lines = raw.split(/\r?\n/);
    const hunks: DiffHunk[] = [];
    let current: DiffHunk | undefined;
    let bodyLines: string[] = [];
    for (const line of lines) {
        if (line.startsWith('@@')) {
            if (current) {
                current.body = bodyLines.join('\n');
                hunks.push(current);
            }
            const m = HUNK_HEADER_RE.exec(line);
            if (m) {
                current = {
                    oldStart: parseInt(m[1]!, 10),
                    oldLines: m[2] ? parseInt(m[2], 10) : 1,
                    newStart: parseInt(m[3]!, 10),
                    newLines: m[4] ? parseInt(m[4], 10) : 1,
                    body: '',
                };
                bodyLines = [line];
            } else {
                current = undefined;
                bodyLines = [];
            }
            continue;
        }
        if (current) {
            // Skip the diff --git / index / +++ / --- header lines that may appear before the first hunk.
            // Inside a hunk, accept context (' '), removal ('-'), addition ('+'), and '\ No newline'.
            if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\')) {
                bodyLines.push(line);
            }
        }
    }
    if (current) {
        current.body = bodyLines.join('\n');
        hunks.push(current);
    }
    return hunks;
}

export const __testing = { parseNameStatusZ, parseUnifiedHunks };
