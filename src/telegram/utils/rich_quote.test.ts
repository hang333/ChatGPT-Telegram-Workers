import { describe, expect, it } from 'vitest';
import { SEGMENTATION_MARK } from './md2tgmd';
import { foldRichExpandable } from './rich_quote';

const base = { logOnTop: false, summary: 'S', cjkFix: (t: string) => t };

describe('foldRichExpandable', () => {
    it('keeps the log outside the fold (default: below body)', () => {
        const msg = `正文内容\n${SEGMENTATION_MARK}\n>\`gemini-3.1-pro-preview 31.6s\``;
        expect(foldRichExpandable(msg, base)).toBe(
            '<details><summary>S</summary>\n\n正文内容\n\n</details>\n\n>`gemini-3.1-pro-preview 31.6s`',
        );
    });

    it('places the log above the fold when logOnTop', () => {
        const msg = `>\`gemini 31.6s\`\n${SEGMENTATION_MARK}\n正文内容`;
        expect(foldRichExpandable(msg, { ...base, logOnTop: true })).toBe(
            '>`gemini 31.6s`\n\n<details><summary>S</summary>\n\n正文内容\n\n</details>',
        );
    });

    it('folds only the body when there is no log', () => {
        const msg = `正文内容\n${SEGMENTATION_MARK}\n`;
        expect(foldRichExpandable(msg, base)).toBe('<details><summary>S</summary>\n\n正文内容\n\n</details>');
    });

    it('folds the whole message when there is no segmentation mark', () => {
        expect(foldRichExpandable('纯正文', base)).toBe('<details><summary>S</summary>\n\n纯正文\n\n</details>');
    });

    it('applies cjkFix to both body and log', () => {
        const msg = `正文\n${SEGMENTATION_MARK}\n>日志`;
        const out = foldRichExpandable(msg, { ...base, cjkFix: t => `[${t}]` });
        expect(out).toBe('<details><summary>S</summary>\n\n[正文]\n\n</details>\n\n[>日志]');
    });
});
