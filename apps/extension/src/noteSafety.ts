const resolvedPattern = /(?:已经|已)(?:找到|约到|租到|解决|定好)(?:老师|化妆师|妆娘|房子|房源|人|了|啦)?|(?:找到|约到|租到)(?:老师|化妆师|妆娘|房子|房源)了|(?:不用|不需要)(?:再)?(?:推荐|找|了)/;
const imageDependentPattern = /(?:如图|看图|图[一二三四五六七八九十\d]|[pP][1-9]|图片里|图片上|照片里|图中|见图|要求图片)/;

export function resolutionEvidence(texts: string[]): string | null {
  return texts.map(text => text.replace(/\s+/g, ' ').trim()).find(text => resolvedPattern.test(text))?.slice(0, 300) ?? null;
}

export function textIsComplete(title: string, body: string, hasVerifiedBodyContainer: boolean): boolean {
  return Boolean(title && hasVerifiedBodyContainer && body.length >= 4 && body.length < 10_000 &&
    !imageDependentPattern.test(`${title} ${body}`) && !/[.。…]{3,}$/.test(body));
}

export function targetIntentIsUsable(value: string): boolean {
  const text = value.trim();
  return text.length >= 6 && /找|求|需要|想|咨询|寻|租|约|征|推荐/.test(text) && !/^(?:我在|你好|您好|hello)[，,。!！\s]*/i.test(text);
}
