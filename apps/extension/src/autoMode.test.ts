import { describe, expect, it } from 'vitest';
import { searchCandidateSchema, type Assessment, type Interaction, type NoteSnapshot, type SearchCandidate } from '@yuezhuang/shared';
import { AUTO_MODE_BATCH_SIZE, AUTO_MODE_DELAY_MS, FAST_MODE_DELAY_MS, FAST_MODE_EMPTY_DELAY_MS, MAX_COMMENT_DELAY_MS, MIN_COMMENT_DELAY_MS, autoCandidateStatus, commentRecordSkipReason, recoverableCommentStop, nextCommentDelayMs, nextModeDelayMs, recheckableAfterPromptUpdate, retryableAfterCommentCoverageFix } from './autoMode';

const note: NoteSnapshot = { id: 'xhs:1', title: '上海求化妆', body: '下周要参加活动', source: 'xhs', capturedAt: '2026-09-27', completeness: 'partial' };
const assessment: Assessment = { intent: 'demand', decision: 'eligible_for_review', serviceFit: 'compatible', evidence: ['求化妆'], reason: '需求帖' };

describe('Auto queue gate', () => {
  const record: Interaction = { id: 'i', noteId: 'xhs:1', noteHash: '', accountLabel: '我', templateId: null, templateVersion: null, body: '求看', status: 'marked_published', source: 'xhs', createdAt: '2026-10-06', markedPublishedAt: '2026-10-06' };
  it('deduplicates per note and operating account, never by the comment text alone', () => {
    expect(commentRecordSkipReason([record], 'xhs:1', '我')).toContain('已评论过');
    expect(commentRecordSkipReason([record], 'xhs:2', '我')).toBeNull();
    expect(commentRecordSkipReason([record], 'xhs:1', '另一账号')).toBeNull();
    for (const status of ['generated', 'copied', 'skipped'] as const) expect(commentRecordSkipReason([{ ...record, status }], 'xhs:1', '我')).toBeNull();
  });
  it('preserves an unknown lock or a filled-but-unsent record without claiming it was published', () => {
    expect(commentRecordSkipReason([{ ...record, status: 'unknown' }], 'xhs:1', '我')).toContain('结果不明');
    expect(commentRecordSkipReason([{ ...record, status: 'filled' }], 'xhs:1', '我')).toContain('不等于已发布');
  });
  it('converts only legacy send-timeout reviews, never platform/identity/follow errors or unlocked posts', () => {
    const review = searchCandidateSchema.parse({ id: '1', taskId: 't', noteId: 'xhs:1', url: 'https://www.xiaohongshu.com/explore/1', title: '求约妆', snippet: '', capturedAt: '2026-10-06', status: 'needs_review', reason: '自动评论已停止：send_clicked_but_publication_unverified', draft: '', note: null });
    expect(recoverableCommentStop(review, [record], '我')).toBe(true);
    expect(recoverableCommentStop(review, [], '我')).toBe(false);
    expect(recoverableCommentStop({ ...review, followStatus: 'unknown' }, [record], '我')).toBe(false);
    expect(recoverableCommentStop({ ...review, reason: `${review.reason} security_challenge` }, [record], '我')).toBe(false);
    expect(recoverableCommentStop({ ...review, reason: '自动评论已停止：comment_sender_changed' }, [record], '我')).toBe(false);
  });
  it('skips an unverified real note without a per-post review queue', () => {
    expect(autoCandidateStatus(note, assessment)).toBe('skipped');
  });
  it('allows drafting only for complete notes with eligible assessment', () => {
    expect(autoCandidateStatus({ ...note, completeness: 'complete' }, assessment)).toBe('eligible');
    expect(autoCandidateStatus({ ...note, completeness: 'complete' }, { ...assessment, decision: 'manual_review' })).toBe('skipped');
    expect(autoCandidateStatus({ ...note, completeness: 'complete' }, { ...assessment, serviceFit: 'uncertain' })).toBe('skipped');
    expect(autoCandidateStatus({ ...note, completeness: 'complete' }, { ...assessment, intent: 'supply' })).toBe('skipped');
    expect(autoCandidateStatus({ ...note, completeness: 'complete', resolutionEvidence: '已找到' }, assessment)).toBe('skipped');
  });
  it('keeps hard skips out of review queue', () => {
    expect(autoCandidateStatus(note, { ...assessment, decision: 'hard_skip' })).toBe('skipped');
  });
  it('paces real comments one at a time, 3–5 minutes apart', () => {
    expect(AUTO_MODE_BATCH_SIZE).toBe(1);
    expect(nextCommentDelayMs(() => 0)).toBe(MIN_COMMENT_DELAY_MS);
    expect(nextCommentDelayMs(() => 0.999999)).toBeLessThanOrEqual(MAX_COMMENT_DELAY_MS);
  });
  it('continues promptly when the wait switch is off', () => {
    expect(nextModeDelayMs(false, true)).toBe(FAST_MODE_DELAY_MS);
    expect(nextModeDelayMs(false, false)).toBe(FAST_MODE_EMPTY_DELAY_MS);
    expect(nextModeDelayMs(true, true)).toBe(AUTO_MODE_DELAY_MS);
  });
  it('requeues only likely old comment-coverage false negatives, never hard skips', () => {
    const longNote = { ...note, body: '我在上海找房，想租可以接受女生合租的主卧，预算合适的话希望月底入住。' };
    const oldReview: SearchCandidate = { id: '1', taskId: 't', noteId: 'xhs:1', url: 'https://www.xiaohongshu.com/explore/1', title: longNote.title, snippet: '', capturedAt: '2026-09-27', status: 'needs_review', reason: '笔记内容未完整确认', note: longNote, draft: '', promptVersion: null, assessment: { ...assessment, decision: 'manual_review', reason: '笔记内容未完整确认，需要人工复核。' }, likeStatus: 'none', likedAt: null, authorId: null, authorName: '', authorUrl: null, followStatus: 'none', followedAt: null, followReason: '' };
    expect(retryableAfterCommentCoverageFix(oldReview)).toBe(true);
    expect(retryableAfterCommentCoverageFix({ ...oldReview, status: 'skipped' })).toBe(false);
    expect(retryableAfterCommentCoverageFix({ ...oldReview, assessment: { ...oldReview.assessment!, serviceFit: 'incompatible' } })).toBe(false);
    expect(retryableAfterCommentCoverageFix({ ...oldReview, note: { ...longNote, body: '详情如图，请看图片' } })).toBe(false);
  });
  it('rechecks old judgments but never already interacted or manually skipped posts', () => {
    const candidate: SearchCandidate = { id: '1', taskId: 't', noteId: 'xhs:1', url: 'https://www.xiaohongshu.com/explore/1', title: '上海找房', snippet: '', capturedAt: '2026-10-04', status: 'skipped', reason: '求租房型不符', note: null, draft: '', promptVersion: 'candidate-v5', assessment: null, likeStatus: 'none', likedAt: null, authorId: null, authorName: '', authorUrl: null, followStatus: 'none', followedAt: null, followReason: '' };
    expect(recheckableAfterPromptUpdate(candidate, [], '房东')).toBe(true);
    expect(recheckableAfterPromptUpdate({ ...candidate, reason: '人工跳过' }, [], '房东')).toBe(false);
    expect(recheckableAfterPromptUpdate({ ...candidate, likeStatus: 'liked' }, [], '房东')).toBe(false);
    expect(recheckableAfterPromptUpdate({ ...candidate, followStatus: 'followed' }, [], '房东')).toBe(false);
    expect(recheckableAfterPromptUpdate({ ...candidate, followStatus: 'unknown' }, [], '房东')).toBe(false);
    expect(recheckableAfterPromptUpdate({ ...candidate, status: 'published' }, [], '房东')).toBe(false);
    expect(recheckableAfterPromptUpdate(candidate, [{ id: 'i', noteId: 'xhs:1', noteHash: '', accountLabel: '房东', templateId: null, templateVersion: null, body: '你好', status: 'unknown', source: 'xhs', createdAt: '2026-10-04', markedPublishedAt: null }], '房东')).toBe(false);
  });
});
