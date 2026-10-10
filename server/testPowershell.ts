import fs from 'node:fs';
import path from 'node:path';

/**
 * For tests that run a PowerShell script: Windows PowerShell 5.1 on Windows (what the scripts meet on a real PC), else
 * PowerShell 7 (`pwsh`) from PATH when installed (GitHub's Ubuntu runners have it), else undefined: skip. A script that
 * needs Windows itself (CIM, scheduled tasks) stays a Windows-only test (test/windows-tests.txt).
 */
export const powershell: string | undefined =
  process.platform === 'win32' ? 'powershell.exe' : (process.env.PATH ?? '').split(path.delimiter).map((d) => path.join(d, 'pwsh')).find((p) => fs.existsSync(p));
