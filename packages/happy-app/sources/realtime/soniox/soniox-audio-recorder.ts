import { AudioManager, AudioRecorder } from 'react-native-audio-api';

const TARGET_SAMPLE_RATE = 16000;
const BUFFER_LENGTH_SAMPLES = 1600; // ~100ms @ 16kHz

export interface SonioxAudioRecorderHandlers {
    onPcm: (pcm: ArrayBuffer) => void;
    onError?: (err: string) => void;
}

/**
 * Captures microphone audio at 16kHz mono and emits 16-bit signed
 * little-endian PCM chunks (the format Soniox expects).
 *
 * react-native-audio-api delivers `AudioBuffer` (Float32 channels). We
 * downmix to mono if needed and convert Float32 [-1, 1] to Int16 LE.
 */
export class SonioxAudioRecorder {
    private recorder: AudioRecorder | null = null;
    private handlers: SonioxAudioRecorderHandlers | null = null;
    private running = false;

    async start(handlers: SonioxAudioRecorderHandlers): Promise<void> {
        if (this.running) return;
        this.handlers = handlers;

        try {
            AudioManager.setAudioSessionOptions?.({
                iosCategory: 'playAndRecord',
                iosMode: 'spokenAudio',
                iosOptions: ['allowBluetooth', 'defaultToSpeaker'],
            });
            AudioManager.setAudioSessionActivity?.(true);
        } catch {
            /* best-effort — older versions of the lib don't expose these */
        }

        const recorder = new AudioRecorder({
            sampleRate: TARGET_SAMPLE_RATE,
            bufferLengthInSamples: BUFFER_LENGTH_SAMPLES,
        });

        recorder.onAudioReady((event: { buffer: { getChannelData: (i: number) => Float32Array; numberOfChannels: number; length: number } }) => {
            if (!this.running) return;
            try {
                const channels = event.buffer.numberOfChannels;
                const length = event.buffer.length;
                const ch0 = event.buffer.getChannelData(0);
                let mono: Float32Array;
                if (channels === 1) {
                    mono = ch0;
                } else {
                    const ch1 = event.buffer.getChannelData(1);
                    mono = new Float32Array(length);
                    for (let i = 0; i < length; i++) {
                        mono[i] = (ch0[i] + ch1[i]) * 0.5;
                    }
                }
                const pcm = floatToPcm16(mono);
                this.handlers?.onPcm(pcm);
            } catch (err) {
                this.handlers?.onError?.(`PCM convert error: ${err}`);
            }
        });

        try {
            recorder.start();
        } catch (err) {
            this.handlers?.onError?.(`Failed to start mic: ${err}`);
            throw err;
        }

        this.recorder = recorder;
        this.running = true;
    }

    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;
        try {
            this.recorder?.stop();
        } catch {
            /* ignore */
        }
        this.recorder = null;
        try {
            AudioManager.setAudioSessionActivity?.(false);
        } catch {
            /* ignore */
        }
    }
}

function floatToPcm16(float32: Float32Array): ArrayBuffer {
    const out = new ArrayBuffer(float32.length * 2);
    const view = new DataView(out);
    for (let i = 0; i < float32.length; i++) {
        let s = Math.max(-1, Math.min(1, float32[i]));
        s = s < 0 ? s * 0x8000 : s * 0x7fff;
        view.setInt16(i * 2, s | 0, true);
    }
    return out;
}
