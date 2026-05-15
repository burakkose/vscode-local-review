/**
 * Minimal vscode module stub for tests.
 * Only needed when a transitive import pulls in vscode at runtime.
 */
/* eslint-disable @typescript-eslint/no-namespace */
export namespace workspace {
    export function getConfiguration(_section?: string): any {
        return { get: () => undefined };
    }
    export const fs = {
        readFile: async (_uri: any): Promise<Uint8Array> => new Uint8Array(),
        writeFile: async (_uri: any, _content: Uint8Array): Promise<void> => {},
        createDirectory: async (_uri: any): Promise<void> => {},
        stat: async (_uri: any) => ({ type: 1, ctime: 0, mtime: 0, size: 0 }),
        delete: async (_uri: any, _opts?: any): Promise<void> => {},
        rename: async (_source: any, _target: any, _opts?: any): Promise<void> => {},
        copy: async (_source: any, _target: any, _opts?: any): Promise<void> => {},
    };
    export const workspaceFolders: any[] = [];
    export function createFileSystemWatcher(): any {
        return {
            onDidChange: () => ({ dispose: () => {} }),
            onDidCreate: () => ({ dispose: () => {} }),
            onDidDelete: () => ({ dispose: () => {} }),
            dispose: () => {},
        };
    }
    export function onDidChangeConfiguration(_listener: any): { dispose: () => void } {
        return { dispose: () => {} };
    }
}

export namespace window {
    export function createOutputChannel() {
        return { appendLine: () => {}, dispose: () => {} };
    }
    export function showInformationMessage() {
        return Promise.resolve(undefined);
    }
    export function showWarningMessage() {
        return Promise.resolve(undefined);
    }
    export function showErrorMessage() {
        return Promise.resolve(undefined);
    }
    export function createStatusBarItem() {
        return { show: () => {}, hide: () => {}, dispose: () => {} };
    }
}

export class Uri {
    readonly scheme: string;
    readonly path: string;
    readonly query: string;
    readonly fsPath: string;

    private constructor(scheme: string, path: string, query?: string) {
        this.scheme = scheme;
        this.path = path;
        this.query = query ?? '';
        this.fsPath = path.replace(/\//g, process.platform === 'win32' ? '\\' : '/');
    }

    static file(path: string): Uri {
        return new Uri('file', path);
    }

    static from(components: { scheme: string; path: string; query?: string }): Uri {
        return new Uri(components.scheme, components.path, components.query);
    }

    static joinPath(base: Uri, ...segments: string[]): Uri {
        const joined = [base.path, ...segments].join('/').replace(/\/+/g, '/');
        return new Uri(base.scheme, joined, base.query);
    }

    toString(): string {
        return `${this.scheme}://${this.path}${this.query ? '?' + this.query : ''}`;
    }
}

export class EventEmitter {
    private listeners: Array<(e: any) => void> = [];

    event = (listener: (e: any) => void) => {
        this.listeners.push(listener);
        return {
            dispose: () => {
                this.listeners = this.listeners.filter(l => l !== listener);
            },
        };
    };

    fire(data?: any) {
        for (const l of this.listeners) l(data);
    }

    dispose() {
        this.listeners = [];
    }
}

export class Disposable {
    private disposables: Array<{ dispose: () => void }>;
    constructor(...disposables: Array<{ dispose: () => void }>) {
        this.disposables = disposables;
    }
    static from(...disposables: Array<{ dispose: () => void }>): Disposable {
        return new Disposable(...disposables);
    }
    dispose() {
        for (const d of this.disposables) d.dispose();
    }
}

export class RelativePattern {
    constructor(
        public base: any,
        public pattern: string,
    ) {}
}

export class FileSystemError extends Error {
    code: string;
    constructor(message?: string) {
        super(message ?? 'FileSystemError');
        this.name = 'FileSystemError';
        this.code = '';
    }
    static FileNotFound(messageOrUri?: string | Uri): FileSystemError {
        const e = new FileSystemError(typeof messageOrUri === 'string' ? messageOrUri : 'File not found');
        e.code = 'FileNotFound';
        return e;
    }
    static FileExists(messageOrUri?: string | Uri): FileSystemError {
        const e = new FileSystemError(typeof messageOrUri === 'string' ? messageOrUri : 'File exists');
        e.code = 'FileExists';
        return e;
    }
    static NoPermissions(messageOrUri?: string | Uri): FileSystemError {
        const e = new FileSystemError(typeof messageOrUri === 'string' ? messageOrUri : 'No permissions');
        e.code = 'NoPermissions';
        return e;
    }
}

export enum StatusBarAlignment {
    Left = 1,
    Right = 2,
}

export enum TreeItemCollapsibleState {
    None = 0,
    Collapsed = 1,
    Expanded = 2,
}

export class TreeItem {
    label?: string;
    collapsibleState?: TreeItemCollapsibleState;
    description?: string;
    tooltip?: string;
    iconPath?: any;
    command?: any;
    contextValue?: string;
    resourceUri?: Uri;
    constructor(labelOrUri: string | Uri, collapsibleState?: TreeItemCollapsibleState) {
        if (typeof labelOrUri === 'string') {
            this.label = labelOrUri;
        } else {
            this.resourceUri = labelOrUri;
        }
        this.collapsibleState = collapsibleState;
    }
}

export class ThemeIcon {
    constructor(
        public readonly id: string,
        public readonly color?: any,
    ) {}
}

export class ThemeColor {
    constructor(public readonly id: string) {}
}
