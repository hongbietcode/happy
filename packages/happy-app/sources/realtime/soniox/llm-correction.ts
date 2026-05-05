const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const TIMEOUT_MS = 10000;
const MAX_CONTEXT_CHARS_PER_MESSAGE = 500;

export interface ContextMessage {
    role: 'user' | 'assistant';
    text: string;
}

export interface LlmCorrectionConfig {
    apiKey: string;
    baseUrl: string;
    model: string;
    language?: string | null;
    keywords?: string | null;
    recentMessages?: ContextMessage[];
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max) + '…';
}

function buildSystemPrompt(cfg: LlmCorrectionConfig): string {
    const langHint =
        cfg.language === 'en' ? 'Output in English.' :
        cfg.language === 'vi' ? 'Output in Vietnamese.' :
        'Preserve the original language.';

    const lines: string[] = [
        'Fix spelling and grammar errors in the following speech-to-text transcript.',
        'Output ONLY the corrected text, nothing else. Preserve the original meaning.',
        langHint,
    ];

    const keywords = cfg.keywords?.trim();
    if (keywords) {
        lines.push('');
        lines.push(`Glossary — preserve these terms verbatim (proper nouns, technical names, brands): ${keywords}`);
    }

    const recent = cfg.recentMessages?.filter((m) => m.text.trim()).slice(-5) ?? [];
    if (recent.length > 0) {
        lines.push('');
        lines.push('Recent conversation context (for reference only — do not echo, only use to disambiguate the transcript):');
        for (const m of recent) {
            const tag = m.role === 'user' ? 'User' : 'Assistant';
            lines.push(`${tag}: ${truncate(m.text.trim(), MAX_CONTEXT_CHARS_PER_MESSAGE)}`);
        }
    }

    return lines.join('\n');
}

async function tryOnce(url: string, cfg: LlmCorrectionConfig, systemPrompt: string, text: string, attempt: number): Promise<{ ok: true; text: string } | { ok: false; transient: boolean; error: string }> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const startedAt = Date.now();
    const apiKeyMasked = cfg.apiKey ? `${cfg.apiKey.slice(0, 4)}…${cfg.apiKey.slice(-4)}` : '(empty)';
    console.log('[LLM correction] request', {
        attempt,
        url,
        model: cfg.model,
        apiKey: apiKeyMasked,
        systemPromptLen: systemPrompt.length,
        userTextLen: text.length,
        timeoutMs: TIMEOUT_MS,
    });
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify({
                model: cfg.model,
                temperature: 0.1,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: text },
                ],
            }),
            signal: ac.signal,
        });

        const elapsed = Date.now() - startedAt;
        console.log('[LLM correction] response', { attempt, status: res.status, ok: res.ok, elapsedMs: elapsed });

        if (!res.ok) {
            const transient = TRANSIENT_STATUSES.has(res.status);
            const body = await res.text().catch(() => '');
            console.warn('[LLM correction] non-2xx body:', body.slice(0, 500));
            return { ok: false, transient, error: `HTTP ${res.status}: ${body}` };
        }

        const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const corrected = json.choices?.[0]?.message?.content?.trim();
        if (!corrected) {
            console.warn('[LLM correction] empty choices in response:', JSON.stringify(json).slice(0, 500));
            return { ok: false, transient: false, error: 'No choices in response' };
        }
        return { ok: true, text: corrected };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const elapsed = Date.now() - startedAt;
        const transient = message.toLowerCase().includes('aborted') || message.toLowerCase().includes('network');
        console.warn('[LLM correction] fetch threw', { attempt, elapsedMs: elapsed, transient, message, name: err instanceof Error ? err.name : undefined });
        return { ok: false, transient, error: message };
    } finally {
        clearTimeout(t);
    }
}

/**
 * Run an OpenAI-compatible chat-completions correction pass on a transcript.
 * Returns the original text on persistent failure (matches the translator's behavior).
 */
export async function correctTranscript(text: string, cfg: LlmCorrectionConfig): Promise<string> {
    if (!text.trim()) return text;
    const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const systemPrompt = buildSystemPrompt(cfg);
    console.log('[LLM correction] start', {
        baseUrl: cfg.baseUrl,
        url,
        model: cfg.model,
        language: cfg.language ?? null,
        keywords: cfg.keywords ?? null,
        recentMessagesCount: cfg.recentMessages?.length ?? 0,
        textLen: text.length,
    });
    console.log('[LLM correction] system prompt:\n' + systemPrompt);
    console.log('[LLM correction] user text:', text);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const result = await tryOnce(url, cfg, systemPrompt, text, attempt + 1);
        if (result.ok) {
            console.log('[LLM correction] success', { attempt: attempt + 1, correctedLen: result.text.length, sample: result.text.slice(0, 200) });
            return result.text;
        }
        if (!result.transient || attempt === MAX_RETRIES - 1) {
            console.warn('[LLM correction] giving up, returning original. error:', result.error);
            return text;
        }
        const wait = 500 * Math.pow(2, attempt);
        console.log('[LLM correction] retry after', wait, 'ms — error was:', result.error);
        await new Promise((r) => setTimeout(r, wait));
    }
    return text;
}
