import type { LanguageModelV3 } from '@ai-sdk/provider';
import { APICallError } from 'ai';
import { createRetryable, isErrorAttempt, isResultAttempt } from 'ai-retry';
import { retryAfterDelay } from 'ai-retry/retryables';
import { log } from '../log';

export const BAD_PREFIX_GOOGLE_SEARCH = 'print(google_search.search(';

function normalizeMaxRetries(value: unknown): number {
    const raw = Number(value ?? 0);
    if (!Number.isFinite(raw)) {
        return 0;
    }
    return Math.max(0, Math.trunc(raw));
}

function extractGeneratedTextFromContent(content: unknown): string {
    if (!Array.isArray(content)) {
        return '';
    }

    return content
        .filter(part => part && typeof part === 'object' && (part as any).type === 'text' && typeof (part as any).text === 'string')
        .map(part => (part as any).text as string)
        .join('');
}

function hasToolCallContent(content: unknown): boolean {
    if (!Array.isArray(content)) {
        return false;
    }

    return content.some(part => part && typeof part === 'object' && (part as any).type === 'tool-call');
}

export function isEmptyResponseText(text: string): boolean {
    return text.trim().length === 0;
}

export function isBadPrefixResponseText(text: string): boolean {
    return text.trimStart().startsWith(BAD_PREFIX_GOOGLE_SEARCH);
}

export function createChatRetryableModel(model: LanguageModelV3, maxRetries: unknown): LanguageModelV3 {
    const maxRetriesNormalized = normalizeMaxRetries(maxRetries);
    const maxAttempts = Math.max(1, maxRetriesNormalized + 1);

    return createRetryable({
        model,
        disabled: maxRetriesNormalized <= 0,
        retries: [
            // Result-based retry #1: empty response (0 tokens / empty text).
            (retryContext) => {
                if (!isResultAttempt(retryContext.current)) {
                    return undefined;
                }

                const { result } = retryContext.current;

                // Don't treat tool-call steps as "empty responses".
                if (hasToolCallContent(result.content)) {
                    return undefined;
                }

                const text = extractGeneratedTextFromContent(result.content);
                const hasZeroOutputTokens = result.usage?.outputTokens?.total === 0;

                if (hasZeroOutputTokens || isEmptyResponseText(text)) {
                    log.info(`[ai-retry] retry on empty response from ${retryContext.current.model.provider}/${retryContext.current.model.modelId}`);
                    return { model: retryContext.current.model, maxAttempts };
                }

                return undefined;
            },

            // Result-based retry #2: bad "print(google_search.search(" prefix.
            (retryContext) => {
                if (!isResultAttempt(retryContext.current)) {
                    return undefined;
                }

                const { result } = retryContext.current;

                // If the model is actually calling tools, don't interfere.
                if (hasToolCallContent(result.content)) {
                    return undefined;
                }

                const text = extractGeneratedTextFromContent(result.content);

                if (isBadPrefixResponseText(text)) {
                    log.info(`[ai-retry] retry on bad prefix response from ${retryContext.current.model.provider}/${retryContext.current.model.modelId}`);
                    return { model: retryContext.current.model, maxAttempts };
                }

                return undefined;
            },

            // Error-based retry with backoff + retry-after support (429/503/etc).
            retryAfterDelay({ maxAttempts, delay: 1000, backoffFactor: 2 }),

            // Generic error-based retry fallback (network errors, etc.).
            (retryContext) => {
                if (!isErrorAttempt(retryContext.current)) {
                    return undefined;
                }

                const { error } = retryContext.current;

                // If the request was cancelled/timed out, retrying with the same abort signal
                // will fail immediately. Keep the original behavior (no retry).
                if (error instanceof Error && error.name === 'AbortError') {
                    return undefined;
                }

                // Skip clearly non-retryable API errors (invalid request, auth, etc.).
                if (APICallError.isInstance(error) && error.isRetryable === false) {
                    return undefined;
                }

                return { model: retryContext.current.model, maxAttempts };
            },
        ],
        onRetry: (retryContext) => {
            const nextAttempt = retryContext.attempts.length + 1;
            log.debug(`[ai-retry] retry attempt ${nextAttempt} for ${retryContext.current.model.provider}/${retryContext.current.model.modelId}`);
        },
    }) as unknown as LanguageModelV3;
}

