import type { AutoModeState } from './autoMode';

export function AutoProgress({ current }: { current: AutoModeState['currentCandidate'] | undefined }) {
  return <>
    <p className="muted">处理顺序：从上到下，同一行从左到右。标题初筛不相关的会跳过、不打开；已处理项不重复互动，重新启动从第一个未处理项继续。</p>
    {current && <div aria-live="polite">
      <p>当前{current.listOrder === null ? '帖子' : `第 ${current.listOrder + 1} 条`}：{current.title} · {current.stage}</p>
      {current.reason && <p className="muted">判断结果：{current.reason}</p>}
    </div>}
  </>;
}
