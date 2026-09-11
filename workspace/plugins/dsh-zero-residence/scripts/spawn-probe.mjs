// 隔离复现：detached + fd 重定向的 spawn 在 Windows 上是否真的跑了命令
import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = '<DSH_CHECKOUT>\\workspace\\plugins\\dsh-zero-residence\\tmp';
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const CMD = 'Start-Sleep -Seconds 5; Write-Output "MARKER-$env:PROBE_TAG"';

function variant(tag, opts) {
  return new Promise((resolve) => {
    const file = join(dir, `${tag}.log`);
    let fd = -1;
    const args = ['-NoProfile', '-NonInteractive', '-Command', CMD];
    if (opts.useFd) fd = openSync(file, 'w');
    const stdio = opts.useFd ? ['ignore', fd, fd] : ['ignore', 'pipe', 'pipe'];
    const t0 = Date.now();
    let child;
    try {
      child = spawn('pwsh', args, {
        detached: opts.detached, windowsHide: true, stdio,
        env: { ...process.env, PROBE_TAG: tag },
      });
    } catch (e) { console.log(`${tag}: spawn threw ${e.message}`); return resolve(); }

    let piped = '';
    if (!opts.useFd) { child.stdout.on('data', d => { piped += d }); child.stderr.on('data', d => { piped += d }) }
    let spawnErr = null;
    child.on('error', e => { spawnErr = e.message });
    child.on('exit', (code, sig) => {
      const dt = Date.now() - t0;
      let body = '';
      try { body = readFileSync(file, 'utf8') } catch { }
      console.log(`${tag.padEnd(22)} exit=${String(code).padStart(4)} sig=${sig ?? '-'}  elapsed=${dt}ms  log=${body.length}B piped=${piped.length}B ${spawnErr ? 'ERR:' + spawnErr : ''}`);
      if (opts.useFd && fd >= 0) closeSync(fd);
      resolve();
    });
    if (opts.detached) { child.unref(); console.log(`${tag}: 已 unref，pid=${child.pid}（不等待）`) }
  });
}

console.log('命令: ' + CMD + '\n（正常应约 5000ms 且产出 MARKER）\n');
await variant('A-fd-detached', { useFd: true, detached: true });
console.log('--- A 已返回，现在单独跑 B/C ---');
await variant('B-fd-nodetach', { useFd: true, detached: false });
await variant('C-pipe-nodetach', { useFd: false, detached: false });
console.log('\n注：A 若立即返回属预期（detached+unref）；看它的 exit 事件与日志内容才是判据。');
