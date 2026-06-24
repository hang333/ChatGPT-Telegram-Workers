import { SEGMENTATION_MARK } from './md2tgmd';

interface FoldOptions {
    /** 日志是否在正文之前（对应 ENV.LOG_POSITION_ON_TOP） */
    logOnTop: boolean;
    /** <details> 折叠块的标题 */
    summary: string;
    /** 对文本做 CJK 强调修复（未启用时传恒等函数） */
    cjkFix: (text: string) => string;
}

/**
 * Rich 模式下把超长正文折叠进 <details>，而把日志（模型/耗时/token）留在折叠块外保持可见。
 *
 * 消息由 mergeLogMessages 以 SEGMENTATION_MARK 分隔正文与日志：
 * - 默认：`正文 // 标记 // 日志`
 * - LOG_POSITION_ON_TOP：`日志 // 标记 // 正文`
 *
 * 用 <details>（而非 <blockquote>）是因为只有 <details> 内部的 Markdown 仍会被渲染。
 */
export function foldRichExpandable(message: string, { logOnTop, summary, cjkFix }: FoldOptions): string {
    const details = (body: string) => `<details><summary>${summary}</summary>\n\n${cjkFix(body.trim())}\n\n</details>`;
    const markIndex = message.indexOf(SEGMENTATION_MARK);
    if (markIndex < 0) {
        // 没有日志分隔标记，整体折叠
        return details(message);
    }
    const before = message.slice(0, markIndex);
    const after = message.slice(markIndex + SEGMENTATION_MARK.length);
    const body = logOnTop ? after : before;
    const logText = (logOnTop ? before : after).trim();
    const block = details(body);
    if (!logText) {
        return block;
    }
    return logOnTop ? `${cjkFix(logText)}\n\n${block}` : `${block}\n\n${cjkFix(logText)}`;
}
