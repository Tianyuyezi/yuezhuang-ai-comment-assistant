import { describe, expect, it } from 'vitest';
import { resolutionEvidence, targetIntentIsUsable, textIsComplete } from './noteSafety';

describe('real-note safety gates', () => {
  it('skips resolved requests found in author updates or comments', () => {
    expect(resolutionEvidence(['已经找到老师了！大家有需要可以在评论区找！'])).toContain('已经找到老师');
    expect(resolutionEvidence(['还没找到老师，继续蹲'])).toBeNull();
  });
  it('accepts concise verified text but rejects image-dependent or unverified content', () => {
    expect(textIsComplete('找妆娘', '生日想找上海化妆师，喜欢日杂感妆，想咨询日期和风格。', true)).toBe(true);
    expect(textIsComplete('上海求租', '主卧合租可以', true)).toBe(true);
    expect(textIsComplete('找妆娘', '生日妆要求如图，想咨询具体价格和档期。', true)).toBe(false);
    expect(textIsComplete('上海找房', '想找合租，具体对房子的要求图片上有，近地铁，室友不抽烟，生活规律。', true)).toBe(false);
    expect(textIsComplete('找妆娘', '生日想找上海化妆师，喜欢日杂感妆，想咨询日期和风格。', false)).toBe(false);
  });
  it('rejects the currently misconfigured target intent', () => {
    expect(targetIntentIsUsable('我在，你好')).toBe(false);
    expect(targetIntentIsUsable('寻找长租房源')).toBe(true);
    expect(targetIntentIsUsable('作者正在寻找上海化妆师提供日常妆或新娘妆服务')).toBe(true);
  });
});
