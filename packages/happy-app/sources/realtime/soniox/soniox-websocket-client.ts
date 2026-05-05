export type SonioxStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

const SONIOX_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
const SONIOX_MODEL = 'stt-rt-preview';

export interface SonioxClientOptions {
    apiKey: string;
    sourceLanguage?: string;
    endpointDelayMs?: number;
}

interface SonioxToken {
    text: string;
    is_final: boolean;
    speaker?: number | null;
    translation_status?: 'none' | 'original' | 'translation';
}

interface SonioxResponse {
    error_code?: number;
    error_message?: string;
    finished?: boolean;
    tokens?: SonioxToken[];
}

/**
 * Direct Soniox real-time STT WebSocket client.
 *
 * Connects straight to wss://stt-rt.soniox.com/transcribe-websocket — no
 * happy-server proxy. The user's API key is sent in the first JSON config
 * message per Soniox spec.
 *
 * Wire protocol (Soniox-native):
 *   client -> server : { api_key, model, audio_format, sample_rate, num_channels,
 *                        language_hints, enable_endpoint_detection, ... } (first message)
 *   client -> server : binary PCM s16le 16kHz mono frames
 *   client -> server : empty string ('') to signal end-of-stream
 *   server -> client : { tokens: [{ text, is_final, speaker?, translation_status? }], finished?, error_code?, error_message? }
 */
export class SonioxWebSocketClient {
    private ws: WebSocket | null = null;
    private intentional = false;

    onConnected: (() => void) | null = null;
    onOriginal: ((text: string, isFinal: boolean, speaker: number | null) => void) | null = null;
    onStatusChange: ((status: SonioxStatus) => void) | null = null;
    onError: ((message: string) => void) | null = null;
    onClosed: (() => void) | null = null;

    connect(options: SonioxClientOptions) {
        this.intentional = false;
        this.setStatus('connecting');

        let socket: WebSocket;
        try {
            socket = new WebSocket(SONIOX_WS_URL);
            (socket as any).binaryType = 'arraybuffer';
        } catch (err) {
            this.setStatus('error');
            this.onError?.(`Failed to open WebSocket: ${err}`);
            return;
        }

        socket.onopen = () => {
            const sourceLang = options.sourceLanguage && options.sourceLanguage !== 'auto'
                ? [options.sourceLanguage]
                : undefined;
            const config: Record<string, unknown> = {
                api_key: options.apiKey,
                model: SONIOX_MODEL,
                audio_format: 'pcm_s16le',
                sample_rate: 16000,
                num_channels: 1,
                enable_endpoint_detection: true,
            };
            if (sourceLang) config.language_hints = sourceLang;
            socket.send(JSON.stringify(config));
            this.setStatus('connected');
            this.onConnected?.();
        };

        socket.onmessage = (event: { data: any }) => {
            try {
                const raw = typeof event.data === 'string' ? event.data : event.data.toString();
                const data = JSON.parse(raw) as SonioxResponse;

                if (data.error_code) {
                    this.onError?.(`Soniox ${data.error_code}: ${data.error_message ?? 'unknown'}`);
                    return;
                }

                if (data.tokens && data.tokens.length > 0) {
                    let finalBuf = '';
                    let interimBuf = '';
                    let speaker: number | null = null;
                    for (const tok of data.tokens) {
                        if (tok.translation_status === 'translation') continue;
                        if (tok.is_final) {
                            finalBuf += tok.text;
                            if (tok.speaker != null) speaker = tok.speaker;
                        } else {
                            interimBuf += tok.text;
                        }
                    }
                    if (finalBuf) this.onOriginal?.(finalBuf, true, speaker);
                    if (interimBuf) this.onOriginal?.(interimBuf, false, null);
                }
            } catch {
                /* ignore malformed frames */
            }
        };

        socket.onerror = () => {
            this.onError?.('Soniox WebSocket error');
        };

        socket.onclose = () => {
            this.ws = null;
            this.setStatus('disconnected');
            this.onClosed?.();
        };

        this.ws = socket;
    }

    sendAudio(pcm: ArrayBuffer) {
        if (this.ws && this.ws.readyState === 1) {
            this.ws.send(pcm);
        }
    }

    end() {
        if (this.ws && this.ws.readyState === 1) {
            try {
                this.ws.send('');
            } catch {
                /* ignore */
            }
        }
    }

    disconnect() {
        this.intentional = true;
        if (this.ws) {
            try {
                if (this.ws.readyState === 1) this.ws.send('');
                this.ws.close(1000);
            } catch {
                /* ignore */
            }
            this.ws = null;
        }
        this.setStatus('disconnected');
    }

    private setStatus(status: SonioxStatus) {
        this.onStatusChange?.(status);
    }
}
