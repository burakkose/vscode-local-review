import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { Git, GitError } from '../src/git';

function createTempGitRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-test-'));
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, windowsHide: true });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, windowsHide: true });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, windowsHide: true });
    // Create an initial commit
    fs.writeFileSync(path.join(dir, 'file1.ts'), 'const x = 1;\n');
    fs.writeFileSync(path.join(dir, 'file2.ts'), 'const y = 2;\nconst z = 3;\n');
    execFileSync('git', ['add', '.'], { cwd: dir, windowsHide: true });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, windowsHide: true });
    return dir;
}

function cleanupTempDir(dir: string) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // Best-effort cleanup on Windows
    }
}

describe('Git class (integration)', () => {
    let repoDir: string;
    let git: Git;
    let baseSha: string;

    before(() => {
        repoDir = createTempGitRepo();
        git = new Git(repoDir);
        baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, windowsHide: true }).toString().trim();
    });

    after(() => {
        cleanupTempDir(repoDir);
    });

    describe('isRepo', () => {
        it('should return true for a git repository', async () => {
            assert.strictEqual(await git.isRepo(), true);
        });

        it('should return false for a non-repo directory', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-repo-'));
            const nonGit = new Git(tmpDir);
            try {
                assert.strictEqual(await nonGit.isRepo(), false);
            } finally {
                cleanupTempDir(tmpDir);
            }
        });
    });

    describe('repoRoot', () => {
        it('should return the repository root', async () => {
            const root = await git.repoRoot();
            // Normalize for Windows comparison (git may return different casing/slashes)
            const normalizedRoot = root.replace(/\\/g, '/').replace(/^\//, '').toLowerCase();
            const normalizedDir = repoDir.replace(/\\/g, '/').replace(/^\//, '').toLowerCase();
            assert.ok(
                normalizedRoot.endsWith(normalizedDir.split('/').pop()!),
                `Expected root "${normalizedRoot}" to correspond to "${normalizedDir}"`,
            );
        });
    });

    describe('headSha', () => {
        it('should return a 40-char hex SHA', async () => {
            const sha = await git.headSha();
            assert.strictEqual(sha.length, 40);
            assert.ok(/^[a-f0-9]+$/.test(sha));
        });
    });

    describe('revParse', () => {
        it('should resolve HEAD to a SHA', async () => {
            const sha = await git.headSha();
            // headSha uses rev-parse HEAD without --end-of-options, compare against baseSha
            assert.strictEqual(sha, baseSha);
        });

        it('should throw GitError for invalid ref', async () => {
            try {
                await git.revParse('nonexistent-ref-123');
                assert.fail('should have thrown');
            } catch (e) {
                assert.ok(e instanceof GitError);
            }
        });
    });

    describe('refExists', () => {
        it('should return true for HEAD', async () => {
            assert.strictEqual(await git.refExists('HEAD'), true);
        });

        it('should return true for main branch', async () => {
            assert.strictEqual(await git.refExists('main'), true);
        });

        it('should return false for nonexistent ref', async () => {
            assert.strictEqual(await git.refExists('nonexistent-branch-xyz'), false);
        });
    });

    describe('candidateBaseRefs', () => {
        it('should include main in the list', async () => {
            const refs = await git.candidateBaseRefs();
            assert.ok(refs.includes('main'));
        });
    });

    describe('mergeBase', () => {
        it('should return a SHA for valid base', async () => {
            const mb = await git.mergeBase('main');
            assert.ok(mb);
            assert.strictEqual(mb!.length, 40);
        });

        it('should return undefined for invalid ref', async () => {
            const mb = await git.mergeBase('nonexistent-xyz');
            assert.strictEqual(mb, undefined);
        });
    });

    describe('changedFiles', () => {
        it('should return empty list when no changes', async () => {
            const files = await git.changedFiles(baseSha, false);
            assert.deepStrictEqual(files, []);
        });

        it('should detect a modified file', async () => {
            fs.writeFileSync(path.join(repoDir, 'file1.ts'), 'const x = 42;\n');
            try {
                const files = await git.changedFiles(baseSha, false);
                assert.ok(files.some(f => f.path === 'file1.ts' && f.status === 'M'));
            } finally {
                // Restore
                fs.writeFileSync(path.join(repoDir, 'file1.ts'), 'const x = 1;\n');
            }
        });

        it('should include untracked files when requested', async () => {
            const untrackedPath = path.join(repoDir, 'untracked.ts');
            fs.writeFileSync(untrackedPath, 'new file\n');
            try {
                const files = await git.changedFiles(baseSha, true);
                assert.ok(files.some(f => f.path === 'untracked.ts' && f.status === 'A'));
            } finally {
                fs.unlinkSync(untrackedPath);
            }
        });

        it('should not include untracked files when not requested', async () => {
            const untrackedPath = path.join(repoDir, 'untracked2.ts');
            fs.writeFileSync(untrackedPath, 'new\n');
            try {
                const files = await git.changedFiles(baseSha, false);
                assert.ok(!files.some(f => f.path === 'untracked2.ts'));
            } finally {
                fs.unlinkSync(untrackedPath);
            }
        });

        it('should sort results by path', async () => {
            fs.writeFileSync(path.join(repoDir, 'file1.ts'), 'modified\n');
            fs.writeFileSync(path.join(repoDir, 'file2.ts'), 'modified\n');
            try {
                const files = await git.changedFiles(baseSha, false);
                for (let i = 1; i < files.length; i++) {
                    assert.ok(files[i]!.path >= files[i - 1]!.path);
                }
            } finally {
                fs.writeFileSync(path.join(repoDir, 'file1.ts'), 'const x = 1;\n');
                fs.writeFileSync(path.join(repoDir, 'file2.ts'), 'const y = 2;\nconst z = 3;\n');
            }
        });
    });

    describe('showFile', () => {
        it('should return file contents at a given ref', async () => {
            const content = await git.showFile(baseSha, 'file1.ts');
            assert.strictEqual(content, 'const x = 1;\n');
        });

        it('should return undefined for nonexistent path', async () => {
            const content = await git.showFile(baseSha, 'nonexistent.ts');
            assert.strictEqual(content, undefined);
        });
    });

    describe('fileHunks', () => {
        it('should return empty array when no changes', async () => {
            const hunks = await git.fileHunks(baseSha, 'file1.ts');
            assert.deepStrictEqual(hunks, []);
        });

        it('should return hunks for modified file', async () => {
            fs.writeFileSync(path.join(repoDir, 'file1.ts'), 'const x = 42;\nconst added = true;\n');
            try {
                const hunks = await git.fileHunks(baseSha, 'file1.ts');
                assert.ok(hunks.length > 0);
                assert.ok(hunks[0]!.body.includes('@@'));
                assert.ok(hunks[0]!.newStart >= 1);
            } finally {
                fs.writeFileSync(path.join(repoDir, 'file1.ts'), 'const x = 1;\n');
            }
        });

        it('should return empty for nonexistent file', async () => {
            const hunks = await git.fileHunks(baseSha, 'nonexistent.ts');
            assert.deepStrictEqual(hunks, []);
        });
    });

    describe('snapshotWorkingTree', () => {
        it('should return undefined for clean tree', async () => {
            const sha = await git.snapshotWorkingTree();
            assert.strictEqual(sha, undefined);
        });

        it('should return a SHA for dirty tree', async () => {
            fs.writeFileSync(path.join(repoDir, 'file1.ts'), 'dirty\n');
            try {
                const sha = await git.snapshotWorkingTree();
                assert.ok(sha);
                assert.strictEqual(sha!.length, 40);
            } finally {
                fs.writeFileSync(path.join(repoDir, 'file1.ts'), 'const x = 1;\n');
            }
        });
    });

    describe('pinRef / unpinRef', () => {
        it('should pin and unpin a ref', async () => {
            const success = await git.pinRef('refs/local-review/test-pin', baseSha);
            assert.strictEqual(success, true);

            // Verify ref exists
            assert.strictEqual(await git.refExists('refs/local-review/test-pin'), true);

            // Unpin
            await git.unpinRef('refs/local-review/test-pin');
            assert.strictEqual(await git.refExists('refs/local-review/test-pin'), false);
        });

        it('unpinRef should not throw for nonexistent ref', async () => {
            await git.unpinRef('refs/local-review/nonexistent-pin');
            // Should not throw
        });

        it('pinRef should return false for invalid SHA', async () => {
            const success = await git.pinRef('refs/local-review/bad', 'not-a-sha');
            assert.strictEqual(success, false);
        });
    });

    describe('GitError', () => {
        it('should capture stderr', () => {
            const err = new GitError('cmd failed: bad ref', 'bad ref');
            assert.strictEqual(err.stderr, 'bad ref');
            assert.ok(err.message.includes('bad ref'));
        });

        it('should work without stderr', () => {
            const err = new GitError('cmd failed');
            assert.strictEqual(err.stderr, undefined);
        });
    });
});
