// schedule.mjs — расписание запусков (targets/schedule.json). Без зависимостей.
// Вызывается из process-jobs.mjs. Формат и примеры: docs/schedule-and-updates.md
//
// Файл расписания:
// { "tz": "Europe/Kyiv", "graceHours": 6, "entries": [
//    { "name": "sat-morning", "at": "2026-10-31T10:00", "job": "jobs/sat-standard.json" },
//    { "name": "weekday-check", "daily": "09:00", "days": [1,2,3,4,5], "from": "2026-11-02", "until": "2026-11-13", "job": "jobs/check.json" } ] }
// Время — локальное в tz (по умолчанию Киев). days: 1 = понедельник … 7 = воскресенье.
import fs from 'node:fs';

const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) fmtCache.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }));
  return fmtCache.get(tz);
}
export function localParts(ms, tz) {
  const o = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour, mm: +o.minute, wd: WD[o.weekday] };
}
export function zonedToUtc(y, m, d, hh, mm, tz) {
  const want = Date.UTC(y, m - 1, d, hh, mm);
  let t = want;
  for (let i = 0; i < 3; i++) { const p = localParts(t, tz); t += want - Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm); }
  return t;
}
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export function validateSchedule(s, jobExists = () => true) {
  const err = [];
  if (!s || typeof s !== 'object' || !Array.isArray(s.entries)) return ['ожидался объект с массивом entries'];
  const tz = s.tz || 'Europe/Kyiv';
  try { fmt(tz); } catch { err.push(`неизвестный часовой пояс «${tz}»`); }
  if (s.graceHours != null && !(Number(s.graceHours) > 0)) err.push('graceHours: ожидалось положительное число');
  const names = new Set();
  s.entries.forEach((e, i) => {
    const w = `entries[${i}]${e && e.name ? ` «${e.name}»` : ''}`;
    if (!e || typeof e !== 'object') { err.push(`${w}: не объект`); return; }
    if (!/^[\w.\-]+$/.test(e.name || '')) err.push(`${w}: name обязателен (буквы, цифры, _ . -)`);
    else if (names.has(e.name)) err.push(`${w}: имя повторяется`); else names.add(e.name);
    if (!/^jobs\/[\w.\-]+\.json$/.test(e.job || '')) err.push(`${w}: job должен быть вида jobs/имя.json`);
    else if (!jobExists(e.job)) err.push(`${w}: файла ${e.job} нет ни в репозитории, ни в архиве`);
    const hasAt = e.at != null, hasDaily = e.daily != null;
    if (hasAt === hasDaily) err.push(`${w}: нужно ровно одно из полей at / daily`);
    if (hasAt && !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/.test(e.at)) err.push(`${w}: at вида 2026-10-31T10:00`);
    if (hasDaily && !/^([01]\d|2[0-3]):[0-5]\d$/.test(e.daily)) err.push(`${w}: daily вида 09:30`);
    if (e.days != null && !(Array.isArray(e.days) && e.days.every(n => Number.isInteger(n) && n >= 1 && n <= 7))) err.push(`${w}: days — числа 1..7`);
    for (const k of ['from', 'until']) if (e[k] != null && !/^\d{4}-\d{2}-\d{2}$/.test(e[k])) err.push(`${w}: ${k} вида 2026-11-13`);
  });
  return err;
}

// Возвращает { due: [{key,name,job,slotMs}], missed: [...] } без учёта состояния (его фильтрует вызывающий).
export function computeSlots(s, nowMs) {
  const tz = s.tz || 'Europe/Kyiv';
  const graceMs = (Number(s.graceHours) || 6) * 3600e3;
  const due = [], missed = [];
  const keyOf = (name, ms) => `sched:${name}@${new Date(ms).toISOString().slice(0, 16)}Z`;
  const push = (e, ms) => {
    if (ms > nowMs) return;
    const item = { key: keyOf(e.name, ms), name: e.name, job: e.job, slotMs: ms };
    (nowMs - ms <= graceMs ? due : missed).push(item);
  };
  for (const e of s.entries || []) {
    if (e.enabled === false) continue;
    if (e.at) {
      const [d, t] = e.at.split(/[T ]/); const [y, m, dd] = d.split('-').map(Number); const [hh, mm] = t.split(':').map(Number);
      push(e, zonedToUtc(y, m, dd, hh, mm, tz));
    } else if (e.daily) {
      const [hh, mm] = e.daily.split(':').map(Number);
      const now = localParts(nowMs, tz);
      for (const back of [1, 0]) {
        const base = Date.UTC(now.y, now.m - 1, now.d) - back * 86400e3; // дата в tz (через UTC-арифметику календаря)
        const dt = new Date(base);
        const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate();
        const wd = ((dt.getUTCDay() + 6) % 7) + 1;
        const ds = ymd(y, m, d);
        if (e.days && !e.days.includes(wd)) continue;
        if (e.from && ds < e.from) continue;
        if (e.until && ds > e.until) continue;
        const ms = zonedToUtc(y, m, d, hh, mm, tz);
        if (ms > nowMs) continue;
        if (nowMs - ms <= graceMs) push(e, ms); // отставший daily за пределами окна не считаем «пропущенным»
      }
    }
  }
  due.sort((a, b) => a.slotMs - b.slotMs);
  return { due, missed };
}

export function loadSchedule(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---- человекочитаемые описания (для сообщений в Telegram) ----
export function kyivTime(ms, tz = 'Europe/Kyiv') {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}
export function kyivDateTime(ms, tz = 'Europe/Kyiv') {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)).replace(',', '');
}
const DAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
export function describeEntry(e, jobs = {}) {
  const j = jobs[e.job] ? ` ${jobs[e.job].mode || 'standard'}` : '';
  const when = e.at ? e.at.replace('T', ' ') : `каждый день ${e.daily}${e.days ? ' (' + e.days.map(d => DAYS[d - 1]).join(',') + ')' : ''}${e.from ? ' с ' + e.from : ''}${e.until ? ' по ' + e.until : ''}`;
  return `${when} —${j} «${e.name}»${e.enabled === false ? ' (выключено)' : ''}`;
}
