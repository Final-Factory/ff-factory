import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cygpathCandidates, ensureGitBashTmp, gitBashTmp, keepGitBashTmp, type GitBashTmpDeps } from './gitBashTmp.ts';

const CYG = 'C:\\Program Files\\Git\\usr\\bin\\cygpath.exe';

function deps(o: { files?: string[]; stdout?: string; code?: number; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; mkdirFails?: boolean } = {}) {
  const files = new Set((o.files ?? [CYG]).map((f) => f.toLowerCase()));
  const made: string[] = [];
  const ran: string[][] = [];
  const d: GitBashTmpDeps = {
    platform: o.platform ?? 'win32',
    env: o.env ?? { ProgramFiles: 'C:\\Program Files', PATH: '' },
    exists: (p) => files.has(p.toLowerCase()),
    mkdir: (p) => {
      if (o.mkdirFails) throw new Error('EPERM');
      made.push(p);
      files.add(p.toLowerCase());
    },
    run: async (cmd, args) => {
      ran.push([cmd, ...args]);
      return { code: o.code ?? 0, stdout: o.stdout ?? 'C:\\Users\\u\\AppData\\Local\\Temp\\ffa-e91861a0\r\n', stderr: '' };
    },
  };
  return { d, made, ran };
}

test('cygpath is looked for next to the Git Claude Code uses, then on PATH, then in Program Files', () => {
  const c = cygpathCandidates({ CLAUDE_CODE_GIT_BASH_PATH: 'E:\\Git\\bin\\bash.exe', PATH: 'C:\\Windows;D:\\Tools\\Git\\cmd', ProgramFiles: 'C:\\Program Files' });
  assert.equal(c[0], 'E:\\Git\\usr\\bin\\cygpath.exe');
  assert.ok(c.includes('D:\\Tools\\Git\\usr\\bin\\cygpath.exe'), c.join('\n'));
  assert.equal(c.at(-1), CYG);
  assert.equal(cygpathCandidates({ CLAUDE_CODE_GIT_BASH_PATH: 'E:\\Git\\usr\\bin\\bash.exe' })[0], 'E:\\Git\\usr\\bin\\cygpath.exe');
});

test("Git Bash's /tmp is what cygpath -w /tmp says; nothing off Windows or without Git", async () => {
  const a = deps();
  assert.equal(await gitBashTmp(a.d), 'C:\\Users\\u\\AppData\\Local\\Temp\\ffa-e91861a0');
  assert.deepEqual(a.ran, [[CYG, '-w', '/tmp']]);
  assert.equal(await gitBashTmp(deps({ platform: 'darwin' }).d), undefined);
  assert.equal(await gitBashTmp(deps({ files: [] }).d), undefined);
  assert.equal(await gitBashTmp(deps({ code: 1 }).d), undefined);
  assert.equal(await gitBashTmp(deps({ stdout: '/tmp\n' }).d), undefined, 'a POSIX answer is not a folder to make');
});

test('a removed /tmp is made again; one that is there is left alone', async () => {
  const gone = deps();
  assert.deepEqual(await ensureGitBashTmp(gone.d), { dir: 'C:\\Users\\u\\AppData\\Local\\Temp\\ffa-e91861a0', made: true });
  assert.deepEqual(gone.made, ['C:\\Users\\u\\AppData\\Local\\Temp\\ffa-e91861a0']);
  const there = deps({ files: [CYG, 'C:\\Users\\u\\AppData\\Local\\Temp\\ffa-e91861a0'] });
  assert.deepEqual(await ensureGitBashTmp(there.d), { dir: 'C:\\Users\\u\\AppData\\Local\\Temp\\ffa-e91861a0', made: false });
  assert.deepEqual(there.made, []);
  const r = await ensureGitBashTmp(deps({ mkdirFails: true }).d);
  assert.equal(r.made, false);
  assert.match(r.error ?? '', /EPERM/);
});

test('clean-up keeps a session folder that became /tmp, never a whole temp root', () => {
  const roots = ['C:\\Users\\u\\AppData\\Local\\Temp', 'D:\\work\\ffw\\tmp'];
  assert.equal(keepGitBashTmp('D:\\work\\ffw\\tmp\\ffa-1234', roots), 'D:\\work\\ffw\\tmp\\ffa-1234');
  assert.equal(keepGitBashTmp('c:\\users\\u\\appdata\\local\\temp\\', roots), undefined);
  assert.equal(keepGitBashTmp(undefined, roots), undefined);
});
