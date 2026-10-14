import type { LanguageModelV4 } from '@ai-sdk/provider';
import { APICallError } from 'ai';
import { isResultAttempt } from 'ai-retry';
import { createRetryableModel, error, result } from 'ai-retry/language-model';
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

export function createChatRetryableModel(model: LanguageModelV4, maxRetries: unknown): LanguageModelV4 {
    const maxRetriesNormalized = normalizeMaxRetries(maxRetries);
    // `Condition.retry()` rejects maxAttempts < 2, so skip wrapping entirely when retries are off.
    if (maxRetriesNormalized <= 0) {
        return model;
    }
    const maxAttempts = maxRetriesNormalized + 1;

    // Result-based retries only judge plain-text steps; tool-call steps are left alone.
    const textResult = (predicate: (text: string, outputTokens: number | undefined) => boolean) =>
        result(res => !hasToolCallContent(res.content) && predicate(extractGeneratedTextFromContent(res.content), res.usage?.outputTokens?.total));

    return createRetryableModel({
        model,
        retries: [
            // Empty response (0 tokens / empty text).
            textResult((text, outputTokens) => outputTokens === 0 || isEmptyResponseText(text)).retry({ maxAttempts }),
            // Bad "print(google_search.search(" prefix.
            textResult(isBadPrefixResponseText).retry({ maxAttempts }),
            // Retryable API errors (429/503/etc.) with backoff; honors Retry-After headers.
            error.isRetryable(true).retry({ maxAttempts, delay: 1000, backoffFactor: 2 }),
            // Generic fallback (network errors, etc.). Retrying a manual abort would fail immediately
            // with the same signal, and non-retryable API errors (invalid request, auth...) won't recover.
            error(err => !isAbortError(err) && !(APICallError.isInstance(err) && !err.isRetryable)).retry({ maxAttempts }),
        ],
        onRetry: ({ current, attempts }) => {
            const reason = isResultAttempt(current) ? 'bad result' : `error: ${(current.error as Error)?.message ?? current.error}`;
            log.info(`[ai-retry] retry attempt ${attempts.length + 1}/${maxAttempts} for ${current.model.provider}/${current.model.modelId} (${reason})`);
        },
    });
}

function isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === 'AbortError';
}
