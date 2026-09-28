import type { HostStats } from './types.ts';

/** Memory in use: the OS monitor's figure where known (macOS), else total minus free. Server and UI alike. */
export const memUsed = (s: Pick<HostStats, 'memTotalBytes' | 'memFreeBytes' | 'memUsedBytes'>) => s.memUsedBytes ?? s.memTotalBytes - s.memFreeBytes;
