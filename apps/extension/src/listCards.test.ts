import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { orderedCardLinks } from './listCards';

const visible = (element: Element) => !element.closest('[hidden],[aria-hidden="true"]');
const card = (id: string) => `<section class="note-item" data-id="${id}"><a class="cover" href="/explore/${id}">封面</a><a class="title" href="/explore/${id}">${id}</a></section>`;
const ids = (document: Document) => orderedCardLinks(document, visible).map(link => link.closest('section')!.getAttribute('data-id'));
function place(document: Document, id: string, top: number, left: number) {
  document.querySelector<HTMLElement>(`section[data-id="${id}"]`)!.getBoundingClientRect = () => ({ top, left } as DOMRect);
}
describe('visual feed order', () => {
  it('orders shuffled/column-major DOM top-down, left-right, once per card', () => {
    const document = new JSDOM(['d', 'b', 'c', 'a'].map(card).join('')).window.document;
    place(document, 'a', 100, 0); place(document, 'b', 100, 300); place(document, 'c', 500, 0); place(document, 'd', 550, 300);
    expect(ids(document)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('keeps a row left-to-right despite sub-pixel top differences', () => {
    const document = new JSDOM(['c', 'b', 'a'].map(card).join('')).window.document;
    place(document, 'a', 100.5, 0); place(document, 'b', 100, 300); place(document, 'c', 450, 0);
    expect(ids(document)).toEqual(['a', 'b', 'c']);
  });
  it('retains the first card and every loaded card beyond sixty', () => {
    const document = new JSDOM(Array.from({ length: 80 }, (_, index) => card(String(index))).join('')).window.document;
    expect(ids(document)).toEqual(Array.from({ length: 80 }, (_, index) => String(index)));
  });
  it('does not collect cards from a detail, comments, recommendations or hidden nodes', () => {
    const document = new JSDOM(`${card('a')}<div class="note-container">${card('b')}</div><div class="comments-container">${card('c')}</div><div data-recommendation>${card('d')}</div><div hidden>${card('e')}</div><a href="/explore/f">非卡片</a>`).window.document;
    expect(ids(document)).toEqual(['a']);
  });
  it('keeps document order when geometry is identical and does not scroll or click', () => {
    const document = new JSDOM(['b', 'a', 'c'].map(card).join('')).window.document;
    document.querySelectorAll<HTMLAnchorElement>('a').forEach(link => { link.onclick = () => { throw new Error('No clicks allowed'); }; });
    expect(ids(document)).toEqual(['b', 'a', 'c']);
  });
});
