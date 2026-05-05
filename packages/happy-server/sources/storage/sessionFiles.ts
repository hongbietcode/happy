import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

const UPLOAD_ROOT = process.env.HAPPY_UPLOADS_ROOT || '/tmp/happy-uploads';
const SAFE_EXT = /^[A-Za-z0-9]{1,8}$/;

export interface SavedSessionFile {
    fileId: string;
    path: string;
    filename: string;
    size: number;
}

export function sessionUploadDir(sessionId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
        throw new Error('Invalid sessionId');
    }
    return path.join(UPLOAD_ROOT, sessionId);
}

function pickExtension(originalName: string, mimeType: string | undefined): string {
    const fromName = path.extname(originalName).replace(/^\./, '').toLowerCase();
    if (fromName && SAFE_EXT.test(fromName)) return fromName;

    const fromMime = (() => {
        switch (mimeType) {
            case 'image/jpeg': return 'jpg';
            case 'image/png': return 'png';
            case 'image/webp': return 'webp';
            case 'image/gif': return 'gif';
            case 'image/heic': return 'heic';
            case 'image/heif': return 'heif';
            default: return null;
        }
    })();
    if (fromMime) return fromMime;
    return 'bin';
}

export async function saveSessionFile(
    sessionId: string,
    fileBuffer: Buffer,
    originalName: string,
    mimeType: string | undefined
): Promise<SavedSessionFile> {
    const dir = sessionUploadDir(sessionId);
    await fs.mkdir(dir, { recursive: true });

    const fileId = randomUUID();
    const ext = pickExtension(originalName, mimeType);
    const filename = `${fileId}.${ext}`;
    const filePath = path.join(dir, filename);

    await fs.writeFile(filePath, fileBuffer);

    return {
        fileId,
        path: filePath,
        filename,
        size: fileBuffer.length,
    };
}

export async function cleanupSessionFiles(sessionId: string): Promise<void> {
    const dir = sessionUploadDir(sessionId);
    await fs.rm(dir, { recursive: true, force: true });
}

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function cleanupOldUploads(maxAgeMs = DEFAULT_MAX_AGE_MS): Promise<number> {
    const now = Date.now();
    let removed = 0;
    let entries: string[];
    try {
        entries = await fs.readdir(UPLOAD_ROOT);
    } catch {
        return 0;
    }
    for (const sessionId of entries) {
        const sessionDir = path.join(UPLOAD_ROOT, sessionId);
        let files: string[];
        try {
            files = await fs.readdir(sessionDir);
        } catch {
            continue;
        }
        let remaining = files.length;
        for (const name of files) {
            const filePath = path.join(sessionDir, name);
            try {
                const stat = await fs.stat(filePath);
                if (now - stat.mtimeMs > maxAgeMs) {
                    await fs.rm(filePath, { force: true });
                    removed++;
                    remaining--;
                }
            } catch {}
        }
        if (remaining === 0) {
            await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
        }
    }
    return removed;
}
