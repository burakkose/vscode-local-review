export function isSafeReviewId(id: string): boolean {
    return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

export function normalizeReviewId(id: unknown): string | undefined {
    if (typeof id !== 'string') return undefined;
    const trimmed = id.trim();
    return isSafeReviewId(trimmed) ? trimmed : undefined;
}

export function normalizeRepoPath(input: unknown): string | undefined {
    if (typeof input !== 'string') return undefined;
    const normalized = input.trim().replace(/\\/g, '/');
    if (!normalized || containsControlChars(normalized)) return undefined;
    if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return undefined;
    const parts = normalized.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) return undefined;
    return parts.join('/');
}

export function containsControlChars(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 32 || code === 127) return true;
    }
    return false;
}
