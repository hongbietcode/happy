import React, { useEffect, useRef } from 'react';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import type { VoiceSession, VoiceSessionConfig } from '../types';
import { SonioxWebSocketClient } from './soniox-websocket-client';
import { SonioxAudioRecorder } from './soniox-audio-recorder';
import { detectStopWord } from './stop-word-detection';
import { correctTranscript, type ContextMessage } from './llm-correction';

/**
 * Soniox-flow VoiceSession.
 *
 * Lifecycle (single-shot transcribe):
 *   startSession()
 *     -> open WS direct to wss://stt-rt.soniox.com/transcribe-websocket using user's API key
 *     -> start mic, stream PCM
 *     -> accumulate finals via onOriginal (live-typed into the session draft)
 *     -> stop word detected OR endSession() called
 *         -> stop mic, end WS
 *         -> if LLM correction configured (api key + base url + model): corrected = LLM(text); else: text
 *         -> write final text to the session draft so the user can review/edit
 *           before pressing Send manually. We never auto-send.
 *
 * Unlike ElevenLabs (continuous bidirectional), Soniox is one transcript
 * per session. Finalizing the transcript ends the session.
 */
class SonioxVoiceSessionImpl implements VoiceSession {
    private client: SonioxWebSocketClient | null = null;
    private recorder: SonioxAudioRecorder | null = null;
    private accumulated = '';
    private interim = '';
    private currentSessionId: string | null = null;
    private finalizing = false;
    private draftBefore: string | null = null;

    private liveText(): string {
        const parts: string[] = [];
        if (this.accumulated) parts.push(this.accumulated);
        if (this.interim) parts.push(this.interim);
        return parts.join(' ').trim();
    }

    private pushDraft() {
        const sessionId = this.currentSessionId;
        if (!sessionId) return;
        const text = this.liveText();
        storage.getState().updateSessionDraft(sessionId, text || null);
    }

    async startSession(config: VoiceSessionConfig): Promise<string | null> {
        if (this.client) {
            console.warn('[Soniox] startSession called while session active, ignoring');
            return null;
        }

        const settings = storage.getState().settings;
        const apiKey = settings.voiceSonioxApiKey?.trim();
        if (!apiKey) {
            storage.getState().setRealtimeStatus('disconnected');
            throw new Error('Soniox API key is not set. Configure it in Settings → Voice → Soniox STT.');
        }

        this.accumulated = '';
        this.interim = '';
        this.finalizing = false;
        this.currentSessionId = config.sessionId;
        this.draftBefore = storage.getState().sessions[config.sessionId]?.draft ?? null;

        storage.getState().setRealtimeStatus('connecting');

        this.client = new SonioxWebSocketClient();
        this.client.onConnected = () => {
            storage.getState().setRealtimeStatus('connected');
            storage.getState().setRealtimeMode('idle');
        };
        this.client.onStatusChange = (status) => {
            if (status === 'error') {
                storage.getState().setRealtimeStatus('disconnected');
            }
        };
        this.client.onError = (msg) => {
            console.warn('[Soniox] error:', msg);
        };
        this.client.onClosed = () => {
            // Treat unexpected close as session end if we weren't already finalizing
            if (!this.finalizing) {
                this.cleanup();
            }
        };
        this.client.onOriginal = (text, isFinal, _speaker) => {
            if (!isFinal) {
                this.interim = text;
                storage.getState().setRealtimeMode('user-speaking', true);
                this.pushDraft();
                return;
            }
            this.accumulated = this.accumulated ? this.accumulated + ' ' + text : text;
            this.interim = '';
            storage.getState().setRealtimeMode('idle');
            this.pushDraft();

            const stopWord = settings.voiceStopWord;
            if (stopWord) {
                const { detected, cleanedTranscript } = detectStopWord(this.accumulated, stopWord);
                if (detected) {
                    this.accumulated = cleanedTranscript;
                    this.pushDraft();
                    this.finalizeTranscript().catch((err) => console.warn('[Soniox] finalize error:', err));
                }
            }
        };

        this.client.connect({
            apiKey,
            sourceLanguage: settings.voiceSourceLanguage || 'auto',
            endpointDelayMs: 1500,
        });

        this.recorder = new SonioxAudioRecorder();
        try {
            await this.recorder.start({
                onPcm: (pcm) => this.client?.sendAudio(pcm),
                onError: (err) => console.warn('[Soniox] recorder error:', err),
            });
        } catch (err) {
            await this.cleanup();
            throw err;
        }

        return null;
    }

    async endSession(): Promise<void> {
        await this.finalizeTranscript();
    }

    sendTextMessage(message: string): void {
        const sessionId = this.currentSessionId;
        if (!sessionId) return;
        sync.sendMessage(sessionId, message, { source: 'voice' }).catch((err) => {
            console.warn('[Soniox] sendMessage error:', err);
        });
    }

    sendContextualUpdate(_update: string): void {
        // No-op: Soniox is one-shot transcribe, no agent to update.
    }

    private async finalizeTranscript(): Promise<void> {
        if (this.finalizing) return;
        this.finalizing = true;

        const sessionId = this.currentSessionId;
        const text = this.accumulated.trim();
        const settings = storage.getState().settings;

        try {
            this.recorder?.stop().catch(() => {});
            this.client?.end();
            this.client?.disconnect();
        } catch {
            /* ignore */
        }

        if (!sessionId) {
            this.cleanup();
            return;
        }

        if (!text) {
            // Nothing was transcribed — restore whatever the user had typed before.
            storage.getState().updateSessionDraft(sessionId, this.draftBefore);
            this.cleanup();
            return;
        }

        let finalText = text;
        const baseUrl = (settings.voiceLlmCorrectionBaseUrl?.trim() || 'https://api.openai.com/v1');
        const correctionConfigured =
            !!settings.voiceLlmCorrectionApiKey &&
            !!settings.voiceLlmCorrectionModel;
        if (correctionConfigured) {
            const recentMessages = collectRecentMessages(sessionId, 5);
            console.log('[Soniox] LLM correction: running', {
                model: settings.voiceLlmCorrectionModel,
                baseUrl,
                originalLen: text.length,
                hasKeywords: !!settings.voiceLlmCorrectionKeywords?.trim(),
                contextMessages: recentMessages.length,
            });
            try {
                finalText = await correctTranscript(text, {
                    apiKey: settings.voiceLlmCorrectionApiKey!,
                    baseUrl,
                    model: settings.voiceLlmCorrectionModel!,
                    language: settings.voiceSourceLanguage,
                    keywords: settings.voiceLlmCorrectionKeywords,
                    recentMessages,
                });
                console.log('[Soniox] LLM correction: done', {
                    changed: finalText !== text,
                    correctedLen: finalText.length,
                });
            } catch (err) {
                console.warn('[Soniox] LLM correction threw, keeping original transcript:', err);
                finalText = text;
            }
        } else {
            console.log('[Soniox] LLM correction: skipped', {
                hasApiKey: !!settings.voiceLlmCorrectionApiKey?.trim(),
                hasModel: !!settings.voiceLlmCorrectionModel?.trim(),
                baseUrl,
            });
        }

        // Leave the (possibly LLM-corrected) transcript in the session draft so the
        // user can review/edit before pressing Send. We do not auto-send.
        storage.getState().updateSessionDraft(sessionId, finalText);
        this.cleanup();
    }

    private cleanup() {
        try {
            this.recorder?.stop().catch(() => {});
        } catch {
            /* ignore */
        }
        this.recorder = null;
        this.client = null;
        this.accumulated = '';
        this.interim = '';
        this.currentSessionId = null;
        this.draftBefore = null;
        this.finalizing = false;
        storage.getState().setRealtimeStatus('disconnected');
        storage.getState().setRealtimeMode('idle', true);
    }
}

/**
 * Pull the last N user/assistant text messages for the session, oldest→newest,
 * so the LLM correction prompt can disambiguate the transcript using context.
 * Storage keeps messages sorted newest-first.
 */
function collectRecentMessages(sessionId: string, n: number): ContextMessage[] {
    const sessionMessages = storage.getState().sessionMessages[sessionId];
    if (!sessionMessages) return [];
    const out: ContextMessage[] = [];
    for (const m of sessionMessages.messages) {
        if (out.length >= n) break;
        if (m.kind === 'user-text' && m.text.trim()) {
            out.push({ role: 'user', text: m.text });
        } else if (m.kind === 'agent-text' && m.text.trim()) {
            out.push({ role: 'assistant', text: m.text });
        }
    }
    return out.reverse();
}

let registeredImpl: SonioxVoiceSessionImpl | null = null;

export function getSonioxVoiceSession(): VoiceSession {
    if (!registeredImpl) registeredImpl = new SonioxVoiceSessionImpl();
    return registeredImpl;
}

/**
 * Bridge component — currently no UI, but kept as a component so we have
 * a hook into mount/unmount if we add visual feedback later (matches the
 * shape of RealtimeVoiceSession for ElevenLabs).
 */
export const SonioxRealtimeSession: React.FC = () => {
    const ref = useRef(false);
    useEffect(() => {
        ref.current = true;
        // Touch the impl so it's instantiated lazily.
        getSonioxVoiceSession();
    }, []);
    return null;
};
