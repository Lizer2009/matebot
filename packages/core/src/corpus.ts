/**
 * The twelve multi-turn scenarios from the approved v1.1 spec, as data.
 *
 * Each row states what the product must do for its input class, whether this
 * phase implements it, and — when it does not — the exact safe behaviour the
 * user gets instead. Keeping this as data rather than twelve prompt handlers is
 * deliberate: a new capability is registered once and the rows that depend on it
 * move from `deferred` to `implemented`, without adding a special case per
 * phrasing.
 */

export type CorpusClass = "QUERY" | "ANALYZE" | "CREATE" | "UPDATE" | "QA";

export type CorpusStatus =
  /** Shipped end to end in this phase, with tests. */
  | "implemented"
  /** A later phase implements it; the fallback below is what happens today. */
  | "deferred"
  /** No capability is planned for this path; it degrades by design. */
  | "unsupported";

export type CorpusScenario = {
  id: number;
  prompt: string;
  class: CorpusClass;
  status: CorpusStatus;
  /** The phase this row's behaviour belongs to. */
  phase: "phase0" | "phase1" | "phase2" | "phase3";
  /** The phase that implements it, when deferred. */
  implementingPhase?: "phase1" | "phase2" | "phase3";
  /** Whether the correct behaviour is to render a surface at all. */
  rendersSurface: boolean;
  /** The surface family a correct implementation would render. */
  surfaceKind?: "form" | "result" | "progress";
  /** Whether the row involves a side effect the user must confirm. */
  expectsAction: boolean;
  /** Whether the row exercises same-surface multi-turn editing. */
  multiTurn: boolean;
  /** What the user sees today while the capability is absent. */
  safeBehaviour?: string;
};

export const MULTI_TURN_CORPUS: readonly CorpusScenario[] = [
  {
    id: 1,
    prompt: "本年度销售（有真实数据）",
    class: "ANALYZE",
    phase: "phase2",
    status: "deferred",
    implementingPhase: "phase2",
    rendersSurface: true,
    surfaceKind: "result",
    expectsAction: false,
    multiTurn: false,
    safeBehaviour: "结果面（表/图）未实现；当前用 render_plot 出 PNG，或在无数据时追问来源。",
  },
  {
    id: 2,
    prompt: "同上后改「看上季度」",
    class: "UPDATE",
    phase: "phase2",
    status: "deferred",
    implementingPhase: "phase2",
    rendersSurface: true,
    surfaceKind: "result",
    expectsAction: false,
    multiTurn: true,
    safeBehaviour: "同卡 view 变更未实现；不得编造季度数字，也不得新建销售专用编辑器。",
  },
  {
    id: 3,
    prompt: "无数据源时问销售",
    class: "ANALYZE",
    phase: "phase2",
    status: "deferred",
    implementingPhase: "phase2",
    rendersSurface: false,
    expectsAction: false,
    multiTurn: false,
    safeBehaviour: "追问数据来源；禁止编造 series，也不得出假图。",
  },
  {
    id: 4,
    prompt: "下周日程",
    class: "QUERY",
    phase: "phase1",
    status: "deferred",
    implementingPhase: "phase1",
    rendersSurface: true,
    surfaceKind: "result",
    expectsAction: false,
    multiTurn: false,
    safeBehaviour: "日历查询结果卡未实现；禁止把「查询」当成「创建」，当前用对话回答。",
  },
  {
    id: 5,
    prompt: "帮我约会议（缺时间）",
    class: "CREATE",
    phase: "phase1",
    status: "deferred",
    implementingPhase: "phase1",
    rendersSurface: true,
    surfaceKind: "form",
    // Once Phase 1 lands this row gains a confirmable create action.
    expectsAction: false,
    multiTurn: false,
    safeBehaviour:
      "日历编辑器与创建动作未实现；registry 标记 calendar.create implemented=false，不出可点按钮。",
  },
  {
    id: 6,
    prompt: "分析这个文件",
    class: "ANALYZE",
    phase: "phase2",
    status: "deferred",
    implementingPhase: "phase2",
    rendersSurface: true,
    surfaceKind: "result",
    expectsAction: false,
    multiTurn: false,
    safeBehaviour: "本地只读分析不要求远程 Connection；结果面未实现，当前用对话给出结论。",
  },
  {
    id: 7,
    prompt: "写封邮件…再 NL 改收件人",
    class: "CREATE",
    phase: "phase0",
    status: "implemented",
    rendersSurface: true,
    surfaceKind: "form",
    expectsAction: true,
    multiTurn: true,
  },
  {
    id: 8,
    prompt: "简单事实问答",
    class: "QA",
    phase: "phase0",
    status: "implemented",
    rendersSurface: false,
    expectsAction: false,
    multiTurn: false,
  },
  {
    id: 9,
    prompt: "GitHub 拉到本机",
    class: "CREATE",
    phase: "phase3",
    status: "unsupported",
    rendersSurface: false,
    expectsAction: false,
    multiTurn: false,
    safeBehaviour: "无受控能力：明确说明缺失与可选替代，禁止 secret shell 旁路。",
  },
  {
    id: 10,
    prompt: "多卡并存「把它改一下」",
    class: "UPDATE",
    phase: "phase0",
    status: "implemented",
    rendersSurface: true,
    surfaceKind: "form",
    expectsAction: false,
    multiTurn: true,
  },
  {
    id: 11,
    prompt: "提交后鉴权中断再 resume",
    class: "CREATE",
    phase: "phase0",
    status: "implemented",
    rendersSurface: true,
    surfaceKind: "progress",
    expectsAction: true,
    multiTurn: true,
  },
  {
    id: 12,
    prompt: "在途发送时再点一次 + 另开只读查询",
    class: "CREATE",
    phase: "phase0",
    status: "implemented",
    rendersSurface: true,
    surfaceKind: "progress",
    expectsAction: true,
    multiTurn: true,
  },
] as const;

/** Rows this phase can honestly claim as passing end to end. */
export const CORPUS_IMPLEMENTED = MULTI_TURN_CORPUS.filter((row) => row.status === "implemented");

export function corpusByStatus(status: CorpusStatus): CorpusScenario[] {
  return MULTI_TURN_CORPUS.filter((row) => row.status === status);
}

export function corpusRow(id: number): CorpusScenario | undefined {
  return MULTI_TURN_CORPUS.find((row) => row.id === id);
}
