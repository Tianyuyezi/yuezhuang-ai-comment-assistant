import { publicModelConfigSchema, type ModelConfigUpdate, type PublicModelConfig } from '@yuezhuang/shared';

export type ModelProbe = { ok: true; mode: 'mock' | 'real'; modelId: string };
export type ModelSettingsClient = {
  read(): Promise<PublicModelConfig>; save(value: ModelConfigUpdate): Promise<PublicModelConfig>; probe(): Promise<ModelProbe>;
};

const messages: Record<string, string> = {
  not_paired: '网关配对令牌不正确，请先在下方更新配对令牌，再重新读取配置。',
  invalid_origin: '请求来源未获允许，请在扩展设置页操作。',
  invalid_host: '只能通过本机网关配置模型。',
  invalid_model_config: '模型配置格式不正确，请检查地址、模型名称和密钥。',
  invalid_model_address: '请输入有效的 HTTPS 地址，不要包含账号密码、查询参数或片段。',
  real_upstream_requires_https: '模型服务必须使用 HTTPS，不能明文传输密钥。',
  real_mode_not_configured: '真实模式需要有效的请求地址和 API 密钥。',
  model_address_required: '保留密钥时不能清空请求地址。',
  invalid_key_update: '清除密钥和填写新密钥不能同时进行。',
  new_provider_requires_key: '已更换服务域名，请重新填写该服务的 API 密钥；不会自动转发原密钥。',
  model_config_conflict: '配置已在其他窗口更新，请重新读取后再修改。',
  model_config_busy: '网关正在保存配置，请稍后重新读取。',
  model_request_in_progress: '还有模型请求尚未结束，请稍后重试保存。',
  model_config_save_failed: '本机私有配置文件保存失败，原配置未改变。请检查目录写入权限。',
  upstream_timeout: '连接测试超时，请检查模型地址与网络。',
  upstream_network_error: '无法连接模型服务，请检查网络、地址和受信任证书。',
  upstream_invalid_response: '模型服务返回格式异常，请确认支持 Responses JSON 请求。',
  upstream_empty_output: '模型服务没有返回有效内容。',
  upstream_incomplete: '模型响应未完成。',
  upstream_refusal: '模型服务拒绝了连接测试请求。',
  upstream_probe_failed: '模型未返回预期的测试结果。',
};

export function modelSettingsError(value: unknown): string {
  const code = value instanceof Error ? value.message : '';
  if (Object.hasOwn(messages, code)) return messages[code];
  if (code === 'gateway_http_404') return '本机网关版本较旧，请重启新版网关后重新读取配置。';
  if (/^upstream_http_\d{3}$/.test(code)) return `模型服务返回 HTTP ${code.slice(-3)}；请检查密钥、模型名称或服务状态。`;
  if (code === 'invalid_config_response') return '网关返回的配置格式不正确，请检查是否使用新版网关。';
  return '本机网关暂不可用或操作未完成，请检查网关后重试；敏感错误内容已隐藏。';
}

export function createModelSettingsClient(gatewayUrl: string, pairingToken: string, fetcher: typeof fetch = fetch): ModelSettingsClient {
  const request = async (path: string, method: 'GET' | 'POST' | 'PATCH', body?: ModelConfigUpdate) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetcher(`${gatewayUrl}${path}`, {
        method, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(pairingToken && !/^sk-/i.test(pairingToken) ? { 'x-yuezhuang-pairing-token': pairingToken } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      const data = await response.json();
      if (!response.ok) {
        const code = typeof data?.error === 'string' && (Object.hasOwn(messages, data.error) || /^upstream_http_\d{3}$/.test(data.error)) ? data.error : `gateway_http_${response.status}`;
        throw new Error(code);
      }
      return data;
    } finally { clearTimeout(timer); }
  };
  const publicConfig = (value: unknown) => {
    const parsed = publicModelConfigSchema.safeParse(value);
    if (!parsed.success) throw new Error('invalid_config_response');
    return parsed.data;
  };
  return {
    read: async () => publicConfig(await request('/v1/provider/config', 'GET')),
    save: async value => publicConfig(await request('/v1/provider/config', 'PATCH', value)),
    probe: async () => {
      const data = await request('/v1/provider/probe', 'POST');
      if (data?.ok !== true || !['mock', 'real'].includes(data.mode) || typeof data.modelId !== 'string') throw new Error('invalid_config_response');
      return { ok: true, mode: data.mode, modelId: data.modelId };
    }
  };
}
