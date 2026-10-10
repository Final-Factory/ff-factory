// w906 probe only: every node process records who it is and how it ended, so an empty coverage file names its process.
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.FF_PROCLOG;
if (dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    fs.writeFileSync(path.join(dir, `${process.pid}-${t0}.start.json`), JSON.stringify({ pid: process.pid, ppid: process.ppid, t: t0, cov: process.env.NODE_V8_COVERAGE ?? null, argv: process.argv.map((a) => a.slice(0, 300)), execArgv: process.execArgv }));
    process.on('exit', (code) => {
      try {
        fs.writeFileSync(path.join(dir, `${process.pid}-${t0}.exit.json`), JSON.stringify({ pid: process.pid, code, t: Date.now() }));
      } catch {}
    });
  } catch {}
}
