// site-check.mjs — диагностика elektroschit.com.ua:
// структурный аудит + PageSpeed Insights (PSI) + локальный Lighthouse (lab) + серверная диагностика.
// Без зависимостей, Node 20+. Описание: docs/how-it-works.md, формат заданий: docs/job-format.md
//
// Обычно запускается автоматически из scripts/process-jobs.mjs по файлу-заданию (jobs/*.json).
// Вручную: node scripts/site-check.mjs help
//
// Ключ PSI берётся ТОЛЬКО из переменной окружения PSI_KEY (в GitHub — секрет репозитория). В файле ключа нет.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE_DEFAULT = 'https://elektroschit.com.ua';
const UA = 'site-check/2.0';
const MODE_DEFAULTS = {
  audit:    { runs: 0, device: 'mobile', audit: true },
  standard: { runs: 3, device: 'key',    audit: true },
  final:    { runs: 1, device: 'key',    audit: true },
  targets:  { runs: 3, device: 'mobile', audit: false },
  lab:      { runs: 3, device: 'mobile', audit: false },
};
const ALIAS = { quick: 'standard', full: 'final' };
const MODES = new Set([...Object.keys(MODE_DEFAULTS), ...Object.keys(ALIAS), 'plan']);

const HELP = `
site-check — диагностика сайта: аудит + PSI + локальный Lighthouse + серверная диагностика.

РЕЖИМЫ (первое слово)
  audit      только структурный аудит сайта (≈2 мин, ключ не нужен)
  standard   аудит + PSI по представителям каждого типа страниц (было: quick)
  final      аудит + PSI по ВСЕМ страницам из sitemap, 1 прогон; слабые перепрогоняются (было: full)
  targets    PSI только по страницам из списка (--targets файл или --pages /a/,/b/)
  lab        локальный Lighthouse (нужен Chrome) по списку или по представителям
  plan       показать, какие страницы пойдут в замер, и время; замеры не запускаются

ПАРАМЕТРЫ (всё можно задать и в job-файле, см. docs/job-format.md; флаги главнее файла)
  --job файл.json     взять параметры из задания
  --base URL          другой адрес (preview-ветка), по умолчанию ${BASE_DEFAULT}
  --targets файл.txt  список страниц (по одной на строку, # — комментарий)
  --pages a,b         список страниц через запятую
  --runs N            прогонов на страницу
  --device D          mobile | desktop | both | key (mobile + desktop для 4 ключевых страниц)
  --detail D          short | full (full — с разделом «Детали»)
  --parallel N        параллельных потоков PSI (по умолчанию 1)
  --gap N             пауза между повторами одной страницы, сек (по умолчанию 90)
  --lighthouse VER    версия npm-пакета lighthouse для lab (по умолчанию latest)
  --goal "текст"      цель теста, попадёт в отчёт и Telegram
  --out префикс       куда писать отчёт (по умолчанию reports/<дата_время>_<режим>_<метка>)
  --audit / --no-audit, --no-server

КЛЮЧ PSI: переменная окружения PSI_KEY. Режимам audit и lab ключ не нужен.
`;

function die(msg) { console.error(msg); process.exit(1); }

// ---------- аргументы + job ----------
const argv = process.argv.slice(2);
if (argv.some(a => ['help', '--help', '-h', '/?'].includes(a))) { console.log(HELP); process.exit(0); }
const FLAGS = new Set(['job', 'base', 'targets', 'pages', 'runs', 'device', 'detail', 'parallel', 'gap', 'out', 'goal', 'lighthouse']);
const cli = {}; let word = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--audit') cli.audit = true;
  else if (a === '--no-audit') cli.audit = false;
  else if (a === '--no-server') cli.server = false;
  else if (a.startsWith('--') && FLAGS.has(a.slice(2))) cli[a.slice(2)] = argv[++i];
  else if (MODES.has(a)) word = a;
  else die(`Не понял аргумент «${a}». Справка: node scripts/site-check.mjs help`);
}
let job = {};
if (cli.job) { try { job = JSON.parse(fs.readFileSync(cli.job, 'utf8')); } catch (e) { die(`Не удалось прочитать job «${cli.job}»: ${e.message}`); } }
const pick = (k, d) => cli[k] ?? job[k] ?? d;
const numOpt = (k, d) => { const v = pick(k, d); const n = Number(v); if (Number.isNaN(n) || n < 0) die(`Параметр ${k}: ожидалось число, получено «${v}»`); return n; };

let rawMode = word || job.mode || 'standard';
const PLAN_ONLY = rawMode === 'plan';
if (PLAN_ONLY) rawMode = (job.mode && job.mode !== 'plan') ? job.mode : 'standard';
const MODE = ALIAS[rawMode] || rawMode;
if (!MODE_DEFAULTS[MODE]) die(`Неизвестный режим «${rawMode}». Допустимо: audit, standard, final, targets, lab`);
const MD = MODE_DEFAULTS[MODE];

const GOAL = String(pick('goal', '') || '');
const JOB_ID = String(job.id || '');
const BASE = String(pick('base', BASE_DEFAULT)).replace(/\/+$/, '');
const IS_PROD = BASE === BASE_DEFAULT;
const LABEL = IS_PROD ? 'prod' : (() => { try { const h = new URL(BASE).hostname; return /^[\d.]+$/.test(h) ? h.replace(/\./g, '-') : (h.split('.')[0] || 'other'); } catch { return 'other'; } })();
const RUNS = numOpt('runs', MD.runs);
const DEVICE = String(pick('device', MD.device));
if (!['mobile', 'desktop', 'both', 'key'].includes(DEVICE)) die(`device: mobile | desktop | both | key, получено «${DEVICE}»`);
const DETAIL = String(pick('detail', 'full'));
const PAR = Math.max(1, numOpt('parallel', 1));
const GAP_SEC = numOpt('gap', job.gapSec ?? 90);
const GAP_MS = GAP_SEC * 1000;
const RETRY_BELOW = numOpt('retryBelow', 90);
const BUST_ALL = job.bustAll === true;
const LH_VERSION = String(pick('lighthouse', 'latest'));
const SAVE_RAW = job.saveRaw !== false;
const WITH_SERVER = cli.server ?? job.server ?? true;
const KEY = process.env.PSI_KEY || '';
const IS_LAB = MODE === 'lab';
let RUN_AUDIT = cli.audit ?? job.audit ?? MD.audit;

// список страниц для targets/lab
const normPath = s => {
  let p = String(s).trim(); if (!p) return null;
  if (/^https?:\/\//i.test(p)) { try { const u = new URL(p); p = u.pathname + u.search; } catch { return null; } }
  return p.startsWith('/') ? p : '/' + p;
};
let TARGETS = [];
{
  const fromFile = pick('targets', '');
  if (fromFile) {
    let txt = ''; try { txt = fs.readFileSync(fromFile, 'utf8'); } catch (e) { die(`Не удалось прочитать список страниц «${fromFile}»: ${e.message}`); }
    TARGETS.push(...txt.split(/\r?\n/).map(l => l.replace(/#.*$/, '')).map(normPath).filter(Boolean));
  }
  const pg = pick('pages', null);
  if (pg) TARGETS.push(...(Array.isArray(pg) ? pg : String(pg).split(',')).map(normPath).filter(Boolean));
  TARGETS = [...new Set(TARGETS)];
}
if (MODE === 'targets' && !TARGETS.length) die('Режим targets: нужен список страниц (targets: файл или pages: [...]).');
if (['standard', 'final'].includes(MODE) || (IS_LAB && !TARGETS.length)) RUN_AUDIT = true; // нужен список страниц из sitemap

const pad2 = n => String(n).padStart(2, '0');
const NOW = new Date();
const STAMP = `${NOW.getUTCFullYear()}-${pad2(NOW.getUTCMonth() + 1)}-${pad2(NOW.getUTCDate())}_${pad2(NOW.getUTCHours())}${pad2(NOW.getUTCMinutes())}`;
const OUT = String(pick('out', '') || `reports/${STAMP}_${MODE}_${LABEL}`);
const RAW_DIR = `raw/${STAMP}_${MODE}_${LABEL}`;
const kyivTime = d => { try { return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'short' }).format(d); } catch { return ''; } };

// ---------- общие константы ----------
const CONC = 8;
const IMG_WARN_KB = 250;   // картинка тяжелее — предупреждение
const PAGE_WARN_KB = 300;  // HTML тяжелее — предупреждение
// Карточки, которые всегда входят в quick (проблемные в прошлых замерах). Редактируй список по мере надобности.
const PINNED_WORKS = ['shafa-indykatsii-pozhezhohasinnia', 'post-upravlinnia-osvitlenniiam-16-kanaliv'];
// Десктоп-прогоны — только для ключевых страниц
const DESKTOP_PATHS = ['/', '/posluhy-ta-produktsiia/hrshch/', '/vykonani-roboty/', '/ru/'];
// Замечания аудита, которые влияют на скорость (показываются рядом с PSI)
const PERF_CODES = new Set(['css-external-in-head', 'script-blocking-head', 'script-no-defer', 'work-main-lazy',
  'work-main-no-fetchpriority', 'work-main-not-webp', 'work-main-no-srcset', 'img-heavy', 'img-no-dimensions',
  'img-not-webp', 'catalog-first-lazy', 'html-heavy']);

let stopping = false;
process.on('SIGINT', () => {
  if (stopping) process.exit(1);
  stopping = true;
  console.log('\n⏹  Останавливаюсь после текущего запроса и пишу отчёт по тому, что измерено… (ещё раз Ctrl+C — выход сразу)');
});

// ============================================================
//                    СТРУКТУРНЫЙ АУДИТ
// ============================================================
const issues = [];
const add = (sev, code, page, msg) => issues.push({ sev, code, page, msg });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const kb = b => Math.round((b || 0) / 1024);

// ---------- сеть ----------
async function req(url, method = 'GET', tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const t0 = Date.now();
      const r = await fetch(url, { method, redirect: 'manual', headers: { 'user-agent': UA } });
      const ms = Date.now() - t0;
      if (method === 'HEAD' && r.status === 405) return req(url, 'GET', 1);
      return { status: r.status, headers: r.headers, ms, res: r };
    } catch (e) {
      if (i === tries - 1) return { status: 0, error: String(e.message || e), headers: new Headers(), ms: 0 };
      await sleep(500 * (i + 1));
    }
  }
}
async function getText(url) {
  const r = await req(url, 'GET');
  if (r.status === 0) return { ...r, text: '' };
  const text = await r.res.text();
  return { ...r, text, bytes: Buffer.byteLength(text) };
}
async function pool(items, worker, n = CONC) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await worker(items[k], k); }
  }));
  return out;
}

// ---------- разбор HTML (regex, без зависимостей) ----------
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
};
const hasAttr = (tag, name) => new RegExp(`\\s${name}(\\s|=|>|/)`, 'i').test(tag);
const tags = (html, name) => html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) || [];
const decode = s => (s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const strip = s => decode((s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

function parseSrcset(ss) {
  return (ss || '').split(',').map(x => x.trim().split(/\s+/)[0]).filter(Boolean);
}
const abs = (u, pageUrl) => { try { return new URL(decode(u), pageUrl).toString(); } catch { return null; } };
const sameOrigin = u => { try { return new URL(u).origin === new URL(BASE).origin; } catch { return false; } };
const classes = tag => (attr(tag, 'class') || '').split(/\s+/);

function parsePage(html, url) {
  const p = { url };
  p.title = strip((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  const metas = tags(html, 'meta');
  const meta = n => { const t = metas.find(m => (attr(m, 'name') || attr(m, 'property') || '').toLowerCase() === n); return t ? decode(attr(t, 'content') || '') : null; };
  p.description = meta('description');
  p.og = { title: meta('og:title'), description: meta('og:description'), url: meta('og:url'), type: meta('og:type'), image: meta('og:image') };
  p.robots = meta('robots');
  p.viewport = meta('viewport');
  const links = tags(html, 'link');
  const canon = links.find(l => (attr(l, 'rel') || '').toLowerCase() === 'canonical');
  p.canonical = canon ? attr(canon, 'href') : null;
  p.alternates = links.filter(l => (attr(l, 'rel') || '').toLowerCase() === 'alternate' && attr(l, 'hreflang'))
    .map(l => ({ lang: attr(l, 'hreflang'), href: attr(l, 'href') }));
  p.lang = attr((html.match(/<html\b[^>]*>/i) || [''])[0], 'lang');
  p.h1 = (html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi) || []).map(strip);
  p.jsonld = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  p.imgs = tags(html, 'img').map(t => ({
    tag: t, src: attr(t, 'src'), srcset: attr(t, 'srcset'), sizes: attr(t, 'sizes'), alt: attr(t, 'alt'),
    width: attr(t, 'width'), height: attr(t, 'height'), loading: attr(t, 'loading'),
    fetchpriority: attr(t, 'fetchpriority'), cls: classes(t),
  }));
  p.anchors = tags(html, 'a').map(t => attr(t, 'href')).filter(Boolean);
  p.scripts = tags(html, 'script').map(t => attr(t, 'src')).filter(Boolean);
  const headEnd = html.search(/<\/head>/i);
  const head = headEnd > 0 ? html.slice(0, headEnd) : '';
  const body = headEnd > 0 ? html.slice(headEnd) : html;
  const syncSrc = t => attr(t, 'src') && !hasAttr(t, 'defer') && !hasAttr(t, 'async') && !/type=["']module["']/i.test(t);
  p.cssLinks = tags(head, 'link').filter(l => (attr(l, 'rel') || '').toLowerCase() === 'stylesheet').map(l => attr(l, 'href'));
  p.headScripts = tags(head, 'script').filter(syncSrc).map(t => attr(t, 'src'));
  p.bodyScriptsNoDefer = tags(body, 'script').filter(syncSrc).map(t => attr(t, 'src')).filter(s => s.startsWith('/'));
  p.html = html;
  return p;
}

// ---------- 1. список страниц ----------
async function collectUrls() {
  const sm = await getText(`${BASE}/sitemap.xml`);
  if (sm.status !== 200) { add('ERR', 'sitemap-missing', '/sitemap.xml', `sitemap.xml отвечает ${sm.status}`); return []; }
  const locs = [...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
  const paths = new Set(locs.map(l => { try { return new URL(l).pathname; } catch { return null; } }).filter(Boolean));
  paths.add('/ru/vykonani-roboty/'); // не в sitemap по замыслу, но доступна по URL
  const bad = locs.filter(l => !l.endsWith('/') && !l.endsWith('.xml'));
  if (bad.length) add('WARN', 'sitemap-no-trailing-slash', '/sitemap.xml', `${bad.length} URL без / на конце, напр. ${bad[0]}`);
  console.log(`sitemap: ${locs.length} URL`);
  return [...paths];
}

// ---------- 2. проверки страницы ----------
const PRODUCT_SLUGS = ['hrshch', 'dymovydalennia', 'dvyhuny', 'shuz', 'krm', 'zenitni-lihtari', 'ahro', 'plk'];
const pageKind = path => {
  if (/^\/(ru\/)?vykonani-roboty\/?$/.test(path)) return 'catalog';
  if (/^\/vykonani-roboty\/[^/]+\/?$/.test(path)) return 'work';
  if (/^\/ru\/vykonani-roboty\/[^/]+\/?$/.test(path)) return 'work-ru';
  if (/^\/posluhy-ta-produktsiia\/[^/]+\/?$/.test(path)) return 'product';
  if (/^\/ru\/uslugi-i-produktsiya\/[^/]+\/?$/.test(path)) return 'product-ru';
  return 'other';
};

function checkCommon(p, path, http) {
  if (http.status !== 200) { add('ERR', 'page-status', path, `статус ${http.status}`); return; }
  if (http.bytes > PAGE_WARN_KB * 1024) add('WARN', 'html-heavy', path, `HTML ${kb(http.bytes)} КБ`);
  if (!p.title) add('ERR', 'no-title', path, 'нет <title>');
  else if (p.title.length > 65) add('WARN', 'title-long', path, `title ${p.title.length} симв.: ${p.title}`);
  if (!p.description) add('ERR', 'no-description', path, 'нет meta description');
  else if (p.description.length < 110 || p.description.length > 170) add('WARN', 'description-length', path, `description ${p.description.length} симв.`);
  if (!p.canonical) add('ERR', 'no-canonical', path, 'нет canonical');
  else {
    try {
      const cu = new URL(p.canonical);
      if (cu.pathname !== path) add('ERR', 'canonical-mismatch', path, `canonical → ${p.canonical}`);
      if (!cu.pathname.endsWith('/')) add('WARN', 'canonical-no-slash', path, p.canonical);
      if (IS_PROD && cu.origin !== new URL(BASE).origin) add('WARN', 'canonical-origin', path, `canonical на другом домене: ${cu.origin}`);
    } catch { add('ERR', 'canonical-invalid', path, p.canonical); }
  }
  if (p.h1.length !== 1) add(p.h1.length === 0 ? 'ERR' : 'WARN', 'h1-count', path, `H1: ${p.h1.length} шт.`);
  if (!p.lang) add('WARN', 'no-html-lang', path, 'нет <html lang>');
  if (!p.viewport) add('WARN', 'no-viewport', path, 'нет meta viewport');
  if (!p.og.title || !p.og.description || !p.og.image) add('WARN', 'og-incomplete', path, `og: title=${!!p.og.title} description=${!!p.og.description} image=${!!p.og.image}`);
  if (p.robots && /noindex/i.test(p.robots)) add('WARN', 'noindex', path, `robots: ${p.robots}`);
  p.jsonld.forEach((j, i) => { try { JSON.parse(j); } catch (e) { add('ERR', 'jsonld-invalid', path, `JSON-LD #${i + 1} не парсится`); } });
  if (!p.jsonld.length) add('INFO', 'no-jsonld', path, 'нет JSON-LD');
  if (/\/ru\//.test(path) && p.lang && !/^ru/i.test(p.lang)) add('WARN', 'ru-lang', path, `lang="${p.lang}" на /ru/`);
  if (!/\/ru\//.test(path) && p.lang && !/^uk/i.test(p.lang)) add('WARN', 'uk-lang', path, `lang="${p.lang}"`);
  p.alternates.forEach(a => { if (!a.href) add('WARN', 'hreflang-empty', path, a.lang); });
  // alt/size/loading картинок
  p.imgs.filter(im => im.src && !im.cls.includes('em-lightbox-img')).forEach(im => {
    if (im.alt === null) add('WARN', 'img-no-alt', path, (im.src || '').slice(-70));
    else if (im.alt.trim() === '' && !im.cls.includes('decor')) add('INFO', 'img-empty-alt', path, (im.src || '').slice(-70));
    if (!im.width || !im.height) add('WARN', 'img-no-dimensions', path, (im.src || '').slice(-70));
  });
  // старые прямые /images/*.jpg на страницах
  p.imgs.filter(im => /^\/images\/.*\.jpe?g$/i.test(im.src || '')).forEach(im => add('INFO', 'img-legacy-jpg', path, im.src));
}

function checkPerfHints(p, path) {
  p.cssLinks.forEach(h => add('WARN', 'css-external-in-head', path, `внешний CSS в <head> блокирует отрисовку: ${h}`));
  p.headScripts.forEach(s => add('WARN', 'script-blocking-head', path, `скрипт в <head> без defer/async: ${s}`));
  p.bodyScriptsNoDefer.forEach(s => add('INFO', 'script-no-defer', path, `скрипт без defer: ${s}`));
}

function checkWork(p, path, imgStatusUrls) {
  const main = p.imgs.find(i => i.cls.includes('em-work-main-img'));
  if (!main) { add('ERR', 'work-no-main-img', path, 'нет главного фото .em-work-main-img'); }
  else {
    if (!main.srcset) add('WARN', 'work-main-no-srcset', path, 'у главного фото нет srcset');
    if (!main.sizes) add('WARN', 'work-main-no-sizes', path, 'у главного фото нет sizes');
    if (main.loading !== 'eager') add('ERR', 'work-main-lazy', path, `главное фото loading=${main.loading} (LCP!)`);
    if (main.fetchpriority !== 'high') add('WARN', 'work-main-no-fetchpriority', path, 'нет fetchpriority="high"');
    if (!/\.webp(\?|$)/i.test(main.src || '')) add('WARN', 'work-main-not-webp', path, main.src || '');
  }
  const thumbBtns = (p.html.match(/<button\b[^>]*class="[^"]*em-work-thumb[^"]*"[^>]*>/gi) || []);
  const thumbData = thumbBtns.map(t => ({ src: attr(t, 'data-src'), cap: attr(t, 'data-caption'), idx: attr(t, 'data-index') }));
  const thumbImgs = p.imgs.filter(i => !i.cls.includes('em-work-main-img') && /em-work-thumb/.test(p.html) && i.sizes && /72px/.test(i.sizes));
  if (thumbBtns.length && thumbImgs.length !== thumbBtns.length) add('WARN', 'work-thumb-img-count', path, `кнопок ${thumbBtns.length}, фото в них ${thumbImgs.length}`);
  thumbData.forEach((t, i) => {
    if (!t.src) add('ERR', 'work-thumb-no-data-src', path, `миниатюра #${i + 1} без data-src`);
    else imgStatusUrls.add(abs(t.src, BASE + path));
    if (!t.cap) add('WARN', 'work-thumb-no-caption', path, `миниатюра #${i + 1} без подписи`);
  });
  // массив фото лайтбокса (define:vars → const photos = [...])
  const m = p.html.match(/(?:const|let|var)\s+photos\s*=\s*(\[[\s\S]*?\]);/);
  let lb = null;
  if (!m) add('ERR', 'work-no-lightbox-data', path, 'не найден массив photos для лайтбокса');
  else { try { lb = JSON.parse(m[1]); } catch { add('ERR', 'work-lightbox-json', path, 'массив photos не парсится'); } }
  if (lb) {
    const expected = Math.max(1, thumbBtns.length);
    if (lb.length !== expected) add('ERR', 'work-lightbox-count', path, `в лайтбоксе ${lb.length} фото, миниатюр ${thumbBtns.length || 1}`);
    lb.forEach((ph, i) => {
      if (!ph.src) add('ERR', 'work-lightbox-empty-src', path, `фото #${i + 1} без src`);
      else {
        imgStatusUrls.add(abs(ph.src, BASE + path));
        if (!/^\/_astro\/.*\.webp$/i.test(ph.src)) add('WARN', 'work-lightbox-not-astro', path, ph.src);
        const th = thumbData[i];
        if (th && th.src && th.src !== ph.src) add('WARN', 'work-lightbox-vs-thumb', path, `фото #${i + 1}: data-src ≠ src лайтбокса`);
      }
    });
  }
  if (!/class="[^"]*em-lightbox-img/.test(p.html)) add('ERR', 'work-no-lightbox-el', path, 'на странице нет .em-lightbox-img');
  if (!p.scripts.some(s => /em-work-lightbox\.js/.test(s))) add('ERR', 'work-no-lightbox-js', path, 'не подключён em-work-lightbox.js');
  if (!/class="[^"]*em-similar-grid/.test(p.html)) add('INFO', 'work-no-similar', path, 'нет блока «Схожі роботи»');
  else {
    const sim = (p.html.split('em-similar-grid')[1] || '');
    const cards = (sim.match(/class="em-work-card"/g) || []).length;
    if (cards < 2) add('WARN', 'work-similar-few', path, `«Схожі»: ${cards} карт.`);
  }
  if (!p.og.type || p.og.type !== 'article') add('INFO', 'work-og-type', path, `og:type=${p.og.type}`);
  return { photos: thumbBtns.length || 1 };
}

function checkCatalog(p, path) {
  const cards = p.html.match(/<a\b[^>]*class="em-work-card"[^>]*>/g) || [];
  if (cards.length < 10) add('WARN', 'catalog-few-cards', path, `карточек: ${cards.length}`);
  cards.forEach(c => { if (!attr(c, 'data-types')) add('WARN', 'catalog-card-no-types', path, (attr(c, 'href') || '')); });
  const ci = p.imgs.filter(i => /em-work-card-photo/.test('') || (i.sizes && /380px/.test(i.sizes)));
  if (ci.length !== cards.length) add('WARN', 'catalog-card-img-count', path, `карточек ${cards.length}, фото ${ci.length}`);
  ci.forEach((i, k) => {
    if (!i.srcset) add('WARN', 'catalog-img-no-srcset', path, (i.src || '').slice(-60));
    if (k < 3 && i.loading !== 'eager') add('INFO', 'catalog-first-lazy', path, `карточка #${k + 1} loading=${i.loading}`);
  });
  return { cards: cards.length };
}

function checkProduct(p, path) {
  const slug = path.replace(/\/$/, '').split('/').pop();
  if (!PRODUCT_SLUGS.includes(slug)) return;
  const nCollage = (p.html.match(/class="em-hero-collage-item"/g) || []).length;
  if (nCollage !== 4) add('WARN', 'product-collage-count', path, `в hero-коллаже ${nCollage} фото (ожидается 4)`);
  const gal = (p.html.match(/class="em-gallery-item[ "]/g) || []).length;
  if (gal && gal !== 8) add('WARN', 'product-gallery-count', path, `в галерее ${gal} фото (ожидается 8)`);
  if (!/faq/i.test(p.html)) add('WARN', 'product-no-faq', path, 'не найден блок FAQ');
  if (!/kontakty-blok|em-contact/i.test(p.html)) add('WARN', 'product-no-contact', path, 'не найден ContactBlock');
  if (!/em-also-make|Також виготовляємо|Также изготавливаем/i.test(p.html)) add('INFO', 'product-no-alsomake', path, 'не найден блок «Також виготовляємо»');
}

// ---------- основной прогон ----------

async function runAudit() {
  console.log(`Аудит: ${BASE}${LABEL ? ' [' + LABEL + ']' : ''}`);
  const paths = await collectUrls();
  if (!paths.length) { console.log('Нет страниц — выходим.'); return { pages: [], stats: {}, imgInfo: new Map(), paths: [], pageMeta: new Map() }; }

  // страницы
  const pages = [];
  await pool(paths, async (path, k) => {
    const url = BASE + path;
    const h = await getText(url);
    if (h.status >= 300 && h.status < 400) {
      add('WARN', 'page-redirect', path, `→ ${h.status} ${h.headers.get('location')}`);
      pages.push({ path, http: h, p: null });
    } else {
      pages.push({ path, http: h, p: h.status === 200 ? parsePage(h.text, url) : null });
    }
    if ((k + 1) % 10 === 0) console.log(`  страниц: ${k + 1}/${paths.length}`);
  });
  pages.sort((a, b) => a.path.localeCompare(b.path));

  // проверка 404 и robots
  const nf = await req(`${BASE}/__no-such-page-audit__/`, 'GET');
  if (nf.status !== 404) add('WARN', 'no-404', '/__no-such-page-audit__/', `несуществующий URL даёт ${nf.status}, а не 404`);
  const rb = await getText(`${BASE}/robots.txt`);
  if (rb.status !== 200) add('ERR', 'robots-missing', '/robots.txt', `статус ${rb.status}`);
  else if (!/sitemap:/i.test(rb.text)) add('WARN', 'robots-no-sitemap', '/robots.txt', 'нет строки Sitemap:');

  const imgUrls = new Set();
  const linkUrls = new Map(); // url → [страницы]
  const stats = { work: { pages: 0, photos: 0 }, catalog: {}, product: 0 };
  const pageMeta = new Map(); // path → { kind, htmlKB, photos }

  for (const { path, http, p } of pages) {
    const kind = pageKind(path);
    if (!p) { if (http.status !== 200 && !(http.status >= 300 && http.status < 400)) add('ERR', 'page-status', path, `статус ${http.status}${http.error ? ' ' + http.error : ''}`); continue; }
    checkCommon(p, path, http);
    checkPerfHints(p, path);
    const meta = { kind, htmlKB: kb(http.bytes), photos: 0 };
    pageMeta.set(path, meta);
    if (kind === 'work') { const r = checkWork(p, path, imgUrls); stats.work.pages++; stats.work.photos += r.photos; meta.photos = r.photos; }
    if (kind === 'catalog' && path === '/vykonani-roboty/') stats.catalog = checkCatalog(p, path);
    if (kind === 'product') { checkProduct(p, path); stats.product++; }

    // картинки страницы → общий список
    p.imgs.forEach(im => {
      [im.src, ...parseSrcset(im.srcset)].forEach(u => { if (!u || u.startsWith('data:')) return; const a = abs(u, BASE + path); if (a) imgUrls.add(a); });
    });
    // ссылки
    [...p.anchors, p.canonical, ...p.alternates.map(a => a.href)].filter(Boolean).forEach(h => {
      if (/^(mailto:|tel:|viber:|tg:|javascript:|#)/i.test(h)) return;
      const a = abs(h, BASE + path); if (!a) return;
      const u = new URL(a); u.hash = '';
      if (!sameOrigin(a)) return;
      if (new URL(a).pathname.startsWith('/cdn-cgi/')) return; // служебные ссылки Cloudflare (защита email)
      const key = u.toString();
      (linkUrls.get(key) || linkUrls.set(key, []).get(key)).push(path);
    });
    // og:image
    if (p.og.image) { const a = abs(p.og.image, BASE + path); if (a) imgUrls.add(a); }
  }

  // дубли title/description/h1
  const dup = (key, code) => {
    const m = new Map();
    pages.filter(x => x.p && !/noindex/i.test(x.p.robots || '')).forEach(({ path, p }) => {
      const v = key(p); if (!v) return; (m.get(v) || m.set(v, []).get(v)).push(path);
    });
    for (const [v, ps] of m) if (ps.length > 1) add('WARN', code, ps[0], `${ps.length} стр. с одинаковым значением «${v.slice(0, 70)}»: ${ps.slice(0, 4).join(', ')}`);
  };
  dup(p => p.title, 'dup-title'); dup(p => p.description, 'dup-description'); dup(p => p.h1[0], 'dup-h1');

  // картинки: статус/формат/вес
  const imgList = [...imgUrls];
  console.log(`картинок к проверке: ${imgList.length}`);
  const imgInfo = new Map();
  await pool(imgList, async (u, k) => {
    const r = await req(u, 'HEAD');
    const len = Number(r.headers.get('content-length') || 0);
    imgInfo.set(u, { status: r.status, type: r.headers.get('content-type') || '', kb: kb(len) });
    const short = new URL(u).pathname;
    if (!sameOrigin(u)) return;
    if (r.status !== 200) add('ERR', 'img-broken', short, `статус ${r.status}`);
    else {
      if (len > IMG_WARN_KB * 1024) add('WARN', 'img-heavy', short, `${kb(len)} КБ`);
      if (/\/_astro\//.test(short) && !/webp/.test(imgInfo.get(u).type)) add('WARN', 'img-not-webp', short, imgInfo.get(u).type);
    }
    if ((k + 1) % 200 === 0) console.log(`  картинок: ${k + 1}/${imgList.length}`);
  });

  // ссылки: статус
  const links = [...linkUrls.keys()].filter(u => !imgUrls.has(u));
  console.log(`внутренних ссылок к проверке: ${links.length}`);
  await pool(links, async u => {
    const path = new URL(u).pathname;
    if (paths.includes(path)) return; // страницу уже проверили
    const r = await req(u, 'HEAD');
    const from = linkUrls.get(u).slice(0, 3).join(', ');
    if (r.status >= 300 && r.status < 400) add('WARN', 'link-redirect', path, `${r.status} → ${r.headers.get('location')} (со страниц: ${from})`);
    else if (r.status !== 200) add('ERR', 'link-broken', path, `статус ${r.status} (со страниц: ${from})`);
  });

  return { pages, stats, imgInfo, paths, pageMeta };
}


// ============================================================
//              PSI (PageSpeed) и локальный Lighthouse
// ============================================================
const kib = b => Math.round((b || 0) / 1024);
const median = arr => { const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const sec = ms => (ms / 1000).toFixed(1).replace('.', ',') + ' с';
const shortUrl = u => String(u || '').replace(/^https?:\/\/[^/]+/, '').slice(0, 110);
const slug = s => String(s).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'root';

// пороги Core Web Vitals (Google): [хорошо, плохо]
const THRESH = { FCP: [1800, 3000], LCP: [2500, 4000], INP: [200, 500], CLS: [0.1, 0.25], TTFB: [800, 1800], TBT: [200, 600] };
const cwv = (m, v) => {
  if (v == null || Number.isNaN(Number(v))) return '⚪';
  const [g, p] = THRESH[m];
  return Number(v) <= g ? '🟢' : Number(v) <= p ? '🟡' : '🔴';
};
const scoreIcon = s => s >= 90 ? '🟢' : s >= 50 ? '🟡' : '🔴';

function urlsIn(d) {
  const out = [];
  const walk = x => { if (!x || typeof x !== 'object') return; if (typeof x.url === 'string') out.push(x.url); for (const v of Object.values(x)) walk(v); };
  walk(d);
  return [...new Set(out)];
}

function cruxPick(exp) {
  const m = exp?.metrics; if (!m) return null;
  const g = k => m[k] ? { p75: m[k].percentile, cat: m[k].category } : null;
  return {
    overall: exp.overall_category || null,
    lcp: g('LARGEST_CONTENTFUL_PAINT_MS'), inp: g('INTERACTION_TO_NEXT_PAINT'), fcp: g('FIRST_CONTENTFUL_PAINT_MS'),
    ttfb: g('EXPERIMENTAL_TIME_TO_FIRST_BYTE'),
    cls: m.CUMULATIVE_LAYOUT_SHIFT_SCORE ? { p75: m.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100, cat: m.CUMULATIVE_LAYOUT_SHIFT_SCORE.category } : null,
  };
}

// Разбор отчёта Lighthouse. Id аудитов у разных версий Lighthouse отличаются (старые audit / новые *-insight),
// поэтому для ключевых полей есть запасные варианты; чего нет — остаётся пустым и не ломает отчёт.
function extract(lhr) {
  const a = lhr.audits || {};
  const num = id => a[id]?.numericValue ?? null;
  const val = id => a[id]?.displayValue ?? null;
  const rnd = v => v == null ? null : Math.round(v);
  const out = {
    score: Math.round((lhr.categories?.performance?.score ?? 0) * 100),
    FCP: val('first-contentful-paint'), LCP: val('largest-contentful-paint'), TBT: val('total-blocking-time'),
    CLS: val('cumulative-layout-shift'), SI: val('speed-index'), totalWeight: val('total-byte-weight'),
    fcpMs: rnd(num('first-contentful-paint')) ?? 0, lcpMs: rnd(num('largest-contentful-paint')) ?? 0,
    tbtMs: rnd(num('total-blocking-time')) ?? 0, cls: num('cumulative-layout-shift'), siMs: rnd(num('speed-index')),
    ttfbMs: rnd(num('server-response-time')),
    domElements: num('dom-size') ?? num('dom-size-insight'),
    requests: a['network-requests']?.details?.items?.length ?? null,
    fetchedAt: lhr.fetchTime,
  };
  try { // LCP: элемент и этапы
    const items = a['lcp-breakdown-insight']?.details?.items || [];
    const table = items.find(i => i.type === 'table');
    const node = items.find(i => i.type === 'node');
    out.lcpElement = node ? (node.selector || '') + ' | ' + (node.snippet || '').slice(0, 140) : null;
    out.lcpPhases = table ? table.items.map(i => ({ label: String(i.label || i.phase || '?'), ms: Math.round(i.duration || 0) })) : null;
    out.renderDelayMs = out.lcpPhases?.find(p => /render delay|отрисов/i.test(p.label))?.ms ?? null;
  } catch { /* ignore */ }
  try { // что грузит главный поток
    out.mainThreadTop = (a['mainthread-work-breakdown']?.details?.items || []).slice()
      .sort((x, y) => (y.duration || 0) - (x.duration || 0)).slice(0, 5)
      .map(i => ({ group: i.groupLabel || i.group, ms: Math.round(i.duration || 0) }));
  } catch { /* ignore */ }
  try { // сторонние скрипты
    const tp = a['third-party-summary']?.details?.items || a['third-parties-insight']?.details?.items || [];
    out.thirdParties = tp.slice().sort((x, y) => (y.blockingTime ?? y.mainThreadTime ?? 0) - (x.blockingTime ?? x.mainThreadTime ?? 0)).slice(0, 5)
      .map(i => ({ name: typeof i.entity === 'string' ? i.entity : (i.entity?.text || '?'), transferKiB: kib(i.transferSize), blockingMs: Math.round(i.blockingTime ?? 0), mainThreadMs: Math.round(i.mainThreadTime ?? 0) }));
  } catch { /* ignore */ }
  try { // JS по времени выполнения
    out.topJsByTime = (a['bootup-time']?.details?.items || []).slice()
      .sort((x, y) => (y.total ?? y.totalTime ?? 0) - (x.total ?? x.totalTime ?? 0)).slice(0, 5)
      .map(i => ({ url: shortUrl(i.url), ms: Math.round(i.total ?? i.totalTime ?? 0) }));
  } catch { /* ignore */ }
  try { // длинные задачи
    out.longTasks = (a['long-tasks']?.details?.items || []).slice(0, 5).map(i => ({ url: shortUrl(i.url), ms: Math.round(i.duration || 0) }));
  } catch { /* ignore */ }
  try { // неиспользуемый JS/CSS
    out.unusedJs = (a['unused-javascript']?.details?.items || []).slice(0, 5).map(i => ({ url: shortUrl(i.url), wastedKiB: kib(i.wastedBytes) }));
    out.unusedCss = (a['unused-css-rules']?.details?.items || []).slice(0, 5).map(i => ({ url: shortUrl(i.url), wastedKiB: kib(i.wastedBytes) }));
  } catch { /* ignore */ }
  try { // вес по типам ресурсов
    out.byType = (a['resource-summary']?.details?.items || []).filter(i => i.resourceType !== 'total')
      .map(i => ({ type: i.resourceType, req: i.requestCount, kib: kib(i.transferSize) })).sort((x, y) => y.kib - x.kib);
  } catch { /* ignore */ }
  try { // картинки
    const rows = (a['image-delivery-insight']?.details?.items || []).map(i => ({
      url: shortUrl(i.url || i.node?.snippet || ''), sizeKiB: kib(i.totalBytes), saveKiB: kib(i.wastedBytes),
    })).sort((x, y) => y.saveKiB - x.saveKiB);
    out.imageSavingsTotal = val('image-delivery-insight');
    out.imageCount = rows.length;
    out.topImages = rows.slice(0, 5);
  } catch { /* ignore */ }
  try { // блокирующие ресурсы
    const rb = a['render-blocking-insight'] || a['render-blocking-resources'];
    out.renderBlocking = rb?.displayValue ?? null;
    out.renderBlockingUrls = urlsIn(rb?.details).map(shortUrl);
  } catch { /* ignore */ }
  try { // LCP-картинка обнаруживается рано?
    const d = a['lcp-discovery-insight'] || a['prioritize-lcp-image'];
    out.lcpDiscoveryScore = d?.score ?? null;
  } catch { /* ignore */ }
  const handled = new Set(['first-contentful-paint', 'largest-contentful-paint', 'speed-index', 'total-blocking-time', 'cumulative-layout-shift',
    'image-delivery-insight', 'mainthread-work-breakdown', 'third-party-summary', 'bootup-time', 'unused-javascript', 'unused-css-rules',
    'dom-size', 'server-response-time', 'long-tasks', 'resource-summary', 'render-blocking-insight', 'render-blocking-resources',
    'lcp-discovery-insight', 'prioritize-lcp-image']);
  out.otherIssues = Object.entries(a)
    .filter(([id, x]) => x.score !== null && x.score !== undefined && x.score < 0.9 &&
      x.scoreDisplayMode !== 'informative' && x.scoreDisplayMode !== 'notApplicable' && !handled.has(id))
    .map(([id, x]) => `${id}${x.displayValue ? ' — ' + x.displayValue : ''}`);
  return out;
}

async function psiCall(url, strategy) {
  const q = new URLSearchParams({ url, strategy, category: 'performance', locale: 'en' });
  if (KEY) q.set('key', KEY);
  const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(api);
    if (res.ok) {
      const j = await res.json();
      return { lhr: j.lighthouseResult, crux: { page: cruxPick(j.loadingExperience), origin: cruxPick(j.originLoadingExperience) } };
    }
    if (res.status === 429 || res.status >= 500) { await sleep(attempt * 15000); continue; }
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error('слишком много повторов (429/5xx) — проверь PSI_KEY');
}

// Локальный Lighthouse через npx (на GitHub-runner Chrome уже установлен)
function labCall(url, device) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(fs.existsSync('raw') ? 'raw' : '.', `lh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    const args = ['--yes', `lighthouse@${LH_VERSION}`, url, '--output=json', `--output-path=${tmp}`, '--only-categories=performance',
      '--locale=en', '--quiet', '--chrome-flags=--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage'];
    if (device === 'desktop') args.push('--preset=desktop');
    const p = spawn('npx', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', d => { err = (err + d).slice(-600); });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('lighthouse: таймаут 5 минут')); }, 300000);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      try { const lhr = JSON.parse(fs.readFileSync(tmp, 'utf8')); fs.rmSync(tmp, { force: true }); resolve(lhr); }
      catch { reject(new Error(`lighthouse завершился с кодом ${code}: ${err.trim().slice(-300)}`)); }
    });
  });
}

const sameRun = (a, b) => !!a && !!b && (
  (a.fetchedAt && a.fetchedAt === b.fetchedAt) ||
  (a.score === b.score && a.lcpMs === b.lcpMs && a.fcpMs === b.fcpMs && a.tbtMs === b.tbtMs));

// ---- выбор страниц ----
function pickJobs(audit) {
  const paths = audit.paths || [];
  const meta = audit.pageMeta || new Map();
  const has = p => paths.includes(p);
  const picked = new Set();
  if (TARGETS.length) TARGETS.forEach(p => picked.add(p));
  else if (MODE === 'final') paths.forEach(p => picked.add(p));
  else {
    ['/', '/ru/', '/posluhy-ta-produktsiia/', '/kontakty/', '/pro-nas/', '/vykonani-roboty/'].forEach(p => has(p) && picked.add(p));
    paths.filter(p => pageKind(p) === 'product').forEach(p => picked.add(p));
    const works = paths.filter(p => pageKind(p) === 'work').sort();
    if (works.length) {
      const byHtml = [...works].sort((a, b) => (meta.get(b)?.htmlKB || 0) - (meta.get(a)?.htmlKB || 0));
      const byPhotos = [...works].sort((a, b) => (meta.get(b)?.photos || 0) - (meta.get(a)?.photos || 0));
      picked.add(byHtml[0]); picked.add(byPhotos[0]); picked.add(works[works.length >> 1]);
      (job.pinnedWorks || PINNED_WORKS).forEach(s => { const p = `/vykonani-roboty/${s}/`; if (has(p)) picked.add(p); });
    }
  }
  const devs = p => DEVICE === 'both' ? ['mobile', 'desktop'] : DEVICE === 'desktop' ? ['desktop']
    : DEVICE === 'key' ? ['mobile', ...(DESKTOP_PATHS.includes(p) ? ['desktop'] : [])] : ['mobile'];
  const jobs = [];
  for (const p of [...picked].sort()) for (const d of devs(p)) jobs.push({ path: p, strategy: (IS_LAB ? 'lab-' : '') + d });
  return jobs;
}

async function warm(url) { try { await fetch(url, { headers: { 'user-agent': 'site-check-warmup/2.0' } }); } catch { /* ignore */ } }

async function psiOnce(st, bust, n) {
  const url = BASE + st.path + (bust ? (st.path.includes('?') ? '&' : '?') + `psi=${Date.now()}` : '');
  if (bust) await warm(url);
  const isLab = st.strategy.startsWith('lab-');
  const dev = st.strategy.replace('lab-', '');
  let lhr, crux = null;
  if (isLab) lhr = await labCall(url, dev); else ({ lhr, crux } = await psiCall(url, dev));
  if (SAVE_RAW && n <= 2) {
    try { fs.mkdirSync(RAW_DIR, { recursive: true }); fs.writeFileSync(path.join(RAW_DIR, `${slug(st.path)}_${st.strategy}_${n}.json`), JSON.stringify(lhr)); } catch { /* ignore */ }
  }
  st.last = Date.now();
  return { bust: !!bust, crux, ...extract(lhr) };
}

async function waitGap(st) {
  if (IS_LAB) return;
  const wait = st.last + GAP_MS - Date.now();
  if (st.last && wait > 0) { console.log(`   (пауза ${Math.ceil(wait / 1000)} с до повтора ${st.strategy} ${st.path})`); await sleep(wait); }
}

async function doRun(st, k, total) {
  if (stopping) return;
  await waitGap(st);
  if (stopping) return;
  const tag = `${st.strategy.padEnd(11)} ${st.path} [${k}/${total}]`;
  try {
    let r = await psiOnce(st, BUST_ALL, k);
    const prev = st.runs[st.runs.length - 1];
    if (!IS_LAB && sameRun(prev, r)) {
      console.log(`${tag} ${r.score} — совпало с предыдущим, похоже на кэш; жду и повторяю с ?psi=…`);
      await sleep(GAP_MS);
      if (stopping) { r.cacheSuspect = true; st.runs.push(r); return; }
      const r2 = await psiOnce(st, true, k);
      r2.cacheRetry = true;
      if (sameRun(prev, r2)) r2.cacheSuspect = true;
      r = r2;
    }
    st.runs.push(r);
    console.log(`${tag} ${r.score}  LCP ${r.LCP}${r.cacheSuspect ? '  ⚠ кэш?' : ''}`);
  } catch (e) {
    st.errors++;
    console.log(`${tag} ОШИБКА ${e.message || e}`);
  }
  if (!IS_LAB) await sleep(KEY ? 1000 : 6000);
}

function summarize(st) {
  if (!st.runs.length) return { path: st.path, strategy: st.strategy, error: 'все прогоны упали' };
  const fresh = st.runs.filter(r => !r.cacheSuspect);
  const runs = fresh.length ? fresh : st.runs;
  const scores = runs.map(r => r.score);
  const medScore = median(scores);
  const typical = runs.reduce((b, r) => Math.abs(r.score - medScore) < Math.abs(b.score - medScore) ? r : b, runs[0]);
  return {
    path: st.path, strategy: st.strategy, n: runs.length, scores, scoreMedian: medScore,
    scoreMin: Math.min(...scores), scoreMax: Math.max(...scores), spread: Math.max(...scores) - Math.min(...scores),
    lcpMedianMs: median(runs.map(r => r.lcpMs)), fcpMedianMs: median(runs.map(r => r.fcpMs)), tbtMedianMs: median(runs.map(r => r.tbtMs)),
    ttfbMedianMs: runs.some(r => r.ttfbMs != null) ? median(runs.map(r => r.ttfbMs ?? 0)) : null,
    renderDelayMedianMs: runs.some(r => r.renderDelayMs != null) ? median(runs.map(r => r.renderDelayMs ?? 0)) : null,
    cacheSuspects: st.runs.filter(r => r.cacheSuspect).length, errors: st.errors, typical,
  };
}

async function runPsi(jobs) {
  const states = jobs.map(j => ({ ...j, runs: [], last: 0, errors: 0 }));
  const par = IS_LAB ? 1 : PAR;
  if (!IS_LAB) { console.log(`\nПрогрев ${states.length} страниц…`); await pool([...new Set(states.map(s => s.path))], p => warm(BASE + p), 4); }
  for (let round = 1; round <= RUNS && !stopping; round++) await pool(states, st => doRun(st, round, RUNS), par);
  if (MODE === 'final' && RUNS < 3 && !stopping) {
    const weak = states.filter(s => s.runs.length && median(s.runs.map(r => r.score)) < RETRY_BELOW);
    if (weak.length) {
      console.log(`\nСтраниц ниже ${RETRY_BELOW}: ${weak.length} — перепрогоняю ещё 3 раза.`);
      for (let round = 1; round <= 3 && !stopping; round++) await pool(weak, st => doRun(st, RUNS + round, RUNS + 3), par);
    }
  }
  return states.map(summarize);
}

// ============================================================
//                 СЕРВЕРНАЯ ДИАГНОСТИКА (без PSI)
// ============================================================
// Заголовки и скорость ответа сервера. TTFB считается из GitHub-runner (США/ЕС), а не из Украины:
// важна не абсолютная цифра, а стабильность и динамика между запусками.
async function timedGet(url, headers = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { 'accept-encoding': 'br, gzip', 'user-agent': UA, ...headers }, redirect: 'manual' });
    const ms = Date.now() - t0;
    const buf = await r.arrayBuffer();
    return { ok: true, ms, status: r.status, h: r.headers, bytes: buf.byteLength, text: /text|html|json|xml/.test(r.headers.get('content-type') || '') ? Buffer.from(buf).toString('utf8') : '' };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: String(e.message || e) }; }
}
const hdr = (h, n) => h?.get(n) || '';

async function serverDiag(paths) {
  const set = new Set(['/']);
  const prod = paths.find(p => pageKind(p) === 'product'); if (prod) set.add(prod);
  const wk = paths.find(p => pageKind(p) === 'work'); if (wk) set.add(wk);
  TARGETS.slice(0, 3).forEach(p => set.add(p));
  console.log(`\nСерверная диагностика: ${set.size} страниц × 5 запросов`);
  const pages = []; let homeText = '';
  for (const p of set) {
    const times = []; let first = null;
    for (let i = 0; i < 5; i++) {
      const r = await timedGet(BASE + p);
      if (r.ok) { times.push(r.ms); if (!first) first = r; }
      await sleep(300);
    }
    if (!first) { add('ERR', 'srv-unreachable', p, 'сервер не ответил ни на один из 5 запросов'); continue; }
    if (p === '/') homeText = first.text;
    const row = { path: p, status: first.status, min: Math.min(...times), med: median(times), max: Math.max(...times),
      cf: hdr(first.h, 'cf-cache-status'), cc: hdr(first.h, 'cache-control'), enc: hdr(first.h, 'content-encoding'), kb: kb(first.bytes), server: hdr(first.h, 'server') };
    pages.push(row);
    if (first.status === 200 && !row.enc && first.bytes > 1500) add('WARN', 'srv-no-compression', p, 'HTML отдаётся без сжатия (нет content-encoding)');
    if (row.med > 800) add('WARN', 'srv-slow-html', p, `медиана ответа ${row.med} мс из runner (мин ${row.min}, макс ${row.max})`);
    if (row.max > 3 * Math.max(row.med, 100) && row.max > 1000) add('INFO', 'srv-unstable-html', p, `разброс ответа: ${row.min}–${row.max} мс`);
  }
  const found = [...new Set([...(homeText.match(/\/_astro\/[^"'\s)]+\.(?:webp|js|css)/g) || []).slice(0, 2), ...(homeText.match(/\/js\/[^"'\s]+\.js/g) || []).slice(0, 1)])];
  const assets = [];
  for (const a of found) {
    await timedGet(BASE + a); // первый запрос может быть MISS
    const r = await timedGet(BASE + a);
    if (!r.ok) continue;
    const cc = hdr(r.h, 'cache-control');
    const maxAge = Number((cc.match(/max-age=(\d+)/) || [])[1] || 0);
    assets.push({ path: a, status: r.status, ms: r.ms, cf: hdr(r.h, 'cf-cache-status'), cc, enc: hdr(r.h, 'content-encoding'), age: hdr(r.h, 'age'), kb: kb(r.bytes) });
    if (a.startsWith('/_astro/') && maxAge < 2592000 && !/immutable/.test(cc)) add('WARN', 'srv-asset-short-cache', a, `cache-control: «${cc || 'нет'}» (файл с хешем в имени можно кэшировать на год)`);
    if (/\.(js|css)$/.test(a) && !hdr(r.h, 'content-encoding') && r.bytes > 1500) add('WARN', 'srv-asset-no-compression', a, 'JS/CSS без сжатия');
    if (r.status === 200 && hdr(r.h, 'cf-cache-status') && !/HIT|DYNAMIC/i.test(hdr(r.h, 'cf-cache-status'))) add('INFO', 'srv-asset-not-hit', a, `cf-cache-status: ${hdr(r.h, 'cf-cache-status')} при повторном запросе`);
  }
  return { pages, assets };
}

// ============================================================
//                    ИСТОРИЯ, РАЗБОР ПРИЧИН, ОТЧЁТ
// ============================================================
// Сравнение: для каждой пары «страница|режим» берётся самый свежий предыдущий замер из reports/*.json
function loadPrev(dir) {
  const merged = { pages: {}, html: {}, date: null };
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'processed.json').sort().reverse().slice(0, 60); } catch { /* нет папки */ }
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).snapshot;
      if (!s || s.base !== BASE) continue;
      merged.date ??= s.date;
      for (const [k, v] of Object.entries(s.pages || {})) if (!(k in merged.pages)) merged.pages[k] = { ...v, date: s.date };
      for (const [k, v] of Object.entries(s.html || {})) if (!(k in merged.html)) merged.html[k] = v;
    } catch { /* битый файл пропускаем */ }
  }
  return merged;
}

function buildSnapshot(psi, audit) {
  const snap = { date: NOW.toISOString(), base: BASE, label: LABEL, mode: MODE, jobId: JOB_ID, pages: {}, html: {} };
  for (const r of psi) if (!r.error) snap.pages[`${r.path}|${r.strategy}`] = { score: r.scoreMedian, spread: r.spread, lcpMs: r.lcpMedianMs, fcpMs: r.fcpMedianMs, tbtMs: r.tbtMedianMs };
  for (const [p, m] of (audit.pageMeta || new Map())) snap.html[p] = m.htmlKB;
  return snap;
}

function diffVsPrev(prev, snap) {
  const out = { score: new Map(), regressions: [], improvements: [], htmlGrowth: [] };
  for (const [k, cur] of Object.entries(snap.pages)) {
    const old = prev.pages[k]; if (!old) continue;
    const d = cur.score - old.score;
    const noise = Math.max(5, cur.spread || 0, old.spread || 0);
    out.score.set(k, { d, noise: Math.abs(d) <= noise });
    const line = `${k.replace('|', ' ')}: ${old.score} → ${cur.score}, LCP ${sec(old.lcpMs)} → ${sec(cur.lcpMs)} (было ${old.date.slice(0, 10)})`;
    if (d <= -noise || (cur.lcpMs - old.lcpMs >= 700 && d < 0)) out.regressions.push(line);
    else if (d >= noise) out.improvements.push(line);
  }
  for (const [p, kbNow] of Object.entries(snap.html)) {
    const kbOld = prev.html[p];
    if (kbOld && kbNow - kbOld >= 5 && kbNow / kbOld > 1.2) out.htmlGrowth.push(`${p}: HTML ${kbOld} → ${kbNow} КБ`);
  }
  return out;
}

function phaseHint(label) {
  if (/load delay/i.test(label)) return 'LCP-картинка обнаружена поздно: нужен fetchpriority="high"/preload, не lazy';
  if (/load duration|load time/i.test(label)) return 'сама загрузка файла долгая: уменьшить вес/размер картинки';
  if (/render delay/i.test(label)) return 'после загрузки отрисовку держат CSS/JS (блокирующие ресурсы, главный поток)';
  if (/first byte|ttfb/i.test(label)) return 'долго отвечает сервер/CDN';
  return 'проверь этап в деталях';
}

function findCulprits(psi) {
  const res = [];
  for (const r of psi.filter(x => !x.error && x.scoreMedian < 95)) {
    const t = r.typical, why = [];
    if (t.ttfbMs > 800) why.push(`${cwv('TTFB', t.ttfbMs)} TTFB ${sec(t.ttfbMs)} — серверная часть (кэш/CDN/сервер)`);
    if (t.lcpPhases?.length && t.lcpMs) {
      const big = [...t.lcpPhases].sort((a, b) => b.ms - a.ms)[0];
      if (big && big.ms > 400 && big.ms > 0.4 * t.lcpMs) why.push(`LCP ${sec(t.lcpMs)}: дольше всего этап «${big.label}» (${big.ms} мс) — ${phaseHint(big.label)}`);
    }
    if (t.lcpDiscoveryScore != null && t.lcpDiscoveryScore < 0.9) why.push('LCP-картинка не оптимизирована для раннего обнаружения (fetchpriority/preload)');
    if (t.renderBlockingUrls?.length) why.push(`${t.renderBlockingUrls.length} блокирующих ресурсов: ${t.renderBlockingUrls.slice(0, 3).join(', ')}`);
    if (t.tbtMs > 200) {
      const tp = t.thirdParties?.[0], mt = t.mainThreadTop?.[0], js = t.topJsByTime?.[0];
      const bits = [];
      if (mt) bits.push(`главный поток: ${mt.group} ${mt.ms} мс`);
      if (tp && (tp.blockingMs > 50 || tp.mainThreadMs > 200)) bits.push(`сторонний «${tp.name}» (блокировка ${tp.blockingMs} мс)`);
      if (js && js.ms > 300) bits.push(`JS ${js.url} ${js.ms} мс`);
      why.push(`TBT ${t.tbtMs} мс` + (bits.length ? ' — ' + bits.join('; ') : ''));
    }
    if (t.domElements > 1500) why.push(`DOM ${t.domElements} элементов (много)`);
    const uj = (t.unusedJs || [])[0]; if (uj && uj.wastedKiB > 100) why.push(`неиспользуемый JS ${uj.url}: ${uj.wastedKiB} КиБ`);
    const ti = (t.topImages || [])[0]; if (ti && ti.saveKiB > 100) why.push(`картинка ${ti.url}: можно сэкономить ${ti.saveKiB} КиБ`);
    const rel = issues.filter(i => i.page === r.path && PERF_CODES.has(i.code) && i.code !== 'script-no-defer').map(i => i.code);
    if (rel.length) why.push(`аудит HTML: ${[...new Set(rel)].join(', ')}`);
    if (why.length) res.push({ path: r.path, strategy: r.strategy, score: r.scoreMedian, reasons: why });
  }
  return res.sort((a, b) => a.score - b.score).slice(0, 8);
}

function renderReport({ audit, psi, diff, prev, server, culprits }) {
  const order = { ERR: 0, WARN: 1, INFO: 2 };
  const icon = { ERR: '🔴', WARN: '🟡', INFO: '⚪' };
  const cnt = s => issues.filter(i => i.sev === s).length;
  const groups = new Map();
  for (const i of issues) { const k = i.sev + '|' + i.code; if (!groups.has(k)) groups.set(k, { sev: i.sev, code: i.code, items: [] }); groups.get(k).items.push(i); }
  const list = [...groups.values()].sort((a, b) => order[a.sev] - order[b.sev] || b.items.length - a.items.length);
  const stats = audit.stats || {};
  const totalImgKB = [...(audit.imgInfo || new Map()).values()].reduce((s, x) => s + x.kb, 0);
  const okPsi = psi.filter(r => !r.error);
  const weak = okPsi.filter(r => r.scoreMedian < 90);
  const flaky = okPsi.filter(r => r.spread > 10);
  const cacheSus = okPsi.filter(r => r.cacheSuspects);
  const measured = MODE !== 'audit';

  let md = `# Site check — ${BASE}${LABEL ? ' [' + LABEL + ']' : ''}\n`;
  md += `Дата: ${NOW.toISOString().slice(0, 16).replace('T', ' ')} UTC (Киев: ${kyivTime(NOW)}) | режим: **${MODE}**${IS_LAB ? ' (локальный Lighthouse)' : ''}`;
  if (measured) md += ` | прогонов: ${RUNS} | потоков: ${IS_LAB ? 1 : PAR} | устройства: ${DEVICE}`;
  md += `\n`;
  if (JOB_ID) md += `Job: \`${JOB_ID}\`\n`;
  if (GOAL) md += `Цель: ${GOAL}\n`;

  md += `\n## Итоги\n`;
  if (RUN_AUDIT) {
    md += `- Аудит: страниц ${audit.pages?.length ?? 0}, картинок ${audit.imgInfo?.size ?? 0} (${Math.round(totalImgKB / 1024)} МБ) → 🔴 ${cnt('ERR')} | 🟡 ${cnt('WARN')} | ⚪ ${cnt('INFO')}\n`;
    md += `- Карточек работ: ${stats.work?.pages ?? 0} (фото: ${stats.work?.photos ?? 0}), в каталоге: ${stats.catalog?.cards ?? '?'}, страниц продукции: ${stats.product ?? 0}\n`;
  } else md += `- Структурный аудит не запускался (замечания ниже — только серверная диагностика)\n`;
  if (measured) {
    md += `- ${IS_LAB ? 'Lighthouse' : 'PSI'}: измерено ${okPsi.length} из ${psi.length}; ниже 90: ${weak.length ? weak.map(r => `${r.path} (${r.strategy} ${r.scoreMedian})`).join(', ') : 'нет'}\n`;
    md += `- Нестабильные (разброс > 10): ${flaky.length ? flaky.map(r => `${r.path} (${r.strategy} ${r.scores.join('/')})`).join(', ') : 'нет'}\n`;
    if (cacheSus.length) md += `- ⚠ Похоже на кэш PSI: ${cacheSus.map(r => r.path).join(', ')}\n`;
  }

  if (measured && culprits.length) {
    md += `\n## Топ причин низкой производительности\n_Чинить в этом порядке: сверху худшие страницы._\n\n`;
    culprits.forEach((c, i) => { md += `${i + 1}. \`${c.path}\` (${c.strategy}, ${c.score})\n`; c.reasons.forEach(r => { md += `   - ${r}\n`; }); });
  } else if (measured && okPsi.length) md += `\n## Топ причин низкой производительности\nСтраниц с оценкой ниже 95 нет — разбирать нечего 🎉\n`;

  if (measured) {
    md += `\n## ${IS_LAB ? 'Lighthouse' : 'PSI'}: Core Web Vitals (оценка = медиана прогонов)\n\n`;
    md += `| Страница | Режим | Оценка | Прогоны | FCP | LCP | TBT | CLS | TTFB | К прошлому |\n|---|---|---|---|---|---|---|---|---|---|\n`;
    for (const r of psi) {
      if (r.error) { md += `| ${r.path} | ${r.strategy} | ошибка | | | | | | | |\n`; continue; }
      const t = r.typical, d = diff.score.get(`${r.path}|${r.strategy}`);
      const dTxt = d ? `${d.d > 0 ? '+' : ''}${d.d}${d.noise ? ' ~' : d.d < 0 ? ' ⬇' : ' ⬆'}` : '';
      md += `| ${r.path} | ${r.strategy} | ${scoreIcon(r.scoreMedian)} **${r.scoreMedian}**${r.spread > 10 ? ' ⚠' : ''} | ${r.scores.join(' / ')} | ${cwv('FCP', r.fcpMedianMs)} ${sec(r.fcpMedianMs)} | ${cwv('LCP', r.lcpMedianMs)} ${sec(r.lcpMedianMs)} | ${cwv('TBT', r.tbtMedianMs)} ${r.tbtMedianMs} мс | ${cwv('CLS', t.cls)} ${t.cls != null ? t.cls.toFixed(3) : '—'} | ${r.ttfbMedianMs != null ? cwv('TTFB', r.ttfbMedianMs) + ' ' + r.ttfbMedianMs + ' мс' : '—'} | ${dTxt} |\n`;
    }
    md += `\n«~» — изменение в пределах шума (≤ max(5, разброс)); ⚠ — разброс прогонов больше 10 пунктов. Пороги: 🟢 хорошо / 🟡 терпимо / 🔴 плохо по критериям Google.\n`;
    if (IS_LAB) md += `⚠ Оценки локального Lighthouse (серверы GitHub) не равны оценкам PSI — сравнивай lab только с lab.\n`;

    if (prev.date) {
      md += `\n## Что изменилось с прошлых замеров (самый свежий: ${prev.date.slice(0, 16).replace('T', ' ')})\n`;
      if (!diff.regressions.length && !diff.improvements.length && !diff.htmlGrowth.length) md += `Значимых изменений нет.\n`;
      diff.regressions.forEach(x => { md += `- 🔻 ${x}\n`; });
      diff.improvements.forEach(x => { md += `- 🔺 ${x}\n`; });
      diff.htmlGrowth.forEach(x => { md += `- 📈 ${x}\n`; });
    }

    const cruxRows = okPsi.filter(r => !r.strategy.startsWith('lab-') && (r.typical.crux?.page || r.typical.crux?.origin));
    if (!IS_LAB) {
      md += `\n## Реальные пользователи (CrUX, p75 за 28 дней)\n`;
      if (!cruxRows.length) md += `Данных нет — трафика мало для отчёта Google. Это нормально для B2B-сайта.\n`;
      else {
        md += `| Страница | Источник | LCP | INP | CLS | FCP | TTFB |\n|---|---|---|---|---|---|---|\n`;
        const seenOrigin = new Set();
        for (const r of cruxRows) {
          const c = r.typical.crux;
          const row = (src, x) => x ? `| ${r.path} | ${src} | ${x.lcp ? cwv('LCP', x.lcp.p75) + ' ' + sec(x.lcp.p75) : '—'} | ${x.inp ? cwv('INP', x.inp.p75) + ' ' + x.inp.p75 + ' мс' : '—'} | ${x.cls ? cwv('CLS', x.cls.p75) + ' ' + x.cls.p75 : '—'} | ${x.fcp ? sec(x.fcp.p75) : '—'} | ${x.ttfb ? sec(x.ttfb.p75) : '—'} |\n` : '';
          md += row('страница', c.page);
          if (!seenOrigin.has(r.strategy)) { seenOrigin.add(r.strategy); md += row('весь сайт', c.origin).replace(r.path, `(${r.strategy})`); }
        }
        md += `\nINP измеряется только у реальных пользователей — в лабораторном замере его нет.\n`;
      }
    }
  }

  if (server?.pages?.length) {
    md += `\n## Серверная диагностика (5 запросов с runner'а)\n\n| Страница | Статус | Ответ мин/мед/макс, мс | cf-cache | cache-control | сжатие | КБ |\n|---|---|---|---|---|---|---|\n`;
    server.pages.forEach(p => { md += `| ${p.path} | ${p.status} | ${p.min}/${p.med}/${p.max} | ${p.cf || '—'} | ${p.cc || '—'} | ${p.enc || '**нет**'} | ${p.kb} |\n`; });
    if (server.assets.length) {
      md += `\n| Ресурс | Статус | мс | cf-cache | cache-control | сжатие | age |\n|---|---|---|---|---|---|---|\n`;
      server.assets.forEach(a => { md += `| ${a.path} | ${a.status} | ${a.ms} | ${a.cf || '—'} | ${a.cc || '—'} | ${a.enc || '—'} | ${a.age || '—'} |\n`; });
    }
    md += `\nОтвет измеряется из дата-центра GitHub, а не из Украины: смотри динамику и стабильность, не абсолютные цифры.\n`;
  }

  md += `\n## Замечания\n`;
  if (!list.length) md += 'Замечаний нет 🎉\n';
  for (const g of list) {
    md += `\n### ${icon[g.sev]} ${g.code} — ${g.items.length}\n`;
    g.items.slice(0, 6).forEach(i => { md += `- \`${i.page}\` — ${i.msg}\n`; });
    if (g.items.length > 6) md += `- … и ещё ${g.items.length - 6}\n`;
  }
  const top = [...(audit.imgInfo || new Map()).entries()].sort((a, b) => b[1].kb - a[1].kb).slice(0, 10);
  if (top.length && DETAIL === 'full') { md += `\n### Самые тяжёлые картинки\n`; top.forEach(([u, x]) => { md += `- ${x.kb} КБ — \`${new URL(u).pathname}\`\n`; }); }

  if (measured && DETAIL === 'full') {
    md += `\n## Детали (по «типичному» прогону)\n`;
    for (const r of okPsi) {
      const t = r.typical, f = (arr, fn) => (arr || []).map(fn).join('; ') || '—';
      md += `\n### ${r.path} (${r.strategy}, ${t.score})\n`
        + `- LCP-элемент: ${t.lcpElement || '—'}\n- Этапы LCP: ${f(t.lcpPhases, p => `${p.label}: ${p.ms} мс`)}\n`
        + `- Блокирующие: ${t.renderBlocking || '—'}${t.renderBlockingUrls?.length ? ' [' + t.renderBlockingUrls.join(', ') + ']' : ''}\n`
        + `- Главный поток: ${f(t.mainThreadTop, x => `${x.group} ${x.ms} мс`)}\n`
        + `- Сторонние: ${f(t.thirdParties, x => `${x.name} (${x.transferKiB} КиБ, блок. ${x.blockingMs} мс)`)}\n`
        + `- JS по времени: ${f(t.topJsByTime, x => `${x.url} ${x.ms} мс`)}\n`
        + `- Длинные задачи: ${f(t.longTasks, x => `${x.url} ${x.ms} мс`)}\n`
        + `- Неиспользуемый JS: ${f(t.unusedJs, x => `${x.url} ${x.wastedKiB} КиБ`)}; CSS: ${f(t.unusedCss, x => `${x.url} ${x.wastedKiB} КиБ`)}\n`
        + `- Вес по типам: ${f(t.byType, x => `${x.type} ${x.kib} КиБ/${x.req} зап.`)}\n`
        + `- Запросов: ${t.requests ?? '—'}, вес: ${t.totalWeight || '—'}, DOM: ${t.domElements ?? '—'}\n`
        + `- Картинки: ${t.imageSavingsTotal || '—'}, всего ${t.imageCount ?? '—'}; топ: ${f(t.topImages, i => `${i.url} (${i.sizeKiB} КиБ, экономия ${i.saveKiB})`)}\n`
        + `- Прочее: ${(t.otherIssues || []).join('; ') || '—'}\n`;
    }
  }
  return md;
}

// Короткая сводка для Telegram (лимит сообщения 4096 символов)
function buildSummary({ audit, psi, diff, culprits, server }) {
  const cnt = s => issues.filter(i => i.sev === s).length;
  const okPsi = psi.filter(r => !r.error);
  const L = [];
  L.push(`🔬 site-check | ${MODE}${IS_LAB ? ' (lab)' : ''} | ${LABEL}`);
  if (GOAL) L.push(`🎯 ${GOAL}`);
  L.push(`🕒 ${NOW.toISOString().slice(0, 16).replace('T', ' ')} UTC (Киев ${kyivTime(NOW)})`);
  if (RUN_AUDIT) L.push(`Аудит: 🔴 ${cnt('ERR')} | 🟡 ${cnt('WARN')} | ⚪ ${cnt('INFO')} (страниц ${audit.pages?.length ?? 0})`);
  if (MODE !== 'audit') {
    L.push(`${IS_LAB ? 'Lighthouse' : 'PSI'}: измерено ${okPsi.length}/${psi.length}`);
    const sorted = [...okPsi].sort((a, b) => a.scoreMedian - b.scoreMedian);
    const lines = sorted.filter(r => sorted.length <= 14 || r.scoreMedian < 90).slice(0, 14);
    lines.forEach(r => L.push(`${scoreIcon(r.scoreMedian)} ${r.scoreMedian} ${r.strategy} ${r.path} · LCP ${sec(r.lcpMedianMs)} · TBT ${r.tbtMedianMs}`));
    if (lines.length < sorted.length) L.push(`… остальные ${sorted.length - lines.length} стр. ≥ 90`);
    if (diff.regressions.length) { L.push('🔻 Регрессии:'); diff.regressions.slice(0, 4).forEach(x => L.push('• ' + x)); }
    if (diff.improvements.length) L.push(`🔺 Улучшений: ${diff.improvements.length}`);
    if (culprits.length) { L.push('Топ причин:'); culprits.slice(0, 3).forEach((c, i) => L.push(`${i + 1}. ${c.path} (${c.score}): ${c.reasons[0]}`)); }
  }
  const sv = server?.pages?.find(p => p.path === '/');
  if (sv) L.push(`Сервер /: ответ ${sv.min}/${sv.med}/${sv.max} мс, cf-cache ${sv.cf || '—'}, сжатие ${sv.enc || 'нет'}`);
  return L.join('\n').slice(0, 3800);
}

// ============================================================
//                          MAIN
// ============================================================
async function main() {
  console.log(`site-check: ${BASE} [${LABEL}] | режим ${MODE}${IS_LAB ? ' (lab)' : ''}${MODE !== 'audit' ? `, прогонов ${RUNS}, потоков ${IS_LAB ? 1 : PAR}, устройства ${DEVICE}` : ''}`);
  if (GOAL) console.log(`Цель: ${GOAL}`);
  if (MODE !== 'audit' && !IS_LAB && !KEY) console.log('⚠ PSI_KEY не задан: PSI будет часто отвечать 429 и работать медленнее.');

  let audit = { pages: [], stats: {}, imgInfo: new Map(), paths: [], pageMeta: new Map() };
  if (RUN_AUDIT) audit = await runAudit();
  let jobs = [];
  if (MODE !== 'audit') {
    jobs = pickJobs(audit);
    if (!jobs.length) die('Нет страниц для замера (проверь список страниц или sitemap).');
    const estSec = IS_LAB ? jobs.length * RUNS * 45 : Math.round(jobs.length * RUNS * 30 / PAR + Math.max(0, RUNS - 1) * Math.max(0, GAP_MS / 1000 - jobs.length * 30 / PAR));
    console.log(`\nЗамеры: страниц×режимов ${jobs.length}, прогонов ${jobs.length * RUNS}, ориентировочно ${Math.max(1, Math.round(estSec / 60))} мин.`);
    if (PLAN_ONLY) { jobs.forEach(j => console.log(`  ${j.strategy.padEnd(11)} ${j.path}`)); console.log('\nplan: только план, замеры не запускались.'); return; }
  } else if (PLAN_ONLY) { console.log('plan: режим audit — замеров нет.'); return; }

  const server = WITH_SERVER ? await serverDiag(audit.paths?.length ? audit.paths : []) : null;
  const psi = jobs.length ? await runPsi(jobs) : [];

  const prev = loadPrev(path.dirname(OUT));
  const snap = buildSnapshot(psi, audit);
  const diff = diffVsPrev(prev, snap);
  const culprits = psi.length ? findCulprits(psi) : [];
  const ctx = { audit, psi, diff, prev, server, culprits };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(`${OUT}.md`, renderReport(ctx));
  fs.writeFileSync(`${OUT}.summary.txt`, buildSummary(ctx));
  const c = s => issues.filter(i => i.sev === s).length;
  fs.writeFileSync(`${OUT}.json`, JSON.stringify({
    snapshot: snap, goal: GOAL, jobId: JOB_ID, mode: MODE, runs: RUNS, parallel: PAR, device: DEVICE,
    counts: { ERR: c('ERR'), WARN: c('WARN'), INFO: c('INFO') }, stats: audit.stats, server, culprits, issues, psi,
  }, null, 1));

  console.log(`\nГотово: аудит 🔴 ${c('ERR')} | 🟡 ${c('WARN')} | ⚪ ${c('INFO')}${psi.length ? ` | замеры: ${psi.filter(r => !r.error).length}/${psi.length}` : ''}`);
  console.log(`Файлы: ${OUT}.md / .json / .summary.txt`);
  console.log(`RESULT_PREFIX=${OUT}`);
  if (psi.length && !psi.some(r => !r.error)) { console.error('Ни один замер не удался.'); process.exitCode = 2; }
}

main().catch(e => { console.error('Критическая ошибка скрипта:', e); process.exit(1); });
