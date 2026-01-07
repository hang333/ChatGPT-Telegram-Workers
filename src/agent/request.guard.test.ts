import { describe, expect, it } from 'vitest';
import { __internal } from './request';
import { BAD_PREFIX_GOOGLE_SEARCH } from './retry';

describe('guardedStreamHandler', () => {
    it('does not throw when bad-prefix is detected at stream start', async () => {
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue({ type: 'text-delta', text: BAD_PREFIX_GOOGLE_SEARCH });
                controller.close();
            },
        });

        const messageInfo = { content: '', occured_error: false };
        const sent: string[] = [];

        const result = await __internal.guardedStreamHandler(
            stream as unknown as AsyncIterable<any>,
            (part: any) => (part?.type === 'text-delta' ? String(part.text ?? '') : ''),
            {
                send: async (text: string) => {
                    sent.push(text);
                },
            } as any,
            messageInfo as any,
        );

        expect(result.detectedBadPrefix).toBe(true);
        expect(result.assistantTextProbe).toContain(BAD_PREFIX_GOOGLE_SEARCH);
        expect(result.content).toBe('');
        expect(messageInfo.occured_error).toBe(false);
        expect(sent).toEqual([]);
    });
});
