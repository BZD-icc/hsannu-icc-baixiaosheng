const bundleFormat = 'hsannu-icc-bundle-v1';
const maxRecords = 1_000;
const maxBundleLength = 16_000_000;
const dimensions = ['clarity', 'feedback', 'pace'];
const sourceTypes = ['school', 'experience', 'lead'];
const workloads = ['light', 'moderate', 'heavy'];
const levels = ['HL', 'SL'];
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const academicYearPattern = /^([0-9]{4})\s*[-–—/至]\s*([0-9]{4})$/;
const datePattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const timestampPattern = /^([0-9]{4}-[0-9]{2}-[0-9]{2})(?:T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?(?:Z|[+-][0-9]{2}:[0-9]{2}))?$/;

export function createId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}格式无效。`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label}格式无效。`);
  }
  return value;
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${label}应为文本。`);
  const clean = value.trim().normalize();
  if (clean.length > maxLength) throw new Error(`${label}最多 ${maxLength} 个字符。`);
  return clean || undefined;
}

function requiredText(value, label, maxLength) {
  const clean = optionalText(value, label, maxLength);
  if (!clean) throw new Error(`请填写${label}。`);
  return clean;
}

function choice(value, values, label) {
  if (!values.includes(value)) throw new Error(`${label}无效。`);
  return value;
}

function academicYear(value, allowCalendarYear = false) {
  const input = requiredText(value, '学年', 20).normalize('NFKC');
  if (allowCalendarYear && /^[0-9]{4}$/.test(input)) return input;
  const years = academicYearPattern.exec(input);
  if (!years || Number(years[2]) !== Number(years[1]) + 1) {
    throw new Error('请用两个连续的年份填写学年，例如 2026-2027。');
  }
  return `${years[1]}-${years[2]}`;
}

function dateOnly(value) {
  if (!datePattern.test(value)) throw new Error('日期格式应为 YYYY-MM-DD。');
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('日期无效。');
  }
  return value;
}

function timestamp(value) {
  if (typeof value === 'string') {
    const match = timestampPattern.exec(value);
    if (!match) throw new Error('记录时间无效。');
    dateOnly(match[1]);
  } else if (!(value instanceof Date) && typeof value !== 'number') {
    throw new Error('记录时间无效。');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('记录时间无效。');
  return date.toISOString();
}

export function safeHttpUrl(value) {
  if (typeof value !== 'string') return '';
  const candidate = value.trim();
  if (!/^https?:\/\//i.test(candidate) || /[\u0000-\u001f\u007f\\]/.test(candidate)) return '';
  try {
    const url = new URL(candidate);
    if (url.username || url.password) return '';
    return url.href;
  } catch {
    return '';
  }
}

function intelData(data) {
  const clean = {
    title: requiredText(data.title, '标题', 160),
    summary: requiredText(data.summary, '资料摘要', 2_000),
    sourceType: choice(data.sourceType, sourceTypes, '来源类型'),
  };
  const url = optionalText(data.url, '出处链接', 2_048);
  const cohort = optionalText(data.cohort, '届别', 80);
  const year = optionalText(data.year, '学年', 20);
  const topic = optionalText(data.topic, '科目或主题', 80);
  const date = optionalText(data.date, '日期', 10);
  if (url) {
    clean.url = safeHttpUrl(url);
    if (!clean.url || clean.url.length > 2_048) throw new Error('请填写有效的 HTTP 或 HTTPS 出处链接。');
  }
  if (cohort) clean.cohort = cohort;
  if (year) clean.year = academicYear(year, true);
  if (topic) clean.topic = topic;
  if (date) clean.date = dateOnly(date);
  return clean;
}

function reviewData(data) {
  const clean = {
    teacher: requiredText(data.teacher, '教师', 100),
    course: requiredText(data.course, '课程', 100),
    level: choice(data.level, levels, '课程层级'),
    year: academicYear(data.year),
  };
  const cohort = optionalText(data.cohort, '届别', 80);
  if (cohort) clean.cohort = cohort;
  const scores = data.scores === undefined ? {} : object(data.scores, '评分');
  clean.scores = {};
  for (const dimension of dimensions) {
    const score = scores[dimension];
    if (score === undefined || score === null || score === '') continue;
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new Error('各维度的分数应为 1 至 5 的整数。');
    }
    clean.scores[dimension] = score;
  }
  if (data.workload !== undefined && data.workload !== null && data.workload !== '') {
    clean.workload = choice(data.workload, workloads, '工作量');
  }
  return clean;
}

function normalizeRecord(record) {
  object(record, '记录');
  const { publisherId, id, version } = record;
  if (typeof publisherId !== 'string' || !idPattern.test(publisherId) ||
      typeof id !== 'string' || !idPattern.test(id)) {
    throw new Error('发布者或记录标识无效。');
  }
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('记录版本无效。');
  const kind = choice(record.kind, ['intel', 'review'], '记录类型');
  const state = choice(record.state, ['active', 'withdrawn'], '记录状态');
  if (typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') {
    throw new Error('记录时间无效。');
  }
  const createdAt = timestamp(record.createdAt);
  const updatedAt = timestamp(record.updatedAt);
  if (updatedAt < createdAt) throw new Error('更新时间早于创建时间。');
  const data = object(record.data, '记录内容');
  const cleanData = state === 'withdrawn' ? {} : kind === 'intel' ? intelData(data) : reviewData(data);
  return { publisherId, id, version, kind, state, createdAt, updatedAt, data: cleanData };
}

export function createRecord({ publisherId, kind, data }, now = new Date()) {
  const createdAt = timestamp(now);
  return normalizeRecord({
    publisherId, id: createId(), version: 1, kind, state: 'active',
    createdAt, updatedAt: createdAt, data,
  });
}

function updateRecord(record, state, data, now) {
  const updatedAt = timestamp(now);
  return normalizeRecord({
    ...record,
    version: record.version + 1,
    state,
    updatedAt: updatedAt < record.updatedAt ? record.updatedAt : updatedAt,
    data,
  });
}

export function reviseRecord(record, data, now = new Date()) {
  const current = normalizeRecord(record);
  if (current.state === 'withdrawn') throw new Error('这条记录已撤回。');
  return updateRecord(current, 'active', data, now);
}

export function withdrawRecord(record, now = new Date()) {
  const current = normalizeRecord(record);
  if (current.state === 'withdrawn') return current;
  return updateRecord(current, 'withdrawn', {}, now);
}

export function recordKey(record) {
  return `${record.publisherId}/${record.id}`;
}

export function cohortKey(value) {
  if (typeof value !== 'string') return '';
  return value.trim().normalize('NFKC').replace(/([0-9]{4})\s+(?=[届级])/g, '$1').toLowerCase();
}

function normalizeRecords(records) {
  if (!Array.isArray(records)) throw new Error('记录列表格式无效。');
  if (records.length > maxRecords) throw new Error(`每个资料库或资料包最多支持 ${maxRecords} 条记录。`);
  return Array.from(records, normalizeRecord);
}

export function mergeRecords(current, incoming) {
  const byKey = new Map();
  for (const record of normalizeRecords(current)) {
    const key = recordKey(record);
    if (byKey.has(key)) throw new Error('资料库含重复记录标识。');
    byKey.set(key, record);
  }

  let added = 0;
  let updated = 0;
  let duplicates = 0;
  let stale = 0;
  let conflicts = 0;
  for (const record of normalizeRecords(incoming)) {
    const key = recordKey(record);
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, record);
      added += 1;
    } else if (record.version < previous.version) {
      stale += 1;
    } else if (record.version === previous.version) {
      if (JSON.stringify(record) === JSON.stringify(previous)) duplicates += 1;
      else conflicts += 1;
    } else if (record.kind !== previous.kind || record.createdAt !== previous.createdAt ||
               (previous.state === 'withdrawn' && record.state === 'active')) {
      conflicts += 1;
    } else {
      byKey.set(key, record);
      updated += 1;
    }
  }
  if (byKey.size > maxRecords) throw new Error(`资料库最多支持 ${maxRecords} 条记录。`);
  return { records: [...byKey.values()], added, updated, duplicates, stale, conflicts };
}

export function makeBundle(records) {
  return { format: bundleFormat, generatedAt: new Date().toISOString(), records: normalizeRecords(records) };
}

export function parseBundle(input) {
  let bundle = input;
  if (typeof input === 'string') {
    if (input.length > maxBundleLength) throw new Error('资料包过大。');
    try {
      bundle = JSON.parse(input);
    } catch {
      throw new Error('无法读取资料包 JSON。');
    }
  }
  object(bundle, '资料包');
  if (bundle.format !== bundleFormat) throw new Error('资料包格式或版本不受支持。');
  if (typeof bundle.generatedAt !== 'string') throw new Error('资料包缺少生成时间。');
  timestamp(bundle.generatedAt);
  return normalizeRecords(bundle.records);
}

export function reviewSummary(records, filters = {}) {
  const normalizedFilters = {
    teacher: filters.teacher?.trim().normalize().toLowerCase(),
    course: filters.course?.trim().normalize().toLowerCase(),
    level: filters.level?.trim().toUpperCase(),
    year: filters.year?.trim() ? academicYear(filters.year) : '',
    cohort: cohortKey(filters.cohort),
  };
  const groups = new Map();
  const latest = mergeRecords([], records).records;
  for (const record of latest) {
    if (record.kind !== 'review' || record.state !== 'active') continue;
    const { teacher, course, level, year, cohort, scores, workload } = record.data;
    const teacherKey = teacher.toLowerCase();
    const courseKey = course.toLowerCase();
    if ((normalizedFilters.teacher && normalizedFilters.teacher !== teacherKey) ||
        (normalizedFilters.course && normalizedFilters.course !== courseKey) ||
        (normalizedFilters.level && normalizedFilters.level !== level) ||
        (normalizedFilters.year && normalizedFilters.year !== year) ||
        (normalizedFilters.cohort && normalizedFilters.cohort !== cohortKey(cohort))) continue;
    const key = JSON.stringify([teacherKey, courseKey, level, year]);
    if (!groups.has(key)) {
      groups.set(key, {
        teacher, course, level, year, count: 0,
        scores: Object.fromEntries(dimensions.map(dimension => [dimension, { sum: 0, count: 0 }])),
        workload: { light: 0, moderate: 0, heavy: 0 },
      });
    }
    const group = groups.get(key);
    group.count += 1;
    for (const dimension of dimensions) {
      if (scores[dimension] === undefined) continue;
      group.scores[dimension].sum += scores[dimension];
      group.scores[dimension].count += 1;
    }
    if (workload) group.workload[workload] += 1;
  }
  return Array.from(groups.values(), group => ({
    ...group,
    scores: Object.fromEntries(dimensions.map(dimension => {
      const { sum, count } = group.scores[dimension];
      return [dimension, { mean: count ? sum / count : null, count }];
    })),
  }));
}
