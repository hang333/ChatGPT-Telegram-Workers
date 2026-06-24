/**
 * Bot API 10.1 (2026-06-11) Rich Messages 类型补充。
 *
 * 依赖的 telegram-bot-api-types 尚未跟进该版本，这里通过模块增强补齐所需类型：
 * - InputRichMessage / SendRichMessageParams：sendRichMessage 使用
 * - SendRichMessageRequest：供 TelegramBotAPI 组合出 sendRichMessage 方法
 * - EditMessageTextParams.rich_message：编辑时携带富文本（text 保留为旧客户端降级文本）
 *
 * 参考：https://core.telegram.org/bots/api#sendrichmessage
 */
export {};

declare module 'telegram-bot-api-types' {
    /** https://core.telegram.org/bots/api#inputrichmessage */
    export interface InputRichMessage {
        /** 富文本内容（Rich Markdown 语法），与 html 二选一 */
        markdown?: string;
        /** 富文本内容（Rich HTML 语法），与 markdown 二选一 */
        html?: string;
        /** 传 true 关闭自动实体识别（链接、邮箱、@用户名、#话题 等） */
        skip_entity_detection?: boolean;
    }

    /** https://core.telegram.org/bots/api#sendrichmessage */
    export interface SendRichMessageParams {
        business_connection_id?: string;
        chat_id: number | string;
        message_thread_id?: number;
        direct_messages_topic_id?: number;
        rich_message: InputRichMessage;
        disable_notification?: boolean;
        protect_content?: boolean;
        allow_paid_broadcast?: boolean;
        message_effect_id?: string;
        suggested_post_parameters?: SuggestedPostParameters;
        reply_parameters?: ReplyParameters;
        reply_markup?: InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove | ForceReply;
    }

    export interface SendRichMessageRequest {
        sendRichMessage: (params: SendRichMessageParams) => Promise<Response>;
        sendRichMessageWithReturns: (params: SendRichMessageParams) => Promise<SendMessageResponse>;
    }

    /** Bot API 10.1：editMessageText 新增 rich_message，可将已有消息编辑为富文本 */
    export interface EditMessageTextParams {
        rich_message?: InputRichMessage;
    }
}
