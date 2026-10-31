// process-jobs.mjs — обработка очереди из inbox/*.zip и запусков по расписанию (запускается из .github/workflows/site-check.yml).
// Описание и схема: docs/how-it-works.md, docs/schedule-and-updates.md
//
// Для каждого ZIP: проверка путей → распаковка во временную папку (staging) → проверка JSON и скриптов
// (node --check + пробный запуск) → только при успехе перенос в репозиторий → запуск jobs/*.json из архива →
// отчёт и файл в Telegram → ZIP удаляется (всегда). Если проверка не прошла, репозиторий НЕ меняется.
// Затем: задания по расписанию из targets/schedule.json, у которых наступило время.
// Коммит результатов делает workflow. Ручной повтор: JOB_INPUT=jobs/имя.json node scripts/process-jobs.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tgSend, tgDoc } from './lib/telegram.mjs';
import { loadSchedule, validateSchedule, computeSlots } from './lib/schedule.mjs';

// Пробный запуск (staging-проверка): модули загрузились без ошибок — выходим.
if (process.env.SC_SMOKE) { console.log('smoke: process-jobs загружается'); process.exit(0); }

const INBOX = 'inbox';
const STATE = 'reports/processed.json';
const SCHEDULE_FILE = 'targets/schedule.json';
const ALLOWED = /^(jobs|targets|scripts|docs)\/[^\0\\]+$|^README\.md$/;
const RUN_URL = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : '';

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const writeState = s => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 1)); };

function listZip(zip) {
  const r = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('не удалось прочитать архив (битый ZIP?)');
  return r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
}
function validate(entries) {
  if (entries.length > 200) throw new Error(`в архиве слишком много файлов (${entries.length})`);
  const bad = entries.filter(e => !e.endsWith('/') && (!ALLOWED.test(e) || e.split('/').includes('..') || e.startsWith('/')));
  if (bad.length) throw new Error(`недопустимые пути в архиве: ${bad.slice(0, 3).join(', ')} (разрешены jobs/, targets/, scripts/, docs/, README.md)`);
}
const run = (cmd, args, opt = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 60000, ...opt });
const lastLines = (s, n = 8) => String(s || '').trim().split('\n').slice(-n).join('\n');

// Проверка распакованного архива ДО переноса в репозиторий. Бросает Error с понятным текстом.
function checkStaged(stage, entries) {
  const files = entries.filter(e => !e.endsWith('/'));
  const existsAnywhere = p => fs.existsSync(path.join(stage, p)) || fs.existsSync(p);

  for (const f of files.filter(e => /^(jobs|targets)\/.+\.json$/.test(e))) {
    let obj;
    try { obj = JSON.parse(fs.readFileSync(path.join(stage, f), 'utf8')); } catch (e) { throw new Error(`${f}: некорректный JSON (${e.message})`); }
    if (f === SCHEDULE_FILE) {
      const errs = validateSchedule(obj, existsAnywhere);
      if (errs.length) throw new Error(`${f}: ${errs.slice(0, 4).join('; ')}`);
    }
  }

  const scripts = files.filter(e => /^scripts\/.+\.mjs$/.test(e));
  if (scripts.length) {
    for (const f of scripts) {
      const r = run(process.execPath, ['--check', path.join(stage, f)]);
      if (r.status !== 0) throw new Error(`${f}: синтаксическая ошибка\n${lastLines(r.stderr, 6)}`);
    }
    // пробный запуск: копия текущих scripts/ + новые файлы поверх, в отдельной папке
    const smoke = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-smoke-'));
    try {
      if (fs.existsSync('scripts')) fs.cpSync('scripts', path.join(smoke, 'scripts'), { recursive: true });
      fs.cpSync(path.join(stage, 'scripts'), path.join(smoke, 'scripts'), { recursive: true });
      const env = { ...process.env, TG_TOKEN: '', TG_CHAT_ID: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', PSI_KEY: '' };
      const a = run(process.execPath, ['scripts/process-jobs.mjs'], { cwd: smoke, env: { ...env, SC_SMOKE: '1' } });
      if (a.status !== 0) throw new Error(`пробный запуск process-jobs.mjs не прошёл\n${lastLines(a.stderr || a.stdout)}`);
      if (fs.existsSync(path.join(smoke, 'scripts/site-check.mjs'))) {
        const b = run(process.execPath, ['scripts/site-check.mjs', 'help'], { cwd: smoke, env });
        if (b.status !== 0) throw new Error(`пробный запуск site-check.mjs не прошёл\n${lastLines(b.stderr || b.stdout)}`);
      }
    } finally { fs.rmSync(smoke, { recursive: true, force: true }); }
  }
  return { scripts };
}

function promote(stage, entries) {
  for (const f of entries.filter(e => !e.endsWith('/'))) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.cpSync(path.join(stage, f), f);
  }
}

function runSiteCheck(jobFile) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, ['scripts/site-check.mjs', '--job', jobFile], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', prefix = '';
    const feed = d => { const s = d.toString(); process.stdout.write(s); tail = (tail + s).slice(-1500); const m = s.match(/RESULT_PREFIX=(\S+)/); if (m) prefix = m[1]; };
    p.stdout.on('data', feed); p.stderr.on('data', feed);
    p.on('close', code => resolve({ code, tail, prefix }));
    p.on('error', e => resolve({ code: 1, tail: String(e), prefix: '' }));
  });
}

// stateKey: ключ в processed.json (по умолчанию id задания). Для запусков по расписанию — ключ слота.
async function runJob(jobFile, state, force, label, stateKey) {
  let job;
  try { job = JSON.parse(fs.readFileSync(jobFile, 'utf8')); } catch (e) { await tgSend(`❌ site-check: job «${jobFile}» не читается: ${e.message}`); return false; }
  const id = String(job.id || path.basename(jobFile, '.json'));
  const key = stateKey || id;
  if (!force && state[key]) { await tgSend(`⏭ site-check: job «${id}» уже выполнялся ${state[key].date.slice(0, 16)} — пропущен. Чтобы повторить, смени id в файле задания.`); return true; }
  await tgSend(`▶️ site-check: старт ${label} «${id}»\nрежим ${job.mode || 'standard'} → ${job.base || 'prod'}${job.goal ? '\n🎯 ' + job.goal : ''}`);
  const r = await runSiteCheck(jobFile);
  const ok = r.code === 0 && r.prefix;
  state[key] = { date: new Date().toISOString(), prefix: r.prefix || null, ok: !!ok };
  if (ok) {
    let sum = ''; try { sum = fs.readFileSync(`${r.prefix}.summary.txt`, 'utf8'); } catch { /* нет */ }
    await tgSend((sum || `✅ job «${id}» готов`) + (RUN_URL ? `\n\n${RUN_URL}` : '') + `\n📄 ${r.prefix}.md`);
    await tgDoc(`${r.prefix}.md`, `site-check ${id}`);
  } else {
    await tgSend(`🔴 site-check: job «${id}» завершился с ошибкой (код ${r.code}).\n\n${r.tail.slice(-1200)}${RUN_URL ? '\n\n' + RUN_URL : ''}`);
  }
  return !!ok;
}

async function processInbox(state) {
  let failed = false;
  const zips = fs.existsSync(INBOX) ? fs.readdirSync(INBOX).filter(f => f.toLowerCase().endsWith('.zip')).sort() : [];
  if (!zips.length) { console.log('inbox пуст.'); return false; }
  console.log(`В очереди архивов: ${zips.length}: ${zips.join(', ')}`);
  for (let i = 0; i < zips.length; i++) {
    const zip = path.join(INBOX, zips[i]);
    const queueInfo = `архив ${i + 1}/${zips.length} «${zips[i]}»`;
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-stage-'));
    try {
      const entries = listZip(zip);
      validate(entries);
      const r = spawnSync('unzip', ['-o', '-q', zip, '-d', stage], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error('распаковка не удалась: ' + r.stderr.slice(0, 200));
      const { scripts } = checkStaged(stage, entries);
      promote(stage, entries);
      const files = entries.filter(e => !e.endsWith('/'));
      // задания с "scheduledOnly": true только кладутся в репозиторий — запускает их расписание
      const jobs = files.filter(e => /^jobs\/[^/]+\.json$/.test(e)).sort().filter(e => { try { return JSON.parse(fs.readFileSync(e, 'utf8')).scheduledOnly !== true; } catch { return true; } });
      if (scripts.length) await tgSend(`🛠 site-check: ${queueInfo} — скрипты обновлены (${scripts.map(s => s.replace(/^scripts\//, '')).join(', ')}). Проверка синтаксиса и пробный запуск прошли.`);
      if (!jobs.length) { await tgSend(`📦 site-check: ${queueInfo} принят, заданий для немедленного запуска нет — обновлены файлы: ${files.slice(0, 8).join(', ')}${files.length > 8 ? ` и ещё ${files.length - 8}` : ''}`); continue; }
      for (const j of jobs) { if (!(await runJob(j, state, false, queueInfo))) failed = true; writeState(state); }
    } catch (e) {
      failed = true;
      await tgSend(`❌ site-check: ${queueInfo} отклонён, репозиторий не изменён — ${e.message}`);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
      fs.rmSync(zip, { force: true }); // архив удаляется всегда: повторно он не запустится
    }
  }
  return failed;
}

async function processSchedule(state) {
  let sched;
  try { sched = loadSchedule(SCHEDULE_FILE); } catch (e) { return notifySchedError(state, `${SCHEDULE_FILE} не читается: ${e.message}`); }
  if (!sched) return false;
  const errs = validateSchedule(sched, p => fs.existsSync(p));
  if (errs.length) return notifySchedError(state, `${SCHEDULE_FILE}: ${errs.slice(0, 4).join('; ')}`);
  delete state._schedErr;
  const { due, missed } = computeSlots(sched, Date.now());
  let failed = false;
  for (const m of missed) {
    if (state[m.key]) continue;
    state[m.key] = { date: new Date().toISOString(), skipped: true };
    await tgSend(`⏭ site-check: расписание «${m.name}» (${new Date(m.slotMs).toISOString().slice(0, 16).replace('T', ' ')} UTC) пропущено — запуск опоздал больше чем на ${sched.graceHours || 6} ч.`);
  }
  for (const d of due) {
    if (state[d.key]) continue;
    const ok = await runJob(d.job, state, true, `по расписанию «${d.name}»`, d.key);
    if (!ok) failed = true;
    writeState(state);
  }
  if (!due.length) console.log('По расписанию сейчас ничего не нужно запускать.');
  return failed;
}
async function notifySchedError(state, msg) {
  if (state._schedErr !== msg) { state._schedErr = msg; await tgSend(`⚠️ site-check: расписание не применено — ${msg}`); }
  return false;
}

async function main() {
  const state = readState();
  const rerun = (process.env.JOB_INPUT || '').trim();
  if (rerun) {
    if (!/^jobs\/[\w.\-]+\.json$/.test(rerun) || !fs.existsSync(rerun)) { await tgSend(`❌ site-check: повтор job: файл «${rerun}» не найден (ожидается jobs/имя.json)`); process.exit(1); }
    const ok = await runJob(rerun, state, true, 'повтор');
    writeState(state); process.exit(ok ? 0 : 1);
  }
  const f1 = await processInbox(state);
  writeState(state);
  const f2 = await processSchedule(state);
  writeState(state);
  if (f1 || f2) process.exit(1);
}

main().catch(async e => { console.error(e); await tgSend(`❌ site-check: критическая ошибка обработчика: ${e.message}`); process.exit(1); });
