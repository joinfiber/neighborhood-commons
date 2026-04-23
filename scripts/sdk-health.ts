/**
 * SDK Health Report
 *
 * Prints the current state of the `neighborhood-commons` npm package:
 * version distribution, download stats, latest version. Useful before
 * shipping a breaking change so you know which consumer versions you
 * would impact.
 *
 * Usage: tsx scripts/sdk-health.ts
 */

interface NpmRegistryData {
  'dist-tags': { latest?: string };
  versions: Record<string, { name: string; version: string }>;
  time: Record<string, string>;
}

interface NpmDownloadsData {
  downloads: number;
  start: string;
  end: string;
  package: string;
}

const PACKAGE = 'neighborhood-commons';

async function fetchRegistry(): Promise<NpmRegistryData> {
  const res = await fetch(`https://registry.npmjs.org/${PACKAGE}`);
  if (!res.ok) throw new Error(`Registry fetch failed: ${res.status}`);
  return (await res.json()) as NpmRegistryData;
}

async function fetchDownloads(period: string): Promise<NpmDownloadsData | null> {
  const res = await fetch(`https://api.npmjs.org/downloads/point/${period}/${PACKAGE}`);
  if (!res.ok) return null;
  return (await res.json()) as NpmDownloadsData;
}

async function fetchVersionDownloads(): Promise<Record<string, number> | null> {
  const res = await fetch(`https://api.npmjs.org/versions/${encodeURIComponent(PACKAGE)}/last-week`);
  if (!res.ok) return null;
  const json = (await res.json()) as { downloads: Record<string, number> };
  return json.downloads;
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

async function main(): Promise<void> {
  console.log(`SDK Health Report — ${PACKAGE}\n`);

  const [registry, lastDay, lastWeek, lastMonth, perVersion] = await Promise.all([
    fetchRegistry(),
    fetchDownloads('last-day'),
    fetchDownloads('last-week'),
    fetchDownloads('last-month'),
    fetchVersionDownloads(),
  ]);

  const latest = registry['dist-tags'].latest ?? '(unknown)';
  console.log(`Latest: ${latest}`);
  console.log(`Total versions published: ${Object.keys(registry.versions).length}\n`);

  console.log('Version timeline:');
  const versionTimes = Object.entries(registry.time)
    .filter(([k]) => k !== 'created' && k !== 'modified')
    .sort(([, a], [, b]) => new Date(a).getTime() - new Date(b).getTime());
  for (const [version, time] of versionTimes) {
    const marker = version === latest ? ' (latest)' : '';
    console.log(`  ${formatDate(time)}  ${version}${marker}`);
  }
  console.log('');

  console.log('Downloads:');
  if (lastDay) console.log(`  last day:    ${lastDay.downloads}`);
  if (lastWeek) console.log(`  last week:   ${lastWeek.downloads}`);
  if (lastMonth) console.log(`  last month:  ${lastMonth.downloads}`);
  console.log('');

  if (perVersion && Object.keys(perVersion).length > 0) {
    console.log('Per-version downloads (last week):');
    const sorted = Object.entries(perVersion)
      .filter(([, count]) => count > 0)
      .sort(([, a], [, b]) => b - a);
    for (const [version, count] of sorted) {
      const marker = version === latest ? ' (latest)' : '';
      console.log(`  ${count.toString().padStart(6)}  ${version}${marker}`);
    }
    console.log('');
    console.log('Use this distribution before shipping a breaking change to know who is at risk.');
  } else {
    console.log('Per-version download data not yet available (typical for very new packages).');
  }
}

void main().catch((err: Error) => {
  console.error('SDK health check failed:', err.message);
  process.exit(1);
});
