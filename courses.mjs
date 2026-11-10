const programmes = {
  ib: {
    title: 'IB DP',
    groups: [
      { name: '语言与文学', tone: 'sky', subjects: ['中文 A', '英语 A'] },
      { name: '语言习得', tone: 'lilac', subjects: ['中文 B', '英语 B'] },
      { name: '个人与社会', tone: 'sand', subjects: ['经济', '商管', '数字社会'] },
      { name: '科学', tone: 'mint', subjects: ['化学', '物理', '生物'] },
      { name: '数学', tone: 'aqua', subjects: ['数学'] },
      { name: '艺术', tone: 'rose', subjects: ['美术'] },
    ],
  },
  igcse: {
    title: 'IGCSE',
    groups: [
      { name: '语言', tone: 'sky', subjects: ['ESL', 'EFL', 'Chinese First', 'Chinese Second'] },
      { name: '数学', tone: 'aqua', subjects: ['数学'] },
      { name: '科学', tone: 'mint', subjects: ['物理', '化学', 'Coordinated Science'] },
      { name: '经济与社会', tone: 'sand', subjects: ['经济'] },
      { name: '艺术', tone: 'rose', subjects: ['美术'] },
    ],
  },
};

const svgNamespace = 'http://www.w3.org/2000/svg';
const centre = 230;
const outerRadius = 216;
const innerRadius = 87;
const labelRadius = 146;

function svgElement(name, attributes, text) {
  const node = document.createElementNS(svgNamespace, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function polar(radius, degrees) {
  const angle = degrees * Math.PI / 180;
  return [centre + radius * Math.cos(angle), centre + radius * Math.sin(angle)];
}

function sector(start, end) {
  const outerStart = polar(outerRadius, start).join(' ');
  const outerEnd = polar(outerRadius, end).join(' ');
  const innerEnd = polar(innerRadius, end).join(' ');
  const innerStart = polar(innerRadius, start).join(' ');
  return `M ${outerStart} A ${outerRadius} ${outerRadius} 0 0 1 ${outerEnd} L ${innerEnd} A ${innerRadius} ${innerRadius} 0 0 0 ${innerStart} Z`;
}

function wheelSector(group, index, angle) {
  const middle = -90 + angle * index;
  const [x, y] = polar(labelRadius, middle);
  const titleY = y - 6 - group.subjects.length * 8;
  const node = svgElement('g', { class: `course-tone-${group.tone}` });
  node.append(
    svgElement('path', { class: 'course-sector', d: sector(middle - angle / 2, middle + angle / 2) }),
    svgElement('text', { class: 'course-sector-title', x, y: titleY }, group.name),
  );
  for (const [offset, subject] of group.subjects.entries()) {
    node.append(svgElement('text', { class: 'course-sector-subject', x, y: titleY + 20 + offset * 17 }, subject));
  }
  return node;
}

function groupItem(group) {
  const item = document.createElement('li');
  item.className = `course-group course-tone-${group.tone}`;
  const heading = document.createElement('h3');
  heading.textContent = group.name;
  const list = document.createElement('ul');
  for (const subject of group.subjects) {
    const entry = document.createElement('li');
    entry.textContent = subject;
    list.append(entry);
  }
  item.append(heading, list);
  return item;
}

export function mountCourseWheel() {
  const wheel = document.querySelector('#course-wheel svg');
  const list = document.getElementById('course-groups');
  const title = document.getElementById('course-program-title');
  const meta = document.getElementById('course-meta');
  const ibSource = document.getElementById('course-ib-source');
  const igcseSource = document.getElementById('course-igcse-source');
  const buttons = document.querySelectorAll('[data-course-program]');

  function select(key) {
    const programme = programmes[key];
    const angle = 360 / programme.groups.length;
    const count = programme.groups.reduce((sum, group) => sum + group.subjects.length, 0);
    const summary = `${programme.groups.length} 组 · ${count} 门`;
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.courseProgram === key));
    title.textContent = programme.title;
    meta.textContent = summary;
    ibSource.hidden = key !== 'ib';
    igcseSource.hidden = key !== 'igcse';
    wheel.replaceChildren(
      svgElement('circle', { class: 'course-wheel-edge', cx: centre, cy: centre, r: 224 }),
      ...programme.groups.map((group, index) => wheelSector(group, index, angle)),
      svgElement('circle', { class: 'course-wheel-centre', cx: centre, cy: centre, r: 81 }),
      svgElement('text', { class: 'course-wheel-title', x: centre, y: centre + 3 }, programme.title),
      svgElement('text', { class: 'course-wheel-meta', x: centre, y: centre + 30 }, summary),
    );
    list.replaceChildren(...programme.groups.map(groupItem));
  }

  for (const button of buttons) button.addEventListener('click', () => select(button.dataset.courseProgram));
  select('ib');
}
