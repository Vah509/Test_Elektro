// digest.mjs — короткая сводка теста для Telegram, строится из reports/*.json. Без зависимостей.
// Принцип: одно сообщение — одно событие; только проблемы и предупреждения; детали — в отчёте (ссылка).
// Пороги = пороги Google (Core Web Vitals / Lighthouse). Коды причин — таблица в docs/telegram-messages.md.

const MAX_PER_BLOCK = 5;       // строк в блоке, остальное сворачивается в «+N ещё»
const MAX_REASONS = 2;         // кодов причин на одну страницу

// [жёлтый от, красный от]
export const TH = { lcp: [2500, 4000], fcp: [1800, 3000], tbt: [200, 600], cls: [0.1, 0.25], ttfb: [800, 1800] };
const PSI_YELLOW = 90, PSI_RED = 50;

const lvl = (v, [y, r]) => (v == null || Number.isNaN(v)) ? 0 : v >= r ? 2 : v >= y ? 1 : 0;
const sec = ms => (ms / 1000).toFixed(1).replace('.', ',') + 'с';
const fmtMs = ms => ms >= 1000 ? sec(ms) : Math.round(ms) + 'мс';

export function pageLabel(p) {
  if (!p || p === '/') return 'главная';
  const seg = p.replace(/\/+$/, '').split('/').filter(Boolean).pop() || p;
  return seg.length > 26 ? seg.slice(0, 25) + '…' : seg;
}
const num = s => { const m = String(s || '').replace(/\u00a0/g, ' ').match(/([\d.,]+)\s*(KiB|MiB|KB|MB)?/i); if (!m) return null; let n = parseFloat(m[1].replace(',', '.')); if (/mi?b/i.test(m[2] || '')) n *= 1024; return n; };

// ---- причины (только для страниц, у которых уже жёлтая/красная метрика) ----
function reasonsFor(r) {
  const t = r.typical || {}, out = [];
  const lcp = r.lcpMedianMs || 0, ph = label => (t.lcpPhases || []).find(x => label.test(x.label))?.ms ?? 0;
  const badLcp = lvl(lcp, TH.lcp) > 0;
  if (badLcp) {
    // PSI считает LCP в симуляции, а этапы берёт из наблюдаемого прогона — абсолютные мс несопоставимы, поэтому смотрим доли этапов.
    const del = ph(/resource load delay/i), dur = ph(/resource load duration/i), rnd = t.renderDelayMs ?? ph(/render delay/i);
    const sum = ph(/time to first byte/i) + del + dur + rnd || 1;
    if ((del / sum >= 0.4 && del >= 100) || (t.lcpDiscoveryScore != null && t.lcpDiscoveryScore < 0.5)) out.push('ЛЦП-ПЗ');
    if (dur / sum >= 0.4 && dur >= 100) out.push('ЛЦП-ВЕС');
    if (rnd / sum >= 0.5 && rnd >= 100) out.push('ЛЦП-РНД');
    if (!out.length && /<img|<picture|\bimg\b/i.test(t.lcpElement || '')) out.push('ФОТО');
  }
  const rbMs = num(t.renderBlocking); // «Est savings of 150 ms»
  if (rbMs != null && /ms/i.test(String(t.renderBlocking)) && rbMs >= 300 && (lvl(r.fcpMedianMs, TH.fcp) || badLcp)) out.push('БЛОК');
  const tp = (t.thirdParties || []).reduce((s, x) => s + (x.mainThreadMs || 0), 0);
  const tpBlock = (t.thirdParties || []).reduce((s, x) => s + (x.blockingMs || 0), 0);
  if ((tp >= 400 || tpBlock >= 150) && lvl(r.tbtMedianMs, TH.tbt) > 0) out.push('СТОРОН');
  const unused = [...(t.unusedJs || []), ...(t.unusedCss || [])].reduce((s, x) => s + (x.wastedKiB || 0), 0);
  if (unused >= 150) out.push('ЛИШ-JS');
  if ((t.domElements || 0) > 1500) out.push('DOM');
  const w = num(t.totalWeight);
  if (w != null && w > 2000) out.push('ТЯЖЕЛО');
  return out.slice(0, MAX_REASONS);
}

// ---- страницы: метрики -> красные/жёлтые ----
function classifyPage(r) {
  const t = r.typical || {};
  const metrics = [
    ['LCP', r.lcpMedianMs, TH.lcp, fmtMs], ['FCP', r.fcpMedianMs, TH.fcp, fmtMs],
    ['TBT', r.tbtMedianMs, TH.tbt, fmtMs], ['CLS', t.cls, TH.cls, v => v.toFixed(2).replace('.', ',')],
    ['TTFB', r.ttfbMedianMs, TH.ttfb, fmtMs],
  ].map(([n, v, th, f]) => ({ n, v, l: lvl(v, th), s: v == null ? '' : `${n} ${f(v)}` }));
  const score = r.scoreMedian;
  const scoreL = score == null ? 0 : score < PSI_RED ? 2 : score < PSI_YELLOW ? 1 : 0;
  const level = Math.max(scoreL, ...metrics.map(m => m.l));
  const bad = metrics.filter(m => m.l > 0).sort((a, b) => b.l - a.l);
  return { level, score, bad, metrics, row: r };
}

// ---- сервер: сжатие, кэш, стабильность ----
function serverFindings(server) {
  const red = [], yellow = [];
  for (const p of server?.pages || []) {
    const lab = pageLabel(p.path);
    if (p.status && p.status >= 400) red.push({ page: lab, text: `HTTP ${p.status}` });
    else if (!p.enc) red.push({ page: lab, text: 'НЕТ-СЖ' });
    if (p.med >= TH.ttfb[1]) red.push({ page: lab, text: `СРВ-ЛАГ ${p.med}мс` });
    else if (p.med >= TH.ttfb[0] || (p.max >= 600 && p.max >= p.med * 4)) yellow.push({ page: lab, text: `СРВ-ЛАГ ${p.med}/${p.max}мс` });
  }
  for (const a of server?.assets || []) {
    const hashed = /\/_astro\//.test(a.path || '');
    const m = /max-age=(\d+)/i.exec(a.cc || '');
    const age = m ? +m[1] : null;
    if (hashed && (!a.cc || /no-store|no-cache/i.test(a.cc) || age === 0)) red.push({ page: 'ассеты', text: 'КЭШ' });
    else if (hashed && (age == null || age < 31536000)) yellow.push({ page: 'ассеты', text: `КЭШ ${age == null ? '—' : Math.round(age / 3600) + 'ч'}` });
  }
  return { red, yellow };
}

const uniqBy = (arr, key) => { const s = new Set(); return arr.filter(x => { const k = key(x); if (s.has(k)) return false; s.add(k); return true; }); };

// Разбор отчёта -> { level: 0|1|2, red: [], yellow: [], stats }
export function analyze(report) {
  const psi = (report.psi || []).filter(r => !r.error);
  const both = new Set(psi.map(r => r.strategy)).size > 1;
  const red = [], yellow = [];
  for (const r of psi) {
    const c = classifyPage(r);
    if (!c.level) continue;
    const lab = pageLabel(r.path) + (both ? ` (${r.strategy === 'mobile' ? 'm' : 'd'})` : '');
    const parts = c.bad.map(m => m.s).slice(0, 3);
    if (!parts.length && c.score != null) parts.push(`PSI ${c.score}`);
    const reasons = reasonsFor(r);
    const noisy = (r.spread ?? 0) > 10 ? ' ⚠ШУМ' : '';
    const item = { page: lab, text: `${parts.join(' · ')}${reasons.length ? ' · ' + reasons.join(' ') : ''}${noisy}`, score: c.score ?? 100 };
    (c.level === 2 ? red : yellow).push(item);
  }
  red.sort((a, b) => a.score - b.score); yellow.sort((a, b) => a.score - b.score);
  const sv = serverFindings(report.server);
  red.push(...uniqBy(sv.red, x => x.page + x.text));
  yellow.push(...uniqBy(sv.yellow, x => x.page + x.text));
  // замечания структурного аудита (ERR/WARN), сгруппированы по коду
  const byCode = new Map();
  for (const i of report.issues || []) {
    if (i.sev !== 'ERR' && i.sev !== 'WARN') continue;
    if (i.code === 'srv-asset-short-cache') continue; // уже учтено как КЭШ
    const k = i.sev + ':' + i.code; const g = byCode.get(k) || { sev: i.sev, code: i.code, pages: new Set() };
    g.pages.add(i.page); byCode.set(k, g);
  }
  for (const g of byCode.values()) {
    const first = pageLabel([...g.pages][0]);
    const item = { page: g.code, text: g.pages.size > 1 ? `${g.pages.size} стр. (напр. ${first})` : first };
    (g.sev === 'ERR' ? red : yellow).push(item);
  }
  const scores = psi.map(r => r.scoreMedian).filter(x => x != null);
  return {
    level: red.length ? 2 : yellow.length ? 1 : 0, red, yellow,
    measured: psi.length, total: (report.psi || []).length,
    avg: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
  };
}

const icon = l => l === 2 ? '🔴' : l === 1 ? '🟡' : '🟢';
function block(title, ic, items) {
  if (!items.length) return [];
  const L = [`${ic} ${title} (${items.length})`];
  items.slice(0, MAX_PER_BLOCK).forEach(x => L.push(`• ${x.page} — ${x.text}`));
  if (items.length > MAX_PER_BLOCK) L.push(`• +${items.length - MAX_PER_BLOCK} ещё — в отчёте`);
  return L;
}

// ---- сообщения ----
export const msg = {
  scriptsOk: t => `🟢 site-check: скрипты обновлены и проверены · ${t}`,
  scriptsFail: (t, why) => `🔴 site-check: ошибка обновления скриптов · ${t}\n${String(why).slice(0, 400)}`,
  archiveFail: (t, why) => `🔴 site-check: архив отклонён · ${t}\n${String(why).slice(0, 400)}`,
  filesOk: (t, n) => `🟢 site-check: файлы обновлены · ${t} · ${n} шт.`,
  schedule: (t, tz, lines) => `🗓 site-check: расписание обновлено · ${t}\n(${tz})\n${lines.length ? lines.join('\n') : 'записей нет — по расписанию ничего не запускается'}`,
  start: (t, name, mode, base, plan) => `🟢 site-check: старт теста · ${t}\n${name} (${mode}${base ? ', ' + base : ''})${plan ? '\n' + plan : ''}`,
  fail: (t, dur, name, mode, why, link) => `🔴 site-check: ошибка выполнения теста · ${t} · ${dur} мин\n${name} (${mode})\n${String(why).slice(0, 500)}${link ? '\n' + link : ''}`,
  missed: (name, when, grace) => `🟡 site-check: слот «${name}» (${when}) пропущен — запуск опоздал больше чем на ${grace} ч`,
  schedErr: why => `🔴 site-check: расписание не применено\n${String(why).slice(0, 400)}`,
  skip: id => `⏭ site-check: «${id}» уже выполнялся — пропущен (смени id или запусти вручную)`,
  alive: (t, next, daily) => `💓 site-check: расписание живо · ${t}\n${next ? 'ближайший запуск: ' + next : 'разовых запусков впереди нет'}${daily ? `\nежедневных записей: ${daily}` : ''}`,
};

export function doneMessage({ report, t, dur, name, mode, base, reportUrl, runUrl }) {
  const a = report ? analyze(report) : { level: 0, red: [], yellow: [], measured: 0, total: 0, avg: null };
  const L = [`${icon(a.level)} site-check: тест выполнен · ${t} · ${dur} мин`, `${name} (${mode}${base ? ', ' + base : ''})`];
  if (a.level === 0) L.push('', 'Проблем и предупреждений не найдено ✅');
  else { L.push(''); L.push(...block('Проблемы', '🔴', a.red)); if (a.red.length && a.yellow.length) L.push(''); L.push(...block('Предупреждения', '🟡', a.yellow)); }
  const st = [];
  if (a.total) st.push(`замеров ${a.measured}/${a.total}`);
  if (a.avg != null) st.push(`ср. PSI ${a.avg}`);
  if (st.length) L.push('', st.join(' · '));
  if (reportUrl) L.push(`📄 ${reportUrl}`);
  else if (runUrl) L.push(`📄 ${runUrl}`);
  return L.join('\n').slice(0, 3800);
}
