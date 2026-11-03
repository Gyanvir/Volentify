'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  MapPin,
  MessageSquare,
  Radio,
  RotateCw,
  Send,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { api, ApiError, apiFetch, useApi } from '@/lib/api';
import { MESH_PRIORITY_HEX, MESH_TYPE_LABEL } from '@/lib/constants';
import { useSession } from '@/lib/session';
import type {
  Assignment,
  Availability,
  DataSource,
  DispatchResult,
  MeshEvent,
  MeshNode,
  Task,
  TaskStatus,
  Volunteer,
} from '@/lib/types';
import { cn, formatCoord, pct, SEVERITY_ORDER, timeAgo, titleCase } from '@/lib/utils';
import { Pill, SeverityBadge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingRows, SourceTag } from '@/components/ui/DataState';
import { Segmented } from '@/components/ui/Field';
import { PageHeader, Panel, Section, Stat } from '@/components/ui/Page';
import { useToast } from '@/components/ui/Toast';

const FACTORS = [
  { name: 'Urgency', body: 'Critical missions are filled first and weigh ten times a low-priority request.' },
  { name: 'Scarcity', body: 'Skills held by few responders count for more, so the pool is spent where it is thinnest.' },
  { name: 'Skill match', body: 'An exact certification beats a neighbouring skill; specialist missions never go to untrained hands.' },
  { name: 'Specialist protection', body: 'Paramedics, boat crews and drone pilots are held back from generic work while others can do it.' },
  { name: 'Distance', body: 'Closer responders score higher, halving at fifteen kilometres.' },
  { name: 'Fatigue', body: 'Each active mission lowers a responder’s score so the load spreads across the team.' },
];

const TIER_TONE = { EXACT: 'good', ADJACENT: 'warn', GENERIC: 'neutral' } as const;
const TIER_LABEL = { EXACT: 'Exact skill', ADJACENT: 'Related skill', GENERIC: 'General help' } as const;

function Formula() {
  return (
    <figure className="overflow-x-auto rounded-2xl border border-line bg-ink-900 px-6 py-7">
      <div className="min-w-[34rem] font-serif text-[1.35rem] italic text-ivory sm:text-2xl" aria-label="Composite score equals urgency times scarcity times skill match times squander penalty, divided by one plus distance over d-zero, divided by one plus beta times workload">
        C<sub className="text-[0.6em]">i,j</sub>
        <span className="mx-2 not-italic text-stone">=</span>
        W<sub className="text-[0.6em]">urgency</sub> · S<sub className="text-[0.6em]">k</sub> · Sim(v, T) · Π<sub className="text-[0.6em]">squander</sub>
        <span className="mx-2 not-italic text-stone">×</span>
        <span className="inline-flex flex-col items-center align-middle text-[0.8em] leading-tight"><span>1</span><span className="border-t border-stone px-1">1 + d / d<sub className="text-[0.6em]">0</sub></span></span>
        <span className="mx-2 not-italic text-stone">×</span>
        <span className="inline-flex flex-col items-center align-middle text-[0.8em] leading-tight"><span>1</span><span className="border-t border-stone px-1">1 + β H<sub className="text-[0.6em]">work</sub></span></span>
      </div>
      <figcaption className="mt-4 text-xs text-stone">
        Sperling (2026) priority-driven heuristic · d<sub>0</sub> = 15 km · β = 0.15 · Π<sub>squander</sub> = 0.12 · O(T log T + T·V)
      </figcaption>
    </figure>
  );
}

function MyQueue({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const me = useApi<Volunteer>('/api/volunteers/me');
  const mine = useApi<Task[]>('/api/tasks?mine=true');
  const [busy, setBusy] = useState<string | null>(null);

  const setAvailability = async (availability: Availability) => {
    if (!me.data) return;
    setBusy('availability');
    try {
      const v = await api.post<Volunteer>('/api/volunteer/availability', { volunteer_id: me.data.id, availability });
      me.mutate(() => v);
      toast(`You are now ${availability.toLowerCase()}`);
      onChange();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not update availability', 'error');
    } finally { setBusy(null); }
  };

  const setStatus = async (task: Task, status: TaskStatus) => {
    setBusy(task.id);
    try {
      await api.patch<Task>(`/api/tasks/${task.id}`, { status });
      toast(status === 'COMPLETED' ? 'Mission marked complete' : status === 'OPEN' ? 'Mission released back to the board' : 'Mission started');
      mine.reload(); onChange();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not update the mission', 'error');
    } finally { setBusy(null); }
  };

  if (me.error?.status === 404) {
    return (
      <Panel className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-sand">Your account has no volunteer profile yet. Add your skills to receive missions.</p>
        <ButtonLink href="/onboarding" size="sm">Complete volunteer profile</ButtonLink>
      </Panel>
    );
  }
  const active = (mine.data ?? []).filter((t) => t.status === 'ASSIGNED' || t.status === 'IN_PROGRESS');

  return (
    <Panel className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl">Your mission queue</h2>
          {me.data && <p className="mt-1 text-sm text-stone">{me.data.skills.join(', ') || 'No skills listed'} · based in {me.data.location_name}</p>}
        </div>
        {me.data && (
          <Segmented<Availability> ariaLabel="Your availability" value={me.data.availability} onChange={setAvailability}
            options={[{ value: 'AVAILABLE', label: 'Available' }, { value: 'BUSY', label: 'Busy' }, { value: 'OFFLINE', label: 'Off duty' }]} />
        )}
      </div>
      {mine.loading && !mine.data ? <LoadingRows rows={1} />
        : mine.error ? <ErrorState message={mine.error.message} onRetry={mine.reload} />
        : active.length === 0 ? <p className="text-sm text-stone">No active missions. Accept one from the open missions below.</p>
        : (
          <ul className="divide-y divide-line">
            {active.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2"><SeverityBadge level={t.urgency} /><Pill>{titleCase(t.status)}</Pill></div>
                  <p className="mt-1.5 text-[0.9375rem] text-ivory">{t.title}</p>
                  <p className="text-xs text-stone">{t.location_name}</p>
                </div>
                <div className="flex gap-2">
                  {t.status === 'ASSIGNED' && <Button size="sm" loading={busy === t.id} onClick={() => setStatus(t, 'IN_PROGRESS')}>Start</Button>}
                  {t.status === 'IN_PROGRESS' && <Button size="sm" loading={busy === t.id} onClick={() => setStatus(t, 'COMPLETED')}>Mark complete</Button>}
                  <Button size="sm" variant="ghost" disabled={busy === t.id} onClick={() => setStatus(t, 'OPEN')}>Release</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
    </Panel>
  );
}

type MeshTab = 'REPORTS' | 'MESSAGES' | 'ALL';

function MeshTelemetryFeed({ onPromoted }: { onPromoted: () => void }) {
  const toast = useToast();
  const { user } = useSession();
  const [tab, setTab] = useState<MeshTab>('REPORTS');
  const [busy, setBusy] = useState<string | null>(null);
  const [broadcastText, setBroadcastText] = useState('');
  const [broadcastUrgent, setBroadcastUrgent] = useState(false);
  const [broadcasting, setBroadcasting] = useState(false);

  const eventsApi = useApi<MeshEvent[]>('/api/mesh/events?limit=100', { refreshMs: 15_000 });
  const nodesApi = useApi<MeshNode[]>('/api/mesh/nodes', { refreshMs: 30_000 });

  const all = useMemo(() => eventsApi.data ?? [], [eventsApi.data]);
  const activeNodes = useMemo(() => (nodesApi.data ?? []).filter((n) => n.active).length, [nodesApi.data]);

  // Messages are events of type DISASTER_STATUS with a "message" payload
  const isMessage = (e: MeshEvent) => e.type === 'DISASTER_STATUS' && Boolean((e.payload as Record<string, unknown>)?.message);

  const reports = useMemo(() => all.filter((e) => !isMessage(e)), [all]);
  const messages = useMemo(() => all.filter((e) => isMessage(e)), [all]);

  const displayed = useMemo(() => {
    if (tab === 'REPORTS') return reports;
    if (tab === 'MESSAGES') return messages;
    return all;
  }, [tab, reports, messages, all]);

  const promoteToMission = async (e: MeshEvent) => {
    setBusy(e.event_id);
    try {
      await api.patch<MeshEvent>(`/api/mesh/events/${e.event_id}`, { action: 'PROMOTE' });
      toast('Field report promoted to an open mission on the dispatch board!');
      eventsApi.reload();
      onPromoted();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not promote report to mission', 'error');
    } finally {
      setBusy(null);
    }
  };

  const sendBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = broadcastText.trim();
    if (!text) return;
    setBroadcasting(true);
    try {
      const eventId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const nodeId = user?.id ? `web_${user.id.slice(0, 8)}` : `web_cmd_${Math.random().toString(36).slice(2, 6)}`;
      await api.post('/api/mesh/ingest', {
        gateway_node_id: nodeId,
        events: [{
          event_id: eventId,
          origin_node_id: nodeId,
          type: 'DISASTER_STATUS',
          priority: broadcastUrgent ? 'CRITICAL' : 'MEDIUM',
          payload: {
            message: text,
            from: user?.name ? `${user.name} (Command Dispatch)` : 'Web Command Dispatch',
          },
          observed_at: new Date().toISOString(),
          hop_count: 0,
          ttl: 5,
        }],
      });
      toast('Broadcast transmitted to mesh network');
      setBroadcastText('');
      setBroadcastUrgent(false);
      eventsApi.reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to transmit broadcast', 'error');
    } finally {
      setBroadcasting(false);
    }
  };

  return (
    <Panel className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <Radio className="h-5 w-5 text-signal animate-pulse" aria-hidden />
            <h2 className="text-2xl">Live field mesh & responder telemetry</h2>
          </div>
          <p className="mt-1 text-sm text-stone">
            Reports and radio broadcasts relayed over Bluetooth mesh from the Volentify Android companion app in the field.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={activeNodes > 0 ? 'good' : 'neutral'} dot>
            {activeNodes} field phone{activeNodes === 1 ? '' : 's'} online
          </Pill>
          <SourceTag source={eventsApi.source} />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <Segmented<MeshTab>
          size="sm"
          ariaLabel="Filter mesh telemetry"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'REPORTS', label: `Field requests (${reports.length})` },
            { value: 'MESSAGES', label: `Mesh radio (${messages.length})` },
            { value: 'ALL', label: `All telemetry (${all.length})` },
          ]}
        />
        <span className="text-xs text-stone">Auto-refreshes every 15s</span>
      </div>

      {tab === 'MESSAGES' && (
        <form onSubmit={sendBroadcast} className="rounded-xl border border-line bg-ink-950/60 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ivory flex items-center gap-1.5">
              <MessageSquare className="h-3.5 w-3.5 text-signal" aria-hidden /> Broadcast to field mesh
            </span>
            <button
              type="button"
              onClick={() => setBroadcastUrgent(!broadcastUrgent)}
              className={cn(
                'rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors',
                broadcastUrgent ? 'bg-critical/20 text-critical border border-critical/40' : 'bg-ivory/[0.05] text-stone hover:text-ivory'
              )}
            >
              {broadcastUrgent ? 'Priority: Urgent' : 'Priority: Normal'}
            </button>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={broadcastText}
              onChange={(e) => setBroadcastText(e.target.value)}
              placeholder="Send operational update or radio broadcast to field phones..."
              className="flex-1 rounded-lg border border-line bg-ink-900 px-3 py-2 text-sm text-ivory placeholder:text-stone focus:border-signal focus:outline-none"
              maxLength={240}
            />
            <Button size="sm" type="submit" loading={broadcasting} disabled={!broadcastText.trim()}>
              <Send className="h-3.5 w-3.5" aria-hidden /> Send
            </Button>
          </div>
        </form>
      )}

      {eventsApi.loading && !eventsApi.data ? (
        <LoadingRows rows={3} />
      ) : eventsApi.error ? (
        <ErrorState message={eventsApi.error.message} onRetry={eventsApi.reload} />
      ) : displayed.length === 0 ? (
        <EmptyState
          title={tab === 'REPORTS' ? 'No field reports awaiting dispatch' : tab === 'MESSAGES' ? 'No radio broadcasts received yet' : 'No mesh events found'}
          body="Field reports created in the Volentify Mesh companion app will stream here automatically when any phone within 5 hops reaches network coverage."
        />
      ) : (
        <ul className="divide-y divide-line">
          {displayed.map((e) => {
            const isMsg = isMessage(e);
            const payload = (e.payload ?? {}) as Record<string, unknown>;
            const msgText = typeof payload.message === 'string' ? payload.message : undefined;
            const fromName = (typeof payload.from === 'string' && payload.from) || `Node ${e.origin_node_id.slice(0, 8)}`;
            const isPromoted = e.review_status === 'PROMOTED';
            const rawNeeds = payload.needs;
            const needs = Array.isArray(rawNeeds) ? rawNeeds : rawNeeds ? [rawNeeds] : [];
            const notes = typeof payload.notes === 'string' ? payload.notes : typeof payload.note === 'string' ? payload.note : undefined;
            const peopleCount = typeof payload.count === 'number' ? payload.count : undefined;

            return (
              <li key={e.event_id} className="grid gap-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs ring-1 ring-inset ring-line-strong font-medium"
                      style={{ color: MESH_PRIORITY_HEX[e.priority] }}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
                      {titleCase(e.priority)}
                    </span>

                    {isMsg ? (
                      <Pill tone="info">Radio message</Pill>
                    ) : (
                      <Pill tone={isPromoted ? 'gold' : e.review_status === 'UNREVIEWED' ? 'warn' : 'good'}>
                        {isPromoted ? 'Promoted to mission' : e.review_status === 'UNREVIEWED' ? 'Field report' : 'Reviewed'}
                      </Pill>
                    )}

                    <span className="text-xs text-stone">
                      observed {timeAgo(e.observed_at)} · {e.hop_count} hop{e.hop_count === 1 ? '' : 's'}
                    </span>
                  </div>

                  {isMsg ? (
                    <div>
                      <p className="text-[1.0625rem] text-ivory font-serif leading-snug">"{msgText}"</p>
                      <p className="text-xs text-stone mt-1">From: <span className="text-sand">{fromName}</span></p>
                    </div>
                  ) : (
                    <div>
                      <p className="text-[1.0625rem] text-ivory font-medium">
                        {MESH_TYPE_LABEL[e.type] || titleCase(e.type)}
                      </p>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone mt-1">
                        {needs.length > 0 && (
                          <span className="text-signal">
                            Needs: <strong className="text-ivory">{needs.join(', ')}</strong>
                          </span>
                        )}
                        {notes && <span>Notes: <span className="text-sand">"{notes}"</span></span>}
                        {peopleCount != null && <span>People: <strong className="text-ivory">{peopleCount}</strong></span>}
                        {e.lat != null && e.lng != null ? (
                          <span className="code flex items-center gap-1">
                            <MapPin className="h-3 w-3 text-stone" aria-hidden /> {formatCoord(e.lat, e.lng)}
                          </span>
                        ) : (
                          <span className="text-stone">No GPS fix / location masked</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {!isMsg && !isPromoted && (
                    <Button
                      size="sm"
                      loading={busy === e.event_id}
                      onClick={() => promoteToMission(e)}
                      title="Promote this field report into an open mission so the dispatch engine can assign responders"
                    >
                      <Sparkles className="h-3.5 w-3.5 text-sand" aria-hidden />
                      Convert to mission
                    </Button>
                  )}
                  {isPromoted && (
                    <span className="inline-flex items-center gap-1.5 text-xs text-gold">
                      <CheckCircle2 className="h-4 w-4" aria-hidden />
                      Live on board
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function OpenMissions({ isVolunteer, tasks, onAccepted }: { isVolunteer: boolean; tasks: ReturnType<typeof useApi<Task[]>>; onAccepted: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const accept = async (t: Task) => {
    setBusy(t.id);
    try {
      await api.post<Task>(`/api/tasks/${t.id}/accept`);
      toast(`Mission accepted: ${t.title}`);
      onAccepted();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not accept the mission', 'error');
      tasks.reload();
    } finally { setBusy(null); }
  };
  const rows = useMemo(() => [...(tasks.data ?? [])].sort((a, b) => SEVERITY_ORDER[a.urgency] - SEVERITY_ORDER[b.urgency]), [tasks.data]);

  if (tasks.loading && !tasks.data) return <LoadingRows rows={3} />;
  if (tasks.error) return <ErrorState message={tasks.error.message} onRetry={tasks.reload} />;
  if (!rows.length) return <EmptyState title="Every mission is staffed" body="New requests from incident command or converted field reports will appear here." />;
  return (
    <ul className="divide-y divide-line border-y border-line">
      {rows.map((t) => (
        <li key={t.id} className="grid gap-3 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2"><SeverityBadge level={t.urgency} /><span className="code">{t.code}</span></div>
            <p className="text-[1.0625rem] text-ivory">{t.title}</p>
            {t.description && <p className="text-xs text-sand line-clamp-2">{t.description}</p>}
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8125rem] text-stone">
              <span>{t.required_skill}</span>
              <span>{t.quantity_needed} responder{t.quantity_needed === 1 ? '' : 's'}</span>
              <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" aria-hidden />{t.location_name}</span>
              <span>Raised {timeAgo(t.created_at)}</span>
            </p>
          </div>
          {isVolunteer
            ? <Button size="sm" loading={busy === t.id} onClick={() => accept(t)}>Accept mission</Button>
            : <Link href={`/disasters/${t.disaster_id}`} className="link text-[0.8125rem]">Incident</Link>}
        </li>
      ))}
    </ul>
  );
}

function DispatchCycle({ refreshKey }: { refreshKey: number }) {
  const [result, setResult] = useState<DispatchResult | null>(null);
  const [source, setSource] = useState<DataSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [ranAt, setRanAt] = useState<Date | null>(null);

  const run = useCallback(async () => {
    setRunning(true); setError(null);
    try {
      const r = await apiFetch<DispatchResult>('/api/match/dispatch-batch', { method: 'POST', json: {} });
      setSource(r.source);
      setResult(r.data);
      setRanAt(new Date());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Dispatch engine unavailable');
    } finally { setRunning(false); }
  }, []);

  useEffect(() => { void run(); }, [run, refreshKey]);

  const grouped = useMemo(() => {
    const map = new Map<string, Assignment[]>();
    for (const a of result?.assignments ?? []) map.set(a.task_id, [...(map.get(a.task_id) ?? []), a]);
    return Array.from(map.values());
  }, [result]);
  const maxScarcity = Math.max(1, ...Object.values(result?.scarcity ?? {}));

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <SourceTag source={source} />
          {ranAt && <span className="text-xs text-stone">Last cycle {timeAgo(ranAt)}</span>}
        </div>
        <Button variant="secondary" size="sm" onClick={run} loading={running}><RotateCw className="h-3.5 w-3.5" aria-hidden />Run dispatch cycle</Button>
      </div>

      {error ? <ErrorState message={error} onRetry={run} />
        : !result ? <LoadingRows rows={3} />
        : (
          <>
            <div className="grid grid-cols-2 gap-x-8 gap-y-6 border-y border-line py-6 md:grid-cols-4">
              <Stat label="Slots filled" value={pct(result.completeness)} note={`${result.assignments.length} assignments`} />
              <Stat label="Solve time" value={<>{result.latency_ms.toFixed(2)}<span className="font-sans text-base text-stone"> ms</span></>} note="Measured on the server" />
              <Stat label="Missions evaluated" value={result.tasks_evaluated} note={`${result.volunteers_evaluated} available responders`} />
              <Stat label="Exact skill matches" value={result.tiers.EXACT} note={`${result.tiers.ADJACENT} related · ${result.tiers.GENERIC} general`} />
            </div>

            <div className="grid gap-10 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
              <section aria-labelledby="assignments">
                <h3 id="assignments" className="mb-4 text-2xl">Recommended assignments</h3>
                {grouped.length === 0 ? <p className="text-sm text-stone">No eligible responders for the open missions.</p> : (
                  <ol className="space-y-6">
                    {grouped.map((group) => (
                      <li key={group[0].task_id} className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <SeverityBadge level={group[0].urgency} />
                          <p className="text-[0.9375rem] text-ivory">{group[0].task_title}</p>
                          <span className="code">{group[0].task_code}</span>
                        </div>
                        <ul className="divide-y divide-line rounded-xl border border-line">
                          {group.map((a) => (
                            <li key={`${a.task_id}-${a.slot}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                              <div className="min-w-0">
                                <p className="text-sm text-ivory">{a.volunteer_name}</p>
                                <p className="text-xs text-stone">{a.reason}</p>
                              </div>
                              <div className="flex items-center gap-3">
                                <Pill tone={TIER_TONE[a.tier]}>{TIER_LABEL[a.tier]}</Pill>
                                <span className="data text-xs text-sand">{a.score.toFixed(3)}</span>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <div className="space-y-10">
                <section aria-labelledby="bottlenecks">
                  <h3 id="bottlenecks" className="mb-4 text-2xl">Shortfalls</h3>
                  {result.bottlenecks.length === 0
                    ? <p className="flex items-center gap-2 text-sm text-low"><ShieldCheck className="h-4 w-4" aria-hidden />Every open mission is fully staffed.</p>
                    : (
                      <ul className="space-y-3">
                        {result.bottlenecks.map((b) => (
                          <li key={b.task_id} className="flex items-start gap-3 rounded-xl border border-high/25 bg-high/[0.05] p-3.5">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-high" aria-hidden />
                            <div className="text-sm">
                              <p className="text-ivory">{b.deficit} more {b.skill} needed</p>
                              <p className="text-xs text-stone">{b.task_code} · {b.filled} of {b.requested} filled</p>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                </section>

                <section aria-labelledby="scarcity">
                  <h3 id="scarcity" className="mb-4 text-2xl">Skill scarcity</h3>
                  <p className="mb-4 text-xs text-stone">S<sub>k</sub> = 1 / √N<sub>k</sub> — longer bars mean fewer available responders hold the skill.</p>
                  <ul className="space-y-3">
                    {Object.entries(result.scarcity).sort((a, b) => b[1] - a[1]).map(([skill, s]) => (
                      <li key={skill}>
                        <div className="mb-1 flex justify-between text-[0.8125rem]"><span className="text-sand">{skill}</span><span className="data text-stone">{s.toFixed(2)}</span></div>
                        <div className="h-1.5 rounded-full bg-ink-700"><div className={cn('h-full rounded-full', s >= 0.99 ? 'bg-signal' : 'bg-gold/70')} style={{ width: `${(s / maxScarcity) * 100}%` }} /></div>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            </div>
          </>
        )}
    </div>
  );
}

function PoolSummary() {
  const { data, error, loading, reload } = useApi<Volunteer[]>('/api/volunteers?availability=ALL', { refreshMs: 60_000 });
  if (loading && !data) return <LoadingRows rows={1} />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  const pool = data ?? [];
  const by = (a: Availability) => pool.filter((v) => v.availability === a).length;
  const skills = new Map<string, number>();
  pool.filter((v) => v.availability === 'AVAILABLE').forEach((v) => v.skills.forEach((s) => skills.set(s, (skills.get(s) ?? 0) + 1)));
  return (
    <div className="grid gap-8 md:grid-cols-[auto_minmax(0,1fr)] md:gap-16">
      <div className="grid grid-cols-3 gap-8">
        <Stat label="Available" value={by('AVAILABLE')} />
        <Stat label="On mission" value={by('BUSY')} />
        <Stat label="Off duty" value={by('OFFLINE')} />
      </div>
      <div>
        <p className="mb-3 text-[0.8125rem] text-stone">Skills ready to deploy</p>
        <div className="flex flex-wrap gap-2">
          {Array.from(skills.entries()).sort((a, b) => b[1] - a[1]).map(([s, n]) => (
            <Pill key={s} tone={n <= 1 ? 'warn' : 'neutral'}>{s} <span className="text-stone">{n}</span></Pill>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function DispatchBoard() {
  const { user, status } = useSession();
  const isVolunteer = user?.role === 'VOLUNTEER';
  const tasks = useApi<Task[]>('/api/tasks?status=OPEN', { refreshMs: 45_000 });
  const [cycle, setCycle] = useState(0);
  const refreshAll = useCallback(() => { tasks.reload(); setCycle((n) => n + 1); }, [tasks]);

  return (
    <>
      <PageHeader
        label="Volunteer dispatch"
        title="The right responder, to the right mission, first."
        lede="Volentify allocates open missions in priority order and protects rare specialists from routine work. Every recommendation shows why it was made."
        actions={status === 'authenticated'
          ? (isVolunteer ? null : <ButtonLink href="/map" variant="secondary">See missions on the map</ButtonLink>)
          : <><ButtonLink href="/register?role=VOLUNTEER">Join as a volunteer</ButtonLink><ButtonLink href="/login?next=/volunteer" variant="secondary">Sign in</ButtonLink></>}
      />

      {isVolunteer && <Section className="pt-0"><MyQueue onChange={refreshAll} /></Section>}

      {/* Real-time Field Mesh Telemetry, Reports & Radio */}
      <Section className={isVolunteer ? '' : 'pt-0'}>
        <MeshTelemetryFeed onPromoted={refreshAll} />
      </Section>

      <Section title="Live dispatch board" description="One allocation cycle over every open mission and available responder. Recommendations are advisory — responders accept missions themselves.">
        <DispatchCycle refreshKey={cycle} />
      </Section>

      <Section title="Open missions" description={isVolunteer ? 'Accept a mission to add it to your queue. Command sees your acceptance immediately.' : undefined}
        actions={!isVolunteer && status !== 'loading' ? <ButtonLink href={user ? '/onboarding' : '/register?role=VOLUNTEER'} size="sm" variant="secondary">Volunteer to take missions</ButtonLink> : undefined}>
        <OpenMissions isVolunteer={isVolunteer} tasks={tasks} onAccepted={refreshAll} />
      </Section>

      <Section title="How missions are allocated">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-start">
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            {FACTORS.map((f) => (
              <div key={f.name}>
                <dt className="text-[0.9375rem] text-ivory">{f.name}</dt>
                <dd className="mt-1 text-sm leading-relaxed text-stone">{f.body}</dd>
              </div>
            ))}
          </dl>
          <Formula />
        </div>
      </Section>

      <Section title="Responder pool">
        <PoolSummary />
      </Section>
    </>
  );
}
