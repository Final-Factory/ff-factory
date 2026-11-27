// w6542 repeat harness (temporary, removed before merge): the real start-portal.sh run many times, idle and under CPU load,
// printing each portal.log's priority lines.
import { test } from 'node:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startScript } from './instance/new.ts';

const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const skip = process.platform !== 'win32' ? 'Windows only' : false;
for (const [runs, burn] of [
  [15, 0],
  [12, os.cpus().length],
  [6, os.cpus().length * 2],
] as const) {
  test(`w6542 repeat: ${runs} runs, ${burn} CPU burners on ${os.cpus().length} cores`, { skip }, () => {
    const burners: ChildProcess[] = [];
    for (let b = 0; b < burn; b++) burners.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true }));
    let ok = 0;
    try {
      for (let i = 0; i < runs; i++) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffinst-rep-'));
        try {
          fs.mkdirSync(path.join(dir, 'app', 'server'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'app', 'server', 'index.ts'), "import os from 'node:os'; console.log('stand-in portal up'); setTimeout(() => process.exit(7), 30_000); setInterval(() => { if (os.getPriority() === os.constants.priority.PRIORITY_ABOVE_NORMAL) setTimeout(() => process.exit(7), 500); }, 200);\n");
          const script = path.join(dir, 'start-portal.sh');
          fs.writeFileSync(script, startScript({ name: 'prio', project: 'Prio Test', port: 18999, dir, nodeDir: path.dirname(process.execPath) }));
          const t = Date.now();
          const r = spawnSync(bash, [script], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
          const log = fs.readFileSync(path.join(dir, 'portal.log'), 'utf8');
          const good = r.status === 7 && /to class 0x8000, I\/O 2, memory 5/.test(log) && !/raise failed|could not open|not the portal|error/.test(log);
          if (good) ok++;
          console.log(`repeat burn=${burn} ${i} ${good ? 'PASS' : 'FAIL'} status=${r.status} ${Date.now() - t}ms :: ${log.replace(/\r?\n/g, ' | ')}`);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    } finally {
      for (const b of burners) b.kill();
    }
    console.log(`repeat burn=${burn}: ${ok} of ${runs} passed`);
  });
}
