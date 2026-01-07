export type StreamRetryExhaustedReason = 'empty-response' | 'bad-prefix';

export class StreamRetryExhaustedError extends Error {
    override readonly name = 'StreamRetryExhaustedError';
    readonly reason: StreamRetryExhaustedReason;
    readonly attempts: number;
    readonly provider: string;
    readonly modelId: string;

    constructor(options: { reason: StreamRetryExhaustedReason; attempts: number; provider: string; modelId: string }) {
        const reasonText = options.reason === 'empty-response' ? 'empty response' : 'bad prefix';
        super(`[ai-retry] stream retries exhausted (${options.attempts} attempts): ${reasonText}`);
        this.reason = options.reason;
        this.attempts = options.attempts;
        this.provider = options.provider;
        this.modelId = options.modelId;
    }
}

