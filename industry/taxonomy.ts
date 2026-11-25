// 北航信息的分类与事实词表；分类 key 是稳定的公开接口身份。
export const CATEGORIES = [
  {"key": "campus", "label": "校园建设与变迁", "feedLabel": "校园建设与变迁", "section": "校园建设与变迁", "guide": "校区建设、建筑启用改造、道路和设施调整；普通活动地点不构成校园变迁。"},
  {"key": "governance", "label": "学校治理与人事", "feedLabel": "学校治理与人事", "section": "学校治理与人事", "guide": "明确任免、职责调整、制度与组织变化；出席会议不能证明任免。"},
  {"key": "competition", "label": "竞赛与创新", "feedLabel": "竞赛与创新", "section": "竞赛与创新", "guide": "学术科技竞赛的报名、赛项规则、选拔、公示、正式结果和项目成果，重视工程实践及飞行器设计相关赛事；体育文艺比赛归人物与文化。"},
  {"key": "research", "label": "科研与学术", "feedLabel": "科研与学术", "section": "科研与学术", "guide": "研究方法、论文、成果、项目资助、科研平台和学术活动的具体信息，重点关注飞行器设计、空气动力学、飞行动力学、结构力学与气动弹性。"},
  {"key": "teaching", "label": "教学与招生", "feedLabel": "教学与招生", "section": "教学与招生", "guide": "招生、培养、选课、课程、教学改革、学籍及学生学习安排。"},
  {"key": "services", "label": "校园服务", "feedLabel": "校园服务", "section": "校园服务", "guide": "交通、餐饮、住宿、图书馆、医院、网络和面向师生的服务通知，以及有明确参与条件的校园福利、抽奖、优惠与资源领取。"},
  {"key": "culture", "label": "人物与文化", "feedLabel": "人物与文化", "section": "人物与文化", "guide": "人物校友、校园文化、志愿服务、体育文艺和有明确参与信息的活动。"},
] as const satisfies ReadonlyArray<{ key: string; label: string; feedLabel?: string; section: string; guide: string; commentary?: true }>;
export const RELEASE: { category: string; tag: string; unit: string } | null = null;
export const PLAIN_TERMS: readonly string[] = ["北航", "北京航空航天大学", "学院路", "沙河", "本科", "研究生"];
// Content-type identifiers and weight matrix retained; definitions are in content-understanding.md.
export const ITEM_TYPES = ["model_release", "product_launch", "tool_or_prompt", "research_paper", "industry_event", "opinion_analysis", "tutorial_explainer"] as const;
export const CATEGORY_TAGS = ["校园变迁", "领导变化", "竞赛记录", "科研进展", "教学招生", "校园服务", "人物文化", "其他"] as const;
export const TOPIC_TAGS = ["学院路校区", "沙河校区", "冯如杯", "挑战杯", "报名通知", "选拔公示", "竞赛获奖", "校级领导", "校园建设", "科研论文", "科研项目", "校友", "文化活动", "招生", "教学", "服务调整", "飞行器设计", "飞行器力学"] as const;
export const ENTITY_TAGS = ["北京航空航天大学", "教务部", "科研院", "校团委", "档案馆", "校友会"] as const;
export const TAG_SYNONYMS: Readonly<Record<string,string>> = {
  "任免": "领导变化", "人事": "领导变化", "学科竞赛": "竞赛记录", "论文/研究": "科研进展", "通知": "校园服务", "校史": "校园变迁",
};
export const ENTITIES: Record<string, { name: string; displayTag: string | null; aliases: string[]; otherNames?: string[] }> = {
  buaa: { name: "北京航空航天大学", displayTag: "北京航空航天大学", aliases: ["北航", "北京航空航天大学", "Beihang", "BUAA"] },
  jiaowu: { name: "教务部", displayTag: "教务部", aliases: ["教务部", "教务处", "Jiaowu"] },
  research: { name: "科学技术研究院", displayTag: "科研院", aliases: ["科学技术研究院", "科研院"] },
  youth: { name: "校团委", displayTag: "校团委", aliases: ["校团委", "共青团北京航空航天大学委员会", "Youth"] },
  archives: { name: "档案馆", displayTag: "档案馆", aliases: ["档案馆"] },
  alumni: { name: "校友会", displayTag: "校友会", aliases: ["校友会", "北航校友"] },
};
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [
  { id: "buaa", name: "北京航空航天大学", patterns: [/北航|北京航空航天大学|\bBeihang\b|\bBUAA\b/i] },
  { id: "jiaowu", name: "教务部", patterns: [/教务部|教务处|\bJiaowu\b/i] },
  { id: "youth", name: "校团委", patterns: [/校团委|共青团北京航空航天大学委员会|\bYouth\b/i] },
  { id: "research", name: "科学技术研究院", patterns: [/科学技术研究院|科研院/] },
  { id: "archives", name: "档案馆", patterns: [/档案馆/] },
  { id: "alumni", name: "校友会", patterns: [/校友会|北航校友/] },
];
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [
  { entityId: "jiaowu", domains: ["jiaowu.buaa.edu.cn"] },
  { entityId: "research", domains: ["bhkj.buaa.edu.cn"] },
  { entityId: "youth", domains: ["youth.buaa.edu.cn"] },
  { entityId: "archives", domains: ["archives.buaa.edu.cn"] },
  { entityId: "alumni", domains: ["xyh.buaa.edu.cn"] },
  { entityId: "buaa", domains: ["buaa.edu.cn"] },
];
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [];
