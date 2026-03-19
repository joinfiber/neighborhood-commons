import { useState, useEffect } from 'react';
import { colors } from '../lib/styles';
import {
  adminFetchFeedSources,
  adminCreateFeedSource,
  adminUpdateFeedSource,
  adminPollFeedSource,
} from '../lib/api';
import type { FeedSource } from '../lib/types';

const FEED_TYPES = ['ical', 'rss', 'eventbrite', 'agile_ticketing'] as const;

export function AdminFeedSourcesScreen() {
  const [sources, setSources] = useState<FeedSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [feedUrl, setFeedUrl] = useState('');
  const [feedType, setFeedType] = useState<string>('ical');
  const [pollInterval, setPollInterval] = useState(24);
  const [defaultLocation, setDefaultLocation] = useState('');
  const [defaultTimezone, setDefaultTimezone] = useState('America/New_York');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [pollingId, setPollingId] = useState<string | null>(null);
  const [pollResult, setPollResult] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const res = await adminFetchFeedSources();
    if (res.data?.sources) setSources(res.data.sources);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function startEdit(source: FeedSource) {
    setEditId(source.id);
    setName(source.name);
    setFeedUrl(source.feed_url);
    setFeedType(source.feed_type);
    setPollInterval(source.poll_interval_hours);
    setDefaultLocation(source.default_location || '');
    setDefaultTimezone(source.default_timezone);
    setNotes(source.notes || '');
    setShowForm(true);
  }

  function resetForm() {
    setEditId(null);
    setName('');
    setFeedUrl('');
    setFeedType('ical');
    setPollInterval(24);
    setDefaultLocation('');
    setDefaultTimezone('America/New_York');
    setNotes('');
    setShowForm(false);
    setError('');
  }

  async function handleSave() {
    if (!name.trim()) { setError('Name is required'); return; }
    if (!feedUrl.trim()) { setError('Feed URL is required'); return; }
    setSaving(true);
    setError('');

    if (editId) {
      const res = await adminUpdateFeedSource(editId, {
        name: name.trim(),
        feed_url: feedUrl.trim(),
        feed_type: feedType,
        poll_interval_hours: pollInterval,
        default_location: defaultLocation.trim() || undefined,
        default_timezone: defaultTimezone,
        notes: notes.trim() || undefined,
      });
      if (res.error) { setError(res.error.message); setSaving(false); return; }
    } else {
      const res = await adminCreateFeedSource({
        name: name.trim(),
        feed_url: feedUrl.trim(),
        feed_type: feedType,
        poll_interval_hours: pollInterval,
        default_location: defaultLocation.trim() || undefined,
        default_timezone: defaultTimezone,
        notes: notes.trim() || undefined,
      });
      if (res.error) { setError(res.error.message); setSaving(false); return; }
    }

    setSaving(false);
    resetForm();
    load();
  }

  async function toggleStatus(source: FeedSource) {
    const newStatus = source.status === 'active' ? 'paused' : 'active';
    await adminUpdateFeedSource(source.id, { status: newStatus });
    load();
  }

  async function handlePoll(source: FeedSource) {
    setPollingId(source.id);
    setPollResult(null);
    const res = await adminPollFeedSource(source.id);
    setPollingId(null);
    if (res.error) {
      setPollResult(`Error: ${res.error.message}`);
    } else {
      const d = res.data;
      const count = d?.result?.candidateCount ?? 0;
      setPollResult(`Polled successfully: ${count} new candidate${count !== 1 ? 's' : ''}`);
      load();
    }
    setTimeout(() => setPollResult(null), 5000);
  }

  function formatDate(d: string | null) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  const resultColor = (r: string | null) => {
    if (!r) return colors.muted;
    if (r === 'success') return '#2e7d32';
    if (r === 'failed') return '#c62828';
    return '#e65100';
  };

  return (
    <div>
      {pollResult && (
        <div style={{
          position: 'fixed', top: 16, right: 16, padding: '10px 20px', borderRadius: 10,
          background: pollResult.startsWith('Error') ? '#ffebee' : '#e8f5e9',
          color: pollResult.startsWith('Error') ? '#c62828' : '#2e7d32',
          fontSize: 14, fontWeight: 500, zIndex: 1000, boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
        }}>
          {pollResult}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Feed Sources</h2>
        <button
          onClick={() => { resetForm(); setShowForm(true); }}
          style={{
            padding: '8px 16px', fontSize: 13, borderRadius: 8, border: 'none',
            background: colors.accent, color: 'white', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600,
          }}
        >
          + Add Feed
        </button>
      </div>

      {showForm && (
        <div style={{
          padding: 20, borderRadius: 12, border: `1px solid ${colors.border}`,
          background: colors.bg, marginBottom: 20,
        }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 600 }}>
            {editId ? 'Edit Feed Source' : 'Add Feed Source'}
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 13, marginBottom: 4, fontWeight: 500 }}>Name</label>
                <input
                  value={name} onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. FDR Park Events"
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1px solid ${colors.border}`, fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 13, marginBottom: 4, fontWeight: 500 }}>Type</label>
                <select
                  value={feedType} onChange={(e) => setFeedType(e.target.value)}
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1px solid ${colors.border}`, fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' }}
                >
                  {FEED_TYPES.map((t) => (
                    <option key={t} value={t}>{t === 'agile_ticketing' ? 'Agile Ticketing' : t.toUpperCase()}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 13, marginBottom: 4, fontWeight: 500 }}>Feed URL</label>
              <input
                value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)}
                placeholder="https://example.com/events.ics"
                style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1px solid ${colors.border}`, fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 13, marginBottom: 4, fontWeight: 500 }}>Poll Interval (hours)</label>
                <input
                  type="number" min={1} max={168}
                  value={pollInterval} onChange={(e) => setPollInterval(Number(e.target.value))}
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1px solid ${colors.border}`, fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 13, marginBottom: 4, fontWeight: 500 }}>Default Location</label>
                <input
                  value={defaultLocation} onChange={(e) => setDefaultLocation(e.target.value)}
                  placeholder="Venue name or address"
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1px solid ${colors.border}`, fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 13, marginBottom: 4, fontWeight: 500 }}>Timezone</label>
                <input
                  value={defaultTimezone} onChange={(e) => setDefaultTimezone(e.target.value)}
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1px solid ${colors.border}`, fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' }}
                />
              </div>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 13, marginBottom: 4, fontWeight: 500 }}>Notes</label>
              <textarea
                value={notes} onChange={(e) => setNotes(e.target.value)}
                placeholder="Admin notes..."
                rows={2}
                style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1px solid ${colors.border}`, fontSize: 14, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }}
              />
            </div>
            {error && <p style={{ color: '#c00', fontSize: 13, margin: 0 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleSave} disabled={saving} style={{
                padding: '8px 20px', borderRadius: 8, border: 'none', background: colors.accent,
                color: 'white', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                opacity: saving ? 0.6 : 1,
              }}>
                {saving ? 'Saving...' : editId ? 'Save Changes' : 'Add Feed'}
              </button>
              <button onClick={resetForm} style={{
                padding: '8px 20px', borderRadius: 8, border: `1px solid ${colors.border}`,
                background: 'white', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
              }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <p style={{ color: colors.muted, fontSize: 14 }}>Loading feed sources...</p>
      ) : sources.length === 0 ? (
        <p style={{ color: colors.muted, fontSize: 14 }}>No feed sources yet. Add an iCal, RSS, or Eventbrite feed to start pulling events automatically.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sources.map((source) => (
            <div key={source.id} style={{
              padding: '16px 20px', borderRadius: 12, border: `1px solid ${colors.border}`,
              background: 'white',
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, fontSize: 15 }}>{source.name}</span>
                    <span style={{
                      fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 600,
                      background: source.status === 'active' ? '#e8f5e9' : source.status === 'paused' ? '#fff3e0' : '#f5f5f5',
                      color: source.status === 'active' ? '#2e7d32' : source.status === 'paused' ? '#e65100' : '#666',
                    }}>
                      {source.status}
                    </span>
                    <span style={{
                      fontSize: 11, padding: '2px 8px', borderRadius: 10,
                      background: '#e3f2fd', color: '#1565c0', fontWeight: 500,
                    }}>
                      {source.feed_type === 'agile_ticketing' ? 'Agile Ticketing' : source.feed_type.toUpperCase()}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {source.feed_url}
                  </div>
                  <div style={{ fontSize: 12, color: colors.muted, marginTop: 4, display: 'flex', gap: 12 }}>
                    <span>Every {source.poll_interval_hours}h</span>
                    <span>Last polled: {formatDate(source.last_polled_at)}</span>
                    {source.last_poll_result && (
                      <span style={{ color: resultColor(source.last_poll_result), fontWeight: 500 }}>
                        {source.last_poll_result}
                        {source.last_event_count != null && ` (${source.last_event_count} events)`}
                      </span>
                    )}
                  </div>
                  {source.last_poll_error && (
                    <div style={{ fontSize: 12, color: '#c62828', marginTop: 4 }}>
                      Error: {source.last_poll_error}
                    </div>
                  )}
                  {source.notes && <div style={{ fontSize: 12, color: colors.muted, marginTop: 4 }}>{source.notes}</div>}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={() => handlePoll(source)}
                    disabled={pollingId === source.id}
                    style={{
                      padding: '6px 12px', fontSize: 12, borderRadius: 6, border: `1px solid ${colors.accent}`,
                      background: 'white', color: colors.accent, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500,
                      opacity: pollingId === source.id ? 0.6 : 1,
                    }}
                  >
                    {pollingId === source.id ? 'Polling...' : 'Poll Now'}
                  </button>
                  <button
                    onClick={() => toggleStatus(source)}
                    style={{
                      padding: '6px 12px', fontSize: 12, borderRadius: 6, border: `1px solid ${colors.border}`,
                      background: 'white', cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    {source.status === 'active' ? 'Pause' : 'Activate'}
                  </button>
                  <button
                    onClick={() => startEdit(source)}
                    style={{
                      padding: '6px 12px', fontSize: 12, borderRadius: 6, border: `1px solid ${colors.border}`,
                      background: 'white', cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    Edit
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
