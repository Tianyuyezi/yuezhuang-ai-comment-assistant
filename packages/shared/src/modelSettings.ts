import { z } from 'zod';

export const modelConfigUpdateSchema = z.object({
  revision: z.number().int().nonnegative(), mode: z.enum(['mock', 'real']),
  baseUrl: z.string().trim().max(2048), modelId: z.string().trim().min(1).max(200).regex(/^[^\s]+$/),
  apiKey: z.string().trim().max(4096).regex(/^[^\s]*$/).optional(), clearApiKey: z.boolean().optional()
}).strict();
export type ModelConfigUpdate = z.infer<typeof modelConfigUpdateSchema>;

export const publicModelConfigSchema = z.object({
  revision: z.number().int().nonnegative(), mode: z.enum(['mock', 'real']),
  baseUrl: z.string().max(2048), modelId: z.string().min(1).max(200),
  apiKeyConfigured: z.boolean(), protocol: z.literal('responses'), persistent: z.boolean()
}).strict();
export type PublicModelConfig = z.infer<typeof publicModelConfigSchema>;

export function normalizeModelAddress(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new Error('invalid_model_address'); }
  if (url.protocol !== 'https:') throw new Error('real_upstream_requires_https');
  if (url.username || url.password || url.search || url.hash || /[\s\\]/.test(trimmed)) throw new Error('invalid_model_address');
  return url.href.replace(/\/+$/, '');
}

export function modelResponsesUrl(value: string): string {
  const url = new URL(normalizeModelAddress(value));
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = !path ? '/v1/responses' : path.endsWith('/responses') ? path : `${path}/responses`;
  return url.href;
}
