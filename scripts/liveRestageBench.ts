// w1839: time a Live view's replay (machine/liveStage.ts restage) against a real sandbox editor, leg by leg, without a
// portal or a deployed daemon. The editor must already run (start it with the machine's unity tool): this times play mode,
// the title screen, the save and the steps, which is what the daemon does after its editor start.
//
//   node --import ./scripts/testEnv.ts scripts/liveRestageBench.ts --sandbox <sandbox path> --pid <editor pid> \
//     --stage '<JSON list of steps>' [--runs 3] [--leave] [--out result.json]
//
// --leave leaves play mode between runs (through the bridge), so each run starts from edit mode as a reopened view does.
import fs from 'node:fs';
import { bridgeExecute, bridgeInfo } from '../server/unityHang.ts';
import { gameCommand, readGameChannel } from '../machine/live.ts';
import { LEAVE_PLAY_SNIPPET } from '../machine/liveIdle.ts';
import { legsText, parseStage, restage } from '../machine/liveStage.ts';

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const sandbox = opt('--sandbox');
const pid = Number(opt('--pid'));
const parsed = parseStage(JSON.parse(opt('--stage', '[]')!));
if (!sandbox || !pid || 'error' in parsed) {
  console.error('usage: --sandbox <path> --pid <editor pid> --stage <JSON steps>', 'error' in parsed ? parsed.error : '');
  process.exit(2);
}
const runs = Number(opt('--runs', '1'));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const bridge = async (code: string) => {
  const port = bridgeInfo(sandbox).port;
  return port ? bridgeExecute(port, code) : 'no bridge: none for this editor';
};

const results = [];
for (let r = 0; r < runs; r++) {
  if (args.includes('--leave')) {
    await bridge(LEAVE_PLAY_SNIPPET);
    await sleep(8000);
  }
  const res = await restage(
    {
      editorPid: () => pid,
      startEditor: async () => 'not started: the bench needs a running editor',
      bridge,
      channel: (p) => readGameChannel(p),
      command: (ch, text) => gameCommand(ch, text),
      progress: (d) => console.log(`  ${new Date().toISOString().slice(11, 19)} ${d}`),
      now: () => Date.now(),
      sleep,
    },
    parsed.steps,
  );
  console.log(`run ${r + 1}: ${res.ok ? 'staged' : `FAILED: ${res.detail}`} in ${(res.ms / 1000).toFixed(1)} s (${legsText(res.legs)})`);
  results.push(res);
}
const out = opt('--out');
if (out) fs.writeFileSync(out, JSON.stringify({ sandbox, pid, stage: parsed.steps, results }, null, 2));
