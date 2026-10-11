import { describe, expect, it } from 'vitest';
import { modelConfigUpdateSchema, modelResponsesUrl, normalizeModelAddress, publicModelConfigSchema } from './modelSettings.js';

describe('Responses configuration contract', () => {
  it.each([
    ['https://api.example.test', 'https://api.example.test/v1/responses'],
    ['https://api.example.test/', 'https://api.example.test/v1/responses'],
    ['https://api.example.test/v1', 'https://api.example.test/v1/responses'],
    ['https://api.example.test/v1/', 'https://api.example.test/v1/responses'],
    ['https://api.example.test/v1/responses', 'https://api.example.test/v1/responses'],
    ['https://api.example.test/prefix/v1/', 'https://api.example.test/prefix/v1/responses'],
    ['https://api.example.test/prefix/responses/', 'https://api.example.test/prefix/responses'],
    ['https://api.example.test/proxy', 'https://api.example.test/proxy/responses'],
  ])('normalizes %s without dropping the prefix', (base, endpoint) => expect(modelResponsesUrl(base)).toBe(endpoint));
  it.each(['http://api.example.test', 'not-a-url', 'https://api.example.test?q=test', 'https://api.example.test#test', 'https://api.example.test/with space', 'https://api.example.test\\v1'])('rejects unsafe addresses: %s', value => expect(() => normalizeModelAddress(value)).toThrow());
  it('rejects embedded credentials without exposing them', () => {
    const url = 'https://' + ['user', 'test-only'].join(':') + '@api.example.test';
    expect(() => normalizeModelAddress(url)).toThrow('invalid_model_address');
  });
  it('requires a revision and rejects unknown fields or header injection', () => {
    const base = { revision: 0, mode: 'real', baseUrl: 'https://api.example.test', modelId: 'gateway-model' };
    expect(modelConfigUpdateSchema.parse({ ...base, apiKey: ' test-only ' }).apiKey).toBe('test-only');
    for (const fields of [{ apiKey: 'test\nkey' }, { pairingToken: 'test-only' }, { revision: undefined }, { modelId: 'model\nname' }]) expect(modelConfigUpdateSchema.safeParse({ ...base, ...fields }).success).toBe(false);
  });
  it('rejects a public config that accidentally includes a credential', () => {
    const config = { revision: 0, mode: 'real', baseUrl: 'https://api.example.test', modelId: 'gateway-model', apiKeyConfigured: true, protocol: 'responses', persistent: true };
    expect(publicModelConfigSchema.safeParse(config).success).toBe(true);
    expect(publicModelConfigSchema.safeParse({ ...config, apiKey: 'test-only' }).success).toBe(false);
  });
});
