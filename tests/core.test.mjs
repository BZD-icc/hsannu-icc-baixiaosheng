import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createRecord, makeBundle, mergeRecords, parseBundle, recordKey, reviewSummary,
  reviseRecord, withdrawRecord,
} from '../web/core.mjs';
import { makeAnswer } from '../web/knowledge.mjs';

const index = JSON.parse(await readFile(new URL('../web/knowledge/index.json', import.meta.url), 'utf8'));
const date = new Date('2026-11-07T10:00:00Z');
const hlQuestion = '我这届有哪些 HL 可选，去哪里核对实际开课？';
const currentScope = { cohort: '2027 届', year: '2026-2027' };

function notice(overrides = {}, publisherId = 'sample-alice') {
  return createRecord({ publisherId, kind: 'intel', data: {
    title: '虚构选课通知甲', summary: '模拟通知：物理 HL 开班。', topic: 'HL 选课', sourceType: 'school',
    url: 'https://example.test/cohort-a', date: '2026-11-07', ...currentScope, ...overrides,
  } }, date);
}

function evaluation(overrides = {}) {
  return createRecord({ publisherId: 'sample-student', kind: 'review', data: {
    teacher: '虚构教师甲', course: '物理', level: 'HL', ...currentScope,
    scores: { clarity: 5, pace: 4 }, workload: 'heavy', ...overrides,
  } }, date);
}

test('HL answer distinguishes public catalogs and this cohort’s actual schedule', () => {
  const answer = makeAnswer(index, hlQuestion, currentScope);
  assert.match(answer.text, /2027\s*届/);
  assert.match(answer.text, /2026 招生海报标有 HL/);
  assert.match(answer.text, /数学 AA.*视觉艺术/);
  assert.match(answer.text, /没有找到当届实际选课表/);
  assert.match(answer.text, /教务或 DP 协调员.*正式选课表/);
  for (const id of ['school-ad26', 'school-chart26', 'ib-school']) {
    assert(answer.sources.some(source => source.id === id && /^https:\/\//.test(source.url)), id);
  }
});

test('2025 and 2026 Computer Science evidence stays separate from actual HL', () => {
  const answer = makeAnswer(index, '2027届能选计算机 HL 吗？');
  assert.match(answer.text, /2025 招生海报列有计算机/);
  assert.match(answer.text, /2026 招生海报.*未列计算机/);
  assert.match(answer.text, /Computer Science HL.*当届确认/);
  assert(answer.sources.some(source => source.id === 'school-ad25'));
  assert(answer.sources.some(source => source.id === 'school-chart26'));
});

test('staff queries retain the reported assignments, roles and source limits', () => {
  const cases = [
    ['物理 HL 有哪些老师？', { 物理: /MR（HL）.*CW（HL）.*SH（HL 和 SL）/ }],
    ['数学有哪些老师？', { 数学: /AA HL.*MR、SH.*AA SL.*PH、JJ.*AI.*NN.*HL\/SL 待补充/ }],
    ['化学是谁教？', { 化学: /NP、DM/ }],
    ['英语的老师是谁？', { 英语: /AZ（英语 A 和英语 B）.*DR.*MC.*A\/B 分工待补充/ }],
    ['生物的老师是谁？', { 生物: /JH、SB/ }],
    ['美术是谁教？', { 美术: /\bLT\b/ }],
    ['中文 A 的老师是谁？', { '中文 A': /JQ、NL/ }],
    ['中文 B 的老师是谁？', { '中文 B': /\bHZ\b/ }],
    ['EAL 老师是谁？', { EAL: /VW、EZ、CL/ }],
    ['物理指导员是谁？', { 物理指导员: /\bLK\b/ }],
    ['生物化学指导员是谁？', { 生物化学指导员: /\bLW\b/ }],
    ['升学指导是谁？', { 升学指导: /KZ、SX、KL/ }],
    ['图书管理员是谁？', { 图书管理员: /\bVG\b/ }],
    ['VG', { 图书管理员: /\bVG\b/ }],
    ['MR 教什么课？', { 物理: /MR（HL）/, 数学: /AA HL.*\bMR\b/ }],
  ];
  for (const [question, assignments] of cases) {
    const answer = makeAnswer(index, question);
    assert.deepEqual(answer.evidence.map(item => item.title).sort(), Object.keys(assignments).sort(), question);
    assert.match(answer.text, /同学提供.*待核实/, question);
    assert.doesNotMatch(answer.text, /2026 招生海报|当届实际选课表/, question);
    assert.deepEqual(answer.sources, [], question);
    for (const item of answer.evidence) {
      assert.match(item.summary, assignments[item.title], question);
      assert(answer.text.includes(item.summary), question);
      assert.match(item.kind, /同学提供.*待核实/, question);
      assert(!item.url, question);
    }
  }
});

test('mentioning a teacher or adviser keeps the requested school information', () => {
  const cases = [
    ['2027 EE 的指导老师怎么安排', 'EE 2027 年新版', 'ib-ee27'],
    ['老师说 CAS 需要 150 小时吗？', 'CAS 经历、项目与证据', 'ib-cas'],
    ['我该问老师到哪里核对物理 HL 选课表？', '这届 HL 去哪里核对？', 'school-chart26'],
    ['找升学指导办理推荐信的流程是什么？', '成绩单、预估分与推荐信', 'school-index'],
  ];
  for (const [question, title, sourceId] of cases) {
    const answer = makeAnswer(index, question);
    assert.equal(answer.title, title, question);
    assert(answer.sources.some(source => source.id === sourceId), question);
  }
});

test('EE May 2027 and CAS cite the applicable IB requirements', () => {
  const ee = makeAnswer(index, '2027 EE 是不是 34 分？');
  assert.match(ee.text, /2027 年 5 月首次评估/);
  assert.match(ee.text, /单学科与跨学科.*合计 30 分/);
  assert.match(ee.text, /34 分描述属于旧制/);
  assert(ee.sources.some(source => source.id === 'ib-ee27'));
  assert(!ee.sources.some(source => source.id === 'school-ad26'));

  const cas = makeAnswer(index, 'CAS 只要攒够150小时就行吗？');
  assert.match(cas.text, /不能仅按 150 小时判断/);
  assert.match(cas.text, /至少 18 个月.*至少一个月的合作项目/);
  assert.match(cas.text, /七项学习成果/);
  assert.match(cas.text, /当届手册或协调员/);
  assert(cas.sources.some(source => source.id === 'ib-cas'));
});

test('tuition queries keep the reported amount separate from school admissions evidence', () => {
  const enrollmentQuestion = '2027 招多少人，学费多少？';
  const questions = [
    '收费多少？',
    '2027届的学费是多少？',
    '学费提交期限是什么？',
    'tuition payment deadline',
    enrollmentQuestion,
  ];
  for (const question of questions) {
    const answer = makeAnswer(index, question);
    assert.match(answer.text, /同学提供.*109,000 元.*140,000 元.*31,000 元/, question);
    assert.match(answer.text, /适用届别、生效时间和计费周期待校方确认/, question);
    const report = answer.matches.find(item => item.title === '学费调整线索');
    assert.match(report?.kind ?? '', /同学提供.*待核实/, question);
    assert(!report.url && !report.year && !report.cohort, question);
    assert.deepEqual(answer.sources.map(source => source.id).sort(), ['school-ad26', 'school-index'], question);
    if (question === enrollmentQuestion) {
      assert.match(answer.text, /2026–2027 学年计划招 90 人、3 个班/);
    }
  }
});

test('package and sync copies converge, including corrections and old versions after withdrawal', () => {
  const v1 = notice();
  const v2 = reviseRecord(v1, { ...v1.data, summary: '模拟更正：物理 HL 改到第二轮。' });
  const v3 = withdrawRecord(v2);
  const anotherPublisher = notice({ summary: '模拟相反通知：物理 HL 尚未开放。' }, 'sample-bob');
  const importCopy = parseBundle(JSON.stringify(makeBundle([v1])));
  const installed = mergeRecords([], importCopy);
  const duplicate = mergeRecords(installed.records, [v1, anotherPublisher]);
  assert.equal(duplicate.duplicates, 1);
  assert.equal(duplicate.added, 1);
  const corrected = mergeRecords(duplicate.records, [v2]);
  assert.equal(corrected.updated, 1);
  assert.equal(corrected.records.find(record => recordKey(record) === recordKey(v1)).data.summary, v2.data.summary);
  const removed = mergeRecords(corrected.records, [v3]);
  const replayed = mergeRecords(removed.records, [v1, v2, v3]);
  assert.equal(replayed.stale, 2);
  assert.equal(replayed.duplicates, 1);
  assert.deepEqual(replayed.records, [v3, anotherPublisher]);
  assert.deepEqual(v3.data, {});
});

test('answer finds matching cohort notation and preserves conflicting source identities', () => {
  const matching = notice();
  const conflicting = notice({ title: '虚构选课通知乙', summary: '模拟通知：物理 HL 未开班。',
    url: 'https://example.test/cohort-b' }, 'sample-bob');
  const otherCohort = notice({ title: '其他届通知', cohort: '2028 届' });
  const otherYear = notice({ title: '其他学年通知', year: '2025-2026' });
  const answer = makeAnswer(index, '2027届有哪些 HL 可选？', { year: '2026-2027' },
    [matching, conflicting, otherCohort, otherYear]);
  assert.deepEqual(answer.personalEvidence.map(item => item.title), [matching.data.title, conflicting.data.title]);
  assert.deepEqual(answer.personalEvidence.map(item => item.url), [matching.data.url, conflicting.data.url]);
  assert.deepEqual(answer.personalEvidence.map(item => item.publisher), ['sample-alice', 'sample-bob']);
  assert(answer.personalEvidence.every(item => item.cohort === '2027 届' && item.date === '2026-11-07'));
  assert.match(answer.text, /(?:来源|记录|通知).*(?:分别|分开|冲突|不一致)/);
});

test('evaluation totals isolate teacher, year and HL/SL; each optional score has its own n', () => {
  const first = evaluation();
  const second = evaluation({ scores: { clarity: 3, feedback: 2 }, workload: 'light' });
  const nextCohort = evaluation({ cohort: '2028 届', scores: { clarity: 1 } });
  const unknownCohort = evaluation({ cohort: undefined, scores: { clarity: 1 } });
  const changed = reviseRecord(second, { ...second.data, scores: { clarity: 1, feedback: 2 } });
  const withdrawn = withdrawRecord(changed);
  const others = [evaluation({ teacher: '虚构教师乙' }), evaluation({ year: '2025-2026' }), evaluation({ level: 'SL' })];
  const rows = [first, second, nextCohort, unknownCohort, ...others, first];
  const filtered = { teacher: '虚构教师甲', course: '物理', level: 'HL', ...currentScope };
  const [group] = reviewSummary(rows, filtered);
  assert.equal(reviewSummary(rows).length, 4);
  assert.equal(group.count, 2);
  assert.deepEqual(group.scores, {
    clarity: { mean: 4, count: 2 }, feedback: { mean: 2, count: 1 }, pace: { mean: 4, count: 1 },
  });
  assert.deepEqual(group.workload, { light: 1, moderate: 0, heavy: 1 });
  assert.equal(reviewSummary([...rows, changed], filtered)[0].scores.clarity.mean, 3);
  const [remaining] = reviewSummary([...rows, changed, withdrawn, second], filtered);
  assert.equal(remaining.count, 1);
  assert.deepEqual(remaining.scores.feedback, { mean: null, count: 0 });

  for (const question of ['2027 届物理 HL 讲解评价？', '2027 届物理 HL 老师评分？']) {
    const answer = makeAnswer(index, question, { year: '2026-2027' }, rows);
    const mainGroup = answer.personalEvidence.find(item => item.title.includes('虚构教师甲'));
    assert.match(mainGroup?.summary ?? '', /讲解 4\.0\/5（2 条）/, question);
    assert.match(mainGroup.summary, /工作量/, question);
  }
});
