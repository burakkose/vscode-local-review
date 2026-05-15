import * as crypto from 'crypto';
import type { ThreadStatus, Side } from './store';

export function hashReply(commentId: string, author: string, body: string, status?: ThreadStatus): string {
    return crypto
        .createHash('sha1')
        .update('reply\0')
        .update(commentId)
        .update('\0')
        .update(author)
        .update('\0')
        .update(body)
        .update('\0')
        .update(status ?? '')
        .digest('hex');
}

export function hashNewThread(
    file: string,
    side: Side,
    start: number,
    end: number,
    author: string,
    body: string,
): string {
    return crypto
        .createHash('sha1')
        .update('thread\0')
        .update(file)
        .update('\0')
        .update(side)
        .update('\0')
        .update(`${start}-${end}`)
        .update('\0')
        .update(author)
        .update('\0')
        .update(body)
        .digest('hex');
}

export function hashNewReviewThread(author: string, body: string): string {
    return crypto.createHash('sha1').update('review-thread\0').update(author).update('\0').update(body).digest('hex');
}
