import type { SearchTask } from '@yuezhuang/shared';
import { autoTaskLabel, autoTaskSource, type AutoSource } from './xhs';

type Props = {
  source: AutoSource; keyword: string; tasks: SearchTask[]; currentTaskId?: string; locked: boolean;
  onSourceChange: (source: AutoSource) => void; onKeywordChange: (keyword: string) => void;
  onBind: () => void; onCollect: () => void; onTaskChange: (id: string) => void;
};
export function BrowseTaskControls(props: Props) {
  return <>
    <label htmlFor="auto-source">浏览来源</label>
    <select id="auto-source" value={props.source} disabled={props.locked} onChange={event => props.onSourceChange(event.target.value as AutoSource)}>
      <option value="home">首页推荐流（不搜索）</option><option value="search">关键词搜索结果</option>
    </select>
    {props.source === 'search' && <><label htmlFor="auto-keyword">搜索关键词</label><input id="auto-keyword" value={props.keyword} disabled={props.locked} onChange={event => props.onKeywordChange(event.target.value)} placeholder="例如：上海约妆 / 上海租房" /></>}
    <div className="row"><button disabled={props.locked} onClick={props.onBind}>{props.source === 'home' ? '绑定当前首页' : '当前页搜索 / 绑定任务'}</button><button className="secondary" disabled={props.locked || !props.currentTaskId} onClick={props.onCollect}>收集当前已加载帖子</button></div>
    <p className="muted">{props.source === 'home' ? '请先在当前标签页打开小红书首页。无需关键词，不跳转、不重新搜索；Auto 先逐帖判断已加载卡片，处理完再下拉更多。' : '使用当前页面搜索框；若已搜索同一关键词，只绑定任务并保留“最新”等筛选。'}详情在同一标签页点开、关闭，不新建窗口。</p>
    <label htmlFor="auto-task">当前任务</label><select id="auto-task" disabled={props.locked} value={props.currentTaskId ?? ''} onChange={event => props.onTaskChange(event.target.value)}>
      <option value="">选择任务</option>{props.tasks.filter(task => autoTaskSource(task) === props.source).map(task => <option key={task.id} value={task.id}>{task.campaignName ?? '历史业务'} · {autoTaskLabel(task)} · {task.businessTemplateVersion ? `v${task.businessTemplateVersion} · ` : ''}{new Date(task.createdAt).toLocaleString()}</option>)}
    </select>
  </>;
}
