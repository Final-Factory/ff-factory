// w5631: seeds a fenced Linux editor's moved home and checks its Burst pref, run by the daemon under ff-landlock.py with
// only that home writable (machine/unity.ts seedEditorHomeFenced). The home is a folder workers write, so a folder there
// can be swapped for a link between any check and the write that follows (w6356's review: 8,117 of 40,000 starts wrote
// outside the home against a swap loop); Landlock resolves each write in the kernel, so no swap reaches past the home.
// Usage: node editorHomeSeed.ts <home> <real home>; prints one JSON line {seeded, refused, safe, burst?}.
import fs from 'node:fs';
import { ensureBurstPrefOn, linuxPrefsPath, realBurstPrefDeps } from './burstPref.ts';
import { seedLinuxEditorHome } from './unity.ts';

const [home, realHome] = process.argv.slice(2);
if (!home || !realHome) {
  process.stderr.write('usage: editorHomeSeed.ts <home> <real home>\n');
  process.exit(2);
}
const seed = seedLinuxEditorHome(home, realHome);
let burst: string | undefined;
if (seed.safe.includes(linuxPrefsPath(home))) {
  burst = await ensureBurstPrefOn({
    ...realBurstPrefDeps('linux'),
    home,
    writeFile: (p, s) => {
      const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
      try {
        fs.writeFileSync(fd, s);
      } finally {
        fs.closeSync(fd);
      }
    },
  });
}
process.stdout.write(`${JSON.stringify({ ...seed, ...(burst ? { burst } : {}) })}\n`);
