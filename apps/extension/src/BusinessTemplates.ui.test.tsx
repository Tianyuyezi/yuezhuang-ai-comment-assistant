// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { campaignFromBusinessTemplate, createBusinessTemplate, type BusinessTemplate } from '@yuezhuang/shared';
import { BusinessTemplates } from './BusinessTemplates';

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function ready() {
  const value = createBusinessTemplate('makeup', 'artist');
  value.config.makeupProfile = { cities: ['上海'], serviceAreas: ['上海'], serviceTypes: ['日常妆'], deliveryMode: 'onsite', studioAddress: '', priceFrom: 359, priceTo: null, priceNotes: '路费另计', availability: '' };
  return value;
}
async function mount(template = ready()) {
  const onAction = vi.fn(async (_action: string, _id?: string, value?: BusinessTemplate) => value);
  await act(async () => root.render(<BusinessTemplates templates={[template]} active={campaignFromBusinessTemplate(template, 'active')} onAction={onAction} />));
  return onAction;
}
async function changeSelect(value: string) {
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>('#makeup-budget-filter')!;
    select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function changeNumber(id: string, value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>(`#${id}`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(label: string) {
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === label)!.click());
}

describe('makeup budget Select', () => {
  it('defaults legacy templates to ignore and saves customer bounds without changing the fee', async () => {
    const onAction = await mount();
    expect(host.querySelector<HTMLSelectElement>('#makeup-budget-filter')!.value).toBe('ignore');
    expect(host.querySelector('#makeup-budget-min')).toBeNull();
    await changeSelect('range'); await changeNumber('makeup-budget-min', '100'); await changeNumber('makeup-budget-max', '300');
    await click('保存并应用');
    const saved = onAction.mock.calls[0][2]!;
    expect(saved.config.makeupProfile).toMatchObject({ priceFrom: 359, priceNotes: '路费另计', budgetFilter: { mode: 'range', min: 100, max: 300 } });
    expect(saved.config.offering).toContain('359元起');
  });
  it('hides disabled fields while retaining the configured range for later re-enable', async () => {
    const value = ready(); value.config.makeupProfile!.budgetFilter = { mode: 'range', min: 0, max: 300 };
    const onAction = await mount(value);
    await changeSelect('ignore'); expect(host.querySelector('#makeup-budget-max')).toBeNull();
    await changeSelect('range');
    expect(host.querySelector<HTMLInputElement>('#makeup-budget-min')!.value).toBe('0');
    expect(host.querySelector<HTMLInputElement>('#makeup-budget-max')!.value).toBe('300');
    await changeNumber('makeup-budget-max', ''); await click('保存并应用');
    expect(onAction.mock.calls[0][2]!.config.makeupProfile!.budgetFilter).toEqual({ mode: 'range', min: 0, max: null });
  });
  it('explains and blocks activating an inverted interval', async () => {
    await mount(); await changeSelect('range'); await changeNumber('makeup-budget-min', '500'); await changeNumber('makeup-budget-max', '100');
    expect(host.textContent).toContain('客户预算筛选的最高金额不能低于最低金额');
    expect([...host.querySelectorAll('button')].find(button => button.textContent === '保存并激活')!.disabled).toBe(true);
  });
  it('does not add the makeup filter to rental templates', async () => {
    await mount(createBusinessTemplate('rental', 'rental'));
    expect(host.querySelector('#makeup-budget-filter')).toBeNull();
    expect(host.textContent).toContain('月租');
  });
});
