import { interactionBlocksFirstContact, type Assessment, type Interaction, type NoteSnapshot, type SearchCandidate } from '@yuezhuang/shared';
import { textIsComplete } from './noteSafety';

export const AUTO_MODE_ALARM = 'yuezhuang-auto-mode';
export const AUTO_MODE_DELAY_MS = 60_000;
export const AUTO_MODE_BATCH_SIZE = 1;
export const FAST_MODE_DELAY_MS = 2_000;
export const FAST_MODE_EMPTY_DELAY_MS = 5_000;
export const MIN_COMMENT_DELAY_MS = 3 * 60_000;
export const MAX_COMMENT_DELAY_MS = 5 * 60_000;

export function nextCommentDelayMs(random = Math.random): number {
  return MIN_COMMENT_DELAY_MS + Math.floor(random() * (MAX_COMMENT_DELAY_MS - MIN_COMMENT_DELAY_MS + 1));
}

export function nextModeDelayMs(paceEnabled: boolean, hasQueue: boolean): number {
  return paceEnabled ? AUTO_MODE_DELAY_MS : hasQueue ? FAST_MODE_DELAY_MS : FAST_MODE_EMPTY_DELAY_MS;
}

export type AutoModeState = {
  status: 'stopped' | 'running' | 'paused';
  runId: string | null;
  taskId: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  analyzed: number;
  drafted: number;
  needsReview: number;
  skipped: number;
  published: number;
  liked: number;
  followed: number;
  gatewayFailures: number;
  publishEnabled: boolean;
  likeEnabled: boolean;
  followEnabled: boolean;
  paceEnabled: boolean;
  reason: string;
  style: string;
  currentCandidate: { noteId: string; title: string; listOrder: number | null; stage: string; reason: string } | null;
};

export const initialAutoModeState: AutoModeState = {
  status: 'stopped', runId: null, taskId: null, nextRunAt: null, lastRunAt: null,
  analyzed: 0, drafted: 0, needsReview: 0, skipped: 0, published: 0, liked: 0, followed: 0, gatewayFailures: 0, publishEnabled: false, likeEnabled: false, followEnabled: false, paceEnabled: false,
  reason: '', style: '自然、简短、根据帖子具体需求回应，不夸大', currentCandidate: null
};

export function autoCandidateStatus(note: NoteSnapshot, assessment: Assessment): SearchCandidate['status'] {
  if (assessment.decision === 'hard_skip') return 'skipped';
  if (note.completeness !== 'complete' || note.resolutionEvidence || assessment.decision !== 'eligible_for_review' ||
      assessment.serviceFit !== 'compatible' || assessment.intent !== 'demand' || !assessment.evidence.length) return 'skipped';
  return 'eligible';
}

export function commentRecordSkipReason(interactions: Interaction[], noteId: string, accountLabel: string): string | null {
  const records = interactions.filter(item => item.noteId === noteId && item.accountLabel === accountLabel);
  if (records.some(item => item.status === 'unknown')) return '已有发送结果不明记录，保留防重锁并跳过本帖，不重复发送。';
  if (records.some(item => item.status === 'marked_published')) return '此账号已评论过，自动跳过本帖，不重复互动。';
  if (records.some(item => item.status === 'filled')) return '此账号已有填入记录（不等于已发布），跳过本帖，避免覆盖或重复发送。';
  return null;
}

export function recoverableCommentStop(candidate: SearchCandidate, interactions: Interaction[], accountLabel: string): boolean {
  return candidate.status === 'needs_review' && !['pending', 'unknown'].includes(candidate.followStatus) &&
    /^(自动评论已停止|评论结果不明)：/.test(candidate.reason) &&
    !/security_challenge|account_restricted|comment_sender_changed|target_note_mismatch|note_content_changed|安全验证|平台限制/.test(candidate.reason) &&
    /send_clicked_but_publication_unverified|已点击发送，但未确认|发送请求响应丢失/.test(candidate.reason) &&
    Boolean(commentRecordSkipReason(interactions, candidate.noteId, accountLabel));
}

export function retryableAfterCommentCoverageFix(candidate: SearchCandidate): boolean {
  return candidate.status === 'needs_review' && candidate.likeStatus === 'none' && candidate.followStatus === 'none' && candidate.note?.source === 'xhs' &&
    candidate.note.completeness === 'partial' && !candidate.draft &&
    candidate.assessment?.decision === 'manual_review' && candidate.assessment.serviceFit === 'compatible' &&
    candidate.assessment.reason.startsWith('笔记内容未完整确认') &&
    textIsComplete(candidate.note.title, candidate.note.body, true);
}

export function recheckableAfterPromptUpdate(candidate: SearchCandidate, interactions: Interaction[], accountLabel: string): boolean {
  return ['needs_review', 'skipped'].includes(candidate.status) && candidate.likeStatus === 'none' && candidate.followStatus === 'none' &&
    !candidate.note?.resolutionEvidence && candidate.reason !== '人工跳过' &&
    !interactionBlocksFirstContact(interactions, candidate.noteId, accountLabel);
}
