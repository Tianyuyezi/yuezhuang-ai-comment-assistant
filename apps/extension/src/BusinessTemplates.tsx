import { useEffect, useState } from 'react';
import { businessTemplateIssue, businessTypeLabel, createBusinessTemplate, makeupOfferingDescription, rentalOfferingDescription, type BusinessTemplate, type Campaign, type MakeupProfile } from '@yuezhuang/shared';

export type BusinessTemplateAction = 'BUSINESS_TEMPLATE_SAVE' | 'BUSINESS_TEMPLATE_ACTIVATE' | 'BUSINESS_TEMPLATE_DUPLICATE' | 'BUSINESS_TEMPLATE_ARCHIVE' | 'BUSINESS_TEMPLATE_RESTORE';
type Props = {
  templates: BusinessTemplate[]; active: Campaign;
  onAction: (action: BusinessTemplateAction, templateId?: string, template?: BusinessTemplate) => Promise<BusinessTemplate | undefined>;
};
const split = (value: string) => value.split(/[,，、\n]/).map(word => word.trim()).filter(Boolean);

function WordsInput({ value, onChange, placeholder }: { value: string[]; onChange: (value: string[]) => void; placeholder?: string }) {
  const [raw, setRaw] = useState(value.join('，'));
  const [focused, setFocused] = useState(false);
  const joined = value.join('，');
  useEffect(() => { if (!focused) setRaw(joined); }, [joined, focused]);
  return <input value={raw} placeholder={placeholder} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={event => { setRaw(event.target.value); onChange(split(event.target.value)); }} />;
}

export function BusinessTemplates({ templates, active, onAction }: Props) {
  const [draft, setDraft] = useState<BusinessTemplate | null>(null);
  const [dirty, setDirty] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!draft) { setDraft(templates.find(item => item.id === active.businessTemplateId) ?? templates.find(item => !item.archivedAt) ?? null); return; }
    if (!dirty) {
      const saved = templates.find(item => item.id === draft.id);
      if (saved && saved.version !== draft.version) setDraft(saved);
    }
  }, [templates, active.businessTemplateId, draft?.id, dirty]);

  const edit = (patch: Partial<BusinessTemplate>) => { setDraft(current => current ? { ...current, ...patch } : null); setDirty(true); setError(''); };
  const editConfig = (patch: Partial<BusinessTemplate['config']>) => { if (draft) edit({ config: { ...draft.config, ...patch } }); };
  const editRental = (patch: Partial<NonNullable<BusinessTemplate['config']['rentalProfile']>>) => {
    if (!draft) return;
    const profile = { ...(draft.config.rentalProfile ?? { city: '', metroStations: [], monthlyRent: 0, roomType: 'shared_master' as const, privateBathroom: false }), ...patch };
    editConfig({ rentalProfile: profile, cities: profile.city ? [profile.city] : [], offering: rentalOfferingDescription(profile) });
  };
  const editMakeup = (patch: Partial<NonNullable<BusinessTemplate['config']['makeupProfile']>>) => {
    if (!draft) return;
    const profile = { ...(draft.config.makeupProfile ?? { cities: [], serviceAreas: [], serviceTypes: [], deliveryMode: 'unset' as const, studioAddress: '', priceFrom: null, priceTo: null, priceNotes: '', availability: '' }), ...patch };
    editConfig({ makeupProfile: profile, cities: profile.cities, offering: profile.deliveryMode === 'unset' ? '' : makeupOfferingDescription(profile as MakeupProfile) });
  };
  const budgetFilter = draft?.config.makeupProfile?.budgetFilter ?? { mode: 'ignore' as const, min: null, max: null };
  async function action(type: BusinessTemplateAction, id: string) {
    setWorking(true); setError('');
    try {
      const result = await onAction(type, id);
      if (type === 'BUSINESS_TEMPLATE_DUPLICATE' && result) { setDraft(result); setDirty(false); }
    } catch (error) { setError(String(error).replace(/^Error: /, '')); }
    finally { setWorking(false); }
  }
  async function save(activate: boolean) {
    if (!draft) return;
    setWorking(true); setError('');
    try {
      const saved = await onAction('BUSINESS_TEMPLATE_SAVE', undefined, draft);
      if (!saved) return;
      setDraft(saved); setDirty(false);
      if (activate && active.businessTemplateId !== saved.id) await onAction('BUSINESS_TEMPLATE_ACTIVATE', saved.id);
    } catch (error) { setError(String(error).replace(/^Error: /, '')); }
    finally { setWorking(false); }
  }
  const select = (item: BusinessTemplate) => { setDraft(item); setDirty(false); setError(''); };
  const card = (item: BusinessTemplate) => {
    const issue = item.archivedAt ? null : businessTemplateIssue(item);
    const isActive = active.confirmedAt && active.businessTemplateId === item.id;
    return <article className={`card business-template ${isActive ? 'business-template-active' : ''}`} key={item.id}>
      <div className="business-heading"><strong>{item.name}</strong>{isActive && <span className="pill">已激活</span>}</div>
      <p className="muted">{businessTypeLabel(item.businessType)} · v{item.version}{item.archivedAt ? ' · 已归档' : issue ? ' · 待完善' : ' · 可激活'}</p>
      <p>{item.config.offering || '填写服务内容后即可激活。'}</p>
      {item.businessType === 'makeup' && <p className="muted">客户预算筛选：{item.config.makeupProfile?.budgetFilter?.mode === 'range'
        ? `${item.config.makeupProfile.budgetFilter.min ?? '不限'}–${item.config.makeupProfile.budgetFilter.max ?? '不限'} 元`
        : '不筛选'}；评论按真实服务报价，不按客户预算降价。</p>}
      <div className="row">
        <button className="secondary" disabled={working} onClick={() => select(item)}>编辑</button>
        <button className="secondary" disabled={working} onClick={() => void action('BUSINESS_TEMPLATE_DUPLICATE', item.id)}>复制</button>
        {item.archivedAt
          ? <button disabled={working} onClick={() => void action('BUSINESS_TEMPLATE_RESTORE', item.id)}>恢复</button>
          : <><button disabled={working || Boolean(isActive) || Boolean(issue)} title={issue ?? undefined} onClick={() => void action('BUSINESS_TEMPLATE_ACTIVATE', item.id)}>激活</button><button className="secondary" disabled={working} onClick={() => void action('BUSINESS_TEMPLATE_ARCHIVE', item.id)}>归档</button></>}
      </div>
      {issue && <p className="muted">{issue}</p>}
    </article>;
  };
  return <>
    <section className="card"><h2>业务模板</h2>
      <p>当前业务：{active.confirmedAt ? `${active.name} · v${active.businessTemplateVersion ?? 1}` : '尚未激活完整配置'}</p>
      <p className="muted">每次运行使用一套模板。切换或应用修改会停止原任务；历史记录保留。</p>
      <div className="row">
        <button className="secondary" disabled={working} onClick={() => { setDraft(createBusinessTemplate('rental', crypto.randomUUID())); setDirty(true); setError(''); }}>新增租房模板</button>
        <button className="secondary" disabled={working} onClick={() => { setDraft(createBusinessTemplate('makeup', crypto.randomUUID())); setDirty(true); setError(''); }}>新增化妆师模板</button>
      </div>
    </section>
    {templates.filter(item => !item.archivedAt).map(card)}
    {templates.some(item => item.archivedAt) && <details className="card"><summary>已归档模板（{templates.filter(item => item.archivedAt).length}）</summary>{templates.filter(item => item.archivedAt).map(card)}</details>}
    {error && <p role="alert" className="warning">{error}</p>}
    {draft && <section className="card business-editor">
      <h2>编辑：{draft.name}{dirty ? ' · 未保存' : ''}</h2>
      <p className="muted">{businessTypeLabel(draft.businessType)} · v{draft.version}</p>
      <fieldset key={draft.id} disabled={working || Boolean(draft.archivedAt)}>
        <label>模板名称</label><input maxLength={80} value={draft.name} onChange={event => edit({ name: event.target.value })} />
        {draft.businessType === 'rental' && <>
          <label>房源城市</label><input value={draft.config.rentalProfile?.city ?? ''} onChange={event => editRental({ city: event.target.value })} />
          <label>房型</label><select value={draft.config.rentalProfile?.roomType ?? 'shared_master'} onChange={event => editRental({ roomType: event.target.value as 'shared_master' | 'shared_other' | 'entire' })}><option value="shared_master">主卧合租</option><option value="shared_other">其他房间合租</option><option value="entire">整租</option></select>
          <label>月租（元）</label><input type="number" min={1} max={100000} value={draft.config.rentalProfile?.monthlyRent || ''} onChange={event => editRental({ monthlyRent: Number(event.target.value) })} />
          <label><input type="checkbox" checked={draft.config.rentalProfile?.privateBathroom ?? false} onChange={event => editRental({ privateBathroom: event.target.checked })} /> 有独立卫生间</label>
          <label>关联地铁站</label>
          {(draft.config.rentalProfile?.metroStations ?? []).map((station, index) => <div className="station-row" key={index}>
            <input type="number" min={1} max={30} aria-label={`第${index + 1}条地铁线`} value={station.line || ''} onChange={event => editRental({ metroStations: draft.config.rentalProfile!.metroStations.map((item, at) => at === index ? { ...item, line: Number(event.target.value) } : item) })} /><span>号线</span>
            <input aria-label={`第${index + 1}个站名`} value={station.station} onChange={event => editRental({ metroStations: draft.config.rentalProfile!.metroStations.map((item, at) => at === index ? { ...item, station: event.target.value } : item) })} />
            <button type="button" className="secondary" onClick={() => editRental({ metroStations: draft.config.rentalProfile!.metroStations.filter((_, at) => at !== index) })}>删除</button>
          </div>)}
          <button type="button" className="secondary" onClick={() => editRental({ metroStations: [...(draft.config.rentalProfile?.metroStations ?? []), { line: 0, station: '' }] })}>添加地铁站</button>
        </>}
        {draft.businessType === 'makeup' && <>
          <label>服务城市（逗号分隔）</label><WordsInput value={draft.config.makeupProfile?.cities ?? []} placeholder="例如：上海" onChange={cities => editMakeup({ cities })} />
          <label>可接妆容（逗号分隔）</label><WordsInput value={draft.config.makeupProfile?.serviceTypes ?? []} placeholder="例如：日常妆，领证妆，活动妆" onChange={serviceTypes => editMakeup({ serviceTypes })} />
          <label>服务方式</label><select value={draft.config.makeupProfile?.deliveryMode ?? 'unset'} onChange={event => editMakeup({ deliveryMode: event.target.value as 'unset' | 'onsite' | 'studio' | 'both' })}><option value="unset">请选择</option><option value="onsite">上门</option><option value="studio">到店</option><option value="both">上门和到店</option></select>
          {draft.config.makeupProfile?.deliveryMode !== 'studio' && <><label>可上门区域（逗号分隔）</label><WordsInput value={draft.config.makeupProfile?.serviceAreas ?? []} placeholder="例如：静安区，宝山区" onChange={serviceAreas => editMakeup({ serviceAreas })} /></>}
          {['studio', 'both'].includes(draft.config.makeupProfile?.deliveryMode ?? '') && <><label>到店地址</label><input value={draft.config.makeupProfile?.studioAddress ?? ''} onChange={event => editMakeup({ studioAddress: event.target.value })} /></>}
          <label>起价（元，可留空并填写报价方式）</label><input type="number" min={1} value={draft.config.makeupProfile?.priceFrom ?? ''} onChange={event => editMakeup({ priceFrom: event.target.value ? Number(event.target.value) : null })} />
          <label>价格上限（元，可留空）</label><input type="number" min={1} value={draft.config.makeupProfile?.priceTo ?? ''} onChange={event => editMakeup({ priceTo: event.target.value ? Number(event.target.value) : null })} />
          <label>收费说明</label><textarea maxLength={300} value={draft.config.makeupProfile?.priceNotes ?? ''} placeholder="例如不同妆容收费、上门费，或具体报价方式" onChange={event => editMakeup({ priceNotes: event.target.value })} />
          <label htmlFor="makeup-budget-filter">客户预算筛选</label>
          <select id="makeup-budget-filter" value={budgetFilter.mode} onChange={event => editMakeup({ budgetFilter: { ...budgetFilter, mode: event.target.value as 'ignore' | 'range' } })}>
            <option value="ignore">不按客户预算筛选</option><option value="range">按客户预算区间筛选</option>
          </select>
          {budgetFilter.mode === 'range' && <>
            <label htmlFor="makeup-budget-min">客户预算最低金额（元，留空不限）</label><input id="makeup-budget-min" type="number" min={0} max={100000} value={budgetFilter.min ?? ''} onChange={event => editMakeup({ budgetFilter: { ...budgetFilter, min: event.target.value === '' ? null : Number(event.target.value) } })} />
            <label htmlFor="makeup-budget-max">客户预算最高金额（元，留空不限）</label><input id="makeup-budget-max" type="number" min={0} max={100000} value={budgetFilter.max ?? ''} onChange={event => editMakeup({ budgetFilter: { ...budgetFilter, max: event.target.value === '' ? null : Number(event.target.value) } })} />
          </>}
          <p className="muted">筛选的是客户每人的明确预算，不是你的服务报价。未写预算不因金额剔除；预算区间有交集即可。关闭后不再比较预算与起价，但仍按上述真实收费报价，不降价或声称符合客户预算。旧版高级要求中的预算规则以本选项为准。</p>
          <label>可接时间（可留空）</label><textarea maxLength={300} value={draft.config.makeupProfile?.availability ?? ''} placeholder="填写实际可接日期或时间；留空时不会承诺档期" onChange={event => editMakeup({ availability: event.target.value })} />
        </>}
        <label>提供的服务</label><textarea readOnly={draft.businessType !== 'custom'} value={draft.config.offering} onChange={event => editConfig({ offering: event.target.value })} />
        {draft.businessType === 'custom' && <><label>目标城市</label><WordsInput value={draft.config.cities} onChange={cities => editConfig({ cities })} /></>}
        <label>目标客户需求</label><textarea maxLength={500} value={draft.config.targetIntent} onChange={event => editConfig({ targetIntent: event.target.value })} />
        <label>默认搜索词（逗号分隔）</label><WordsInput value={draft.defaultSearchKeywords} onChange={defaultSearchKeywords => edit({ defaultSearchKeywords })} />
        <label>评论风格</label><textarea maxLength={500} value={draft.commentStyle} onChange={event => edit({ commentStyle: event.target.value })} />
        <label>运营账号标签</label><input maxLength={80} value={draft.config.accountLabel} onChange={event => editConfig({ accountLabel: event.target.value })} />
        <details className="demand-filters"><summary>高级：需求判断与关键词</summary>
          <label>模型判断要求</label><textarea maxLength={2000} value={draft.judgmentInstructions} onChange={event => edit({ judgmentInstructions: event.target.value })} />
          <label>需求词（逗号分隔）</label><WordsInput value={draft.config.demandKeywords} onChange={demandKeywords => editConfig({ demandKeywords })} />
          <label>排除词（逗号分隔）</label><WordsInput value={draft.config.exclusionKeywords} onChange={exclusionKeywords => editConfig({ exclusionKeywords })} />
        </details>
      </fieldset>
      {businessTemplateIssue(draft) && !draft.archivedAt && <p className="muted">{businessTemplateIssue(draft)}</p>}
      {!draft.archivedAt && <div className="row"><button disabled={working} onClick={() => void save(false)}>{active.businessTemplateId === draft.id ? '保存并应用' : '保存模板'}</button><button className="secondary" disabled={working || Boolean(businessTemplateIssue(draft))} onClick={() => void save(true)}>保存并激活</button></div>}
      {working && <p role="status" className="muted">正在保存；应用配置时会等待当前操作结束。</p>}
    </section>}
  </>;
}
