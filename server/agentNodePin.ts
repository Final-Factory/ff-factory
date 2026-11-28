/**
 * The agents' pinned node (w1742) and the daemon's copy's folder name (w6603), with no imports: the command guard reads
 * DAEMON_NODE_FOLDER through daemonReads.ts on every call, and agentNode.ts's own imports added about 20 ms to its load
 * (measured on BEAST, three runs each). agentNode.ts re-exports both.
 */

/**
 * The pinned build: nodejs.org's SHASUMS256.txt for v24.22.1 (fetched and checked 2026-10-22, w1742). `exeSha256` is the
 * node.exe inside that zip and `treeSha256` the digest of all its files (`treeDigest`), both from the zip unpacked with
 * Windows' tar.exe (w5839, 2026-11-25: 1994 files; BEAST's tools\node gave the same two digests).
 */
export const AGENT_NODE = {
  version: 'v24.22.1',
  zip: 'node-v24.22.1-win-x64.zip',
  sha256: 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5',
  exeSha256: 'd702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5',
  treeSha256: '3983141a10f864dbf120545a5bb459883bfff0ce450d8831cb0a1e8caddafa7b',
} as const;

/** The daemon's copy's folder name in the daemon's folder; the read fence gives it back to reads (daemonReads.ts FENCE_READ_ALLOW). */
export const DAEMON_NODE_FOLDER = `node-${AGENT_NODE.version}`;
