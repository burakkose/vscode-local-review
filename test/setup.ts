/**
 * Mocha root hook: register a stub 'vscode' module so tests that
 * transitively require it don't crash. This file is loaded via
 * mocha's --require flag.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const Module = require('module');
const path = require('path');

const originalResolveFilename = (Module as any)._resolveFilename;
const vscodeMockPath = path.resolve(__dirname, 'mocks', 'vscode.js');

(Module as any)._resolveFilename = function (request: string, parent: any, isMain: boolean, options: any) {
    if (request === 'vscode') {
        return vscodeMockPath;
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
};
