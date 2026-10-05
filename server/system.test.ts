import { test } from 'node:test';
import assert from 'node:assert/strict';
import { machineLoadLine, memUsed, parseIoregGpu, parseNvidiaSmi, parsePressure, parseVmStat, parseWinGpu, statsLine } from './system.ts';
import type { HostStats } from '../shared/types.ts';

const GB = 2 ** 30;

// Trimmed from an M3 Pro with 18 GB (2026-09-27).
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    33762.
Pages active:                                 399751.
Pages inactive:                               401894.
Pages speculative:                            172602.
Pages throttled:                                   0.
Pages wired down:                             106180.
Pages purgeable:                                5850.
File-backed pages:                            647959.
Anonymous pages:                              326288.
Pages stored in compressor:                   229978.
Pages occupied by compressor:                  24572.
`;

test('system: macOS memory in use is app + wired + compressed, not total minus the free pages', () => {
  const total = 18 * GB;
  const m = parseVmStat(VM_STAT, total)!;
  // (326288 - 5850 + 106180 + 24572) * 16384 bytes.
  assert.equal(m.usedBytes, (326288 - 5850 + 106180 + 24572) * 16384);
  assert.equal(m.freeBytes, total - m.usedBytes);
  assert.ok(m.usedBytes / total < 0.45, 'about 41%, where total minus free pages would say 97%');
  // Older macOS without "Anonymous pages": active pages stand in.
  const old = parseVmStat(VM_STAT.replace(/^Anonymous pages:.*\n/m, ''), total)!;
  assert.equal(old.usedBytes, (399751 + 106180 + 24572) * 16384);
  // Never more than all of RAM; nothing when the output is not vm_stat's.
  assert.equal(parseVmStat(VM_STAT, GB)!.usedBytes, GB);
  assert.equal(parseVmStat('garbage', total), undefined);
});

test('system: macOS memory pressure levels', () => {
  assert.equal(parsePressure('1\n'), 'normal');
  assert.equal(parsePressure('2'), 'warn');
  assert.equal(parsePressure('4'), 'critical');
  assert.equal(parsePressure(''), undefined);
});

test('system: the Apple GPU from ioreg shares the RAM; utilisation is its busy figure', () => {
  const out = `+-o AGXAcceleratorG15X  <class AGXAcceleratorG15X>
    {
      "model" = "Apple M3 Pro"
      "gpu-core-count" = 14
      "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=25908838400,"Renderer Utilization %"=31,"Device Utilization %"=42,"In use system memory"=3221225472}
    }`;
  assert.deepEqual(parseIoregGpu(out, 18 * GB), { name: 'Apple M3 Pro', memTotalMiB: 18 * 1024, memUsedMiB: 3072, utilPct: 42, unified: true });
  assert.equal(parseIoregGpu('no accelerator here', 18 * GB), undefined);
});

test("system: any Windows GPU from Windows' performance counters, when there is no nvidia-smi", () => {
  // Trimmed from LothDesktop (Intel Arc B580, 2026-09-29), with made-up load: two engines of the Arc busy, one of them
  // shared by two processes; the Remote Display adapter has no memory of its own.
  const out = [
    'engine|pid_11124_luid_0x00000000_0x00012132_phys_0_eng_0_engtype_3d|30',
    'engine|pid_13520_luid_0x00000000_0x00012132_phys_0_eng_0_engtype_3d|25.5',
    'engine|pid_13520_luid_0x00000000_0x00012132_phys_0_eng_3_engtype_videodecode|40',
    'engine|pid_12336_luid_0x00000000_0x000125d0_phys_0_eng_0_engtype_3D|0',
    'mem|luid_0x00000000_0x00012132_phys_0|2191482880',
    'mem|luid_0x00000000_0x000125d0_phys_0|0',
    'adapter|Microsoft Remote Display Adapter|0',
    'adapter|Intel(R) Arc(TM) B580 Graphics|12884901888',
    '',
  ].join('\r\n');
  assert.deepEqual(parseWinGpu(out), { name: 'Intel(R) Arc(TM) B580 Graphics', memTotalMiB: 12288, memUsedMiB: 2090, utilPct: 56 }, 'the busiest engine: 30 + 25.5 on 3D engine 0');
  // Idle, and counters only (no registry entry readable): still numbers, a plain name.
  assert.deepEqual(parseWinGpu('mem|luid_0x0_0x1_phys_0|1048576\nengine|pid_1_luid_0x0_0x1_phys_0_eng_0_engtype_3D|0'), { name: 'GPU', memTotalMiB: 1, memUsedMiB: 1, utilPct: 0 });
  // A busy engine is never over 100%; nothing at all is no GPU.
  assert.equal(parseWinGpu('engine|pid_1_luid_0x0_0x1_phys_0_eng_0_engtype_3D|80\nengine|pid_2_luid_0x0_0x1_phys_0_eng_0_engtype_3D|70')!.utilPct, 100);
  assert.equal(parseWinGpu(''), undefined);
  assert.equal(parseWinGpu('adapter|Microsoft Basic Display Adapter|0'), undefined);
});

test('system: nvidia-smi', () => {
  assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 5090, 32607, 14512, 38\n'), { name: 'NVIDIA GeForce RTX 5090', memTotalMiB: 32607, memUsedMiB: 14512, utilPct: 38 });
  assert.equal(parseNvidiaSmi(''), undefined);
  assert.equal(parseNvidiaSmi('NVIDIA, [N/A], 1, 2'), undefined);
});

const BEAST: HostStats = {
  hostname: 'BEAST',
  platform: 'win32 10.0.26100',
  cpuModel: 'AMD Ryzen 9 9950X',
  cpuCount: 32,
  loadPct: 38,
  memTotalBytes: 128 * GB,
  memFreeBytes: 37 * GB,
  diskTotalBytes: 2000 * GB,
  diskFreeBytes: 700 * GB,
  gpu: { name: 'RTX 5090', memTotalMiB: 32607, memUsedMiB: 14512, utilPct: 38 },
};
const MAC: HostStats = {
  hostname: 'mac.local',
  platform: 'darwin 25.0.0',
  cpuModel: 'Apple M4 Max',
  cpuCount: 16,
  loadPct: 12,
  memTotalBytes: 64 * GB,
  memFreeBytes: 60 * GB,
  memUsedBytes: 21 * GB,
  memPressure: 'normal',
  diskTotalBytes: 1000 * GB,
  diskFreeBytes: 300 * GB,
  gpu: { name: 'Apple M4 Max', memTotalMiB: 64 * 1024, memUsedMiB: 3 * 1024, utilPct: 55, unified: true },
};

test('system: status lines for a discrete GPU and for Apple Silicon', () => {
  assert.equal(memUsed(BEAST), 91 * GB);
  assert.equal(memUsed(MAC), 21 * GB, "the OS monitor's figure wins over total minus free");
  assert.equal(
    statsLine('BEAST', BEAST),
    'BEAST (win32 10.0.26100), AMD Ryzen 9 9950X x32: CPU 38%; RAM 91 GB used of 128 GB; GPU RTX 5090: VRAM 14512/32607 MiB, 38% util; disk free 700 GB of 2000 GB',
  );
  assert.equal(
    statsLine('m5', MAC),
    'm5 (darwin 25.0.0), Apple M4 Max x16: CPU 12%; RAM 21 GB used of 64 GB (memory pressure normal); GPU Apple M4 Max 55% busy, 3.0 GB of the shared RAM in use; disk free 300 GB of 1000 GB',
  );
  assert.match(statsLine('x', { ...MAC, gpu: undefined, diskFreeBytes: undefined }), /GPU n\/a; disk free \? of/);
});

test('system: a machine line says why there are no numbers', () => {
  assert.match(machineLoadLine({ id: 'm5' }, MAC, true), /^m5 \(darwin/);
  assert.match(machineLoadLine({ id: 'm3' }, undefined, true, 3), /^m3: online, no load numbers \(a daemon from before protocol 4 sends none/);
  // A current daemon right after it (re)connected, e.g. after a portal restart (w424): not blamed on an old protocol.
  assert.equal(machineLoadLine({ id: 'lothdesktop' }, undefined, true, 6), 'lothdesktop: online, no load numbers yet (its daemon sends them within a minute of connecting)');
  assert.equal(machineLoadLine({ id: 'lothdesktop' }, undefined, true), 'lothdesktop: online, no load numbers yet (its daemon sends them within a minute of connecting)');
  assert.equal(machineLoadLine({ id: 'mini', lastSeen: '2026-09-27T08:15:00.000Z' }, undefined, false), 'mini: offline since 2026-09-27 08:15 UTC');
  assert.equal(machineLoadLine({ id: 'mini' }, undefined, false), 'mini: offline');
});
