/* eslint-disable no-case-declarations */
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { ModelMessage, StepResult, TextStreamPart } from 'ai';
import type { AgentUserConfig } from '../config/env';
import type { MessageInfo, ToolChoice } from './model_middleware';
import type { ChatStreamTextHandler, OpenAIFuncCallData, ResponseMessage } from './types';
import { generateText, stepCountIs, streamText, TypeValidationError, wrapLanguageModel } from 'ai';
import { ENV } from '../config/env';
import { getLogSingleton, log, popLog } from '../log';
import { SEGMENTATION_MARK } from '../telegram/utils/md2tgmd';
import { StreamRetryExhaustedError } from './errors';
import { AIMiddleware, metaDataExtractor } from './model_middleware';
import { BAD_PREFIX_GOOGLE_SEARCH, createChatRetryableModel, isBadPrefixResponseText } from './retry';
import { Stream } from './stream';

export interface SseChatCompatibleOptions {
    streamBuilder?: (resp: Response, controller: AbortController) => Stream;
    contentExtractor?: (data: object) => string | null;
    fullContentExtractor?: (data: object) => string | null;
    functionCallExtractor?: (data: object, call_list: any[]) => void;
    fullFunctionCallExtractor?: (data: object) => OpenAIFuncCallData[] | null;
    errorExtractor?: (data: object) => string | null;
}

function fixOpenAICompatibleOptions(options: SseChatCompatibleOptions | null): SseChatCompatibleOptions {
    options = options || {};
    options.streamBuilder = options.streamBuilder || function (r, c) {
        return new Stream(r, c);
    };
    options.contentExtractor = options.contentExtractor || function (d: any) {
        return d?.choices?.[0]?.delta?.content;
    };
    options.fullContentExtractor = options.fullContentExtractor || function (d: any) {
        return d.choices?.[0]?.message.content;
    };
    options.functionCallExtractor
        = options.functionCallExtractor
            || function (d: any, call_list: OpenAIFuncCallData[]) {
                const chunk = d?.choices?.[0]?.delta?.tool_calls;
                if (!Array.isArray(chunk))
                    return;
                for (const a of chunk) {
                    if (!Object.hasOwn(a, 'index')) {
                        throw new Error(`The function chunk don't have index: ${JSON.stringify(chunk)}`);
                    }
                    if (a?.type === 'function') {
                        call_list[a.index] = { id: a.id, type: a.type, function: a.function };
                    } else {
                        call_list[a.index].function.arguments += a.function.arguments;
                    }
                }
            };
    options.fullFunctionCallExtractor
        = options.fullFunctionCallExtractor
            || function (d: any) {
                return d?.choices?.[0]?.message?.tool_calls;
            };
    options.errorExtractor = options.errorExtractor || function (d: any) {
        return d.error?.message;
    };
    return options;
}

export function isJsonResponse(resp: Response): boolean {
    return resp.headers.get('content-type')?.includes('json') || false;
}

export function isEventStreamResponse(resp: Response): boolean {
    const types = ['application/stream+json', 'text/event-stream'];
    const content = resp.headers.get('content-type') || '';
    for (const type of types) {
        if (content.includes(type)) {
            return true;
        }
    }
    return false;
}

type OnResult = ((result: any) => Promise<any>) | null;

export async function requestChatCompletions(url: string, header: Record<string, string>, body: any, onStream: ChatStreamTextHandler | null, onResult: OnResult = null, options: SseChatCompatibleOptions | null = null): Promise<string> {
    const controller = new AbortController();
    const { signal } = controller;
    const messageInfo: MessageInfo = {
        content: '',
        occured_error: false,
    };

    let timeoutID = null;
    if (ENV.CHAT_COMPLETE_API_TIMEOUT > 0 && !body?.model?.includes('o1')) {
        timeoutID = setTimeout(() => controller.abort(), ENV.CHAT_COMPLETE_API_TIMEOUT * 1e3);
    }

    log.info('start request llm');

    log.debug('request url, headers, body', url, header, body);
    const resp = await fetch(url, {
        method: 'POST',
        headers: header,
        body: JSON.stringify(body),
        signal,
    });

    clearTimeoutID(timeoutID);

    options = fixOpenAICompatibleOptions(options);

    if (onStream && resp.ok && isEventStreamResponse(resp)) {
        const stream = options.streamBuilder?.(resp, controller);
        if (!stream) {
            throw new Error('Stream builder error');
        }
        return streamHandler(stream, options.contentExtractor!, onStream, messageInfo);
    }

    if (!isJsonResponse(resp)) {
        throw new Error(resp.statusText);
    }

    const result = await resp.json();

    if (!result) {
        throw new Error('Empty response');
    }

    if (options.errorExtractor?.(result)) {
        throw new Error(options.errorExtractor?.(result) || 'Unknown error');
    }

    try {
        await onResult?.(result);
        return options.fullContentExtractor?.(result) || '';
    } catch (e) {
        console.error(e);
        throw new Error(JSON.stringify(result));
    }
}

function clearTimeoutID(timeoutID: any) {
    if (timeoutID)
        clearTimeout(timeoutID);
}

export async function streamHandler(stream: AsyncIterable<any>, contentExtractor: (data: any) => string | null, onStream: ChatStreamTextHandler, messageInfo: MessageInfo): Promise<string> {
    let lengthDelta = 0;
    let updateStep = 5;
    const maxLength = 10_000;

    try {
        for await (const part of stream) {
            const textPart = contentExtractor(part);
            if (textPart === null || textPart === undefined || textPart === '') {
                continue;
            }
            // 已有delta + chunk的长度
            lengthDelta += textPart.length;
            messageInfo.content += textPart;

            if (lengthDelta > updateStep) {
                lengthDelta = 0;
                updateStep = Math.min(updateStep + 40, maxLength);
                onStream.send(`${messageInfo.content.trimEnd()}●`);
            }
        }
    } catch (e) {
        if (messageInfo.content === '') {
            throw e;
        }
        console.error((e as Error).message, (e as Error).stack);
        let content: string | undefined;
        if (e instanceof TypeValidationError) {
            content = (e.value as any)?.choices?.[0]?.delta?.content;
        }
        messageInfo.content += (content ?? `\n\n\`\`\`Error\n${(e as Error).message}\n\`\`\``);
        messageInfo.occured_error = true;
    }

    return messageInfo.content;
}

async function guardedStreamHandler(stream: AsyncIterable<any>, contentExtractor: (data: any) => string | null, onStream: ChatStreamTextHandler, messageInfo: MessageInfo): Promise<{
    content: string;
    sawToolCall: boolean;
    assistantTextProbe: string;
    assistantHasNonWhitespaceText: boolean;
    detectedBadPrefix: boolean;
}> {
    let lengthDelta = 0;
    let updateStep = 5;
    const maxLength = 10_000;

    let sawToolCall = false;
    let assistantTextProbe = '';
    let assistantHasNonWhitespaceText = false;
    let detectedBadPrefix = false;

    const badPrefix = BAD_PREFIX_GOOGLE_SEARCH;
    let allowSend = false;

    const appendProbe = (delta: string) => {
        if (assistantTextProbe.length >= badPrefix.length + 64) {
            return;
        }
        assistantTextProbe += delta;
    };

    const shouldKeepBufferingForPrefixCheck = () => {
        const trimmedStart = assistantTextProbe.trimStart();
        if (trimmedStart.length === 0) {
            return true;
        }
        if (badPrefix.startsWith(trimmedStart)) {
            return true;
        }
        return false;
    };

    try {
        for await (const part of stream) {
            if (part && typeof part === 'object' && typeof (part as any).type === 'string') {
                const partType = (part as any).type as string;
                if (partType.startsWith('tool-')) {
                    sawToolCall = true;
                }

                if (partType === 'text-delta' && typeof (part as any).text === 'string') {
                    const deltaText = (part as any).text as string;
                    if (deltaText !== '') {
                        appendProbe(deltaText);
                        if (/\S/.test(deltaText)) {
                            assistantHasNonWhitespaceText = true;
                        }

                        const trimmedStart = assistantTextProbe.trimStart();
                        if (trimmedStart.startsWith(badPrefix)) {
                            detectedBadPrefix = true;
                            break;
                        }

                        if (!allowSend && !shouldKeepBufferingForPrefixCheck()) {
                            allowSend = true;
                        }
                    }
                }
            }

            const textPart = contentExtractor(part);
            if (textPart === null || textPart === undefined || textPart === '') {
                continue;
            }

            lengthDelta += textPart.length;
            messageInfo.content += textPart;

            if (allowSend && lengthDelta > updateStep) {
                lengthDelta = 0;
                updateStep = Math.min(updateStep + 40, maxLength);
                onStream.send(`${messageInfo.content.trimEnd()}●`);
            }
        }
    } catch (e) {
        if (messageInfo.content === '') {
            throw e;
        }
        console.error((e as Error).message, (e as Error).stack);
        let content: string | undefined;
        if (e instanceof TypeValidationError) {
            content = (e.value as any)?.choices?.[0]?.delta?.content;
        }
        messageInfo.content += (content ?? `\n\n\`\`\`Error\n${(e as Error).message}\n\`\`\``);
        messageInfo.occured_error = true;
    }

    return {
        content: messageInfo.content,
        sawToolCall,
        assistantTextProbe,
        assistantHasNonWhitespaceText,
        detectedBadPrefix,
    };
}

export const __internal = {
    guardedStreamHandler,
};

export async function requestChatCompletionsV2({ model, messages, tools, activeTools, toolChoice, context, cache }: { model: LanguageModelV3; toolModel?: LanguageModelV3; prompt?: string; messages: ModelMessage[]; tools?: any; activeTools: string[]; toolChoice?: ToolChoice[] | undefined; context: AgentUserConfig; cache?: string[] }, onStream: ChatStreamTextHandler | null): Promise<{ messages: ResponseMessage[]; content: string }> {
    // 引入多轮对话 拼接提示
    const messageInfo: MessageInfo = {
        content: cache?.join() ?? '',
        occured_error: false,
    };
    const { prepareStepPre, onStepFinish, onChunk, ...middleware } = await AIMiddleware({
        config: context,
        activeTools,
        onStream,
        toolChoice: toolChoice || [],
        chatModel: model.modelId,
        messageInfo,
    });

    const handeredParams = await combineParams({ context, middleware, model, messages, activeTools, tools, prepareStepPre, onStepFinish, onChunk });

    let responseMessages: ResponseMessage[] = [];
    let contentFull = '';

    if (onStream !== null) {
        const maxRetriesRaw = Number(context.MAX_RETRIES ?? 0);
        const maxRetries = Number.isFinite(maxRetriesRaw) ? Math.max(0, Math.trunc(maxRetriesRaw)) : 0;
        const maxAttempts = Math.max(1, maxRetries + 1);
        const cacheText = cache?.join() ?? '';

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            // On retry, remove the log entry from the failed attempt
            if (attempt > 1) {
                popLog(context);
            }

            // Reset state per attempt (we only retry when nothing has been sent yet).
            messageInfo.content = cacheText;
            messageInfo.occured_error = false;

            const stream = streamText(handeredParams);
            const dataExtractor = thinkingExtractor(messageInfo);

            const guarded = await guardedStreamHandler(stream.fullStream, dataExtractor, onStream, messageInfo);

            const shouldRetryEmpty = !guarded.sawToolCall && !messageInfo.occured_error && !guarded.assistantHasNonWhitespaceText;
            const shouldRetryBadPrefix = !guarded.sawToolCall && !messageInfo.occured_error
                && (guarded.detectedBadPrefix || isBadPrefixResponseText(guarded.assistantTextProbe));

            if (shouldRetryEmpty) {
                void Promise.resolve(stream.response).catch(() => { });
                void Promise.resolve(stream.providerMetadata).catch(() => { });
                if (attempt < maxAttempts) {
                    log.info(`[ai-retry] stream retry on empty response (${attempt + 1}/${maxAttempts})`);
                    continue;
                }
                const logRecord = getLogSingleton({ config: context, init: false });
                if (logRecord) {
                    logRecord.end_time = Date.now();
                }
                log.warn('[ai-retry] stream retries exhausted: empty response');
                throw new StreamRetryExhaustedError({
                    reason: 'empty-response',
                    attempts: maxAttempts,
                    provider: model.provider,
                    modelId: model.modelId,
                });
            }

            if (shouldRetryBadPrefix) {
                void Promise.resolve(stream.response).catch(() => { });
                void Promise.resolve(stream.providerMetadata).catch(() => { });
                if (attempt < maxAttempts) {
                    log.info(`[ai-retry] stream retry on bad prefix (${attempt + 1}/${maxAttempts})`);
                    continue;
                }
                const logRecord = getLogSingleton({ config: context, init: false });
                if (logRecord) {
                    logRecord.end_time = Date.now();
                }
                log.warn(`[ai-retry] stream retries exhausted: bad prefix (${BAD_PREFIX_GOOGLE_SEARCH})`);
                throw new StreamRetryExhaustedError({
                    reason: 'bad-prefix',
                    attempts: maxAttempts,
                    provider: model.provider,
                    modelId: model.modelId,
                });
            }

            contentFull = guarded.content;
            if (messageInfo.occured_error) {
                responseMessages = [{ role: 'assistant', content: contentFull }];
            } else {
                responseMessages = (await stream.response).messages;
                contentFull = metaDataExtractor(await stream.providerMetadata, model.provider, contentFull);
            }

            break;
        }
    } else {
        const result = await generateText(handeredParams);
        contentFull = `${result.reasoning ? `>\`Thought for several seconds\`\n>${(result.reasoningText ?? '').trim().replace(/\n/g, '\n>')}\n>✹\n` : ''}${result.text}`;
        responseMessages = result.response.messages;
        contentFull = metaDataExtractor(result.providerMetadata, model.provider, contentFull);
    }

    return { messages: responseMessages, content: contentFull };
}

function thinkingExtractor(messageInfo: MessageInfo) {
    let thinkingStart = false;
    let thinkingStartTime: undefined | number;
    const thinkingTag = '>`Thinking\\.\\.\\.`';
    return (data: TextStreamPart<any>) => {
        switch (data.type) {
            case 'reasoning-start':
                if (!ENV.SHOW_THINKING_TEXT) {
                    return '';
                }
                thinkingStart = true;
                thinkingStartTime = Date.now();
                return `${thinkingTag}\n>`;
            case 'reasoning-delta':
                if (!ENV.SHOW_THINKING_TEXT) {
                    return '';
                }
                return data.text.replace(/\n/g, '\n>');
            case 'reasoning-end':
                if (!ENV.SHOW_THINKING_TEXT || !thinkingStart) {
                    return '';
                }
                thinkingStart = false;
                const thinkingTime = ((Date.now() - thinkingStartTime!) / 1e3).toFixed(1);
                messageInfo.content = messageInfo.content
                    .replace(thinkingTag, `>\`Thought for ${thinkingTime} seconds\``)
                    // remove trailing blank lines
                    .replace(/(\n>)*$/, '')
                    // three or more newlines are trimmed to 2 newlines
                    .replace(/(\n>){3,}$/g, '\n>\n>');
                return `\n>✹\n${SEGMENTATION_MARK}\n`;
            case 'text-delta':
                return data.text ?? '';
            case 'error':
                throw data.error;
            default:
                return '';
        }
    };
}

async function combineParams({ context, middleware, model, messages, activeTools, tools, prepareStepPre, onStepFinish, onChunk }: { context: AgentUserConfig; middleware: any; model: LanguageModelV3; messages: ModelMessage[]; activeTools: string[]; tools: any; prepareStepPre: (middleware: (...args: any[]) => any) => any; onStepFinish: (data: StepResult<any>) => void; onChunk: (data: { chunk: TextStreamPart<any> }) => void }) {
    const retryableModel = createChatRetryableModel(wrapLanguageModel({ model, middleware }), context.MAX_RETRIES);

    const providerOptions = {
        openai: context.OPENAI_PROVIDER_OPTIONS,
        anthropic: context.ANTHROPIC_PROVIDER_OPTIONS,
        google: context.GOOGLE_PROVIDER_OPTIONS,
        xai: context.XAI_PROVIDER_OPTIONS,
    };
    return {
        model: retryableModel,
        providerOptions,
        messages,
        experimental_continueSteps: context.CONTINUE_STEP,
        // Use ai-retry for retries (controlled by `MAX_RETRIES`) so we can support both
        // error-based retries and custom result-based retries.
        maxRetries: 0,
        temperature: (activeTools?.length || 0) > 0 ? context.FUNCTION_CALL_TEMPERATURE : context.CHAT_TEMPERATURE,
        tools,
        maxTokens: context.MAX_TOKENS,
        activeTools,
        prepareStep: prepareStepPre(middleware),
        stopWhen: stepCountIs(context.MAX_STEPS),
        onStepFinish,
        onChunk,
        ...(ENV.CHAT_TOTAL_DURATION_LIMIT > 0 && { abortSignal: AbortSignal.timeout(ENV.CHAT_TOTAL_DURATION_LIMIT * 1e3) }),
    };
}
