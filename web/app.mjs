import { createId, createRecord, makeBundle, mergeRecords, parseBundle, recordKey, reviewSummary, reviseRecord, safeHttpUrl, withdrawRecord } from './core.mjs';
import { mountCourseWheel } from './courses.mjs';
import { loadKnowledge, makeAnswer } from './knowledge.mjs';
import { parseModelConnectionCode, requestModel } from './model.mjs';
import { openStore } from './store.mjs';
import { createSync, selectedRecords } from './sync.mjs';

const byId = id => document.getElementById(id);
const dimensions = { clarity: '讲解', feedback: '反馈', pace: '节奏' };
const sourceTypes = { school: '同学提供的学校通知', experience: '亲历经验', lead: '待核实线索' };
const workloadTypes = { light: '较轻', moderate: '适中', heavy: '较重' };
const numberFormat = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
const shortId = id => id.slice(0, 8);
const formData = form => Object.fromEntries(new FormData(form));
const ownRecord = record => record.publisherId === state?.publisherId;

let state;
let store;
let index;
let sync;
let lastQuery;
let reviewFilters = {};
let importPending;
let importRead = 0;
let modelController;
const editing = { intel: null, review: null };

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function link(title, rawUrl) {
  const url = safeHttpUrl(rawUrl);
  if (!url) return element('span', title);
  const anchor = element('a', title);
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

function sourceRow(source) {
  const row = element('li');
  row.append(link(source.title, source.url));
  const meta = [source.date, source.scope].filter(Boolean).join(' · ');
  if (meta) row.append(element('span', meta, 'source-meta'));
  return row;
}

function tag(text, tone) {
  return element('span', text, tone ? `tag ${tone}` : 'tag');
}

function status(id, text, error = false) {
  const node = byId(id);
  if (node.textContent !== text) node.textContent = text;
  node.dataset.error = String(error);
}

function replaceList(id, nodes) {
  const list = byId(id);
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.focus : '';
  list.replaceChildren(...nodes);
  if (focused) {
    const successor = Array.from(list.querySelectorAll('[data-focus]')).find(node => node.dataset.focus === focused);
    successor?.focus({ preventScroll: true });
  }
}

function action(label, key, callback, statusId, tone = 'quiet') {
  const button = element('button', label, `button small-button ${tone}`);
  button.type = 'button';
  button.dataset.focus = key;
  button.addEventListener('click', () => runAction(button, statusId, callback));
  return button;
}

async function runAction(button, statusId, callback) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    await callback();
  } catch (error) {
    status(statusId, error.message || '操作失败，请重试。', true);
  } finally {
    if (button) button.disabled = false;
  }
}

function bindForm(id, statusId, callback) {
  const form = byId(id);
  form.addEventListener('submit', event => {
    event.preventDefault();
    void runAction(event.submitter, statusId, () => callback(form));
  });
}

function bindButton(id, statusId, callback) {
  const button = byId(id);
  button.addEventListener('click', () => runAction(button, statusId, callback));
}

function activatePage(moveFocus = false) {
  const requested = location.hash.slice(1);
  if (requested === 'main') return;
  const page = ['ask', 'courses', 'library', 'reviews', 'share'].includes(requested) ? requested : 'ask';
  for (const section of document.querySelectorAll('.page')) section.hidden = section.id !== page;
  for (const anchor of document.querySelectorAll('.nav a')) {
    if (anchor.hash === `#${page}`) anchor.setAttribute('aria-current', 'page');
    else anchor.removeAttribute('aria-current');
  }
  if (moveFocus) {
    const title = byId(`${page}-title`);
    title.tabIndex = -1;
    title.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}

function availableRecords() {
  const excluded = new Set(state?.excludedPublishers);
  return (state?.records ?? []).filter(record => ownRecord(record) || !excluded.has(record.publisherId));
}

function readQuestion() {
  const { question, cohort, year, course } = formData(byId('question-form'));
  return { question: question.trim(), scope: { cohort: cohort.trim(), year: year.trim(), course: course.trim() } };
}

function renderAnswer() {
  if (!index || !lastQuery) return null;
  const { question, scope } = lastQuery;
  const result = makeAnswer(index, question, scope, availableRecords());
  byId('answer-title').textContent = result.title;
  byId('answer-text').textContent = result.text;
  byId('answer-scope').textContent = result.sourceLabel || [scope.cohort, scope.year].filter(Boolean).join(' · ') || '公开资料';
  const cards = result.matches.filter(item => item.summary && !result.text.includes(item.summary)).map(item => {
    const caution = /缺口|待核|线索/.test(item.kind);
    const card = element('div', undefined, caution ? 'answer-item caution' : 'answer-item');
    card.append(element('h3', item.title), element('p', item.summary));
    const meta = [item.kind, item.cohort, item.year, item.date, item.publisher && `发布者 ${item.publisher}`].filter(Boolean).join(' · ');
    card.append(element('span', meta, 'source-meta'));
    if (item.url) card.append(link('查看出处 ↗', item.url));
    return card;
  });
  byId('answer-matches').replaceChildren(...cards);
  const contributedSources = result.personalEvidence.filter(item => item.url).map(item => ({
    title: `${item.kind} · ${item.title}`,
    url: item.url,
    date: item.date,
    scope: [item.cohort, item.year, item.publisher && `发布者 ${item.publisher}`].filter(Boolean).join(' · '),
  }));
  const sources = [...result.sources, ...contributedSources].map(sourceRow);
  if (!sources.length) sources.push(element('li', '没有匹配的出处。可到资料页按主题查看。'));
  byId('answer-sources').replaceChildren(...sources);
  byId('answer-citations').hidden = false;
  return result;
}

function queryFromForm(announce = true) {
  const query = readQuestion();
  if (!query.question) throw new Error('请填写你的问题。');
  lastQuery = query;
  modelController?.abort();
  byId('model-result').hidden = true;
  const result = renderAnswer();
  if (announce) {
    status('question-status', result ? `已查询 · ${result.sources.length} 个公开出处` : '公开索引暂不可用，可打开资料正文。', !result);
  }
  return result;
}

function renderKnowledge() {
  const topic = byId('topic-filter').value;
  const sources = new Map((index?.sources ?? []).map(source => [source.id, source]));
  const rows = (index?.entries ?? []).filter(item => item.staffRole !== 'teacher' && (!topic || item.topic === topic)).map(item => {
    const card = element('article', undefined, 'record-card');
    card.append(tag(item.kind, /缺口|待核/.test(item.kind) ? 'caution' : ''),
      element('h3', item.title), element('p', item.summary));
    if (item.year) card.append(element('p', item.year, 'subtle'));
    const citations = element('ul', undefined, 'source-list');
    citations.replaceChildren(...item.sourceIds.map(id => sources.get(id)).filter(Boolean).map(sourceRow));
    if (citations.children.length) card.append(citations);
    return card;
  });
  replaceList('knowledge-list', rows.length ? rows : [element('p', '公开索引暂不可用，可打开公开知识正文。', 'empty')]);
}

function recordTitle(record) {
  if (record.state === 'withdrawn') return record.kind === 'intel' ? '已撤回的资料' : '已撤回的评价';
  const { title, teacher, course, level } = record.data;
  return record.kind === 'intel' ? title : [course, teacher, level].join(' · ');
}

function recordMeta(record) {
  const { date, cohort, year, topic } = record.data;
  const who = ownRecord(record) ? '我发布' : `发布者 ${shortId(record.publisherId)}`;
  return [who, cohort, year, topic, date || `更新于 ${record.updatedAt.slice(0, 10)}`, `第 ${record.version} 版`].filter(Boolean).join(' · ');
}

function askConfirmation(text, label) {
  const dialog = byId('confirm-dialog');
  byId('confirm-text').textContent = text;
  byId('confirm-action').textContent = label;
  dialog.returnValue = 'cancel';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}

async function updateState(mutator) {
  if (!store) throw new Error('本机资料库不可用，请重开此页。');
  const next = await store.update(mutator);
  applyState(next);
  return next;
}

function offerSync() {
  sync?.broadcast().catch(() => {
    status('sync-status', '准备同步资料失败，可在分享页重试。', true);
  });
}

async function cleanAttachment(key) {
  if (key) await store.deleteAttachment(key).catch(() => {});
}

async function withdraw(record) {
  const key = recordKey(record);
  const id = `${record.kind}-status`;
  if (!(await askConfirmation(`撤回「${recordTitle(record)}」？已共享的记录会在接收撤回版本后退出问答和汇总。`, '确认撤回'))) return;
  let attachment;
  await updateState(current => {
    const latest = current.records.find(item => recordKey(item) === key && item.publisherId === current.publisherId);
    if (!latest || latest.version !== record.version) throw new Error('记录已有更新，请从列表重新操作。');
    current.records = mergeRecords(current.records, [withdrawRecord(latest)]).records;
    if (current.sharedHistory?.includes(key) && !current.published.includes(key)) current.published.push(key);
    attachment = current.attachments?.[key]?.key;
    if (attachment) delete current.attachments[key];
  });
  await cleanAttachment(attachment);
  if (editing[record.kind] && recordKey(editing[record.kind]) === key) resetEditor(record.kind);
  status(id, '已撤回。');
  offerSync();
}

function resetEditor(kind) {
  editing[kind] = null;
  const form = byId(`${kind}-form`);
  form.reset();
  byId(`${kind}-heading`).textContent = kind === 'intel' ? '添加学校资料' : '记录已修课程';
  byId(`cancel-${kind}-edit`).hidden = true;
  if (kind === 'intel') byId('remove-attachment-label').hidden = true;
  if (kind === 'review' && form.elements.course.tagName === 'SELECT') renderReviewTeachers(form);
}

function editRecord(record) {
  const { kind, data } = record;
  resetEditor(kind);
  editing[kind] = record;
  const form = byId(`${kind}-form`);
  for (const [field, value] of Object.entries({ ...data, ...data.scores })) {
    const input = form.elements.namedItem(field);
    if (input) input.value = value;
  }
  if (kind === 'review') {
    form.elements.taken.checked = true;
    if (form.elements.course.tagName === 'SELECT') {
      renderReviewTeachers(form);
      form.elements.teacher.value = data.teacher;
    }
  } else byId('remove-attachment-label').hidden = !state.attachments?.[recordKey(record)];
  byId(`${kind}-heading`).textContent = kind === 'intel' ? '更正学校资料' : '更正课程评价';
  byId(`cancel-${kind}-edit`).hidden = false;
  status(`${kind}-status`, '正在编辑此记录。');
  (kind === 'review' ? form.elements.course : form.querySelector('input')).focus();
}

function download(blob, filename) {
  const href = URL.createObjectURL(blob);
  const anchor = element('a');
  anchor.href = href;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1_000);
}

function recordCard(record) {
  const key = recordKey(record);
  const { data, kind } = record;
  const card = element('article', undefined, 'record-card');
  if (record.state === 'withdrawn') card.append(tag('已撤回', 'caution'));
  else if (kind === 'intel') card.append(tag(sourceTypes[data.sourceType], data.sourceType === 'lead' ? 'caution' : ''));
  card.append(element('h3', recordTitle(record)), element('p', recordMeta(record), 'subtle'));
  if (record.state === 'withdrawn') return card;
  if (kind === 'intel') {
    card.append(element('p', data.summary));
    if (data.url) card.append(link('查看出处 ↗', data.url));
  } else {
    const values = Object.entries(dimensions).map(([key, label]) => data.scores[key] && `${label} ${data.scores[key]}/5`).filter(Boolean);
    if (data.workload) values.push(`工作量 ${workloadTypes[data.workload]}`);
    if (values.length) card.append(element('p', values.join(' · ')));
  }
  if (!ownRecord(record)) {
    if (state.excludedPublishers?.includes(record.publisherId)) card.append(tag('未纳入问答与汇总', 'caution'));
    return card;
  }
  const buttons = element('div', undefined, 'button-row');
  const id = `${kind}-status`;
  buttons.append(action('更正', `edit/${key}`, () => editRecord(record), id),
    action('撤回', `withdraw/${key}`, () => withdraw(record), id, 'danger'));
  const attachment = state.attachments?.[key];
  if (attachment) buttons.append(action(`下载附件 · ${attachment.name}`, `attachment/${key}`, async () => {
    const blob = await store.getAttachment(attachment.key);
    if (!blob) throw new Error('此附件在本机已无法读取。');
    download(blob, attachment.name);
  }, id));
  card.append(buttons);
  return card;
}

async function saveRecord(kind, data, file, removeAttachment) {
  if (!store) throw new Error('本机资料库不可用，请重开此页。');
  const draft = editing[kind];
  const record = draft ? reviseRecord(draft, data) : createRecord({ publisherId: state.publisherId, kind, data });
  const key = recordKey(record);
  let staged;
  let oldAttachment;
  if (file?.name) {
    if (file.size > 10 * 1024 * 1024) throw new Error('本地附件最多 10 MB。');
    staged = { key: `${key}/${createId()}`, name: file.name };
    await store.putAttachment(staged.key, file);
  }
  try {
    await updateState(current => {
      const existing = current.records.find(item => recordKey(item) === key);
      if (draft && (!existing || existing.publisherId !== current.publisherId || existing.version !== draft.version)) {
        throw new Error('记录已有更新，请从列表重新进入编辑。');
      }
      current.records = mergeRecords(current.records, [record]).records;
      if (staged || removeAttachment) {
        current.attachments ??= {};
        oldAttachment = current.attachments[key]?.key;
        if (staged) current.attachments[key] = staged;
        else delete current.attachments[key];
      }
    });
  } catch (error) {
    await cleanAttachment(staged?.key);
    throw error;
  }
  await cleanAttachment(oldAttachment);
  resetEditor(kind);
  const selected = state.published.includes(key);
  status(`${kind}-status`, selected ? '已保存，所选版本将在同学在线时同步。' : '已保存到本机。到分享页勾选后可以发给同学。');
  offerSync();
}

function renderRecords() {
  const records = [...state.records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const intel = records.filter(record => record.kind === 'intel' && (record.state === 'active' || ownRecord(record)));
  const reviews = records.filter(record => record.kind === 'review' && ownRecord(record));
  byId('intel-count').textContent = `${intel.filter(record => record.state === 'active').length} 条`;
  replaceList('intel-list', intel.length ? intel.map(recordCard) : [element('p', '保存或接收的资料会出现在这里。', 'empty')]);
  replaceList('review-list', reviews.length ? reviews.map(recordCard) : [element('p', '保存后可以在这里更正或撤回。', 'empty')]);
}

function reviewChoices() {
  const choices = new Map();
  function addTeachers(course, teachers) {
    if (!choices.has(course)) choices.set(course, new Set());
    for (const teacher of teachers) choices.get(course).add(teacher);
  }
  for (const item of index?.entries ?? []) {
    if (item.staffRole === 'teacher') addTeachers(item.title, item.staffCodes);
  }
  for (const record of availableRecords()) {
    if (record.kind === 'review' && record.state === 'active') {
      addTeachers(record.data.course, [record.data.teacher]);
    }
  }
  return choices;
}

function isCustomReviewChoice(select) {
  return select.selectedOptions?.[0]?.hasAttribute('data-custom');
}

function setReviewChoices(select, labels, placeholder, customLabel) {
  const value = select.value;
  const keepCustom = isCustomReviewChoice(select);
  select.replaceChildren(new Option(placeholder, '', true), ...Array.from(labels, label => new Option(label, label)));
  if (customLabel) {
    const option = new Option(customLabel, ':other:');
    option.dataset.custom = '';
    select.add(option);
    if (keepCustom) {
      option.selected = true;
      return;
    }
  }
  select.value = value;
  if (select.selectedIndex < 0) select.selectedIndex = 0;
}

function toggleReviewInput(input, visible) {
  if (!input) return;
  input.disabled = !visible;
  input.labels[0].hidden = !visible;
  if (!visible) input.value = '';
}

function renderReviewTeachers(form, choices = reviewChoices()) {
  const { course, teacher, customCourse, customTeacher } = form.elements;
  const useCustomCourse = isCustomReviewChoice(course);
  toggleReviewInput(customCourse, useCustomCourse);
  const subject = useCustomCourse ? customCourse.value.trim().normalize() : course.value;
  teacher.disabled = !subject;
  const prompt = customTeacher ? '选择老师' : '全部老师';
  setReviewChoices(teacher, choices.get(subject) ?? [], subject ? prompt : '请先选科目',
    subject && customTeacher ? '其他老师' : '');
  toggleReviewInput(customTeacher, isCustomReviewChoice(teacher));
}

function refreshReviewPickers() {
  const choices = reviewChoices();
  for (const id of ['review-filters', 'review-form']) {
    const form = byId(id);
    if (form.elements.course.tagName !== 'SELECT') continue;
    setReviewChoices(form.elements.course, choices.keys(), '选择科目', form.elements.customCourse ? '其他科目' : '');
    renderReviewTeachers(form, choices);
    if (id === 'review-filters') {
      reviewFilters = { ...reviewFilters, course: form.elements.course.value, teacher: form.elements.teacher.value };
    }
  }
}

function applyReviewFilters(form, draft = reviewFilters) {
  const filters = { ...draft, course: form.elements.course.value, teacher: form.elements.teacher.value };
  const groups = filters.course ? reviewSummary(availableRecords(), filters) : [];
  reviewFilters = filters;
  renderReviews(groups);
  status('review-filter-status', filters.course ? `已筛选 · ${groups.length} 组` : '');
}

function bindReviewPicker(form, onChange) {
  const { course, teacher, customCourse, customTeacher } = form.elements;
  if (course.tagName !== 'SELECT') return;
  function courseChanged() {
    teacher.selectedIndex = 0;
    renderReviewTeachers(form);
    onChange?.();
  }
  course.addEventListener('change', courseChanged);
  customCourse?.addEventListener('input', courseChanged);
  teacher.addEventListener('change', () => {
    toggleReviewInput(customTeacher, isCustomReviewChoice(teacher));
    onChange?.();
  });
}

function renderReviews(groups = reviewFilters.course ? reviewSummary(availableRecords(), reviewFilters) : []) {
  const count = groups.reduce((sum, group) => sum + group.count, 0);
  byId('review-count').textContent = `${count} 条`;
  const cards = groups.map(group => {
    const card = element('article', undefined, 'record-card');
    card.append(element('h3', [group.course, group.teacher, group.level].join(' · ')),
      element('p', [group.year, reviewFilters.cohort, `${group.count} 条评价`].filter(Boolean).join(' · '), 'subtle'));
    const scores = element('dl', undefined, 'score-summary');
    for (const [dimension, label] of Object.entries(dimensions)) {
      const score = group.scores[dimension];
      const item = element('div');
      item.append(element('dt', label), element('dd', score.count ? `${numberFormat.format(score.mean)} / 5 · ${score.count} 条` : '— · 0 条'));
      scores.append(item);
    }
    card.append(scores);
    const workloads = Object.entries(workloadTypes).map(([key, label]) => `${label} ${group.workload[key]} 条`);
    card.append(element('p', `工作量 · ${workloads.join(' / ')}`, 'subtle'));
    return card;
  });
  const empty = reviewFilters.course ? '当前没有符合条件的课程评价。' : '选择科目后查看评价。';
  replaceList('review-groups', cards.length ? cards : [element('p', empty, 'empty')]);
}

function toggleItem(labelText, key, checked, callback, statusId) {
  const label = element('label', undefined, 'check');
  const box = element('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.dataset.focus = key;
  label.append(box, element('span', labelText));
  box.addEventListener('change', () => {
    const target = box.checked;
    void runAction(box, statusId, async () => {
      try {
        await callback(target);
      } catch (error) {
        box.checked = !target;
        throw error;
      }
    });
  });
  return label;
}

function renderShare() {
  const count = selectedRecords(state).length;
  byId('selection-count').textContent = `${count} 条已选`;
  byId('export-bundle').disabled = !count;
  const rows = state.records.filter(record => ownRecord(record) &&
    (record.state === 'active' || state.published.includes(recordKey(record)))).map(record => {
    const key = recordKey(record);
    const card = element('div', undefined, 'record-card');
    if (record.state === 'withdrawn') card.append(tag('同步撤回状态', 'caution'), element('h3', recordTitle(record)));
    else card.append(toggleItem(recordTitle(record), `select/${key}`, state.published.includes(key), async selected => {
      await updateState(current => {
        const latest = current.records.find(item => recordKey(item) === key);
        if (!latest || latest.state !== 'active' || latest.publisherId !== current.publisherId) throw new Error('这条记录已经变更。');
        const keys = new Set(current.published);
        if (selected) {
          keys.add(key);
          current.sharedHistory = [...new Set([...(current.sharedHistory ?? []), key])];
        } else {
          keys.delete(key);
        }
        current.published = [...keys];
      });
      status('selection-status', selected ? '已选中。可导出或等配对同学上线。' : '已取消选择。');
      offerSync();
    }, 'selection-status'));
    card.append(element('p', recordMeta(record), 'subtle'));
    return card;
  });
  replaceList('share-list', rows.length ? rows : [element('p', '先保存一条资料或评价，再来选择。', 'empty')]);

  const publishers = new Map();
  for (const record of state.records) {
    if (!ownRecord(record)) publishers.set(record.publisherId, (publishers.get(record.publisherId) ?? 0) + 1);
  }
  const choices = Array.from(publishers, ([id, records]) => {
    const card = element('div', undefined, 'record-card');
    card.append(toggleItem(`发布者 ${shortId(id)} · ${records} 条`, `source/${id}`,
      !state.excludedPublishers?.includes(id), async included => {
        await updateState(current => {
          const excluded = new Set(current.excludedPublishers);
          if (included) excluded.delete(id);
          else excluded.add(id);
          current.excludedPublishers = [...excluded];
        });
        status('publisher-status', included ? '已纳入此来源。' : '已从问答和汇总中移除此来源。');
      }, 'publisher-status'), element('span', id, 'source-meta'));
    return card;
  });
  replaceList('publisher-list', choices.length ? choices : [element('p', '收到资料后会列出发布者。', 'empty')]);
}

function applyState(next) {
  state = next;
  renderRecords();
  refreshReviewPickers();
  renderReviews();
  renderShare();
  renderAnswer();
}

function clearImport() {
  importPending = undefined;
  ++importRead;
  byId('import-preview').hidden = true;
  byId('import-bundle').value = '';
}

function mergeNotice(result) {
  return `新增 ${result.added} 条，更新 ${result.updated} 条，重复 ${result.duplicates} 条，旧版 ${result.stale} 条，版本冲突 ${result.conflicts} 条。`;
}

function renderSync(snapshot) {
  const labels = { disabled: '未开启', connecting: '连接中', ready: '网页在线', offline: '网络离线', error: '连接失败' };
  const connections = { connecting: '正在连接', awaiting: '等待对方确认', online: '双方在线', offline: '等待对方上线', error: '连接需重试' };
  const badge = byId('sync-badge');
  badge.textContent = labels[snapshot.status];
  badge.className = snapshot.status === 'ready' ? 'tag online' : snapshot.status === 'error' ? 'tag caution' : 'tag';
  byId('sync-toggle').textContent = snapshot.enabled ? '暂停同步' : '开启同步';
  byId('turn-fields').disabled = snapshot.enabled;
  byId('sync-tools').hidden = !snapshot.enabled;
  byId('sync-retry').hidden = !snapshot.enabled;
  byId('pair-code').value = snapshot.code;
  byId('pair-form').querySelector('button').disabled = snapshot.status !== 'ready';
  status('sync-status', snapshot.detail, snapshot.status === 'error');

  const requests = snapshot.requests.map(request => {
    const card = element('div', undefined, 'record-card');
    card.append(tag('等待你确认'), element('h3', request.outgoing ? '你发起的配对' : '收到新的配对请求'),
      element('p', request.id), element('span', `发布者 ${shortId(request.publisherId)}`, 'source-meta'));
    const controls = element('div', undefined, 'button-row');
    controls.append(action('确认配对', `accept/${request.id}`, () => sync.accept(request.id), 'sync-status', 'primary'),
      action('拒绝', `decline/${request.id}`, () => sync.decline(request.id), 'sync-status'));
    card.append(controls);
    return card;
  });
  replaceList('peer-requests', requests);
  const peers = snapshot.peers.map(peer => {
    const card = element('div', undefined, 'record-card');
    card.append(tag(snapshot.enabled ? connections[peer.connection] : '已暂停', peer.connection === 'online' ? 'online' : ''),
      element('h3', `同学网页 · ${peer.id.slice(4, 12)}`), element('p', peer.id, 'subtle'));
    if (peer.lastReceivedAt) {
      const time = new Date(peer.lastReceivedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const label = peer.conflicts ? `，其中 ${peer.conflicts} 条版本冲突` : '';
      card.append(element('p', `${time} 对方确认处理 ${peer.count} 条所选记录${label}。`, 'subtle'));
    }
    if (peer.error) card.append(element('p', peer.error, 'subtle'));
    card.append(action('解除配对', `remove/${peer.id}`, async () => {
      if (await askConfirmation('解除后，这个网页会停止接收你的后续版本。', '解除配对')) await sync.remove(peer.id);
    }, 'sync-status', 'danger'));
    return card;
  });
  replaceList('peer-list', peers);
}

function modelConfig() {
  const { endpoint, model, token } = formData(byId('model-form'));
  return { endpoint: endpoint.trim(), model: model.trim(), token: token.trim() };
}

function renderModelBadge() {
  const endpoint = byId('model-endpoint').value.trim();
  const model = byId('model-name').value.trim();
  const saved = state?.model.endpoint === endpoint && state?.model.model === model;
  let label = '按需连接';
  if (endpoint && model) label = saved ? '已保存连接设置' : '待确认';
  byId('model-badge').textContent = label;
}

async function askModel() {
  const config = modelConfig();
  if (!config.endpoint || !config.model) {
    byId('model-settings').open = true;
    byId('model-agent-copy').focus();
    status('model-agent-status', '复制指令发给 Agent，或展开手动设置。');
    return;
  }
  const result = queryFromForm(false);
  if (!result) throw new Error('请先加载公开资料索引。');
  const { question, scope } = lastQuery;
  const details = [scope.cohort && `届别 ${scope.cohort}`, scope.year && `学年 ${scope.year}`, scope.course && `科目 ${scope.course}`].filter(Boolean).join('，');
  const evidence = byId('model-personal').checked ? [...result.evidence, ...result.personalEvidence] : result.evidence;
  const controller = new AbortController();
  modelController = controller;
  status('question-status', '正在向你填写的模型请求回答。');
  try {
    const answer = await requestModel(config, details ? `${question}\n查询范围 ${details}` : question, evidence, { signal: controller.signal });
    if (controller.signal.aborted) return;
    byId('model-answer').textContent = answer;
    const provided = evidence.slice(0, 20).map(item => sourceRow(item));
    byId('model-sources').replaceChildren(...(provided.length ? provided : [element('li', '本次没有匹配的资料片段。')]));
    byId('model-result').hidden = false;
    status('question-status', '模型已返回文本答复。');
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    if (modelController === controller) modelController = undefined;
  }
}

window.addEventListener('hashchange', () => activatePage(true));
mountCourseWheel();
activatePage();

bindForm('question-form', 'question-status', () => queryFromForm());
for (const quick of document.querySelectorAll('[data-question]')) {
  quick.addEventListener('click', () => {
    byId('question').value = quick.dataset.question;
    queryFromForm();
  });
}
byId('topic-filter').addEventListener('change', renderKnowledge);

bindForm('intel-form', 'intel-status', form => {
  const { attachment, removeAttachment, ...data } = formData(form);
  return saveRecord('intel', data, attachment, Boolean(removeAttachment));
});
bindForm('review-form', 'review-status', form => {
  const { teacher, course, customCourse, customTeacher, level, year, cohort, clarity, feedback, pace, workload } = formData(form);
  const scores = Object.fromEntries(Object.entries({ clarity, feedback, pace })
    .filter(([, value]) => value).map(([key, value]) => [key, Number(value)]));
  return saveRecord('review', {
    course: isCustomReviewChoice(form.elements.course) ? customCourse : course,
    teacher: isCustomReviewChoice(form.elements.teacher) ? customTeacher : teacher,
    level, year, cohort, scores, workload,
  });
});
for (const kind of ['intel', 'review']) {
  bindButton(`cancel-${kind}-edit`, `${kind}-status`, () => {
    resetEditor(kind);
    status(`${kind}-status`, '已取消编辑。');
  });
}
const reviewFilterForm = byId('review-filters');
bindForm('review-filters', 'review-filter-status', form => applyReviewFilters(form, formData(form)));
bindReviewPicker(reviewFilterForm, () => applyReviewFilters(reviewFilterForm));
bindReviewPicker(byId('review-form'));
refreshReviewPickers();

const modelAgentCommand = byId('model-agent-command');
const modelPageUrl = new URL(location.href);
modelPageUrl.search = '';
modelPageUrl.hash = '';
modelAgentCommand.value = [
  `帮我连接 HSANNU ICC 百晓生。网页在 ${modelPageUrl.href}。`,
  '请从我已授权且允许浏览器调用的 Chat Completions 服务中确认完整的接口 URL 和模型 ID。',
  '连接码格式为 {"endpoint":"完整接口 URL","model":"模型 ID"}。',
  '如果能操作网页，请打开「连接我的 AI」，填写「Agent 连接码」并点击「导入连接码」。否则请把连接码作为一行 JSON 直接给我。',
  '访问令牌由我在网页里填写，测试连接和保存也由我确认后操作。',
].join('');

bindButton('model-agent-copy', 'model-agent-status', async () => {
  try {
    await navigator.clipboard.writeText(modelAgentCommand.value);
    status('model-agent-status', '已复制，可以发给你常用的 Agent。');
  } catch {
    byId('model-agent-instructions').open = true;
    modelAgentCommand.focus();
    modelAgentCommand.select();
    status('model-agent-status', '请用系统复制快捷键复制选中的指令。');
  }
});
bindForm('model-agent-form', 'model-agent-status', form => {
  if (byId('test-model').disabled) throw new Error('测试连接进行中，完成后可导入连接码。');
  const { endpoint, model } = parseModelConnectionCode(byId('model-agent-code').value);
  byId('model-endpoint').value = endpoint;
  byId('model-name').value = model;
  byId('model-token').value = '';
  byId('model-personal').checked = false;
  modelController?.abort();
  byId('model-result').hidden = true;
  byId('model-answer').textContent = '';
  byId('model-sources').replaceChildren();
  status('question-status', '');
  status('model-status', '');
  renderModelBadge();
  byId('model-manual-settings').open = true;
  form.reset();
  status('model-agent-status', '已填入接口和模型。请核对设置，需要时填写令牌，再测试连接。');
});
bindForm('model-form', 'model-status', async () => {
  const { endpoint, model } = modelConfig();
  if (Boolean(endpoint) !== Boolean(model)) throw new Error('请一起填写接口 URL 和模型名称。');
  if (endpoint && !safeHttpUrl(endpoint)) throw new Error('请填写有效的模型接口 URL。');
  await updateState(current => { current.model = { endpoint, model }; });
  renderModelBadge();
  status('model-status', endpoint ? '已保存接口与模型名称。' : '已清除连接设置。');
});
byId('model-endpoint').addEventListener('input', () => { byId('model-personal').checked = false; });
bindButton('test-model', 'model-status', async () => {
  status('model-status', '正在发送连接测试。');
  await requestModel(modelConfig(), '连接测试，请回复 OK。', []);
  status('model-status', '连接成功，模型已返回文本。');
});
bindButton('ask-model', 'question-status', askModel);

bindButton('export-bundle', 'bundle-status', async () => {
  const records = selectedRecords(await store.read());
  if (!records.length) throw new Error('请先勾选要下载的资料。');
  const blob = new Blob([JSON.stringify(makeBundle(records), null, 2)], { type: 'application/json' });
  download(blob, `hsannu-icc-${new Date().toISOString().slice(0, 10)}.json`);
  status('bundle-status', `已请求下载 ${records.length} 条所选记录。`);
});
byId('import-bundle').addEventListener('change', async event => {
  const file = event.target.files[0];
  const read = ++importRead;
  importPending = undefined;
  byId('import-preview').hidden = true;
  if (!file) return;
  try {
    if (!store) throw new Error('本机资料库不可用，请重开此页。');
    if (file.size > 16 * 1024 * 1024) throw new Error('资料包最多 16 MB。');
    const records = parseBundle(await file.text());
    if (read !== importRead) return;
    const incoming = records.filter(record => !ownRecord(record));
    if (!incoming.length) throw new Error('此资料包没有可从其他发布者接收的记录。');
    importPending = incoming;
    byId('import-summary').textContent = `预览 ${incoming.length} 条可接收的记录${incoming.length > 8 ? '（前 8 条见下方）' : ''}。`;
    byId('import-items').replaceChildren(...incoming.slice(0, 8).map(record => element('li',
      `${recordTitle(record)} · 发布者 ${shortId(record.publisherId)} · 第 ${record.version} 版`)));
    byId('import-preview').hidden = false;
    status('bundle-status', '核对来源后确认导入。');
  } catch (error) {
    if (read !== importRead) return;
    clearImport();
    status('bundle-status', error.message, true);
  }
});
bindButton('cancel-import', 'bundle-status', () => {
  clearImport();
  status('bundle-status', '已取消导入。');
});
bindButton('confirm-import', 'bundle-status', async () => {
  if (!importPending) return;
  const records = importPending;
  let result;
  await updateState(current => {
    result = mergeRecords(current.records, records.filter(record => record.publisherId !== current.publisherId));
    current.records = result.records;
  });
  if (importPending === records) clearImport();
  status('bundle-status', `导入完成。 ${mergeNotice(result)}`);
});

for (const id of ['turn-url', 'turn-username', 'turn-credential']) byId(id).value = '';
bindButton('sync-toggle', 'sync-status', async () => {
  if (!sync) throw new Error('本机资料库不可用，请重开此页。');
  if (sync.getSnapshot().enabled) await sync.stop();
  else {
    const turn = {
      url: byId('turn-url').value,
      username: byId('turn-username').value,
      credential: byId('turn-credential').value,
    };
    await sync.start({ turn });
  }
  renderSync(sync.getSnapshot());
});
bindButton('sync-retry', 'sync-status', () => sync.retry());
bindButton('copy-code', 'sync-status', async () => {
  const code = byId('pair-code');
  try {
    await navigator.clipboard.writeText(code.value);
    status('sync-status', '已复制本机配对码。');
  } catch {
    code.select();
    status('sync-status', '请用系统复制快捷键复制选中的配对码。');
  }
});
bindForm('pair-form', 'sync-status', async form => {
  await sync.pair(form.elements.peerCode.value);
});

void loadKnowledge().then(loaded => {
  index = loaded;
  const filter = byId('topic-filter');
  for (const topic of index.topics) {
    const option = element('option', topic.title);
    option.value = topic.id;
    filter.append(option);
  }
  byId('knowledge-date').textContent = `核对至 ${index.asOf}`;
  byId('knowledge-sources').replaceChildren(...index.sources.map(sourceRow));
  renderKnowledge();
  refreshReviewPickers();
  renderReviews();
  renderAnswer();
}).catch(() => {
  status('question-status', '公开索引暂不可用。请打开资料页的公开知识正文。', true);
  renderKnowledge();
});

void openStore().then(async opened => {
  store = opened;
  applyState(await store.read());
  const endpoint = byId('model-endpoint');
  const model = byId('model-name');
  if (!endpoint.value && !model.value) {
    endpoint.value = state.model.endpoint;
    model.value = state.model.model;
  }
  renderModelBadge();
  sync = createSync({
    store, onChange: renderSync,
    onReceive: (result, next) => {
      applyState(next);
      status('sync-receipt', `收到配对资料。 ${mergeNotice(result)}`);
    },
  });
  if (state.syncEnabled) await sync.start();
}).catch(() => {
  status('sync-status', '本机资料库不可用，公开资料仍可浏览。', true);
});
