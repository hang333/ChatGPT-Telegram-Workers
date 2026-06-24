/**
 * 修复 CJK 文本中的 Markdown 强调标记渲染问题。
 *
 * Telegram Rich Messages 的 Markdown 兼容 GitHub Flavored Markdown（CommonMark 超集），
 * 而 CommonMark 的强调「贴合（flanking）」规则只考虑空格分词：当强调标记紧贴中文全角标点
 * （如 `**重要：**请注意`、`这是**「重要」**的内容`）时不构成贴合，导致强调失效、星号外露。
 *
 * 由于渲染发生在 Telegram 客户端、我们无法修改其解析器，只能在发送前预处理文本：
 * 在「强调标记与紧邻的 CJK 标点之间」插入零宽空格（U+200B）。零宽空格不是 CommonMark
 * 定义的空白符而是普通字符，故能让标记一侧重新「贴住」非标点字符，使强调恢复生效。
 *
 * 仅处理强调标记紧贴 CJK 标点的场景；纯汉字之间的 `**粗**` 本就能正常渲染，不作处理。
 * 已知边界：汉字之间无标点的 `_`/`__`（如 `这是__重要__的内容`）因 CommonMark 的下划线
 * intraword 特例仍会失效，但该写法极少出现于 AI 输出，暂不处理。
 *
 * 参考：CommonMark spec §6.2；https://github.com/tats-u/markdown-cjk-friendly
 */

const ZWSP = '​';

// 常见于中文文本的标点/符号：CJK 标点、全角形式、中文引号、破折号、省略号
const CJK_PUNCT = '\\u2014\\u2018\\u2019\\u201C\\u201D\\u2026\\u3000-\\u303F\\uFE30-\\uFE4F\\uFF00-\\uFFEF';
// 强调定界符：粗体/斜体/删除线（较长的放前面优先匹配），调用处统一用捕获组 (${DELIM}) 包裹
const DELIM = '\\*\\*|__|~~|\\*|_';

// 闭合标记前紧贴 CJK 标点（右贴合失败）：在 标点 ↔ 标记 之间插入 ZWSP
const closeAfterPunct = new RegExp(`([${CJK_PUNCT}])(${DELIM})(?=\\S)`, 'g');
// 起始标记后紧贴 CJK 标点（左贴合失败）：在 标记 ↔ 标点 之间插入 ZWSP
const openBeforePunct = new RegExp(`(\\S)(${DELIM})([${CJK_PUNCT}])`, 'g');

function fixSegment(text: string): string {
    return text
        .replace(closeAfterPunct, `$1${ZWSP}$2`)
        .replace(openBeforePunct, `$1$2${ZWSP}$3`);
}

/**
 * 在不破坏代码的前提下，对 Markdown 文本做 CJK 强调修复。
 * 跳过围栏代码块（``` ... ```）与行内代码（` ... `）。
 */
export function normalizeCjkEmphasis(text: string): string {
    if (!text.includes('*') && !text.includes('_') && !text.includes('~')) {
        return text;
    }
    // 先按围栏代码块切分：偶数段为正文，奇数段为代码块（原样保留）
    return text.split(/(```[\s\S]*?```)/g).map((block, blockIndex) => {
        if (blockIndex % 2 === 1) {
            return block;
        }
        // 再按行内代码切分：偶数段为正文，奇数段为行内代码（原样保留）
        return block.split(/(`[^`\n]*`)/g).map((seg, segIndex) => {
            return segIndex % 2 === 1 ? seg : fixSegment(seg);
        }).join('');
    }).join('');
}
