import { z } from 'zod';

export const MessageAttachmentSchema = z.object({
    fileId: z.string(),
    path: z.string(),
    filename: z.string(),
    mimeType: z.string().optional(),
    size: z.number().optional()
});

export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>;

// Shared message metadata schema
export const MessageMetaSchema = z.object({
    sentFrom: z.string().optional(), // Source identifier
    permissionMode: z.string().optional(), // Permission mode key for this message
    model: z.string().nullable().optional(), // Model name for this message (null = reset)
    fallbackModel: z.string().nullable().optional(), // Fallback model for this message (null = reset)
    customSystemPrompt: z.string().nullable().optional(), // Custom system prompt for this message (null = reset)
    appendSystemPrompt: z.string().nullable().optional(), // Append to system prompt for this message (null = reset)
    allowedTools: z.array(z.string()).nullable().optional(), // Allowed tools for this message (null = reset)
    disallowedTools: z.array(z.string()).nullable().optional(), // Disallowed tools for this message (null = reset)
    displayText: z.string().optional(), // Optional text to display in UI instead of actual message text
    attachments: z.array(MessageAttachmentSchema).optional() // Files uploaded alongside this user message
});

export type MessageMeta = z.infer<typeof MessageMetaSchema>;
