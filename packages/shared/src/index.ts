import { z } from 'zod';
export * from './modelSettings.js';

export const APP_MODE = ['mock', 'real'] as const;
export type AppMode = (typeof APP_MODE)[number];

export const commandSchema = z.object({
  schemaVersion: z.literal('1.0'),
  action: z.enum(['analyze_current', 'select_template', 'next_template', 'rewrite_draft', 'update_filters', 'explain_result', 'help', 'unsupported']),
  scope: z.literal('current_note'),
  stopAt: z.literal('draft'),
  parameters: z.object({
    keyword: z.string().nullable(), city: z.string().nullable(), serviceType: z.string().nullable(),
    mode: z.enum(['original', 'template', 'rewrite']).nullable(), categoryId: z.string().nullable(), rewriteInstruction: z.string().nullable()
  }),
  needsClarification: z.boolean(),
  userMessage: z.string().max(300)
});
export type Command = z.infer<typeof commandSchema>;

export const noteSchema = z.object({
  id: z.string().min(1), title: z.string().max(300), body: z.string().max(10000),
  source: z.enum(['fixture', 'manual', 'xhs']), capturedAt: z.string(), completeness: z.enum(['complete', 'partial', 'manual']),
  resolutionEvidence: z.string().max(300).nullable().optional(),
  authorName: z.string().max(200).nullable().optional(), publishedRaw: z.string().max(100).nullable().optional()
});
export type NoteSnapshot = z.infer<typeof noteSchema>;

export const rentalProfileSchema = z.object({
  city: z.string().min(1).max(40),
  metroStations: z.array(z.object({ line: z.number().int().min(1).max(30), station: z.string().min(1).max(40) })).min(1).max(10),
  monthlyRent: z.number().int().positive().max(100000),
  roomType: z.enum(['shared_master', 'shared_other', 'entire']),
  privateBathroom: z.boolean()
});
export type RentalProfile = z.infer<typeof rentalProfileSchema>;

export const businessTypeSchema = z.enum(['rental', 'makeup', 'custom']);
export type BusinessType = z.infer<typeof businessTypeSchema>;
export const makeupBudgetFilterSchema = z.object({
  mode: z.enum(['ignore', 'range']),
  min: z.number().min(0).max(100000).nullable(), max: z.number().min(0).max(100000).nullable()
});
export type MakeupBudgetFilter = z.infer<typeof makeupBudgetFilterSchema>;
export const makeupProfileSchema = z.object({
  cities: z.array(z.string().min(1).max(40)).min(1).max(20),
  serviceAreas: z.array(z.string().min(1).max(80)).max(30),
  serviceTypes: z.array(z.string().min(1).max(40)).min(1).max(20),
  deliveryMode: z.enum(['onsite', 'studio', 'both']), studioAddress: z.string().max(200),
  priceFrom: z.number().positive().max(100000).nullable(), priceTo: z.number().positive().max(100000).nullable(),
  priceNotes: z.string().max(300), availability: z.string().max(300),
  budgetFilter: makeupBudgetFilterSchema.optional()
});
export type MakeupProfile = z.infer<typeof makeupProfileSchema>;

export const campaignSchema = z.object({
  id: z.string().min(1), name: z.string().min(1).max(80), offering: z.string().min(1).max(500),
  targetIntent: z.string().min(1).max(500), cities: z.array(z.string().min(1)).max(20),
  demandKeywords: z.array(z.string().min(1)).min(1).max(30), exclusionKeywords: z.array(z.string().min(1)).max(30),
  accountLabel: z.string().min(1).max(80), confirmedAt: z.string().nullable(),
  rentalProfile: rentalProfileSchema.optional(), makeupProfile: makeupProfileSchema.optional(),
  businessType: businessTypeSchema.optional(), businessTemplateId: z.string().optional(),
  businessTemplateVersion: z.number().int().positive().optional(),
  judgmentInstructions: z.string().max(2000).optional(), commentStyle: z.string().max(500).optional(),
  defaultSearchKeywords: z.array(z.string().min(1).max(100)).max(20).optional()
});
export type Campaign = z.infer<typeof campaignSchema>;

export function isRentalCampaign(campaign: Campaign): boolean {
  if (campaign.businessType) return campaign.businessType === 'rental';
  return /租房|房源|合租|主卧|出租|求租/.test(`${campaign.name} ${campaign.offering} ${campaign.targetIntent}`);
}

export function campaignBusinessType(campaign: Campaign): BusinessType {
  if (campaign.businessType) return campaign.businessType;
  if (isRentalCampaign(campaign)) return 'rental';
  return /化妆|约妆|妆娘|美妆/.test(`${campaign.name} ${campaign.offering}`) ? 'makeup' : 'custom';
}

export function makeupBudgetFilter(campaign: Campaign): MakeupBudgetFilter {
  return campaign.makeupProfile?.budgetFilter ?? { mode: 'ignore', min: null, max: null };
}

export function makeupOfferingDescription(profile: MakeupProfile): string {
  const delivery = profile.deliveryMode === 'onsite' ? '上门化妆' : profile.deliveryMode === 'studio' ? '到店化妆' : '上门或到店化妆';
  const price = profile.priceFrom !== null ? (profile.priceTo !== null ? `${profile.priceFrom}–${profile.priceTo}元` : `${profile.priceFrom}元起`) : '';
  return [profile.cities.join('、'), delivery, `提供${profile.serviceTypes.join('、')}`, profile.serviceAreas.length ? `上门范围：${profile.serviceAreas.join('、')}` : '', profile.studioAddress ? `店址：${profile.studioAddress}` : '', price, profile.priceNotes, profile.availability ? `可接时间：${profile.availability}` : ''].filter(Boolean).join('，');
}

export function campaignConfigurationIssue(campaign: Campaign): string | null {
  if (campaignBusinessType(campaign) === 'rental') return rentalProfileIssue(campaign);
  if (campaign.businessType !== 'makeup') return null; // Preserve legacy generic campaigns.
  const profile = campaign.makeupProfile;
  if (!profile) return '请填写化妆服务的城市、妆容类型、服务方式和收费说明。';
  if (profile.deliveryMode !== 'studio' && !profile.serviceAreas.length) return '请填写可上门的服务区域。';
  if (profile.deliveryMode !== 'onsite' && !profile.studioAddress.trim()) return '请填写到店服务地址。';
  if (profile.priceFrom === null && !profile.priceNotes.trim()) return '请填写起价或具体报价方式。';
  if (profile.priceTo !== null && (profile.priceFrom === null || profile.priceTo < profile.priceFrom)) return '价格区间的上限不能低于起价。';
  const filter = makeupBudgetFilter(campaign);
  if (filter.mode === 'range' && filter.min !== null && filter.max !== null && filter.min > filter.max) return '客户预算筛选的最高金额不能低于最低金额。';
  if (campaign.offering !== makeupOfferingDescription(profile)) return '服务描述与化妆师配置不一致，请重新保存。';
  return null;
}

export function rentalOfferingDescription(profile: RentalProfile): string {
  const room = profile.roomType === 'shared_master' ? '主卧合租' : profile.roomType === 'shared_other' ? '房间合租' : '整租';
  return `${profile.city}${room}，${profile.metroStations.map(item => `${item.line}号线${item.station}`).join('、')}，月租${profile.monthlyRent}元，${profile.privateBathroom ? '有独立卫生间' : '无独立卫生间'}`;
}

export function rentalProfileIssue(campaign: Campaign): string | null {
  if (!isRentalCampaign(campaign)) return null;
  if (!campaign.rentalProfile) return '租房业务请先填写房源地铁站、月租、房型和独卫情况。';
  if (campaign.offering !== rentalOfferingDescription(campaign.rentalProfile)) return '房源描述与结构化资料不一致，请重新确认。';
  return null;
}

const rentalDraftSchema = rentalProfileSchema.extend({
  city: z.string().max(40), monthlyRent: z.number().min(0).max(100000),
  metroStations: z.array(z.object({ line: z.number().int().min(0).max(30), station: z.string().max(40) })).max(10)
});
const makeupDraftSchema = makeupProfileSchema.extend({
  cities: z.array(z.string().min(1).max(40)).max(20), serviceTypes: z.array(z.string().min(1).max(40)).max(20),
  deliveryMode: z.enum(['unset', 'onsite', 'studio', 'both'])
});
export const businessTemplateSchema = z.object({
  id: z.string().min(1), name: z.string().min(1).max(80), businessType: businessTypeSchema,
  version: z.number().int().positive(), createdAt: z.string(), updatedAt: z.string(), archivedAt: z.string().nullable(),
  defaultSearchKeywords: z.array(z.string().min(1).max(100)).max(20),
  judgmentInstructions: z.string().max(2000), commentStyle: z.string().max(500),
  config: z.object({
    offering: z.string().max(500), targetIntent: z.string().max(500),
    cities: z.array(z.string().min(1)).max(20), demandKeywords: z.array(z.string().min(1)).max(30),
    exclusionKeywords: z.array(z.string().min(1)).max(30), accountLabel: z.string().max(80),
    rentalProfile: rentalDraftSchema.optional(), makeupProfile: makeupDraftSchema.optional()
  })
});
export type BusinessTemplate = z.infer<typeof businessTemplateSchema>;

export const businessTypeLabel = (type: BusinessType) => type === 'rental' ? '租房' : type === 'makeup' ? '美妆 · 化妆师约客户' : '其他业务';

export function createBusinessTemplate(type: BusinessType, id: string, now = new Date().toISOString()): BusinessTemplate {
  const rentalProfile: RentalProfile = { city: '上海', metroStations: [{ line: 15, station: '丰翔路' }, { line: 7, station: '上大路' }], monthlyRent: 1900, roomType: 'shared_master', privateBathroom: false };
  return businessTemplateSchema.parse({
    id, name: type === 'rental' ? '上海主卧合租' : type === 'makeup' ? '化妆师约客户' : '新业务', businessType: type,
    version: 1, createdAt: now, updatedAt: now, archivedAt: null,
    defaultSearchKeywords: type === 'rental' ? ['上海求租'] : type === 'makeup' ? ['约妆', '找化妆师'] : [],
    judgmentInstructions: type === 'rental'
      ? '寻找正在求租的租客。只剔除与房源明确冲突的硬条件；未提到预算、线路、独卫不算冲突。找室友的帖子需确认作者在求租，而不是招租。'
      : type === 'makeup' ? '寻找正在预约化妆服务的客户。教程、产品推荐、妆容分享、同行接单不算客户需求。按城市、服务区域、妆容和明确日期剔除硬性冲突；未提出的条件不算冲突。金额只按“客户预算筛选”选项处理；评论按配置的真实收费报价，不迁就客户预算降价。' : '',
    commentStyle: '一句简短自然的回复，陈述与需求相关的真实服务信息，不夸大。',
    config: {
      offering: type === 'rental' ? rentalOfferingDescription(rentalProfile) : '',
      targetIntent: type === 'rental' ? '上海正在求租合租房间的租客' : type === 'makeup' ? '正在找化妆师、预约日常妆、活动妆或其他化妆服务的客户' : '',
      cities: type === 'rental' ? ['上海'] : [], demandKeywords: type === 'rental' ? ['求租', '找房'] : type === 'makeup' ? ['约妆', '找化妆师', '妆娘'] : [],
      exclusionKeywords: ['已找到', '不用推荐'], accountLabel: '本地账号',
      ...(type === 'rental' ? { rentalProfile } : type === 'makeup' ? { makeupProfile: { cities: [], serviceAreas: [], serviceTypes: [], deliveryMode: 'unset', studioAddress: '', priceFrom: null, priceTo: null, priceNotes: '', availability: '', budgetFilter: { mode: 'ignore', min: null, max: null } } } : {})
    }
  });
}

export function businessTemplateFromCampaign(campaign: Campaign, now = new Date().toISOString()): BusinessTemplate {
  const type = campaignBusinessType(campaign);
  const preset = createBusinessTemplate(type, campaign.businessTemplateId ?? `legacy-${campaign.id}`, now);
  return { ...preset, name: campaign.name, version: campaign.businessTemplateVersion ?? 1,
    defaultSearchKeywords: campaign.defaultSearchKeywords ?? [], judgmentInstructions: campaign.judgmentInstructions ?? preset.judgmentInstructions,
    commentStyle: campaign.commentStyle ?? preset.commentStyle,
    config: { offering: campaign.offering, targetIntent: campaign.targetIntent, cities: campaign.cities,
      demandKeywords: campaign.demandKeywords, exclusionKeywords: campaign.exclusionKeywords, accountLabel: campaign.accountLabel,
      ...(campaign.rentalProfile ? { rentalProfile: campaign.rentalProfile } : {}),
      ...(campaign.makeupProfile ? { makeupProfile: campaign.makeupProfile } : type === 'makeup' ? { makeupProfile: preset.config.makeupProfile } : {}) }
  };
}

export function campaignFromBusinessTemplate(template: BusinessTemplate, id: string, now = new Date().toISOString()): Campaign {
  if (template.archivedAt) throw new Error('已归档的业务模板不能激活。');
  const config = { ...template.config };
  if (template.businessType === 'rental') {
    const parsed = rentalProfileSchema.safeParse(config.rentalProfile);
    if (!parsed.success) throw new Error('请补齐房源城市、地铁站和月租。');
    config.rentalProfile = parsed.data;
    config.makeupProfile = undefined;
    config.cities = [parsed.data.city];
    config.offering = rentalOfferingDescription(parsed.data);
  } else if (template.businessType === 'makeup') {
    const parsed = makeupProfileSchema.safeParse(config.makeupProfile);
    if (!parsed.success) throw new Error('请填写服务城市、妆容类型，并选择上门或到店服务。');
    config.makeupProfile = parsed.data;
    config.rentalProfile = undefined;
    config.cities = parsed.data.cities;
    config.offering = makeupOfferingDescription(parsed.data);
  }
  const parsed = campaignSchema.safeParse({ ...config, id, name: template.name, confirmedAt: now,
    businessType: template.businessType, businessTemplateId: template.id, businessTemplateVersion: template.version,
    judgmentInstructions: template.judgmentInstructions, commentStyle: template.commentStyle, defaultSearchKeywords: template.defaultSearchKeywords });
  if (!parsed.success) throw new Error('请填写服务内容、目标需求、需求词和账号标签。');
  if (parsed.data.targetIntent.trim().length < 6 || !/找|求|需要|想|咨询|寻|租|约|征|推荐/.test(parsed.data.targetIntent)) throw new Error('目标需求应说明客户在寻找或预约什么。');
  const issue = campaignConfigurationIssue(parsed.data);
  if (issue) throw new Error(issue);
  return parsed.data;
}

export function businessTemplateIssue(template: BusinessTemplate): string | null {
  try { campaignFromBusinessTemplate(template, 'validation-only'); return null; }
  catch (error) { return error instanceof Error ? error.message : '业务配置不完整。'; }
}

export const searchTaskSchema = z.object({
  id: z.string().min(1), campaignId: z.string().min(1), keyword: z.string().max(100),
  // Missing source is a legacy keyword task; home tasks deliberately have no keyword.
  source: z.enum(['search', 'home']).optional(),
  createdAt: z.string(), sourceUrl: z.string().url(), status: z.enum(['opened', 'collected']),
  campaignName: z.string().optional(), businessTemplateId: z.string().optional(), businessTemplateVersion: z.number().int().positive().optional()
}).superRefine((task, context) => {
  if (task.source === 'home' ? task.keyword !== '' : !task.keyword.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['keyword'], message: task.source === 'home' ? '首页任务不使用关键词' : '搜索任务需要关键词' });
  }
});
export type SearchTask = z.infer<typeof searchTaskSchema>;

export const clientBudgetSchema = z.object({
  min: z.number().min(0).max(100000).nullable(), max: z.number().min(0).max(100000).nullable(),
  evidence: z.string().min(1).max(200)
});
export const serviceDateSchema = z.object({
  lastAcceptableDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), evidence: z.string().min(1).max(200)
});
export const engagementPolicySchema = z.object({ canLike: z.boolean(), canFollow: z.boolean(), canComment: z.boolean(), reason: z.string().max(300) });
export const assessmentSchema = z.object({
  intent: z.enum(['demand', 'supply', 'discussion', 'unknown']),
  decision: z.enum(['eligible_for_review', 'hard_skip', 'manual_review']),
  serviceFit: z.enum(['compatible', 'incompatible', 'uncertain']).default('uncertain'),
  evidence: z.array(z.string().min(1).max(200)).max(3), reason: z.string().max(300),
  clientBudget: clientBudgetSchema.nullable().optional(),
  topicFit: z.enum(['relevant', 'irrelevant', 'uncertain']).optional(),
  serviceDate: serviceDateSchema.nullable().optional(), engagementPolicy: engagementPolicySchema.optional()
});
export type Assessment = z.infer<typeof assessmentSchema>;

// The model extracts the budget meaning (e.g. 两张=200); code applies the selected numeric interval.
// Unknown or unsupported observations never become a fabricated monetary exclusion.
export function makeupBudgetOutsideRange(campaign: Campaign, note: NoteSnapshot, budget: Assessment['clientBudget']): boolean {
  if (campaignBusinessType(campaign) !== 'makeup') return false;
  const filter = makeupBudgetFilter(campaign);
  if (filter.mode !== 'range' || !budget || (budget.min === null && budget.max === null) ||
      !`${note.title} ${note.body}`.includes(budget.evidence) ||
      (budget.min !== null && budget.max !== null && budget.min > budget.max)) return false;
  return (filter.min !== null && budget.max !== null && budget.max < filter.min) ||
    (filter.max !== null && budget.min !== null && budget.min > filter.max);
}

function metroLines(text: string): Set<string> {
  const lines = new Set<string>();
  for (const match of text.matchAll(/(\d{1,2})\s*号线/g)) lines.add(String(Number(match[1])));
  for (const match of text.matchAll(/(\d{1,2})\s*[/、和及或跟&]\s*(\d{1,2})\s*号线/g)) {
    lines.add(String(Number(match[1])));
    lines.add(String(Number(match[2])));
  }
  return lines;
}

function clearRentalLineMismatch(campaign: Campaign, note: NoteSnapshot): boolean {
  if (!isRentalCampaign(campaign)) return false;
  const offered = campaign.rentalProfile ? new Set(campaign.rentalProfile.metroStations.map(item => String(item.line))) : metroLines(campaign.offering);
  if (!offered.size) return false;
  const text = `${note.title}。${note.body}`;
  if ([...metroLines(text)].some(line => offered.has(line)) || /其他线也|别的线也|线路不限|地铁不限/.test(text)) return false;
  return text.split(/[。！？；;\n]/).some(segment => {
    const requested = metroLines(segment);
    if (!requested.size || [...requested].some(line => offered.has(line))) return false;
    if (!/(?:只|仅|限定|必须|一定|非).{0,20}\d{1,2}(?:\s*[/、和及或跟&]\s*\d{1,2})?\s*号线|\d{1,2}(?:\s*[/、和及或跟&]\s*\d{1,2})?\s*号线.{0,12}(?:只|仅|限定|必须|不考虑其他)/.test(segment)) return false;
    // Work location, transfer tolerance, or explicitly flexible routes need semantic review.
    if (/不考虑|不要|避开|不想住|通勤|换乘|其他线也|别的线也|线路不限|地铁不限/.test(segment)) return false;
    return true;
  });
}

function clearRentalHousingMismatch(campaign: Campaign, note: NoteSnapshot): boolean {
  if (!isRentalCampaign(campaign) || !/合租|主卧|次卧|室友/.test(campaign.offering)) return false;
  // Hashtags such as #过上整租生活 are not room-type requirements.
  const request = `${note.title} ${note.body}`.replace(/#[^\s#]+/g, ' ');
  if (/不合租|不想合租|不(?:接受|考虑|要).{0,4}合租|拒绝合租/.test(request)) return true;
  if (/只(?:要|考虑)?整租|必须整租|独门独户|独居/.test(request)) return true;
  if (/(?:想找|找|求|想租|可接受|接受|可以|考虑).{0,8}合租|合租.{0,8}(?:可以|接受|考虑|没问题|也行|也可|都行|都可|均可)/.test(request)) return false;
  if (/(?:整租|一居室|一室一厅).{0,12}(?:或|或者|也|均|都).{0,6}合租|合租.{0,12}(?:或|或者|也|均|都).{0,6}(?:整租|一居室|一室一厅)/.test(request)) return false;
  if (/不想整租|不考虑整租|整租不考虑/.test(request)) return false;
  // A preference for an entire apartment is not an explicit shared-room veto.
  return /(?:只要|仅|必须|一定要|只考虑).{0,8}(?:一居室|一室一厅|整租)|(?:一居室|一室一厅|整租).{0,8}(?:才行|不考虑其他|必须)/.test(request);
}

function rentalBudgetUnverifiable(campaign: Campaign, note: NoteSnapshot): boolean {
  if (campaign.rentalProfile) return false;
  if (!isRentalCampaign(campaign)) return false;
  const request = `${note.title} ${note.body}`;
  const money = String.raw`(?:\d{3,5}|\d(?:\.\d)?[kK])`;
  const hasBudget = new RegExp(`(?:预算|房租|租金|月租|每月).{0,12}${money}|${money}.{0,8}(?:预算|以内|以下|左右|每月)`).test(request);
  return hasBudget && !rentalOfferingHasPrice(campaign);
}

export function rentalOfferingHasPrice(campaign: Campaign): boolean {
  if (campaign.rentalProfile) return true;
  const money = String.raw`(?:\d{3,5}|\d(?:\.\d)?[kK])`;
  return new RegExp(`(?:房租|月租|租金|价格|￥|¥)\\s*[:：]?\\s*${money}|${money}\\s*(?:元|块|/月|每月)`).test(campaign.offering);
}

function hardRentalBudgetCeiling(note: NoteSnapshot): number | null {
  const text = `${note.title} ${note.body}`.replace(/#[^\s#]+/g, ' ');
  const money = '(\\d{3,5}|\\d(?:\\.\\d)?[kK])';
  const before = new RegExp(`(?:预算|不超过|不高于|最多|最高)\\s*(?:不超过|不高于|最多|最高|在)?\\s*${money}\\s*(?:元|块)?`, 'i');
  const after = new RegExp(`${money}\\s*(?:元|块)?\\s*(?:以内|以下|封顶|不超过|以下的预算)`, 'i');
  const match = text.match(before) ?? text.match(after);
  if (!match) return null;
  const trailing = text.slice((match.index ?? 0) + match[0].length);
  if (/^(?:\s*(?:左右|上下|起|以上|可谈|到|至|[-~～—]))/.test(trailing)) return null;
  const raw = match[1].toLowerCase();
  return raw.endsWith('k') ? Number(raw.slice(0, -1)) * 1000 : Number(raw);
}

function hardPrivateBathroomMismatch(campaign: Campaign, note: NoteSnapshot): boolean {
  if (!isRentalCampaign(campaign) || !campaign.rentalProfile || campaign.rentalProfile.privateBathroom) return false;
  const text = `${note.title} ${note.body}`.replace(/#[^\s#]+/g, ' ');
  if (/独卫.{0,6}(?:最好|优先|可有可无)/.test(text) || /(?:最好|优先).{0,8}(?:独卫|独立卫生间)/.test(text)) return false;
  return /(?:必须|只要|仅考虑|一定要|非要).{0,8}(?:独卫|独立卫生间)|(?:独卫|独立卫生间).{0,8}(?:必须|刚需|硬性)/.test(text);
}

export const searchCandidateSchema = z.object({
  id: z.string().min(1), taskId: z.string().min(1), noteId: z.string().min(1),
  url: z.string().url(), title: z.string().max(300), snippet: z.string().max(1000),
  status: z.enum(['new', 'needs_review', 'eligible', 'skipped', 'drafted', 'filled', 'published']),
  reason: z.string().max(500), capturedAt: z.string(), note: noteSchema.nullable(), draft: z.string().max(500),
  listOrder: z.number().int().nonnegative().optional(),
  promptVersion: z.string().nullable().default(null), assessment: assessmentSchema.nullable().default(null),
  likeStatus: z.enum(['none', 'pending', 'liked', 'already_liked', 'unknown', 'unavailable']).default('none'),
  likedAt: z.string().nullable().default(null),
  likeReason: z.string().max(500).optional(),
  authorId: z.string().nullable().default(null), authorName: z.string().default(''), authorUrl: z.string().url().nullable().default(null),
  followStatus: z.enum(['none', 'pending', 'followed', 'already_following', 'skipped', 'unavailable', 'unknown']).default('none'),
  followedAt: z.string().nullable().default(null), followReason: z.string().max(500).default('')
});
export type SearchCandidate = z.infer<typeof searchCandidateSchema>;

export const authorFollowSchema = z.object({
  id: z.string().min(1), accountLabel: z.string().min(1), authorId: z.string().regex(/^[a-f0-9]{24}$/i),
  authorName: z.string().max(200), authorUrl: z.string().url(), noteId: z.string().min(1),
  status: z.enum(['pending', 'followed', 'already_following', 'unknown', 'cancelled']),
  businessTemplateId: z.string().optional(), businessTemplateName: z.string().optional(), businessTemplateVersion: z.number().int().positive().optional(),
  createdAt: z.string(), updatedAt: z.string(), reason: z.string().max(500)
});
export type AuthorFollow = z.infer<typeof authorFollowSchema>;
export const authorFollowKey = (accountLabel: string, authorId: string) => JSON.stringify([accountLabel, authorId.toLowerCase()]);

export function gateAssessment(campaign: Campaign, note: NoteSnapshot, assessment: Assessment): Assessment {
  const content = `${note.title} ${note.body}`;
  if (!campaign.confirmedAt) return { ...assessment, decision: 'hard_skip', reason: '请先确认业务资料。' };
  const configurationIssue = (campaign.businessType || campaign.rentalProfile) && campaignConfigurationIssue(campaign);
  if (configurationIssue) return { ...assessment, decision: 'hard_skip', reason: configurationIssue };
  if (note.resolutionEvidence) return { ...assessment, decision: 'hard_skip', reason: `原帖或评论显示需求已解决：${note.resolutionEvidence}`.slice(0, 300) };
  if (campaign.exclusionKeywords.some(word => content.includes(word))) return { ...assessment, decision: 'hard_skip', reason: '命中业务排除词。' };
  if (assessment.topicFit === 'irrelevant') return { ...assessment, decision: 'hard_skip', serviceFit: 'incompatible', reason: '帖子与目标业务无关。' };
  if (clearRentalLineMismatch(campaign, note)) return { ...assessment, decision: 'hard_skip', serviceFit: 'incompatible', reason: '求租线路与已确认房源线路不符。' };
  if (clearRentalHousingMismatch(campaign, note)) return { ...assessment, decision: 'hard_skip', serviceFit: 'incompatible', reason: '求租房型与已确认的合租房源不符。' };
  if (isRentalCampaign(campaign) && campaign.rentalProfile && hardRentalBudgetCeiling(note) !== null && campaign.rentalProfile.monthlyRent > hardRentalBudgetCeiling(note)!) return { ...assessment, decision: 'hard_skip', serviceFit: 'incompatible', reason: '房源月租高于作者明确预算。' };
  if (hardPrivateBathroomMismatch(campaign, note)) return { ...assessment, decision: 'hard_skip', serviceFit: 'incompatible', reason: '作者明确要求独卫，但房源无独卫。' };
  if (assessment.serviceFit === 'incompatible') return { ...assessment, decision: 'hard_skip', reason: `服务与需求不匹配：${assessment.reason}`.slice(0, 300) };
  if (assessment.decision === 'hard_skip') return assessment;
  if (rentalBudgetUnverifiable(campaign, note)) return { ...assessment, decision: 'manual_review', serviceFit: 'uncertain', reason: '作者给出了租金预算，但业务资料未填写房租，无法核验是否匹配。' };
  if (note.completeness !== 'complete') return { ...assessment, decision: 'manual_review', reason: '笔记内容未完整确认，需要人工复核。' };
  if (assessment.serviceFit !== 'compatible') return { ...assessment, decision: 'manual_review', reason: `服务匹配尚未确认：${assessment.reason}`.slice(0, 300) };
  if (assessment.decision !== 'eligible_for_review') return assessment;
  if (assessment.intent !== 'demand') return { ...assessment, decision: 'manual_review', reason: '尚未确认是客户需求。' };
  if (!assessment.evidence.length || assessment.evidence.some(quote => !content.includes(quote))) return { ...assessment, decision: 'manual_review', evidence: [], reason: '模型证据缺失或无法在笔记中定位。' };
  if (campaign.cities.length && !campaign.cities.some(city => content.includes(city)) && !campaign.rentalProfile?.metroStations.some(item => content.includes(item.station))) return { ...assessment, decision: 'manual_review', reason: '未确认目标城市。' };
  if (makeupBudgetOutsideRange(campaign, note, assessment.clientBudget)) return { ...assessment, decision: 'hard_skip', serviceFit: 'incompatible', reason: '客户明确预算超出已配置的预算筛选区间；服务报价未改变。' };
  return assessment;
}

export const shanghaiDate = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
export const makeupAuthorNameBlocked = (name: string | null | undefined) => /妆/.test(name ?? '');

export function makeupDateIssue(note: NoteSnapshot, assessment: Assessment, today = shanghaiDate()): string | null {
  const date = assessment.serviceDate;
  if (!date) return null;
  const content = `${note.title} ${note.body}`;
  if (!content.includes(date.evidence)) return '约妆日期证据无法核验，不评论。';
  if (!date.lastAcceptableDate) return '约妆日期无法确定，不评论。';
  const parsed = new Date(`${date.lastAcceptableDate}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date.lastAcceptableDate) return '约妆日期无效，不评论。';
  return date.lastAcceptableDate < today ? `约妆日期 ${date.lastAcceptableDate} 已过期，只允许点赞、关注，不评论。` : null;
}

// Topic relevance can permit a like; it can never by itself authorize a follow or comment.
export function candidateEngagementPolicy(campaign: Campaign, note: NoteSnapshot, assessment: Assessment, today = shanghaiDate()): z.infer<typeof engagementPolicySchema> {
  const eligible = gateAssessment(campaign, note, assessment).decision === 'eligible_for_review';
  const base = { canLike: eligible, canFollow: eligible, canComment: eligible, reason: '' };
  if (campaignBusinessType(campaign) !== 'makeup') return base;
  const content = `${note.title} ${note.body}`;
  const blocked = !campaign.confirmedAt || Boolean(campaignConfigurationIssue(campaign)) || note.completeness !== 'complete' || note.resolutionEvidence ||
    campaign.exclusionKeywords.some(word => content.includes(word)) || !assessment.evidence.length || assessment.evidence.some(quote => !content.includes(quote)) ||
    (campaign.cities.length > 0 && !campaign.cities.some(city => content.includes(city)));
  if (blocked) return { canLike: false, canFollow: false, canComment: false, reason: '内容、证据、城市或业务状态未通过安全检查。' };
  if (makeupAuthorNameBlocked(note.authorName) || assessment.intent === 'supply') {
    return { canLike: eligible || assessment.topicFit === 'relevant', canFollow: false, canComment: false, reason: '作者名含“妆”或模型识别为服务供给方：只允许相关帖点赞，不关注、不评论。' };
  }
  if (note.source === 'xhs' && !note.authorName?.trim()) return { ...base, canFollow: false, canComment: false, reason: '原帖作者名称无法核验，只允许匹配帖点赞。请刷新小红书页面加载新版脚本。' };
  const dateIssue = makeupDateIssue(note, assessment, today);
  return dateIssue ? { ...base, canComment: false, reason: dateIssue } : base;
}

export const templateSchema = z.object({
  id: z.string(), name: z.string().min(1), category: z.string(), body: z.string().min(1),
  cities: z.array(z.string()), serviceTypes: z.array(z.string()), enabled: z.boolean(),
  approvalStatus: z.enum(['draft', 'approved']), version: z.number().int().positive(),
  allowedModes: z.array(z.enum(['original', 'template', 'rewrite'])), selectionCount: z.number().int().nonnegative(),
  markedPublishedCount: z.number().int().nonnegative(),
  requireMissingFields: z.array(z.string()).default([]), requireKnownFields: z.array(z.string()).default([]),
  variables: z.array(z.enum(['brand_name', 'service_date'])).default([]), archivedAt: z.string().nullable().default(null),
  businessTemplateId: z.string().nullable().optional()
});
export type Template = z.infer<typeof templateSchema>;

export const businessProfileSchema = z.object({
  id: z.literal('default'), brandName: z.string().min(1).max(80), serviceCities: z.array(z.string()).min(1),
  serviceTypes: z.array(z.string()).min(1), version: z.number().int().positive(), confirmedAt: z.string().nullable()
});
export type BusinessProfile = z.infer<typeof businessProfileSchema>;

export const interactionStatus = z.enum(['generated', 'copied', 'filled', 'marked_published', 'unknown', 'skipped']);
export const interactionSchema = z.object({
  id: z.string(), noteId: z.string(), noteHash: z.string(), accountLabel: z.string().min(1),
  templateId: z.string().nullable(), templateVersion: z.number().int().nullable(), body: z.string(), status: interactionStatus,
  source: z.enum(['manual', 'fixture', 'xhs']), createdAt: z.string(), markedPublishedAt: z.string().nullable(),
  businessTemplateId: z.string().optional(), businessTemplateName: z.string().optional(), businessTemplateVersion: z.number().int().positive().optional(),
  publicationSenderId: z.string().regex(/^[a-f0-9]{24}$/i).optional(), publicationCommentId: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
  publicationCheckedAt: z.string().optional(), publicationReason: z.string().max(500).optional()
});
export type Interaction = z.infer<typeof interactionSchema>;

export function interactionBlocksFirstContact(interactions: Interaction[], noteId: string, accountLabel: string): boolean {
  return interactions.some(item => item.noteId === noteId && item.accountLabel === accountLabel && ['filled', 'marked_published', 'unknown'].includes(item.status));
}

export type TemplateMatchContext = {
  city: string | null; serviceType: string | null; knownFields: string[]; mode: 'original' | 'template' | 'rewrite';
};

export function eligibleTemplates(templates: Template[], context: TemplateMatchContext): Template[] {
  const known = new Set(context.knownFields);
  return templates.filter(template =>
    template.enabled && template.approvalStatus === 'approved' && template.archivedAt === null &&
    template.allowedModes.includes(context.mode) &&
    (!context.city || template.cities.includes(context.city)) &&
    (!context.serviceType || template.serviceTypes.includes(context.serviceType)) &&
    template.requireKnownFields.every(field => known.has(field)) &&
    template.requireMissingFields.every(field => !known.has(field)) &&
    (context.mode !== 'original' || template.variables.length === 0)
  );
}

export class CandidatePool {
  private remaining: Template[];
  constructor(candidates: Template[], random: () => number = Math.random) {
    this.remaining = [...candidates];
    for (let index = this.remaining.length - 1; index > 0; index -= 1) {
      const selected = Math.floor(random() * (index + 1));
      [this.remaining[index], this.remaining[selected]] = [this.remaining[selected], this.remaining[index]];
    }
  }
  next(): Template | null { return this.remaining.pop() ?? null; }
  get count(): number { return this.remaining.length; }
}

export function createMockCommand(instruction: string): Command {
  const text = instruction.trim();
  const rewrite = /微调|润色|自然一点/.test(text);
  const next = /换一条|下一条/.test(text);
  const unsupported = /连续评论|批量|自动发送|自动发布/.test(text);
  return {
    schemaVersion: '1.0', action: unsupported ? 'unsupported' : next ? 'next_template' : rewrite ? 'rewrite_draft' : /随机|话术|分析|判断/.test(text) ? 'analyze_current' : 'help',
    scope: 'current_note', stopAt: 'draft',
    parameters: { keyword: /上海约妆/.test(text) ? '上海约妆' : null, city: /上海/.test(text) ? '上海' : null, serviceType: /领证/.test(text) ? 'certificate' : null, mode: rewrite ? 'rewrite' : /变量/.test(text) ? 'template' : 'original', categoryId: /领证/.test(text) ? 'certificate' : null, rewriteInstruction: rewrite ? text : null },
    needsClarification: false,
    userMessage: unsupported ? '首版仅支持当前笔记的审核与拟稿，不支持批量或自动发布。' : '已解析为当前笔记的本地拟稿任务，等待你的审核。'
  };
}
