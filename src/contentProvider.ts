import * as vscode from 'vscode';
import { Git } from './git';

export const BASE_SCHEME = 'local-review-base';
export const EMPTY_SCHEME = 'local-review-empty';

/**
 * Read-only documents at a given immutable git SHA.
 * URI shape: local-review-base:/<repo-relative POSIX path>?sha=<encoded sha>
 *
 * Important: callers should pass an immutable SHA (not a branch ref) so the
 * same URI is guaranteed to render the same content forever.
 */
export class BaseContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    constructor(private git: Git) {}

    /** Swap the underlying Git instance (used when switching active reviews). */
    setGit(git: Git): void {
        this.git = git;
    }

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const sha = parseSha(uri);
        const relPath = uri.path.replace(/^\//, '');
        if (!sha || !relPath) return '';
        const content = await this.git.showFile(sha, relPath);
        return content ?? '';
    }

    refreshAll(uris: vscode.Uri[]) {
        for (const uri of uris) this._onDidChange.fire(uri);
    }

    dispose() {
        this._onDidChange.dispose();
    }
}

/** A scheme that always returns the empty string. Used for the "right side" of deleted files. */
export class EmptyContentProvider implements vscode.TextDocumentContentProvider {
    provideTextDocumentContent(): string {
        return '';
    }
}

export function baseUri(repoRelPath: string, sha: string): vscode.Uri {
    return vscode.Uri.from({
        scheme: BASE_SCHEME,
        path: '/' + repoRelPath.replace(/^\/+/, ''),
        query: 'sha=' + encodeURIComponent(sha),
    });
}

export function emptyUri(repoRelPath: string, label: string): vscode.Uri {
    // Path is preserved so the diff title/breadcrumb shows the right filename.
    return vscode.Uri.from({
        scheme: EMPTY_SCHEME,
        path: '/' + repoRelPath.replace(/^\/+/, ''),
        query: 'label=' + encodeURIComponent(label),
    });
}

function parseSha(uri: vscode.Uri): string | undefined {
    const m = /(?:^|&)sha=([^&]*)/.exec(uri.query);
    return m ? decodeURIComponent(m[1]!) : undefined;
}
