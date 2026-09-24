// Installs the local voice tools (server/voice.ts), all under voice.toolsDir (default
// data/tools/whisper). Nothing system-wide, no admin:
//   speech-to-text: a uv-managed Python, venv/ with faster-whisper and the CUDA 12 runtime wheels,
//                   and the Whisper model;
//   text-to-speech: tts-venv/ with Kokoro on onnxruntime-gpu (CUDA 13 wheels), and the Kokoro model.
// Two venvs because onnxruntime-gpu cannot share one with the CPU onnxruntime faster-whisper needs.
//
// Idempotent: a stamp records what was installed (requirements hashes + models), and a re-run with
// nothing changed returns at once. Each part is stamped as soon as it is done, so a TTS failure
// never costs a working Whisper. `npm run voice-setup` runs it by hand; the server runs it in the
// background at startup when voice.autoInstall is on and the stamp is stale.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, type VoiceConfig } from './config.ts';
import { isWindows, must, run } from './proc.ts';

export const REQUIREMENTS = path.join(ROOT, 'server', 'voice', 'requirements.txt');
export const TTS_REQUIREMENTS = path.join(ROOT, 'server', 'voice', 'requirements-tts.txt');
export const WORKER = path.join(ROOT, 'server', 'voice', 'worker.py');
export const TTS_WORKER = path.join(ROOT, 'server', 'voice', 'tts_worker.py');
const PYTHON_VERSION = '3.12';

/** The Kokoro model files (github.com/thewh1teagle/kokoro-onnx releases). */
export const KOKORO = {
  id: 'kokoro-v1.0',
  base: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/',
  model: 'kokoro-v1.0.onnx',
  voices: 'voices-v1.0.bin',
};

export type VoicePart = 'stt' | 'tts';

export interface VoicePaths {
  venv: string;
  python: string;
  ttsVenv: string;
  ttsPython: string;
  models: string;
  kokoroModel: string;
  kokoroVoices: string;
  stamp: string;
  lock: string;
  log: string;
}

const venvPython = (venv: string) => (isWindows ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python'));

export function voicePaths(v: Pick<VoiceConfig, 'toolsDir'>): VoicePaths {
  const venv = path.join(v.toolsDir, 'venv');
  const ttsVenv = path.join(v.toolsDir, 'tts-venv');
  const models = path.join(v.toolsDir, 'models');
  return {
    venv,
    python: venvPython(venv),
    ttsVenv,
    ttsPython: venvPython(ttsVenv),
    models,
    kokoroModel: path.join(models, KOKORO.id, KOKORO.model),
    kokoroVoices: path.join(models, KOKORO.id, KOKORO.voices),
    stamp: path.join(v.toolsDir, 'installed.json'),
    lock: path.join(v.toolsDir, 'setup.lock'),
    log: path.join(v.toolsDir, 'setup.log'),
  };
}

/** Where a Whisper model's files live once downloaded ("large-v3-turbo" -> <models>/large-v3-turbo). */
export function modelDir(v: Pick<VoiceConfig, 'toolsDir' | 'model'>) {
  return path.join(voicePaths(v).models, v.model.replace(/[^\w.-]+/g, '_'));
}

interface Stamp {
  requirements?: string;
  model?: string;
  ttsRequirements?: string;
  ttsModel?: string;
  at?: string;
}

function hashFile(file: string) {
  // Line endings depend on git's autocrlf, not on what is installed.
  return crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

export const requirementsHash = () => hashFile(REQUIREMENTS);
export const ttsRequirementsHash = () => hashFile(TTS_REQUIREMENTS);

function readStamp(v: VoiceConfig): Stamp | undefined {
  try {
    return JSON.parse(fs.readFileSync(voicePaths(v).stamp, 'utf8')) as Stamp;
  } catch {
    return undefined;
  }
}

/** Why a part needs (re)installing, or null when it is in place for this config. No part: either. */
export function setupNeeded(v: VoiceConfig, part?: VoicePart): string | null {
  const p = voicePaths(v);
  if (part !== 'tts') {
    if (!fs.existsSync(p.python)) return 'not installed';
    const stamp = readStamp(v);
    if (!stamp?.requirements) return 'install incomplete';
    if (stamp.requirements !== requirementsHash()) return 'requirements changed';
    if (stamp.model !== v.model || !fs.existsSync(path.join(modelDir(v), 'model.bin'))) return `model ${v.model} not downloaded`;
  }
  if (part !== 'stt' && v.tts) {
    if (!fs.existsSync(p.ttsPython)) return 'text-to-speech not installed';
    const stamp = readStamp(v);
    if (stamp?.ttsRequirements !== ttsRequirementsHash()) return 'text-to-speech requirements changed';
    if (stamp.ttsModel !== KOKORO.id || !fs.existsSync(p.kokoroModel) || !fs.existsSync(p.kokoroVoices)) return 'Kokoro model not downloaded';
  }
  return null;
}

/** A setup already running (a fresh lock file) in another process. */
export function setupRunning(v: VoiceConfig): boolean {
  try {
    return Date.now() - fs.statSync(voicePaths(v).lock).mtimeMs < 30 * 60_000;
  } catch {
    return false;
  }
}

async function findUv(v: VoiceConfig, log: (s: string) => void): Promise<string> {
  if (v.uvPath) return v.uvPath;
  if ((await run('uv', ['--version'])).code === 0) return 'uv';
  const local = path.join(v.toolsDir, 'uv', isWindows ? 'uv.exe' : 'uv');
  if (fs.existsSync(local)) return local;
  // No uv on this machine: fetch the standalone binary (a zip / tarball from uv's GitHub releases).
  const asset = isWindows
    ? 'uv-x86_64-pc-windows-msvc.zip'
    : process.platform === 'darwin'
      ? `uv-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin.tar.gz`
      : 'uv-x86_64-unknown-linux-gnu.tar.gz';
  log(`downloading uv (${asset})`);
  const res = await fetch(`https://github.com/astral-sh/uv/releases/latest/download/${asset}`);
  if (!res.ok) throw new Error(`uv download failed: ${res.status}`);
  const dir = path.dirname(local);
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, asset);
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  // bsdtar ships with Windows 10+ and reads zips too.
  await must('tar', ['-xf', archive, '-C', dir, ...(isWindows ? [] : ['--strip-components=1'])]);
  fs.rmSync(archive, { force: true });
  if (!fs.existsSync(local)) throw new Error(`uv not found in ${asset}`);
  return local;
}

/** Download a file (following redirects) to `dest` via a temp name, so a cut-off download never looks done. */
async function download(url: string, dest: string) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download ${url}: ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  fs.writeFileSync(part, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(part, dest);
}

/** Install or update the tools. Throws on failure; `log` gets progress lines. */
export async function setupVoice(v: VoiceConfig, log: (s: string) => void = console.log, force = false): Promise<void> {
  const why = setupNeeded(v);
  if (!why && !force) {
    log(`voice tools up to date (${v.model}${v.tts ? `, ${KOKORO.id}` : ''}) in ${v.toolsDir}`);
    return;
  }
  const p = voicePaths(v);
  fs.mkdirSync(v.toolsDir, { recursive: true });
  if (setupRunning(v)) throw new Error(`another voice setup is running (${p.lock})`);
  fs.writeFileSync(p.lock, String(process.pid));
  const t0 = Date.now();
  const stamp = (patch: Stamp) => fs.writeFileSync(p.stamp, JSON.stringify({ ...readStamp(v), ...patch, at: new Date().toISOString() }, null, 2));
  try {
    log(`voice setup: ${why ?? 'forced'}`);
    const uv = await findUv(v, log);
    // Keep uv's cache and its Python inside toolsDir: nothing lands in the user profile.
    const env = {
      ...process.env,
      UV_CACHE_DIR: path.join(v.toolsDir, 'uv-cache'),
      UV_PYTHON_INSTALL_DIR: path.join(v.toolsDir, 'python'),
      UV_PYTHON_PREFERENCE: 'only-managed',
      UV_NO_PROGRESS: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
      HF_HUB_DISABLE_PROGRESS_BARS: '1',
    };
    const long = { env, timeoutMs: 60 * 60_000 };

    if (force || setupNeeded(v, 'stt')) {
      if (!fs.existsSync(p.python)) {
        log(`creating venv (Python ${PYTHON_VERSION})`);
        await must(uv, ['venv', '--python', PYTHON_VERSION, '--allow-existing', p.venv], long);
      }
      log('installing faster-whisper and the CUDA runtime wheels');
      await must(uv, ['pip', 'install', '--python', p.python, '-r', REQUIREMENTS], long);
      log(`downloading Whisper model ${v.model}`);
      await must(p.python, ['-c', 'import sys; from faster_whisper import download_model; download_model(sys.argv[1], output_dir=sys.argv[2])', v.model, modelDir(v)], long);
      stamp({ requirements: requirementsHash(), model: v.model });
    }

    if (v.tts && (force || setupNeeded(v, 'tts'))) {
      if (!fs.existsSync(p.ttsPython)) {
        log('creating the text-to-speech venv');
        await must(uv, ['venv', '--python', PYTHON_VERSION, '--allow-existing', p.ttsVenv], long);
      }
      log('installing Kokoro, onnxruntime-gpu and its CUDA wheels');
      const args = ['pip', 'install', '--python', p.ttsPython, '-r', TTS_REQUIREMENTS];
      if (process.platform !== 'darwin') {
        // kokoro-onnx depends on the CPU onnxruntime; onnxruntime-gpu provides the same module.
        const excludes = path.join(v.toolsDir, 'tts-excludes.txt');
        fs.writeFileSync(excludes, 'onnxruntime\n');
        args.push('--excludes', excludes);
      }
      await must(uv, args, long);
      for (const f of [p.kokoroModel, p.kokoroVoices]) {
        if (fs.existsSync(f)) continue;
        log(`downloading ${path.basename(f)}`);
        await download(KOKORO.base + path.basename(f), f);
      }
      stamp({ ttsRequirements: ttsRequirementsHash(), ttsModel: KOKORO.id });
    }
    log(`voice setup done in ${Math.round((Date.now() - t0) / 1000)} s`);
  } finally {
    fs.rmSync(p.lock, { force: true });
  }
}

// `npm run voice-setup [-- --force]`
if (import.meta.filename === path.resolve(process.argv[1] ?? '')) {
  const cfg = loadConfig();
  try {
    await setupVoice(cfg.voice, console.log, process.argv.includes('--force'));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
