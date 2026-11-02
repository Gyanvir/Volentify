'use client';

import { ExternalLink } from 'lucide-react';
import { useApi } from '@/lib/api';
import type { BulletinFeed } from '@/lib/types';
import { formatDateTime, timeAgo } from '@/lib/utils';
import { Pill, SeverityBadge } from '@/components/ui/Badge';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/DataState';

export function useOfficialWarnings(limit = 40) {
  return useApi<BulletinFeed>(`/api/bhuvan/bulletins?limit=${limit}`, { refreshMs: 300_000 });
}

export function FeedPill({ feed }: { feed: BulletinFeed | undefined }) {
  if (!feed) return null;
  if (feed.mode === 'LIVE') return <Pill tone="good" dot>Live from NDMA SACHET</Pill>;
  if (feed.mode === 'CACHED') return <Pill tone="warn" dot>SACHET unreachable — last copies received</Pill>;
  return <Pill tone="bad" dot>SACHET unreachable</Pill>;
}

const strip = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** Warnings in force, as issued through NDMA's SACHET Common Alerting Protocol system (expired ones are dropped). */
export function OfficialWarnings({ limit = 15, feed }: { limit?: number; feed: ReturnType<typeof useOfficialWarnings> }) {
  const { data, error, loading, reload } = feed;
  if (loading && !data) return <LoadingRows rows={4} />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data?.items.length) {
    return data?.mode === 'OFFLINE'
      ? <EmptyState title="Official warnings are unavailable right now" body="NDMA SACHET could not be reached. Check sachet.ndma.gov.in or your state SDMA." action={<button onClick={reload} className="link text-sm">Try again</button>} />
      : <EmptyState title="No warnings in force" body="Nothing is currently issued in the national CAP feed." />;
  }
  return (
    <ul className="divide-y divide-line rounded-2xl border border-line">
      {data.items.slice(0, limit).map((b, i) => (
        <li key={`${b.link ?? b.title}-${i}`} className="grid gap-2 px-5 py-4 sm:grid-cols-[7rem_1fr_auto] sm:items-start sm:gap-6">
          <SeverityBadge level={b.severity} className="w-fit" />
          <div className="min-w-0 space-y-1">
            <p className="text-[0.9375rem] leading-snug text-ivory">{b.title}</p>
            {b.description && <p className="line-clamp-2 max-w-[75ch] text-sm leading-relaxed text-stone">{strip(b.description)}</p>}
            {b.instruction && <p className="max-w-[75ch] text-sm text-sand"><span className="text-ivory">Advice:</span> {b.instruction}</p>}
            <p className="text-xs text-stone">
              {[b.event, b.source].filter(Boolean).join(' · ')} · <span className="code">{formatDateTime(b.published_at)}</span>
              {b.expires_at && <> · in force until <span className="code">{formatDateTime(b.expires_at)}</span> ({timeAgo(b.expires_at)})</>}
            </p>
          </div>
          {b.link && (
            <a href={b.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-sand hover:text-ivory">
              CAP message <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
