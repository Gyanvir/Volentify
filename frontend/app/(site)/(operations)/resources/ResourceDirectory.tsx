'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ExternalLink, Navigation, Phone, Search } from 'lucide-react';
import { useApi } from '@/lib/api';
import type { Resources } from '@/lib/types';
import { cn, timeAgo } from '@/lib/utils';
import { Pill } from '@/components/ui/Badge';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/DataState';
import { PageHeader, Section } from '@/components/ui/Page';

const directions = (lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
const dial = (n: string) => n.replace(/[^\d+]/g, '');

function DirectionsLink({ lat, lng }: { lat: number; lng: number }) {
  return (
    <a href={directions(lat, lng)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[0.8125rem] text-sand hover:text-ivory">
      <Navigation className="h-3.5 w-3.5" aria-hidden />Directions
    </a>
  );
}

function OsmLink({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[0.8125rem] text-stone hover:text-ivory">
      OpenStreetMap <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  );
}

export default function ResourceDirectory() {
  const { data, error, loading, reload } = useApi<Resources>('/api/resources');
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const match = (...parts: (string | number | null | undefined)[]) => !term || parts.filter(Boolean).join(' ').toLowerCase().includes(term);

  const hotlines = useMemo(() => data?.hotlines ?? [], [data]);
  const hospitals = (data?.hospitals ?? []).filter((h) => match(h.name, h.kind, h.address, h.incident_title));
  const shelters = (data?.shelters ?? []).filter((s) => match(s.name, s.kind, s.address, s.incharge, s.incident_title, ...s.facilities));
  const nothing = data && term && !hospitals.length && !shelters.length;

  return (
    <>
      <PageHeader
        label="Emergency resources"
        title="Help, close at hand"
        lede="National helplines, and the hospitals and relief shelters mapped in OpenStreetMap around incidents active right now. Call ahead: mapped facilities do not report live bed or shelter capacity."
      />

      <Section className="pt-0">
        <h2 className="sr-only">Helplines</h2>
        <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-5">
          {(hotlines.length ? hotlines : Array.from({ length: 10 }, () => null)).map((h, i) => (
            <li key={h?.number ?? i} className="bg-ink">
              {h ? (
                <a href={`tel:${dial(h.number)}`} className="group flex h-full flex-col justify-between gap-3 p-5 transition-colors hover:bg-ink-900">
                  <span className="text-[0.8125rem] text-stone">{h.label}</span>
                  <span className={cn('numeral flex items-center gap-2 text-3xl', h.number === '112' && 'text-critical')}>
                    {h.number}<Phone className="h-4 w-4 text-ash transition-colors group-hover:text-signal" aria-hidden />
                  </span>
                </a>
              ) : <div className="h-24 animate-pulse bg-ink-900" />}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Hospitals and shelters near active incidents">
        <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex h-12 w-full max-w-xl items-center gap-2.5 rounded-xl border border-line bg-ink-800 px-4 focus-within:border-signal/60">
            <Search className="h-4 w-4 text-stone" aria-hidden />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, place, operator or incident"
              aria-label="Search hospitals and shelters" className="h-full w-full bg-transparent text-[0.9375rem] text-ivory placeholder:text-ash focus:outline-none" />
          </div>
          {data && (
            <p className="text-xs text-stone">
              {data.mode === 'LIVE' && data.fetched_at ? <>From OpenStreetMap, updated {timeAgo(data.fetched_at)}</>
                : data.mode === 'OFFLINE' ? 'OpenStreetMap is unreachable right now' : null}
            </p>
          )}
        </div>

        {loading && !data ? <LoadingRows rows={4} />
          : error ? <ErrorState message={error.message} onRetry={reload} />
          : data?.mode === 'NO_INCIDENTS' ? (
            <EmptyState title="No active incidents on land" body="Facilities are listed around incidents in progress. When one is declared, hospitals and shelters near it appear here."
              action={<Link href="/disasters" className="link text-sm">See incidents</Link>} />
          ) : data?.mode === 'OFFLINE' && !data.hospitals.length && !data.shelters.length ? (
            <EmptyState title="Facility data is temporarily unavailable" body="OpenStreetMap could not be reached. The helplines above always work." action={<button onClick={reload} className="link text-sm">Try again</button>} />
          ) : nothing ? <EmptyState title={`Nothing matches “${q}”`} body="Try a city, district or incident name." />
          : (
            <div className="grid gap-12 lg:grid-cols-2">
              <section aria-labelledby="hospitals">
                <h3 id="hospitals" className="mb-4 text-2xl">Hospitals <span className="font-sans text-sm text-stone">{hospitals.length}</span></h3>
                <ul className="divide-y divide-line border-y border-line">
                  {hospitals.map((h) => (
                    <li key={h.id} className="space-y-2 py-5">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-[0.9375rem] text-ivory">{h.name}</p>
                          <p className="text-xs text-stone">{h.kind}{h.beds != null ? ` · ${h.beds} beds mapped` : ''}</p>
                        </div>
                        {h.emergency && <Pill tone="good">Emergency dept.</Pill>}
                      </div>
                      {h.address && <p className="text-[0.8125rem] text-sand">{h.address}</p>}
                      <p className="text-xs text-stone">{h.distance_km} km from {h.incident_title}</p>
                      <div className="flex flex-wrap gap-5 pt-1">
                        {h.phone && <a href={`tel:${dial(h.phone)}`} className="inline-flex items-center gap-1.5 text-[0.8125rem] text-ivory hover:text-signal"><Phone className="h-3.5 w-3.5" aria-hidden />{h.phone}</a>}
                        <DirectionsLink lat={h.lat} lng={h.lng} />
                        <OsmLink href={h.osm_url} />
                      </div>
                    </li>
                  ))}
                  {!hospitals.length && <li className="py-6 text-sm text-stone">No hospitals are mapped near the active incidents.</li>}
                </ul>
              </section>

              <section aria-labelledby="shelters">
                <h3 id="shelters" className="mb-4 text-2xl">Shelters and assembly points <span className="font-sans text-sm text-stone">{shelters.length}</span></h3>
                <ul className="divide-y divide-line border-y border-line">
                  {shelters.map((s) => (
                    <li key={s.id} className="space-y-2 py-5">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-[0.9375rem] text-ivory">{s.name}</p>
                          <p className="text-xs text-stone">{s.kind}{s.incharge ? ` · ${s.incharge}` : ''}</p>
                        </div>
                        {s.capacity != null && <Pill>{s.capacity} places</Pill>}
                      </div>
                      {(s.address || s.facilities.length > 0) && (
                        <p className="text-[0.8125rem] text-sand">{[s.address, s.facilities.join(', ')].filter(Boolean).join(' · ')}</p>
                      )}
                      <p className="text-xs text-stone">{s.distance_km} km from {s.incident_title}</p>
                      <div className="flex flex-wrap gap-5 pt-1">
                        <DirectionsLink lat={s.lat} lng={s.lng} />
                        <OsmLink href={s.osm_url} />
                      </div>
                    </li>
                  ))}
                  {!shelters.length && <li className="py-6 text-sm text-stone">No shelters are mapped near the active incidents. Follow district administration announcements for relief camps.</li>}
                </ul>
              </section>
            </div>
          )}
        {data && <p className="mt-8 text-xs text-stone">{data.attribution}</p>}
      </Section>
    </>
  );
}
