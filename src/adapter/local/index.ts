import type { GetUpdatesResponse } from 'telegram-bot-api-types';
import * as fs from 'node:fs';
import { createCache } from 'cf-worker-adapter/cache';
import { installFetchProxy } from 'cf-worker-adapter/proxy';
import { defaultRequestBuilder, initEnv, startServerV2 } from 'cf-worker-adapter/serve';
import { schedule } from 'node-cron';
import worker from '../../';
import { ENV } from '../../config/env';
import { createRouter } from '../../route/index';
import { createTelegramBotAPI } from '../../telegram/api';
import { handleUpdate } from '../../telegram/handler';

const {
    CONFIG_PATH = '/app/config.json',
    TOML_PATH = '/app/config.toml',
} = process.env;

interface Config {
    database: {
        type: 'memory' | 'local' | 'sqlite' | 'redis';
        path?: string;
    };
    server?: {
        hostname?: string;
        port?: number;
        baseURL: string;
    };
    proxy?: string;
    mode: 'webhook' | 'polling';
}

// 读取配置文件
const config: Config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

if (config.proxy) {
    installFetchProxy(config.proxy);
}

// 初始化数据库
const cache = createCache(config?.database?.type, {
    uri: config.database.path || '',
});
console.log(`database: ${config?.database?.type} is ready`);

// 初始化环境变量
const env = initEnv(TOML_PATH, { DATABASE: cache });
ENV.merge(env);

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 单个 token 的轮询逻辑：带 HTTP 超时 + 错误退避 + 有限并发处理
async function pollToken(token: string) {
    let offset = 0;

    let baseURL = ENV.TELEGRAM_API_DOMAIN || 'https://api.telegram.org';
    while (baseURL.endsWith('/')) {
        baseURL = baseURL.slice(0, -1);
    }
    const url = `${baseURL}/bot${token}/getUpdates`;

    const LONG_POLL_TIMEOUT_SEC = 30;     // Telegram 长轮询超时（服务器端）
    const HTTP_TIMEOUT_MS = 60_000;       // 本地 HTTP 超时保护
    const ERROR_BACKOFF_MS = 5_000;       // 出错后的退避时间
    const MAX_CONCURRENT_HANDLERS = 5;    // 每批最多并发处理的更新数，可按需调

    console.log(`[poll] start polling for token ${token.slice(0, 8)}...`);

    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            const body = {
                offset,
                timeout: LONG_POLL_TIMEOUT_SEC,
            };

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

            let resp: Response;
            try {
                resp = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
            } finally {
                clearTimeout(timeoutId);
            }

            // 限流处理
            if (resp.status === 429) {
                const retryAfter = Number.parseInt(resp.headers.get('Retry-After') || '');
                const waitSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5;
                console.warn(`[poll] 429 rate limited for token ${token.slice(0, 8)}, retry after ${waitSec}s`);
                await sleep(waitSec * 1000);
                continue;
            }

            if (!resp.ok) {
                console.error(`[poll] getUpdates failed: ${resp.status} ${resp.statusText}`);
                await sleep(ERROR_BACKOFF_MS);
                continue;
            }

            const data = await resp.json() as GetUpdatesResponse;
            const updates = Array.isArray(data.result) ? data.result : [];
            if (updates.length === 0) {
                // 没有新消息，继续下一轮
                continue;
            }

            // 记录本批次最后一个 update_id
            const lastUpdateId = updates[updates.length - 1].update_id;

            // 分批并发处理，限制每批并发量
            let index = 0;
            while (index < updates.length) {
                const slice = updates.slice(index, index + MAX_CONCURRENT_HANDLERS);
                await Promise.all(slice.map(async (update) => {
                    try {
                        await handleUpdate(token, update);
                    } catch (e) {
                        console.error('[poll] handleUpdate error', e);
                    }
                }));
                index += MAX_CONCURRENT_HANDLERS;
            }

            // 所有本批次处理完后再更新 offset
            offset = lastUpdateId + 1;
        } catch (e: any) {
            if (e?.name === 'AbortError') {
                console.warn('[poll] getUpdates http timeout, retrying...');
            } else {
                console.error('[poll] unexpected error in polling loop', e);
            }
            await sleep(ERROR_BACKOFF_MS);
        }
    }
}

// long polling 模式入口
async function runPolling() {
    if (!ENV.TELEGRAM_AVAILABLE_TOKENS || ENV.TELEGRAM_AVAILABLE_TOKENS.length === 0) {
        console.warn('[poll] TELEGRAM_AVAILABLE_TOKENS is empty, nothing to poll.');
        return;
    }

    // 先删除 webhook，避免 webhook + polling 同时存在
    for (const token of ENV.TELEGRAM_AVAILABLE_TOKENS) {
        try {
            const api = createTelegramBotAPI(token);
            const me = await api.getMeWithReturns();
            await api.deleteWebhook({});
            console.log(`[@${me.result.username}] Webhook deleted, polling mode enabled.`);
        } catch (e) {
            console.error(`[poll] init token ${token.slice(0, 8)} failed`, e);
        }
    }

    // 为每个 token 启动独立轮询协程
    for (const token of ENV.TELEGRAM_AVAILABLE_TOKENS) {
        pollToken(token).catch((e) => {
            console.error(`[poll] fatal error in pollToken(${token.slice(0, 8)})`, e);
        });
    }
}

try {
    // 定时任务
    if (env.EXPIRED_TIME > 0 && env.CRON_CHECK_TIME) {
        try {
            schedule(env.CRON_CHECK_TIME, async () => await worker.scheduled({} as Event, env, null));
        } catch (e) {
            console.error('Failed to schedule cron job:', e);
        }
    }
} catch (e) {
    console.log(e);
}

// 启动服务 / 轮询
if (config.mode === 'webhook' && config.server !== undefined) {
    const router = createRouter();
    startServerV2(
        config.server.port || 8787,
        config.server.hostname || '0.0.0.0',
        env,
        { baseURL: config.server.baseURL },
        defaultRequestBuilder,
        router.fetch.bind(router),
    );
} else {
    runPolling().catch(console.error);
}
