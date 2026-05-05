import { cleanupOldUploads } from '@/storage/sessionFiles';
import { log } from '@/utils/log';
import { onShutdown } from '@/utils/shutdown';

const HOURLY_MS = 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * HOURLY_MS;

let timer: ReturnType<typeof setInterval> | null = null;

export function startSessionFilesCleanup(): void {
    const run = async () => {
        try {
            const removed = await cleanupOldUploads(SEVEN_DAYS_MS);
            if (removed > 0) {
                log({ module: 'session-files-cleanup' }, `Removed ${removed} stale session file(s)`);
            }
        } catch (err) {
            log({ module: 'session-files-cleanup', level: 'error' }, `Cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    };

    void run();
    timer = setInterval(run, HOURLY_MS);

    onShutdown('session-files-cleanup', async () => {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    });

    log({ module: 'session-files-cleanup' }, 'Scheduled cleanup every 1h, removing files older than 7d');
}
