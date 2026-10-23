// The bug-thread judge against the real model (w1783): every case of server/bugThreads.fixtures.ts through the same prompt,
// schema and model the portal uses (server/bugThreads.ts sdkJudge), on this shell's Claude login. Not part of `npm test`:
// it calls a model. Run it after changing the judge's prompt or model, and put its summary in the pull request:
//
//   node --import ./scripts/testEnv.ts scripts/ownerAckEval.ts [model]
//
// It exits 1 when any verdict differs from the fixture's.
import os from 'node:os';
import { sdkJudge } from '../server/bugThreads.ts';
import { ACK_CASES } from '../server/bugThreads.fixtures.ts';

const model = process.argv[2] ?? 'haiku';
const judge = sdkJudge({ dataDir: os.tmpdir() }, () => model, () => ({ ...process.env }));
let wrong = 0;
for (const [i, c] of ACK_CASES.entries()) {
  const v = await judge({ title: c.title, report: c.report, earlier: [], owner: 'Ben', message: c.reply }, 'ben');
  const ok = v.acknowledged === c.ack;
  if (!ok) wrong++;
  console.log(`${ok ? 'ok  ' : 'WRONG'} ${i + 1}. ${c.ack ? 'ack ' : 'not '} "${c.reply}" -> ${v.acknowledged}: ${v.reason}`);
}
console.log(`${ACK_CASES.length - wrong}/${ACK_CASES.length} agree with the fixtures (${model})`);
process.exit(wrong ? 1 : 0);
