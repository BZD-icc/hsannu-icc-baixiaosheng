// PLAYWRIGHT_MODULE can point to an existing Playwright installation.
// CHROME_EXECUTABLE can point to an existing Chrome binary.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../web', import.meta.url));
const reports = fileURLToPath(new URL('../reports', import.meta.url));
const types = {
  '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript',
  '.json': 'application/json', '.md': 'text/markdown', '.mjs': 'text/javascript', '.txt': 'text/plain',
};
const question = '我这届有哪些 HL 可选，去哪里核对实际开课？';
const sampleNotice = {
  title: '虚构 2027 届物理 HL 选课通知', summary: '独立测试样例：物理 HL 第二轮选课。',
  sourceType: 'school', cohort: '2027 届', year: '2026-2027', topic: '物理 HL 选课',
  url: 'https://example.test/fictional-course-notice', date: '2026-11-07',
};
const privateTitle = '虚构备忘：仅本人保存的经济 HL 选课线索';
const attachmentName = 'local-demo-attachment.txt';
const attachmentText = 'SAMPLE-ATTACHMENT-CONTENT';
const sampleToken = 'sample-browser-test-token';
const sampleReview = { teacher: '虚构教师甲', course: '物理', level: 'HL', year: '2026-2027', cohort: '2027 届' };

let browser;
let app;
let model;
let modelStatus;
const requests = [];

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

before(async () => {
  app = await listen(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const file = join(root, pathname === '/' ? 'index.html' : pathname);
      if (!file.startsWith(root + sep)) throw new Error('Outside test server');
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': `${types[extname(file)] || 'text/plain'}; charset=utf-8` });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  model = await listen(async (request, response) => {
    const headers = {
      'Access-Control-Allow-Origin': app.origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Content-Type': 'application/json',
    };
    if (request.url !== '/v1/chat/completions') return response.writeHead(404, headers).end();
    if (request.method === 'OPTIONS') return response.writeHead(204, headers).end();
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    response.writeHead(modelStatus, headers).end(JSON.stringify(modelStatus === 200
      ? { choices: [{ message: { content: '测试模型已收到问题与证据。' } }] }
      : { error: 'Synthetic error response' }));
  });
  await mkdir(reports, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE });
});

after(async () => {
  await browser?.close();
  await Promise.all([app, model].filter(Boolean).map(({ server }) => new Promise(resolve => server.close(resolve))));
});

const tabNames = { ask: '问答', courses: '课程', library: '资料', reviews: '选课评价', share: '分享与同步' };

async function openTab(page, name) {
  await page.getByRole('navigation').getByRole('link', { name: tabNames[name], exact: true }).click();
  await page.locator(`#${name}`).waitFor({ state: 'visible' });
}

async function visible(page, selector, content) {
  await page.locator(selector).filter({ hasText: content }).waitFor({ state: 'visible' });
}

function input(scope, name) {
  return scope.locator(`[name="${name}"]`);
}

async function addNotice(page, values = sampleNotice, attachment = false) {
  await openTab(page, 'library');
  const form = page.locator('#intel-form');
  for (const [name, value] of Object.entries(values)) {
    if (name === 'sourceType') await input(form, name).selectOption(value);
    else await input(form, name).fill(value);
  }
  if (attachment) {
    await input(form, 'attachment').setInputFiles({ name: attachmentName, mimeType: 'text/plain', buffer: Buffer.from(attachmentText) });
  }
  await form.getByRole('button', { name: '保存资料' }).click();
  await visible(page, '#intel-list', values.title);
}

async function showCourseReviews(page, course) {
  await openTab(page, 'reviews');
  await input(page.locator('#review-filters'), 'course').selectOption(course);
}

async function addReview(page, scores, values = sampleReview, customCourse = false) {
  await openTab(page, 'reviews');
  const form = page.locator('#review-form');
  const { course, teacher, ...details } = values;
  await input(form, 'course').selectOption(customCourse ? ':other:' : course);
  if (customCourse) await input(form, 'customCourse').fill(course);
  const teachers = input(form, 'teacher');
  const available = await teachers.locator('option').evaluateAll(options => options.map(option => option.value));
  await teachers.selectOption(available.includes(teacher) ? teacher : ':other:');
  if (!available.includes(teacher)) await input(form, 'customTeacher').fill(teacher);
  for (const [name, value] of Object.entries(details)) {
    if (name === 'level') await input(form, name).selectOption(value);
    else await input(form, name).fill(value);
  }
  for (const [name, value] of Object.entries(scores)) await input(form, name).selectOption(value);
  await input(form, 'taken').check();
  await form.getByRole('button', { name: '保存评价' }).click();
  await visible(page, '#review-list', teacher);
  await showCourseReviews(page, course);
  await visible(page, '#review-groups', teacher);
}

async function shareNotice(page) {
  await openTab(page, 'share');
  const notice = page.locator('#share-list .record-card').filter({ hasText: sampleNotice.title });
  await notice.getByRole('checkbox').check();
  await visible(page, '#selection-count', /1\s*条已选/);
}

async function exportBundle(page) {
  const download = page.waitForEvent('download');
  await page.locator('#export-bundle').click();
  return readFile(await (await download).path(), 'utf8');
}

async function ask(page, query) {
  await openTab(page, 'ask');
  await page.locator('#question').fill(query);
  await page.getByRole('button', { name: /查资料/ }).click();
}

async function openManualModelSettings(page) {
  await page.locator('#model-settings > summary').click();
  await page.locator('#model-manual-settings > summary').click();
}

async function importBundle(page, json, previewTitle) {
  await openTab(page, 'share');
  await page.locator('#import-bundle').setInputFiles({
    name: 'sample.json', mimeType: 'application/json', buffer: Buffer.from(json),
  });
  await page.locator('#import-preview').waitFor({ state: 'visible' });
  if (previewTitle) await visible(page, '#import-preview', previewTitle);
  await page.locator('#confirm-import').click();
  await page.locator('#import-preview').waitFor({ state: 'hidden' });
}

function testPeerRelay() {
  const peers = new Map();
  const frames = [];
  const configurations = [];
  const deliver = (page, frame) => page.evaluate(message => globalThis.receiveTestPeerFrame(message), frame);

  return {
    frames,
    configurations,
    async configure(context) {
      await context.route('**/vendor/peerjs.min.js', route => route.fulfill({
        path: fileURLToPath(new URL('./peer-transport.js', import.meta.url)),
        contentType: 'text/javascript',
      }));
      await context.exposeBinding('testPeerRelay', async ({ page }, frame) => {
        if (frame.type === 'register') {
          peers.set(frame.from, page);
          configurations.push(frame.data);
          return true;
        }
        if (frame.type === 'unregister') {
          if (peers.get(frame.from) === page) peers.delete(frame.from);
          return true;
        }
        const target = peers.get(frame.to);
        if (!target || target.isClosed()) return false;
        if (frame.type === 'connect') {
          await deliver(target, { ...frame, type: 'incoming' });
          await Promise.all([deliver(page, { ...frame, type: 'ready' }), deliver(target, { ...frame, type: 'ready' })]);
          await Promise.all([deliver(page, { ...frame, type: 'open' }), deliver(target, { ...frame, type: 'open' })]);
        } else {
          if (frame.type === 'data') frames.push(frame);
          await deliver(target, frame);
        }
        return true;
      });
    },
  };
}

async function enableSync(page) {
  await openTab(page, 'share');
  await page.locator('#sync-toggle').click();
  await visible(page, '#sync-status', /在线|可以配对/);
  const code = await page.locator('#pair-code').inputValue();
  assert.match(code, /^icc-[0-9a-f]{32}$/);
  return code;
}

async function waitForRecord(page, id, version, state) {
  await page.waitForFunction(async ({ id, version, state }) => {
    const { openStore } = await import('/store.mjs');
    globalThis.testStore ??= await openStore();
    const workspace = await globalThis.testStore.read();
    return workspace.records.some(record => record.id === id && record.version === version && record.state === state);
  }, { id, version, state }, { timeout: 22_000, polling: 300 });
}

async function checkInitialQuestion(page) {
  await page.locator('#knowledge-date').filter({ hasText: '核对至' }).waitFor({ state: 'attached' });
  const input = page.locator('#question');
  assert.equal(await input.inputValue(), '');
  assert.doesNotMatch(await input.getAttribute('placeholder') ?? '', /\bHL\b/);
  assert.equal(await page.getByRole('button', { name: '本届 HL', exact: true }).count(), 0);
  assert(await page.getByRole('button', { name: '招生简章', exact: true }).isVisible());
  assert(await page.getByRole('button', { name: 'EE 2027', exact: true }).isVisible());
  const answer = await page.locator('#answer-title, #answer-text').allTextContents();
  assert.doesNotMatch(answer.join(' '), /\bHL\b|当届实际选课表/);
  assert.equal(await page.locator('#answer-sources a').count(), 0);
}

test('desktop and mobile start with a blank question and cite sources after submission', async () => {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await desktop.newPage();
    await page.goto(app.origin);
    await checkInitialQuestion(page);
    await page.screenshot({ path: join(reports, 'icc-desktop.png'), fullPage: true, animations: 'disabled' });
    await ask(page, question);
    await visible(page, '#answer-text', /没有找到当届实际选课表/);
    await visible(page, '#answer-text', /2026 招生海报标有 HL/);
    await page.locator('#answer-sources a[href*="/5141.html"]').waitFor();
    await page.locator('#answer-sources a[href*="find-an-ib-school"]').waitFor();
    const phone = await mobile.newPage();
    await phone.goto(app.origin);
    await checkInitialQuestion(phone);
    assert(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await phone.screenshot({ path: join(reports, 'icc-mobile.png'), fullPage: true, animations: 'disabled' });
    await ask(phone, '2027 EE 是不是 34 分？');
    await visible(phone, '#answer-text', /合计 30 分/);
    await phone.locator('#answer-sources a[href*="dp-extended-essay-updates"]').waitFor();
  } finally {
    await Promise.all([desktop.close(), mobile.close()]);
  }
});

const ibSubjects = {
  '语言与文学': ['中文 A', '英语 A'],
  '语言习得': ['中文 B', '英语 B'],
  '个人与社会': ['经济', '商管', '数字社会'],
  '科学': ['化学', '物理', '生物'],
  '数学': ['数学'],
  '艺术': ['美术'],
};

const igcseSubjects = {
  '语言': ['ESL', 'EFL', 'Chinese First', 'Chinese Second'],
  '数学': ['数学'],
  '科学': ['物理', '化学', 'Coordinated Science'],
  '经济与社会': ['经济'],
  '艺术': ['美术'],
};

async function checkCourseProgramme(page, name, expected) {
  const entries = Object.entries(expected);
  const count = entries.flatMap(([, subjects]) => subjects).length;
  await visible(page, '#course-meta', new RegExp(`${entries.length}\\s*组`));
  await visible(page, '#course-meta', new RegExp(`${count}\\s*门`));
  for (const programme of ['ib', 'igcse']) {
    const control = page.locator(`button[data-course-program="${programme}"]`);
    assert.equal(await control.getAttribute('aria-pressed'), String(programme === name));
  }
  const wheel = page.locator('svg#course-wheel, #course-wheel svg');
  assert(await wheel.isVisible());
  assert((await wheel.locator('path').count()) >= entries.length);
  const wheelLabels = (await wheel.locator('text').allTextContents()).join(' ');
  const groups = page.locator('#course-groups');
  assert.deepEqual(
    (await groups.getByRole('heading').allTextContents()).map(label => label.trim()).sort(),
    Object.keys(expected).sort(),
  );
  for (const [label, subjects] of entries) {
    assert(wheelLabels.includes(label), `轮盘缺少分组 ${label}`);
    const heading = groups.getByRole('heading', { name: label, exact: true });
    assert(await heading.isVisible());
    const group = heading.locator('xpath=ancestor::*[ul or ol][1]');
    const labels = await group.locator(':scope > :is(ul, ol) > li').allTextContents();
    assert.deepEqual(labels.map(value => value.trim()).sort(), [...subjects].sort(), label);
  }
}

test('course wheel groups the supplied subjects and supports mobile keyboard switching and history', async () => {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const mobile = await browser.newContext({ viewport: { width: 320, height: 760 }, isMobile: true, hasTouch: true });
  const outbound = [];
  try {
    for (const context of [desktop, mobile]) {
      await context.route('**/*', route => {
        const origin = new URL(route.request().url()).origin;
        if (origin === app.origin) return route.continue();
        outbound.push(origin);
        return route.abort();
      });
    }
    const page = await desktop.newPage();
    await page.goto(app.origin + '/#courses');
    await page.locator('#courses-title').waitFor({ state: 'visible', timeout: 3000 });
    const courseLink = page.getByRole('navigation').getByRole('link', { name: '课程', exact: true });
    assert.equal(await courseLink.getAttribute('aria-current'), 'page');
    await visible(page, '#course-source', /同学提供/);
    await page.locator('#course-source a[href*="ibo.org"]').waitFor();
    await checkCourseProgramme(page, 'ib', ibSubjects);
    await page.screenshot({ path: join(reports, 'icc-course-wheel-desktop.png'), fullPage: true, animations: 'disabled' });

    const phone = await mobile.newPage();
    await phone.goto(app.origin);
    await openTab(phone, 'courses');
    await checkCourseProgramme(phone, 'ib', ibSubjects);
    const igcse = phone.locator('button[data-course-program="igcse"]');
    await igcse.focus();
    await igcse.press('Space');
    await checkCourseProgramme(phone, 'igcse', igcseSubjects);
    await visible(phone, '#course-source', /同学提供/);
    await visible(phone, '#course-source', /按学科/);
    assert(await igcse.evaluate(button => button === document.activeElement));
    assert(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await phone.screenshot({ path: join(reports, 'icc-course-wheel-mobile.png'), fullPage: true, animations: 'disabled' });

    await phone.goBack();
    await phone.locator('#ask').waitFor();
    await phone.goForward();
    await phone.locator('#courses').waitFor();
    const phoneCourseLink = phone.getByRole('navigation').getByRole('link', { name: '课程', exact: true });
    assert.equal(await phoneCourseLink.getAttribute('aria-current'), 'page');
    assert.deepEqual(outbound, []);
  } finally {
    await Promise.all([desktop.close(), mobile.close()]);
  }
});

test('mobile reviews select a subject before a teacher and preserve custom and imported records', async () => {
  const context = await browser.newContext({ viewport: { width: 320, height: 760 }, isMobile: true, hasTouch: true });
  try {
    await context.route('**/*', route =>
      new URL(route.request().url()).origin === app.origin ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(app.origin + '/#courses');
    await page.locator('#courses-title').waitFor();
    assert.equal(await page.locator('#staff-directory').count(), 0);
    assert.doesNotMatch(await page.locator('#courses').innerText(), /任课教师|\b(?:NP|MR)\b/);

    await openTab(page, 'library');
    await page.locator('#topic-filter').selectOption('staff');
    await visible(page, '#knowledge-list', /图书管理员.*VG/s);
    assert.doesNotMatch(await page.locator('#knowledge-list').innerText(), /代号|\b(?:NP|MR)\b/);
    assert.equal(await page.locator('#knowledge-list .record-card').count(), 5);

    await openTab(page, 'reviews');
    const editor = page.locator('#review-form');
    const filters = page.locator('#review-filters');
    for (const form of [filters, editor]) {
      const course = input(form, 'course');
      const teacher = input(form, 'teacher');
      assert.deepEqual(await form.locator('select').evaluateAll(selects => selects.slice(0, 2).map(select => select.name)),
        ['course', 'teacher']);
      assert(await teacher.isDisabled());
      await course.selectOption('物理');
      assert(await teacher.isEnabled());
      const names = (await teacher.locator('option').allTextContents()).map(name => name.trim());
      for (const name of ['MR', 'CW', 'SH']) assert(names.includes(name));
      assert.doesNotMatch(names.join(' '), /代号|\b(?:NP|DM|VG)\b/);
      await teacher.selectOption('CW');
      await course.selectOption('化学');
      assert.equal(await teacher.inputValue(), '');
      const chemistry = await teacher.locator('option').allTextContents();
      for (const name of ['NP', 'DM']) assert(chemistry.includes(name));
      assert.doesNotMatch(chemistry.join(' '), /\b(?:MR|CW|SH|VG)\b/);
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

    for (const teacher of ['MR', 'CW']) {
      await addReview(page, { clarity: '4' }, { ...sampleReview, teacher });
    }
    await visible(page, '#review-count', /2\s*条/);
    await input(filters, 'teacher').selectOption('MR');
    await visible(page, '#review-groups', /物理.*MR/s);
    assert.doesNotMatch(await page.locator('#review-groups').innerText(), /\bCW\b/);
    await visible(page, '#review-count', /1\s*条/);
    await showCourseReviews(page, '化学');
    await visible(page, '#review-count', /0\s*条/);

    const custom = { ...sampleReview, course: '虚构课程', teacher: '虚构教师乙' };
    await addReview(page, { clarity: '5' }, custom, true);
    assert(await input(editor, 'teacher').isDisabled());
    await input(filters, 'teacher').selectOption(custom.teacher);
    await visible(page, '#review-groups', /虚构课程.*虚构教师乙/s);
    const ownReview = page.locator('#review-list .record-card').filter({ hasText: custom.teacher });
    await ownReview.getByRole('button', { name: /更正|编辑/ }).click();
    for (const [name, manual] of [['course', 'customCourse'], ['teacher', 'customTeacher']]) {
      const chosen = await input(editor, name).inputValue();
      const value = chosen === ':other:' ? await input(editor, manual).inputValue() : chosen;
      assert.equal(value, custom[name]);
    }
    await editor.getByRole('button', { name: '取消编辑' }).click();
    assert.equal(await input(editor, 'course').inputValue(), '');
    assert(await input(editor, 'teacher').isDisabled());

    const oldBundle = JSON.parse(await readFile(join(root, 'knowledge', '选课评价示例.json'), 'utf8'));
    const oldCourse = '旧版自由填写科目';
    oldBundle.records[0].data.course = oldCourse;
    oldBundle.records = oldBundle.records.slice(0, 1);
    const oldTeacher = oldBundle.records[0].data.teacher;
    await importBundle(page, JSON.stringify(oldBundle), oldTeacher);
    await showCourseReviews(page, oldCourse);
    await input(filters, 'teacher').selectOption(oldTeacher);
    await visible(page, '#review-groups', oldTeacher);
    assert.doesNotMatch(await page.locator('#review-groups').innerText(), /虚构教师乙/);
  } finally {
    await context.close();
  }
});

test('Agent connection instructions import settings without transmitting or storing credentials', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await context.route('**/*', route => {
      const origin = new URL(route.request().url()).origin;
      return origin === app.origin || origin === model.origin ? route.continue() : route.abort();
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        value: async text => {
          if (globalThis.testClipboardUnavailable) throw new Error('Synthetic clipboard denial');
          globalThis.testCopiedInstruction = text;
        },
      });
    });
    const page = await context.newPage();
    const outbound = [];
    page.on('request', request => {
      const origin = new URL(request.url()).origin;
      if (origin !== app.origin) outbound.push(origin);
    });
    await page.goto(app.origin);
    await page.locator('#model-settings > summary').click();
    const copy = page.locator('#model-agent-copy');
    await copy.waitFor({ state: 'visible', timeout: 3000 });
    const manual = page.locator('#model-manual-settings');
    const endpointInput = page.locator('#model-endpoint');
    const modelInput = page.locator('#model-name');
    const tokenInput = page.locator('#model-token');
    const personalOptIn = page.locator('#model-personal');
    assert(!(await endpointInput.isVisible()));

    await manual.locator('summary').click();
    const previous = { endpoint: model.origin + '/old-model', model: 'previous-model' };
    await endpointInput.fill(previous.endpoint);
    await modelInput.fill(previous.model);
    await tokenInput.fill(sampleToken);
    await personalOptIn.check();
    await page.getByRole('button', { name: '保存连接设置' }).click();
    await visible(page, '#model-badge', '已保存连接设置');

    await copy.click();
    await page.waitForFunction(() => typeof globalThis.testCopiedInstruction === 'string');
    const instruction = await page.evaluate(() => globalThis.testCopiedInstruction);
    const instructionField = page.locator('#model-agent-command');
    assert.equal(await instructionField.inputValue(), instruction);
    assert(await instructionField.evaluate(field => field.readOnly));
    assert(instruction.includes(app.origin));
    assert.match(instruction, /"endpoint"/);
    assert.match(instruction, /"model"/);
    assert(!instruction.includes(sampleToken));
    await page.evaluate(() => { globalThis.testClipboardUnavailable = true; });
    await copy.click();
    await instructionField.waitFor({ state: 'visible' });
    assert(await instructionField.evaluate(field => field.selectionStart === 0 && field.selectionEnd === field.value.length));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

    const form = page.locator('#model-agent-form');
    const code = page.locator('#model-agent-code');
    const submit = form.locator('button[type="submit"]');
    const status = page.locator('#model-agent-status');
    const next = { endpoint: model.origin + '/v1/chat/completions', model: 'agent-selected-model' };
    const requestsBeforeImport = requests.length;
    for (const invalid of [
      '{invalid',
      JSON.stringify({ ...next, token: sampleToken }),
      JSON.stringify({ ...next, endpoint: 'http://example.test/v1/chat/completions' }),
      JSON.stringify({ ...next, endpoint: 'javascript:alert(1)' }),
      JSON.stringify({ ...next, endpoint: `${next.endpoint}?token=${sampleToken}` }),
    ]) {
      await code.fill(invalid);
      await submit.click();
      await page.locator('#model-agent-status[data-error="true"]').waitFor({ state: 'visible' });
      assert(!(await status.innerText()).includes(sampleToken));
      assert.equal(await endpointInput.inputValue(), previous.endpoint);
      assert.equal(await modelInput.inputValue(), previous.model);
      assert.equal(await tokenInput.inputValue(), sampleToken);
      assert(await personalOptIn.isChecked());
      assert.equal(requests.length, requestsBeforeImport);
      assert.equal(outbound.length, 0);
    }

    await manual.locator('summary').click();
    await code.fill(JSON.stringify(next));
    await submit.click();
    await page.locator('#model-agent-status[data-error="false"]').waitFor({ state: 'visible' });
    assert(await endpointInput.isVisible());
    assert.equal(await endpointInput.inputValue(), next.endpoint);
    assert.equal(await modelInput.inputValue(), next.model);
    assert.equal(await tokenInput.inputValue(), '');
    assert(!(await personalOptIn.isChecked()));
    assert.equal(requests.length, requestsBeforeImport);
    assert.equal(outbound.length, 0);
    const saved = await page.evaluate(async () => {
      const { openStore } = await import('/store.mjs');
      return (await (await openStore()).read()).model;
    });
    assert.deepEqual(saved, previous);

    modelStatus = 200;
    await page.locator('#test-model').click();
    await visible(page, '#model-status', /成功|已连接|连接可用/);
    assert.equal(requests.length, requestsBeforeImport + 1);
    assert.equal(requests.at(-1).body.model, next.model);
    assert.equal(requests.at(-1).headers.authorization, undefined);
  } finally {
    await context.close();
  }
});

test('browser persists notes and reviews, limits export, and handles model success and failure', async () => {
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(app.origin);
    await addNotice(page, sampleNotice, true);
    await addNotice(page, { ...sampleNotice, title: privateTitle, summary: '本机保留的另一条样例。' });
    await addReview(page, { clarity: '5', feedback: '2', workload: 'heavy' });
    await addReview(page, { clarity: '3', pace: '4', workload: 'light' });
    await visible(page, '#review-count', /2\s*条/);

    modelStatus = 200;
    await ask(page, question);
    await openManualModelSettings(page);
    await page.locator('#model-endpoint').fill(`${model.origin}/v1/chat/completions`);
    await page.locator('#model-name').fill('sample-model');
    await page.locator('#model-token').fill(sampleToken);
    await page.getByRole('button', { name: '保存连接设置' }).click();
    await page.locator('#test-model').click();
    await visible(page, '#model-status', /成功|已连接|连接可用/);
    await page.locator('#ask-model').click();
    await visible(page, '#model-answer', '测试模型已收到问题与证据。');
    const { body, headers } = requests.at(-1);
    assert.equal(headers.origin, app.origin);
    assert.equal(headers.authorization, `Bearer ${sampleToken}`);
    assert.equal(headers.cookie, undefined);
    assert.equal(body.model, 'sample-model');
    assert.equal(body.stream, false);
    const prompt = JSON.parse(body.messages.find(message => message.role === 'user').content);
    assert.equal(prompt.question, question);
    assert(prompt.evidence.some(item => /2026/.test(item.title)));
    assert(!JSON.stringify(prompt).includes(sampleNotice.title));

    await page.locator('#model-personal').check();
    const optedInRequest = page.waitForResponse(response => response.url().startsWith(model.origin) && response.request().method() === 'POST');
    await page.locator('#ask-model').click();
    await optedInRequest;
    const withPersonal = JSON.parse(requests.at(-1).body.messages.find(message => message.role === 'user').content);
    const personalEvidence = withPersonal.evidence.find(item => item.title === sampleNotice.title);
    assert.equal(personalEvidence?.cohort, sampleNotice.cohort);
    assert.equal(personalEvidence.date, sampleNotice.date);
    assert.equal(personalEvidence.url, sampleNotice.url);
    assert(!JSON.stringify(requests.at(-1).body).includes(attachmentText));

    modelStatus = 401;
    await page.locator('#test-model').click();
    await visible(page, '#model-status', 'HTTP 401');
    assert(!(await page.locator('#model-status').innerText()).includes(sampleToken));

    await shareNotice(page);
    const exported = await exportBundle(page);
    const bundle = JSON.parse(exported);
    assert.equal(bundle.records.length, 1);
    assert.equal(bundle.records[0].data.title, sampleNotice.title);
    for (const excluded of [privateTitle, sampleReview.teacher, sampleToken, attachmentName, attachmentText]) {
      assert(!exported.includes(excluded), `Unexpected private field in export: ${excluded}`);
    }

    await page.locator('#import-bundle').setInputFiles({
      name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{'),
    });
    await visible(page, '#bundle-status', /无法读取|无效|格式/);
    await page.reload();
    await visible(page, '#selection-count', /1\s*条已选/);
    await openTab(page, 'library');
    await visible(page, '#intel-list', sampleNotice.title);
    await visible(page, '#intel-list', privateTitle);
    await visible(page, '#intel-list', attachmentName);
    await showCourseReviews(page, sampleReview.course);
    await visible(page, '#review-count', /2\s*条/);
    await visible(page, '#review-groups', /4\.0/);
    await openTab(page, 'ask');
    await visible(page, '#model-badge', '已保存连接设置');
    await openManualModelSettings(page);
    assert.equal(await page.locator('#model-name').inputValue(), 'sample-model');
    assert.equal(await page.locator('#model-token').inputValue(), '');
    assert.equal(await page.locator('#model-personal').isChecked(), false);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test('two isolated contexts confirm both ends, deduplicate and resync after disconnect (mock transport)', async () => {
  const relay = testPeerRelay();
  const author = await browser.newContext({ acceptDownloads: true });
  const recipient = await browser.newContext();
  await Promise.all([relay.configure(author), relay.configure(recipient)]);
  try {
    const alice = await author.newPage();
    const bob = await recipient.newPage();
    await Promise.all([alice.goto(app.origin), bob.goto(app.origin)]);
    await openManualModelSettings(alice);
    await alice.locator('#model-token').fill(sampleToken);
    await addNotice(alice, sampleNotice, true);
    await addNotice(alice, { ...sampleNotice, title: privateTitle, summary: '不分享的选课线索。' });
    await shareNotice(alice);
    const oldPackage = await exportBundle(alice);
    const original = JSON.parse(oldPackage).records[0];
    await importBundle(bob, oldPackage, sampleNotice.title);
    await waitForRecord(bob, original.id, 1, 'active');

    const [aliceCode, bobCode] = await Promise.all([enableSync(alice), enableSync(bob)]);
    assert.notEqual(aliceCode, bobCode);
    await alice.locator('#peer-code').fill('bad-pair-code');
    await alice.getByRole('button', { name: '发起配对' }).click();
    await visible(alice, '#sync-status', /有效配对码/);
    await alice.locator('#peer-code').fill(bobCode);
    await alice.getByRole('button', { name: '发起配对' }).click();

    const confirmation = page => page.locator('#peer-requests').getByRole('button', { name: /确认配对|接受|同意/ });
    await Promise.all([confirmation(alice).waitFor(), confirmation(bob).waitFor()]);
    await confirmation(alice).click();
    await confirmation(alice).waitFor({ state: 'hidden' });
    assert.equal(relay.frames.filter(frame => frame.data.type === 'part').length, 0);
    await confirmation(bob).click();
    await visible(alice, '#peer-list', /在线|已同步/);
    await visible(bob, '#peer-list', /在线|已同步/);
    await visible(alice, '#peer-list', /确认处理 1 条所选记录/);
    await openTab(bob, 'library');
    await visible(bob, '#intel-count', /1\s*条/);
    await visible(bob, '#intel-list', sampleNotice.title);
    assert(!(await bob.locator('#intel-list').innerText()).includes(privateTitle));
    assert(!(await bob.locator('#intel-list').innerText()).includes(attachmentName));

    await openTab(bob, 'share');
    const publisher = bob.locator('#publisher-list .record-card').filter({ hasText: original.publisherId }).getByRole('checkbox');
    await publisher.uncheck();
    await visible(bob, '#publisher-status', /移除/);
    await ask(bob, '2027届有哪些 HL 可选？');
    assert(!(await bob.locator('.answer-panel').innerText()).includes(sampleNotice.title));
    await openTab(bob, 'share');
    await publisher.check();
    await visible(bob, '#publisher-status', /已纳入/);

    await addReview(bob, { clarity: '5', feedback: '2', workload: 'heavy' });
    await openTab(bob, 'share');
    await bob.locator('#share-list .record-card').filter({ hasText: sampleReview.teacher }).getByRole('checkbox').check();
    await showCourseReviews(alice, sampleReview.course);
    await visible(alice, '#review-groups', sampleReview.teacher);

    await openTab(bob, 'share');
    await bob.locator('#sync-toggle').click();
    await visible(bob, '#sync-badge', /未开启|已关闭/);
    await openTab(alice, 'library');
    const aliceNotice = alice.locator('#intel-list .record-card').filter({ hasText: sampleNotice.title });
    await aliceNotice.getByRole('button', { name: /更正|编辑/ }).click();
    const correctedText = '模拟更正：物理 HL 改到第三轮选课。';
    await input(alice.locator('#intel-form'), 'summary').fill(correctedText);
    await alice.locator('#intel-form button[type="submit"]').click();
    await visible(alice, '#intel-list', correctedText);
    await bob.reload();
    assert.equal(await enableSync(bob), bobCode);
    await waitForRecord(bob, original.id, 2, 'active');
    await ask(bob, '2027届有哪些 HL 可选？');
    await visible(bob, '#answer-text', correctedText);
    await bob.locator(`#answer-matches a[href="${sampleNotice.url}"], #answer-sources a[href="${sampleNotice.url}"]`).waitFor();

    await openTab(alice, 'library');
    await aliceNotice.getByRole('button', { name: '撤回', exact: true }).click();
    await alice.locator('#confirm-action').click();
    await waitForRecord(bob, original.id, 3, 'withdrawn');
    await importBundle(bob, oldPackage);
    await visible(bob, '#bundle-status', '旧版 1 条');
    await waitForRecord(bob, original.id, 3, 'withdrawn');
    await ask(bob, '2027届有哪些 HL 可选？');
    assert(!(await bob.locator('.answer-panel').innerText()).includes(sampleNotice.title));

    const sent = JSON.stringify(relay.frames.filter(frame => frame.data.type === 'part'));
    assert(sent.includes(sampleNotice.title));
    assert(sent.includes(sampleReview.teacher));
    assert(!sent.includes(privateTitle));
    assert(!sent.includes(attachmentName));
    assert(!sent.includes(attachmentText));
    assert(!sent.includes(sampleToken));
  } finally {
    await Promise.all([author.close(), recipient.close()]);
  }
});

test('optional TURN validates inputs, configures Peer and keeps credentials in the current page', async () => {
  const relay = testPeerRelay();
  const context = await browser.newContext({ acceptDownloads: true });
  await relay.configure(context);
  try {
    const page = await context.newPage();
    await page.goto(app.origin);
    await addNotice(page);
    await shareNotice(page);
    await page.locator('#turn-settings summary').click();
    await page.locator('#turn-url').fill('https://turn.example.test');
    await page.locator('#sync-toggle').click();
    await visible(page, '#sync-status', /TURN|turn:/i);
    await visible(page, '#sync-badge', '未开启');
    assert.equal(relay.configurations.length, 0);

    const url = 'turns:relay.example.test:443?transport=tcp';
    const username = 'sample-turn-user';
    const credential = 'sample-turn-credential';
    await page.locator('#turn-url').fill(url);
    await page.locator('#turn-username').fill(username);
    await page.locator('#sync-toggle').click();
    await visible(page, '#sync-status', /用户名|凭证/);
    assert.equal(relay.configurations.length, 0);

    await page.locator('#turn-credential').fill(credential);
    const code = await enableSync(page);
    const configured = relay.configurations.at(-1).config.iceServers;
    assert(configured.some(server => server.urls === url && server.username === username && server.credential === credential));
    assert(await page.locator('#turn-url').isDisabled());

    const exported = await exportBundle(page);
    assert.equal(JSON.parse(exported).records[0].data.title, sampleNotice.title);
    const persisted = await page.evaluate(async () => {
      const { openStore } = await import('/store.mjs');
      return JSON.stringify({ workspace: await (await openStore()).read(), localStorage, sessionStorage });
    });
    for (const value of [url, username, credential]) {
      assert(!persisted.includes(value));
      assert(!exported.includes(value));
    }

    await page.reload();
    await visible(page, '#sync-status', /在线|可以配对/);
    assert.equal(await page.locator('#pair-code').inputValue(), code);
    for (const id of ['turn-url', 'turn-username', 'turn-credential']) {
      assert.equal(await page.locator(`#${id}`).inputValue(), '');
    }
    assert(!JSON.stringify(relay.configurations.at(-1)).includes(url));
  } finally {
    await context.close();
  }
});
