import type { Interaction } from '@yuezhuang/shared';

export type PublicationResult = {
  ok: boolean; published?: boolean; ambiguous?: boolean; alreadyPublished?: boolean;
  reason?: string; senderId?: string; commentId?: string;
  diagnostic?: { commentAreas: number; visibleRows: number; exactTextRows: number; ownTextRows: number; inputCleared: boolean; successHint: boolean };
};
export const publicationFailureMessage = (reason: string) => ({
  send_clicked_but_publication_unverified: '已点击发送，但未确认当前账号的同文评论出现；已锁定本帖，不能自动重发。',
  comment_sender_identity_unverified: '未识别当前登录账号的主页链接，无法可靠核对评论作者。',
  comment_sender_changed: '当前登录账号已变化，不能用另一个账号的评论确认这次发送。',
  send_button_not_unique_or_disabled: '未找到唯一可用的原帖发送按钮，没有点击发送。'
}[reason] ?? reason);

export function publicationRecord(interaction: Interaction, result: PublicationResult): Interaction {
  const confirmed = result.ok && result.published === true;
  return { ...interaction, status: confirmed ? 'marked_published' : result.ambiguous === false ? 'generated' : 'unknown',
    markedPublishedAt: confirmed ? new Date().toISOString() : null,
    publicationSenderId: interaction.publicationSenderId ?? result.senderId,
    publicationCommentId: result.commentId ?? interaction.publicationCommentId,
    publicationCheckedAt: new Date().toISOString(),
    publicationReason: (confirmed ? result.alreadyPublished ? '当前账号已有同文评论，没有再次发送。' : '已确认原帖当前账号的同文评论出现。' : publicationFailureMessage(result.reason ?? '评论发送结果不明')).slice(0, 500) };
}
