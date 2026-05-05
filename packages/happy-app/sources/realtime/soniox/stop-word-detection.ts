export function normalizeText(text: string): string {
    return text
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
}

export function detectStopWord(
    transcript: string,
    stopWord: string,
): { detected: boolean; cleanedTranscript: string } {
    if (!stopWord) return { detected: false, cleanedTranscript: transcript };

    const normalizedTranscript = normalizeText(transcript);
    const normalizedStop = normalizeText(stopWord);

    if (normalizedTranscript.endsWith(normalizedStop)) {
        const cleanedNormalized = normalizedTranscript.slice(
            0,
            normalizedTranscript.length - normalizedStop.length,
        );
        const cleaned = transcript.slice(0, cleanedNormalized.length).trim();
        return { detected: true, cleanedTranscript: cleaned };
    }

    return { detected: false, cleanedTranscript: transcript };
}
