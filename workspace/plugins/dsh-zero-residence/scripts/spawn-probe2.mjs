// 关键区分：父进程存活期间，detached 子进程到底跑没跑？
import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = '<DSH_CHECKOUT>\\workspace\\plugins\\dsh-zero-residence\\tmp2';
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const CMD = 'Start-Sleep -Seconds 4; "MARKER-OK" | Out-File -Encoding utf8 -Append -FilePath ';

function run(tag, opts) {
  const file = join(dir, `${tag}.log`);
  const full = CMD + `'${file}'`;
  const fd = openSync(file, 'w');
  const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', full], {
    detached: opts.detached, windowsHide: true, stdio: ['ignore', fd, fd],
  });
  let exited = null;
  child.on('exit', c => { exited = c; closeSync(fd); });
  child.on('error', e => { console.log(`  ${tag}: SPAWN ERROR ${e.message}`); });
  if (opts.unref) child.unref();
  return { tag, file, child, get exited() { return exited } };
}

const jobs = [
  run('D-detached-nounref', { detached: true, unref: false }),
  run('E-nodetach', { detached: false, unref: false }),
];

const size = f => { try { return statSync(f).size } catch { return -1 } };

console.log('子进程已启动，父进程保持存活观察 9 秒…\n');
for (let i = 1; i <= 9; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const line = jobs.map(j => `${j.tag}: size=${size(j.file)}B exited=${j.exited}`).join('   |   ');
  console.log(`t=${i}s  ${line}`);
}
console.log('\n最终内容：');
for (const j of jobs) {
  let body = '';
  try { body = readFileSync(j.file, 'utf8') } catch { }
  console.log(`  ${j.tag}: ${JSON.stringify(body)}`);
}
