// process-jobs.mjs — обработка очереди заданий из inbox/*.zip (запускается из .github/workflows/site-check.yml).
// Описание и схема: docs/how-it-works.md
//
// Для каждого ZIP: проверка путей → распаковка → для каждого jobs/*.json запуск scripts/site-check.mjs →
// сообщение + отчёт в Telegram → ZIP удаляется (всегда). Коммит результатов делает workflow.
// Запуск вручную по сохранённому заданию: JOB_INPUT=jobs/имя.json node scripts/process-jobs.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tgSend, tgDoc } from './lib/telegram.mjs';

const INBOX = 'inbox';
const STATE = 'reports/processed.json';
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

async function runJob(jobFile, state, force, label) {
  let job;
  try { job = JSON.parse(fs.readFileSync(jobFile, 'utf8')); } catch (e) { await tgSend(`❌ site-check: job «${jobFile}» не читается: ${e.message}`); return false; }
  const id = String(job.id || path.basename(jobFile, '.json'));
  if (!force && state[id]) { await tgSend(`⏭ site-check: job «${id}» уже выполнялся ${state[id].date.slice(0, 16)} — пропущен. Чтобы повторить, смени id в файле задания.`); return true; }
  await tgSend(`▶️ site-check: старт ${label} «${id}»\nрежим ${job.mode || 'standard'} → ${job.base || 'prod'}${job.goal ? '\n🎯 ' + job.goal : ''}`);
  const r = await runSiteCheck(jobFile);
  const ok = r.code === 0 && r.prefix;
  state[id] = { date: new Date().toISOString(), prefix: r.prefix || null, ok: !!ok };
  if (ok) {
    let sum = ''; try { sum = fs.readFileSync(`${r.prefix}.summary.txt`, 'utf8'); } catch { /* нет */ }
    await tgSend((sum || `✅ job «${id}» готов`) + (RUN_URL ? `\n\n${RUN_URL}` : '') + `\n📄 ${r.prefix}.md`);
    await tgDoc(`${r.prefix}.md`, `site-check ${id}`);
  } else {
    await tgSend(`🔴 site-check: job «${id}» завершился с ошибкой (код ${r.code}).\n\n${r.tail.slice(-1200)}${RUN_URL ? '\n\n' + RUN_URL : ''}`);
  }
  return !!ok;
}

async function main() {
  const state = readState();
  let failed = false;
  const rerun = (process.env.JOB_INPUT || '').trim();
  if (rerun) {
    if (!/^jobs\/[\w.\-]+\.json$/.test(rerun) || !fs.existsSync(rerun)) { await tgSend(`❌ site-check: повтор job: файл «${rerun}» не найден (ожидается jobs/имя.json)`); process.exit(1); }
    const ok = await runJob(rerun, state, true, 'повтор');
    writeState(state); process.exit(ok ? 0 : 1);
  }

  const zips = fs.existsSync(INBOX) ? fs.readdirSync(INBOX).filter(f => f.toLowerCase().endsWith('.zip')).sort() : [];
  if (!zips.length) { console.log('inbox пуст — делать нечего.'); return; }
  console.log(`В очереди архивов: ${zips.length}: ${zips.join(', ')}`);

  for (let i = 0; i < zips.length; i++) {
    const zip = path.join(INBOX, zips[i]);
    const queueInfo = `архив ${i + 1}/${zips.length} «${zips[i]}»`;
    try {
      const entries = listZip(zip);
      validate(entries);
      const r = spawnSync('unzip', ['-o', '-q', zip, '-d', '.'], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error('распаковка не удалась: ' + r.stderr.slice(0, 200));
      const jobs = entries.filter(e => /^jobs\/[^/]+\.json$/.test(e)).sort();
      if (!jobs.length) { await tgSend(`📦 site-check: ${queueInfo} принят, заданий нет — обновлены файлы: ${entries.filter(e => !e.endsWith('/')).slice(0, 8).join(', ')}`); continue; }
      for (const j of jobs) { if (!(await runJob(j, state, false, queueInfo))) failed = true; writeState(state); }
    } catch (e) {
      failed = true;
      await tgSend(`❌ site-check: ${queueInfo} отклонён — ${e.message}`);
    } finally {
      fs.rmSync(zip, { force: true }); // архив удаляется всегда: повторно он не запустится
    }
  }
  writeState(state);
  if (failed) process.exit(1);
}

main().catch(async e => { console.error(e); await tgSend(`❌ site-check: критическая ошибка обработчика: ${e.message}`); process.exit(1); });
