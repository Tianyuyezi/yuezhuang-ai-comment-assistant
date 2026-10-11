import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { modelConfigUpdateSchema, normalizeModelAddress, type ModelConfigUpdate } from '@yuezhuang/shared';
export { modelConfigUpdateSchema, modelResponsesUrl, normalizeModelAddress } from '@yuezhuang/shared';

export type Env = Record<string, string | undefined>;
export type ModelConfig = { mode: 'real' | 'mock'; origin?: string; key?: string; model: string; pairingToken: string };

export function readConfig(env: Env): ModelConfig {
  const mode = env.APP_MODE === 'real' ? 'real' : 'mock';
  const origin = env.MODEL_API_ORIGIN?.trim();
  const key = env.MODEL_API_KEY?.trim();
  if (mode === 'real' && (!origin || !key)) throw new Error('real_mode_not_configured');
  if (origin) normalizeModelAddress(origin);
  return { mode, origin, key, model: env.MODEL_ID ?? 'gpt-5.6-luna', pairingToken: env.GATEWAY_PAIRING_TOKEN ?? '' };
}

const credential = z.string().trim().max(4096).regex(/^[^\s]*$/);
const storedSchema = modelConfigUpdateSchema.omit({ clearApiKey: true }).extend({ apiKey: credential }).strict();
export const defaultModelConfigPath = () => fileURLToPath(new URL('../data/model-config.json', import.meta.url));

export class ModelConfigStore {
  private revision = 0;
  private saving = false;
  private constructor(public config: ModelConfig, private path: string | null) {}

  static async open(env: Env, path: string | null): Promise<ModelConfigStore> {
    // A saved UI configuration overrides only model fields, never the pairing token.
    let saved: z.infer<typeof storedSchema> | undefined;
    if (path) {
      try { saved = storedSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('model_config_file_invalid'); }
    }
    let config: ModelConfig;
    try {
      config = readConfig(saved ? { ...env, APP_MODE: saved.mode, MODEL_API_ORIGIN: saved.baseUrl, MODEL_ID: saved.modelId, MODEL_API_KEY: saved.apiKey } : env);
    } catch { throw new Error('model_config_invalid'); }
    const store = new ModelConfigStore(config, path);
    store.revision = saved?.revision ?? 0;
    return store;
  }

  publicConfig() {
    return { revision: this.revision, mode: this.config.mode, baseUrl: this.config.origin ?? '', modelId: this.config.model,
      apiKeyConfigured: Boolean(this.config.key), protocol: 'responses' as const, persistent: Boolean(this.path) };
  }

  async update(value: ModelConfigUpdate) {
    if (this.saving) throw new Error('model_config_busy');
    if (value.revision !== this.revision) throw new Error('model_config_conflict');
    const baseUrl = normalizeModelAddress(value.baseUrl);
    if (value.clearApiKey && value.apiKey) throw new Error('invalid_key_update');
    const apiKey = value.clearApiKey ? '' : value.apiKey || this.config.key || '';
    if (this.config.key && baseUrl && !value.apiKey && !value.clearApiKey && (!this.config.origin || new URL(baseUrl).origin !== new URL(this.config.origin).origin)) {
      throw new Error('new_provider_requires_key');
    }
    if (!baseUrl && apiKey) throw new Error('model_address_required');
    const next = readConfig({ APP_MODE: value.mode, MODEL_API_ORIGIN: baseUrl, MODEL_ID: value.modelId, MODEL_API_KEY: apiKey, GATEWAY_PAIRING_TOKEN: this.config.pairingToken });
    this.saving = true;
    try {
      if (this.path) {
        const temp = `${this.path}.${randomUUID()}.tmp`;
        try {
          await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
          const handle = await open(temp, 'wx', 0o600);
          try { await handle.writeFile(JSON.stringify({ revision: this.revision + 1, mode: next.mode, baseUrl, modelId: next.model, apiKey }) + '\n'); await handle.sync(); }
          finally { await handle.close(); }
          await rename(temp, this.path);
        } catch {
          await unlink(temp).catch(() => undefined);
          throw new Error('model_config_save_failed');
        }
      }
      this.config = next;
      this.revision++;
      return this.publicConfig();
    } finally { this.saving = false; }
  }
}
