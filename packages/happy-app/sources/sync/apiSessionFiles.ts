import { z } from 'zod';
import { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';

const UploadSessionFileResponseSchema = z.object({
    fileId: z.string(),
    path: z.string(),
    filename: z.string(),
    mimeType: z.string().optional(),
    size: z.number()
});

export type UploadedSessionFile = z.infer<typeof UploadSessionFileResponseSchema>;

export async function uploadSessionFile(
    credentials: AuthCredentials,
    sessionId: string,
    fileUri: string,
    filename: string,
    mimeType: string
): Promise<UploadedSessionFile> {
    const serverUrl = getServerUrl();
    const form = new FormData();
    form.append('file', {
        uri: fileUri,
        name: filename,
        type: mimeType
    } as unknown as Blob);

    const response = await fetch(`${serverUrl}/v3/sessions/${sessionId}/files`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'X-Happy-Client': getHappyClientId()
        },
        body: form
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`File upload failed: ${response.status} ${text.slice(0, 200)}`);
    }

    return UploadSessionFileResponseSchema.parse(await response.json());
}
