export function commentsFullyLoaded(declaredCount: number | null, loadedCount: number, hasCollapsedReplies: boolean): boolean {
  return declaredCount !== null && Number.isSafeInteger(declaredCount) && declaredCount >= 0 && loadedCount >= declaredCount && !hasCollapsedReplies;
}

// A note can be assessed after its text and a visible sample of comments are read.
// This does not claim that every comment or reply has been inspected.
export function visibleCommentsReady(hasCommentArea: boolean, declaredCount: number | null, loadedCount: number): boolean {
  return hasCommentArea && (loadedCount > 0 || declaredCount === 0);
}
