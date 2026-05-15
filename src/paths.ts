import * as vscode from 'vscode';
import { isSafeReviewId } from './pathSafety';

export interface ReviewPaths {
    root: vscode.Uri;
    state: vscode.Uri;
    stateBak: vscode.Uri;
    promptMd: vscode.Uri;
    promptJson: vscode.Uri;
    responses: vscode.Uri;
    skill: vscode.Uri;
}

export function reviewPaths(globalStorage: vscode.Uri, reviewId: string): ReviewPaths {
    if (!isSafeReviewId(reviewId)) {
        throw new Error(`Invalid review id '${reviewId}'.`);
    }
    const root = vscode.Uri.joinPath(globalStorage, 'reviews', reviewId);
    return {
        root,
        state: vscode.Uri.joinPath(root, 'state.json'),
        stateBak: vscode.Uri.joinPath(root, 'state.json.bak'),
        promptMd: vscode.Uri.joinPath(root, 'prompt.md'),
        promptJson: vscode.Uri.joinPath(root, 'prompt.json'),
        responses: vscode.Uri.joinPath(root, 'responses.json'),
        skill: vscode.Uri.joinPath(root, 'SKILL.md'),
    };
}

export function catalogIndexUri(globalStorage: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(globalStorage, 'reviews', 'index.json');
}
