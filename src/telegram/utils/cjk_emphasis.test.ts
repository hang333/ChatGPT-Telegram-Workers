import { describe, expect, it } from 'vitest';
import { normalizeCjkEmphasis } from './cjk_emphasis';

const Z = '​';

describe('normalizeCjkEmphasis', () => {
    it('修复闭合标记前紧贴全角冒号', () => {
        expect(normalizeCjkEmphasis('**重要：**请注意')).toBe(`**重要：${Z}**请注意`);
    });

    it('修复被中文引号包裹的加粗', () => {
        expect(normalizeCjkEmphasis('这是**「重要」**的内容')).toBe(`这是**${Z}「重要」${Z}**的内容`);
    });

    it('修复斜体紧贴全角标点', () => {
        expect(normalizeCjkEmphasis('（*重点*）')).toBe(`（${Z}*重点*${Z}）`);
    });

    it('英文强调保持不变', () => {
        expect(normalizeCjkEmphasis('a **English bold** b')).toBe('a **English bold** b');
        expect(normalizeCjkEmphasis('mix **English** 文字')).toBe('mix **English** 文字');
    });

    it('纯汉字之间的加粗保持不变（本就能渲染）', () => {
        expect(normalizeCjkEmphasis('这是**重点**内容')).toBe('这是**重点**内容');
    });

    it('不误伤 snake_case 与 a*b*c', () => {
        expect(normalizeCjkEmphasis('snake_case_var a*b*c')).toBe('snake_case_var a*b*c');
    });

    it('跳过行内代码', () => {
        expect(normalizeCjkEmphasis('`**重要：**`')).toBe('`**重要：**`');
    });

    it('跳过围栏代码块', () => {
        const code = '```\n**重要：**x\n```';
        expect(normalizeCjkEmphasis(code)).toBe(code);
    });

    it('无强调字符时原样返回', () => {
        expect(normalizeCjkEmphasis('普通文本，没有标记。')).toBe('普通文本，没有标记。');
    });
});
