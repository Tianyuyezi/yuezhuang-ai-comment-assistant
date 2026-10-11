import { useEffect, useState } from 'react';
import { modelConfigUpdateSchema, modelResponsesUrl, normalizeModelAddress, type PublicModelConfig } from '@yuezhuang/shared';
import { modelSettingsError, type ModelSettingsClient } from './modelSettingsClient';

export function ModelSettings({ client, beforeSave, onSaved, disabled = false, gatewayUrl }: {
  client: ModelSettingsClient; beforeSave(): Promise<void>; onSaved(config: PublicModelConfig): void; disabled?: boolean; gatewayUrl: string;
}) {
  const [config, setConfig] = useState<PublicModelConfig | null>(null);
  const [mode, setMode] = useState<'mock' | 'real'>('mock');
  const [baseUrl, setBaseUrl] = useState('');
  const [modelId, setModelId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [working, setWorking] = useState<'read' | 'save' | 'probe' | null>(null);
  const [notice, setNotice] = useState('');
  const apply = (value: PublicModelConfig) => {
    setConfig(value); setMode(value.mode); setBaseUrl(value.baseUrl); setModelId(value.modelId); setApiKey(''); setClearApiKey(false);
  };
  useEffect(() => {
    let active = true;
    setConfig(null); setApiKey(''); setClearApiKey(false); setWorking('read'); setNotice('正在读取本机模型配置…');
    void client.read().then(value => { if (active) { apply(value); setNotice('已读取配置。留空 API 密钥会保留现有密钥。'); } })
      .catch(error => { if (active) setNotice(modelSettingsError(error)); }).finally(() => { if (active) setWorking(null); });
    return () => { active = false; };
  }, [client]);
  const dirty = Boolean(config && (mode !== config.mode || baseUrl.trim() !== config.baseUrl || modelId.trim() !== config.modelId || apiKey || clearApiKey));
  let validation = '';
  let endpoint = '';
  try { if (baseUrl.trim()) { normalizeModelAddress(baseUrl); endpoint = modelResponsesUrl(baseUrl); } }
  catch (error) { validation = modelSettingsError(error); }
  if (!modelId.trim() && config) validation = '请填写模型名称。';
  if (mode === 'real' && config && (!baseUrl.trim() || !(apiKey.trim() || config.apiKeyConfigured && !clearApiKey))) validation = '真实模式需要请求地址和 API 密钥。';
  if (apiKey && /\s/.test(apiKey.trim())) validation = 'API 密钥不能包含空格或换行。';
  if (clearApiKey && apiKey) validation = '清除密钥和填写新密钥不能同时进行。';
  const blocked = disabled || working !== null;

  async function reload() {
    setWorking('read'); setNotice('正在重新读取配置…');
    try { apply(await client.read()); setNotice('已重新读取配置。'); }
    catch (error) { setConfig(null); setApiKey(''); setNotice(modelSettingsError(error)); }
    finally { setWorking(null); }
  }
  async function save() {
    if (!config || blocked || validation) return;
    const parsed = modelConfigUpdateSchema.safeParse({ revision: config.revision, mode, baseUrl, modelId, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(clearApiKey ? { clearApiKey: true } : {}) });
    if (!parsed.success) { setNotice('配置格式不正确，请检查各项输入。'); return; }
    setWorking('save'); setNotice('正在停止并等待自动任务结束，然后保存配置…');
    try {
      await beforeSave();
      const saved = await client.save(parsed.data);
      apply(saved); onSaved(saved);
      setNotice(saved.persistent ? '已保存到本机私有配置并立即生效。自动任务保持停止；建议先测试连接，再手动启动。' : '当前网关只支持内存保存，重启后不会保留配置。');
    } catch (error) { setApiKey(''); setNotice(modelSettingsError(error)); }
    finally { setWorking(null); }
  }
  async function probe() {
    if (blocked || dirty || !config) return;
    setWorking('probe'); setNotice('正在使用已保存的配置测试连接…');
    try {
      const result = await client.probe();
      setNotice(result.mode === 'mock' ? '当前为 Mock 模式：本机网关正常，但没有请求真实模型。' : `真实模型连接测试通过：${result.modelId}。本次仅发送固定测试文字，未读取帖子、未点赞、未关注、未评论。`);
    } catch (error) { setNotice(modelSettingsError(error)); }
    finally { setWorking(null); }
  }

  return <section className="card model-settings"><h2>模型请求配置</h2>
    <p className="muted">本机网关：{gatewayUrl}。接口协议：Responses。模型密钥只保存在后端，不回显、不存入扩展持久化存储。</p>
    <p role="status" aria-live="polite" className="warning">{notice}</p>
    <fieldset disabled={blocked || !config}>
      <label htmlFor="model-mode">运行模式</label><select id="model-mode" value={mode} onChange={event => setMode(event.target.value as 'real' | 'mock')}><option value="real">真实模型（Real）</option><option value="mock">模拟模型（Mock）</option></select>
      <label htmlFor="model-base-url">模型请求地址 / Base URL</label><input id="model-base-url" type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.example.test/v1" autoComplete="off" spellCheck={false} />
      <p className="muted">支持 HTTPS 域名、带 /v1 的地址或完整 /responses 地址；保留自定义路径前缀。换服务域名时请重新填写对应密钥。</p>
      {endpoint && <p className="muted model-endpoint">实际请求：{endpoint}</p>}
      <label htmlFor="model-id">模型名称</label><input id="model-id" value={modelId} onChange={event => setModelId(event.target.value)} autoComplete="off" spellCheck={false} placeholder="填写服务实际支持的模型名称" />
      <label htmlFor="model-api-key">API 密钥（{config?.apiKeyConfigured ? '已配置，留空保留' : '未配置'}）</label><input id="model-api-key" type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="new-password" spellCheck={false} maxLength={4096} placeholder={config?.apiKeyConfigured ? '不显示现有密钥；如需更换请填写' : '请输入模型服务密钥'} />
      <label htmlFor="model-clear-key"><input id="model-clear-key" type="checkbox" checked={clearApiKey} onChange={event => setClearApiKey(event.target.checked)} />清除已保存的模型密钥（只可在 Mock 模式保存）</label>
      {validation && <p role="alert" className="warning">{validation}</p>}
      <div className="row"><button disabled={!dirty || Boolean(validation)} onClick={() => void save()}>{working === 'save' ? '正在保存…' : '保存模型配置'}</button><button className="secondary" disabled={dirty} onClick={() => void probe()}>{working === 'probe' ? '正在测试…' : '测试已保存的连接'}</button></div>
    </fieldset>
    <div className="row"><button className="secondary" disabled={blocked} onClick={() => void reload()}>重新读取模型配置</button></div>
    <p className="muted">保存会停止自动任务，不会自动重新启动。连接测试可能消耗少量模型额度，只发送固定测试文字，不发送帖子内容。</p>
  </section>;
}
