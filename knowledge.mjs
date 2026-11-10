import { cohortKey, reviewSummary, safeHttpUrl } from './core.mjs';

const LOOKUP_URL = new URL('./knowledge/index.json', import.meta.url);
const INTEL_LABEL = {
  school: '同学提供的学校通知',
  experience: '学生亲历',
  lead: '待核线索',
};
const COURSE_NAMES = [
  ['计算机', 'computer science', 'cs'],
  ['物理', 'physics'],
  ['化学', 'chemistry'],
  ['生物', 'biology'],
  ['经济', 'economics'],
  ['数字社会', 'digital society'],
  ['商业管理', 'business management'],
  ['数学 aa', 'math aa'],
  ['数学 ai', 'math ai'],
  ['视觉艺术', 'visual arts'],
];

export async function loadKnowledge(url = LOOKUP_URL) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('公开知识索引未能加载，请重新打开本页。');
  const index = await response.json();
  if (!Array.isArray(index.entries) || !Array.isArray(index.sources)) {
    throw new Error('知识索引格式不完整。');
  }
  return index;
}

function normalized(text) {
  return String(text ?? '').normalize('NFKC').trim().toLowerCase();
}

function matchesTerm(text, term) {
  const word = normalized(term);
  if (!word) return false;
  if (/^[a-z0-9]+$/.test(word)) {
    return text.split(/[^a-z0-9]+/).includes(word);
  }
  return text.includes(word);
}

function normalizeYear(value) {
  const match = String(value ?? '').match(/(20\d{2})\s*[\-/–—至]\s*(20\d{2})/);
  return match ? match[1] + '-' + match[2] : '';
}

function scopeFrom(question, scope) {
  const q = normalized(question);
  return {
    year: normalizeYear(scope.year) || normalizeYear(question),
    cohort: String(scope.cohort || question.match(/20\d{2}\s*[级届]/)?.[0] || '').trim(),
    course: String(scope.course || COURSE_NAMES.find(names => names.some(n => matchesTerm(q, n)))?.[0] || '').trim(),
    level: matchesTerm(q, 'hl') ? 'HL' : matchesTerm(q, 'sl') ? 'SL' : '',
  };
}

function courseMatches(value, target) {
  if (!target) return true;
  const v = normalized(value);
  const t = normalized(target);
  const aliases = COURSE_NAMES.find(names => names.some(n => matchesTerm(t, n))) ?? [t];
  return aliases.some(alias => matchesTerm(v, alias));
}

function isCourseLookup(q) {
  return /开课|开班|选课表|能选|可选|选课|选科|开设|offered/.test(q)
    && !/报名|入学考试|预估分|推荐信/.test(q);
}

function selectedStaff(index, q, scope) {
  if (/评价|评分|打分|口碑|体验|讲解|评课/.test(q)) return null;
  const asksForNames = /是谁|谁是|谁教|谁负责|哪位|有谁|哪些(?:老师|教师|指导员)|名单|代号/.test(q);
  if (!asksForNames && (isCourseLookup(q) || /怎么|如何|何时|什么时候|截止|流程|提交|上传|申请|材料|推荐信/.test(q))) return null;
  const roster = index.entries.filter(item => item.topic === 'staff');
  if (!roster.length) return null;
  const query = q.replace(/[?!.。]+$/, '').trim();
  if (query === '任课与指导' || query === '指导与支持') return roster.filter(item => item.staffRole === 'guidance');
  const codes = roster.filter(item => item.staffCodes.some(code => matchesTerm(q, code)));
  const codeLookup = codes.some(item => item.staffCodes.some(code => normalized(code) === query))
    || (codes.length > 0 && /谁|教|代号|负责|\bwho\b/.test(q));
  const search = `${q} ${normalized(scope.course)}`;
  const guidance = /指导员/.test(q) || roster.some(item => item.staffRole === 'guidance'
    && item.keywords.some(word => matchesTerm(search, word)));
  const teacher = /老师|教师|任课|任教|谁教/.test(q);
  if (!guidance && !teacher && !codeLookup) return null;

  const role = guidance ? 'guidance' : teacher ? 'teacher' : '';
  const candidates = roster.filter(item => !role || item.staffRole === role);
  const chineseTrack = /中文\s*[ab](?![a-z0-9])|\bchinese\s*[ab]\b|\bchi[ab]\b/.test(search);
  const byTopic = candidates.filter(item => item.keywords.some(word => (!chineseTrack || word !== '中文')
    && matchesTerm(search, word)));
  const matches = codes.length ? (byTopic.length ? byTopic : candidates).filter(item => codes.includes(item)) : byTopic;
  return matches.length ? matches : null;
}

function selectedEntries(index, q, lookup, scope, tuition) {
  const byId = new Map(index.entries.map(item => [item.id, item]));
  if (tuition) {
    const ids = ['tuition-update', 'admissions-gap'];
    if (/招生|招多少|名额|报名|报考|录取/.test(q)) ids.push('admissions-26');
    return ids.map(id => byId.get(id)).filter(Boolean);
  }
  if (lookup) {
    const ids = ['actual-hl', scope.level === 'SL' ? 'catalog26-sl' : 'catalog26', 'ib-levels'];
    if (scope.course && courseMatches(scope.course, '计算机')) ids.push('computer-science');
    return ids.map(id => byId.get(id)).filter(Boolean);
  }
  const specific = [];
  if (matchesTerm(q, 'ee') || /拓展论文|extended essay/.test(q)) specific.push('ee-2027');
  if (matchesTerm(q, 'tok') || /知识论/.test(q)) specific.push('tok');
  if (matchesTerm(q, 'ia') || /交稿|提交|上传|deadline/.test(q)) specific.push('ia-deadlines');
  if (matchesTerm(q, 'cas') || /150\s*小时/.test(q)) specific.push('cas');
  if (specific.length) return specific.map(id => byId.get(id)).filter(Boolean);
  const scored = index.entries.filter(item => item.topic !== 'staff').map(item => ({
    item,
    score: item.keywords.reduce((total, word) => total + (matchesTerm(q, word) ? word.length + 2 : 0), 0),
  })).filter(match => match.score > 0);
  return scored.sort((a, b) => b.score - a.score).slice(0, 3).map(match => match.item);
}

function sameScope(data, scope, requireKnown = false) {
  if (scope.year && (requireKnown || data.year) && normalizeYear(data.year) !== scope.year) return false;
  if (scope.cohort && (requireKnown || data.cohort) && cohortKey(data.cohort) !== cohortKey(scope.cohort)) return false;
  return true;
}

function selectedIntel(records, scope, q, lookup) {
  return records.filter(record => {
    if (record.kind !== 'intel' || record.state !== 'active' || !sameScope(record.data, scope)) return false;
    const text = normalized([record.data.title, record.data.topic, record.data.summary].join(' '));
    if (scope.course && !courseMatches(text, scope.course)) return false;
    if (lookup && /开课|选课|选科|课表|开班|\bhl\b|\bsl\b/.test(text)) return true;
    const title = normalized(record.data.title);
    return (title.length > 1 && q.includes(title))
      || q.split(/[^a-z0-9\u3400-\u9fff]+/).some(word => word.length >= 3 && text.includes(word));
  }).slice(0, 6).map(({ data, publisherId }) => ({
    title: data.title,
    summary: data.summary,
    kind: INTEL_LABEL[data.sourceType] ?? INTEL_LABEL.lead,
    year: data.year,
    cohort: data.cohort,
    date: data.date,
    publisher: publisherId.slice(0, 12),
    url: safeHttpUrl(data.url),
  }));
}

function ratingEvidence(records, scope, lookup, q) {
  if (!lookup && !/评价|评分|上课体验|讲解|任课教师/.test(q)) return [];
  if (lookup && !scope.course && !/评价|评分|体验/.test(q)) return [];
  const rows = records.filter(record => record.kind === 'review' && record.state === 'active'
    && sameScope(record.data, scope, true) && courseMatches(record.data.course, scope.course));
  const filters = { ...(scope.year && { year: scope.year }), ...(scope.level && { level: scope.level }) };
  const labels = { clarity: '讲解', feedback: '反馈', pace: '节奏' };
  return reviewSummary(rows, filters).slice(0, 6).map(row => ({
    title: [row.teacher, row.course, row.level, row.year].join(' · '),
    summary: Object.entries(labels).map(([key, label]) => {
      const { mean, count } = row.scores[key];
      return count ? label + ' ' + mean.toFixed(1) + '/5（' + count + ' 条）' : label + '暂无评分';
    }).join('、') + '。总计 ' + row.count + ' 条学生评价。'
      + (Object.values(row.workload).some(Boolean)
        ? '工作量：较轻 ' + row.workload.light + '、适中 ' + row.workload.moderate + '、较重 ' + row.workload.heavy + '。'
        : ''),
    year: row.year,
    cohort: scope.cohort,
    kind: '学生选课评价',
  }));
}

function forDisplay(item, sourceMap) {
  return {
    title: item.title, summary: item.summary, kind: item.kind, year: item.year,
    url: safeHttpUrl(sourceMap.get(item.sourceIds[0])?.url),
  };
}

export function makeAnswer(index, question, scope = {}, records = []) {
  const input = String(question ?? '').trim();
  if (!input) throw new Error('请填写你的问题。');
  const q = normalized(input);
  const selectedScope = scopeFrom(input, scope);
  const tuition = /学费|收费/.test(q) || matchesTerm(q, 'tuition');
  const staff = tuition ? null : selectedStaff(index, q, selectedScope);
  const lookup = !tuition && !staff
    && (isCourseLookup(q) || (selectedScope.course && matchesTerm(q, 'hl') && /有|能/.test(q)));
  const entries = staff ?? selectedEntries(index, q, lookup, selectedScope, tuition);
  const sourceMap = new Map(index.sources.map(source => [source.id, source]));
  const ids = entries.length ? entries.flatMap(item => item.sourceIds) : ['school-index'];
  const sources = [...new Set(ids)]
    .map(id => sourceMap.get(id)).filter(source => source && safeHttpUrl(source.url));
  const facts = entries.map(item => forDisplay(item, sourceMap));
  const personal = selectedIntel(records, selectedScope, q, lookup);
  const ratings = staff ? [] : ratingEvidence(records, selectedScope, lookup, q);
  const sourceLabel = staff?.[0]?.kind;
  let title = entries[0]?.title || '继续核对学校资料';
  let text = entries.map(item => item.summary).join('\n\n');

  if (staff) {
    if (staff.length !== 1) title = staff.every(item => item.staffRole === 'guidance') ? '指导与支持' : '任课';
    text = `${sourceLabel}\n\n${text}`;
  } else if (lookup) {
    const currentScope = [selectedScope.cohort, selectedScope.year].filter(Boolean).join('，');
    title = '这届 ' + (selectedScope.level || '课程') + ' 去哪里核对？';
    text = [
      currentScope ? '查询范围：' + currentScope + '。' : '可以补充你的入学届别或要查的学年。',
      bySummary(entries, 'actual-hl'),
      bySummary(entries, selectedScope.level === 'SL' ? 'catalog26-sl' : 'catalog26'),
      bySummary(entries, 'computer-science'),
    ].filter(Boolean).join('\n\n');
  }
  if (personal.length) {
    const notes = personal.map(item => '• ' + item.title + '（'
      + [item.kind, '来源 ' + item.publisher, item.cohort || '届别未填', item.year || '学年未填', item.date].filter(Boolean).join('，')
      + '）' + item.summary);
    text += (text ? '\n\n' : '') + '你保存或收到的相关资料\n' + notes.join('\n');
    if (personal.length > 1) text += '\n各来源分开列出。若说法不同，请核对原通知及最新正式安排。';
  }
  if (ratings.length) {
    text += '\n\n学生选课评价\n' + ratings.map(row => row.title + '：' + row.summary).join('\n');
  } else if (/评价|评分|体验/.test(q)) {
    text += '\n\n当前选入的来源里没有匹配的学生评价。';
  }
  if (!text) text = '本批知识中没有找到匹配的事实。可以尝试换一个校内事务或课程关键词，或打开学校国际课程栏目核对。';
  return {
    title, text, sources,
    ...(sourceLabel && { sourceLabel }),
    matches: [...facts, ...personal, ...ratings],
    evidence: facts,
    personalEvidence: [...personal, ...ratings],
  };
}

function bySummary(entries, id) {
  return entries.find(item => item.id === id)?.summary ?? '';
}
