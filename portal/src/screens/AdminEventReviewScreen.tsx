import { useState, useEffect } from 'react';
import { colors, styles } from '../lib/styles';
import { PORTAL_CATEGORIES, PORTAL_CATEGORY_KEYS } from '../lib/categories';
import { EVENT_TAGS, getTagsForCategory, type EventTag } from '../lib/tags';
import {
  adminFetchEventCandidates,
  adminFetchCandidateDetail,
  adminApproveCandidate,
  adminRejectCandidate,
  adminMarkCandidateDuplicate,
  adminBatchApproveSeries,
  adminFetchStats,
} from '../lib/api';
import type { EventCandidate, PlaceResult, PortalStats } from '../lib/types';
import { PlaceAutocomplete } from '../components/PlaceAutocomplete';
import { CategoryDistribution } from '../components/CategoryDistribution';

interface Props {
  onNavigate: (hash: string) => void;
}

const STATUS_TABS = ['pending', 'approved', 'rejected', 'duplicate'] as const;

const statusColors: Record<string, { bg: string; fg: string }> = {
  pending: { bg: colors.pendingBg, fg: colors.pending },
  approved: { bg: colors.successBg, fg: colors.success },
  rejected: { bg: colors.errorBg, fg: colors.error },
  duplicate: { bg: colors.bg, fg: colors.muted },
};

const inputStyle: React.CSSProperties = {
  ...styles.input,
  padding: '7px 10px',
  fontSize: '13px',
  minHeight: '36px',
};

function confidenceLabel(c: number | null): string {
  if (c == null) return '';
  if (c >= 0.8) return 'High';
  if (c >= 0.5) return 'Medium';
  return 'Low';
}

function confidenceColor(c: number | null): string {
  if (c == null) return colors.muted;
  if (c >= 0.8) return colors.success;
  if (c >= 0.5) return colors.pending;
  return colors.error;
}

function renderEmailBodyWithHighlight(body: string, excerpt: string | null) {
  if (!excerpt) return body;
  const idx = body.toLowerCase().indexOf(excerpt.toLowerCase());
  if (idx === -1) return body;
  return (
    <>
      {body.substring(0, idx)}
      <mark id="excerpt-highlight" style={{ background: colors.pendingBg, padding: '1px 2px', borderRadius: 2 }}>
        {body.substring(idx, idx + excerpt.length)}
      </mark>
      {body.substring(idx + excerpt.length)}
    </>
  );
}

function FieldConfBadge({ field, meta, onClickExcerpt }: {
  field: string;
  meta: { field_confidence: Record<string, number>; excerpts: Record<string, string | null> } | null;
  onClickExcerpt: (excerpt: string) => void;
}) {
  if (!meta) return null;
  const conf = meta.field_confidence[field];
  if (conf == null) return null;

  const excerpt = meta.excerpts[field];
  const pct = Math.round(conf * 100);
  const color = conf >= 0.8 ? colors.success : conf >= 0.5 ? colors.pending : colors.dim;

  return (
    <span
      onClick={(e) => {
        e.stopPropagation();
        if (excerpt) onClickExcerpt(excerpt);
      }}
      title={excerpt ? `Source: "${excerpt}"` : 'No source excerpt'}
      style={{
        fontSize: 10, fontWeight: 600, color, cursor: excerpt ? 'pointer' : 'default',
        marginLeft: 4, opacity: 0.8,
        borderBottom: excerpt ? `1px dotted ${color}` : 'none',
      }}
    >
      {pct}%
    </span>
  );
}

export function AdminEventReviewScreen({ onNavigate: _onNavigate }: Props) {
  void _onNavigate;
  const [candidates, setCandidates] = useState<EventCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<string>('pending');
  const [stats, setStats] = useState<PortalStats | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Source filter
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);

  // Multi-select for series approve
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showSeriesForm, setShowSeriesForm] = useState(false);

  // Edit state for approve-with-edits (single + series shared fields)
  const [editTitle, setEditTitle] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editStartTime, setEditStartTime] = useState('');
  const [editEndTime, setEditEndTime] = useState('');
  const [editVenue, setEditVenue] = useState('');
  const [editAddress, setEditAddress] = useState('');
  const [editCategory, setEditCategory] = useState('community');
  const [editDescription, setEditDescription] = useState('');
  const [editPrice, setEditPrice] = useState('');
  const [editTags, setEditTags] = useState<string[]>([]);
  const [editPlaceId, setEditPlaceId] = useState<string | undefined>();
  const [editLat, setEditLat] = useState<number | undefined>();
  const [editLng, setEditLng] = useState<number | undefined>();
  const [actionLoading, setActionLoading] = useState(false);
  const [sourceEmail, setSourceEmail] = useState<{ subject: string; body_plain: string | null; body_html: string | null; sender_email: string; received_at: string } | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [extractionMeta, setExtractionMeta] = useState<{ field_confidence: Record<string, number>; excerpts: Record<string, string | null> } | null>(null);
  const [highlightExcerpt, setHighlightExcerpt] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const [candidatesRes, statsRes] = await Promise.all([
      adminFetchEventCandidates({ status: activeTab }),
      adminFetchStats(),
    ]);
    if (candidatesRes.data?.candidates) setCandidates(candidatesRes.data.candidates);
    if (statsRes.data?.stats) setStats(statsRes.data.stats);
    setLoading(false);
  }

  useEffect(() => {
    load();
    setSelectedIds(new Set());
    setShowSeriesForm(false);
  }, [activeTab]);

  function handleExcerptClick(excerpt: string) {
    setHighlightExcerpt(excerpt);
    setTimeout(() => {
      const el = document.getElementById('excerpt-highlight');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openSeriesForm() {
    // Pre-fill from the first selected candidate
    const first = candidates.find(c => selectedIds.has(c.id));
    if (first) {
      setEditTitle(first.title);
      setEditStartTime(first.start_time || '');
      setEditEndTime(first.end_time || '');
      setEditVenue(first.location_name || '');
      setEditAddress(first.location_address || '');
      setEditDescription(first.description || '');
      setEditCategory(first.category || 'community');
      setEditTags(Array.isArray(first.tags) ? first.tags : []);
      setEditPrice(first.price || '');
      setEditPlaceId(undefined);
      setEditLat(first.location_lat ?? undefined);
      setEditLng(first.location_lng ?? undefined);
    }
    setShowSeriesForm(true);
    setExpandedId(null);
  }

  async function handleBatchApprove() {
    setActionLoading(true);
    const res = await adminBatchApproveSeries({
      candidate_ids: [...selectedIds],
      title: editTitle,
      description: editDescription || undefined,
      venue_name: editVenue || undefined,
      address: editAddress || undefined,
      place_id: editPlaceId,
      latitude: editLat,
      longitude: editLng,
      category: editCategory,
      tags: editTags.length > 0 ? editTags : undefined,
      start_time: editStartTime || undefined,
      end_time: editEndTime || undefined,
      price: editPrice || undefined,
    });
    setActionLoading(false);
    if (res.error) {
      setToast(`Error: ${res.error.message}`);
    } else {
      setToast(`Series created: ${res.data?.event_count} events published`);
      setSelectedIds(new Set());
      setShowSeriesForm(false);
      load();
    }
  }

  function expand(candidate: EventCandidate) {
    if (expandedId === candidate.id) {
      setExpandedId(null);
      setSourceEmail(null);
      return;
    }
    setExpandedId(candidate.id);
    setShowSeriesForm(false);
    setEditTitle(candidate.title);
    setEditDate(candidate.start_date || '');
    setEditStartTime(candidate.start_time || '');
    setEditEndTime(candidate.end_time || '');
    setEditVenue(candidate.location_name || '');
    setEditAddress(candidate.location_address || '');
    setEditCategory(candidate.category || 'community');
    setEditTags(Array.isArray(candidate.tags) ? candidate.tags : []);
    setEditDescription(candidate.description || '');
    setEditPrice(candidate.price || '');
    setEditPlaceId(undefined);
    setEditLat(candidate.location_lat ?? undefined);
    setEditLng(candidate.location_lng ?? undefined);

    // Fetch source email content and extraction metadata
    setSourceEmail(null);
    setExtractionMeta(null);
    setHighlightExcerpt(null);
    setSourceLoading(true);
    adminFetchCandidateDetail(candidate.id).then((res) => {
      const c = res.data?.candidate;
      if (c?.newsletter_emails && !Array.isArray(c.newsletter_emails)) {
        setSourceEmail(c.newsletter_emails as typeof sourceEmail);
      }
      if (c?.extraction_metadata) {
        setExtractionMeta(c.extraction_metadata as typeof extractionMeta);
      }
      setSourceLoading(false);
    }).catch(() => setSourceLoading(false));
  }

  async function handleApprove(id: string) {
    setActionLoading(true);
    const res = await adminApproveCandidate(id, {
      title: editTitle,
      event_date: editDate || undefined,
      start_time: editStartTime || undefined,
      end_time: editEndTime || undefined,
      venue_name: editVenue || undefined,
      address: editAddress || undefined,
      place_id: editPlaceId,
      latitude: editLat,
      longitude: editLng,
      category: editCategory,
      tags: editTags.length > 0 ? editTags : undefined,
      description: editDescription || undefined,
      price: editPrice || undefined,
    });
    setActionLoading(false);
    if (res.error) {
      setToast(`Error: ${res.error.message}`);
    } else {
      setToast('Event approved and published');
      setExpandedId(null);
      load();
    }
  }

  async function handleReject(id: string) {
    setActionLoading(true);
    const res = await adminRejectCandidate(id);
    setActionLoading(false);
    if (res.error) {
      setToast(`Error: ${res.error.message}`);
    } else {
      setToast('Candidate rejected');
      load();
    }
  }

  async function handleDuplicate(id: string, matchedId?: string | null) {
    setActionLoading(true);
    const res = await adminMarkCandidateDuplicate(id, matchedId || undefined);
    setActionLoading(false);
    if (res.error) {
      setToast(`Error: ${res.error.message}`);
    } else {
      setToast('Marked as duplicate');
      load();
    }
  }

  // Auto-dismiss toast
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  // Keyboard shortcuts: j/k navigate, a approve, r reject, d duplicate, Escape collapse
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Guard: only in pending tab, no input focused, not loading
      if (activeTab !== 'pending') return;
      if (actionLoading) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const visibleCandidates = sourceFilter
        ? candidates.filter(c => (c.newsletter_sources?.name || c.feed_sources?.name) === sourceFilter)
        : candidates;

      if (e.key === 'Escape') {
        setExpandedId(null);
        setSourceEmail(null);
        return;
      }

      if (!expandedId && (e.key === 'j' || e.key === 'k')) {
        // Expand first/last candidate
        if (visibleCandidates.length > 0) {
          const target = e.key === 'j' ? visibleCandidates[0] : visibleCandidates[visibleCandidates.length - 1];
          if (target) expand(target);
        }
        return;
      }

      if (expandedId) {
        const idx = visibleCandidates.findIndex(c => c.id === expandedId);
        if (e.key === 'j' && idx < visibleCandidates.length - 1) {
          const next = visibleCandidates[idx + 1];
          if (next) expand(next);
          return;
        }
        if (e.key === 'k' && idx > 0) {
          const prev = visibleCandidates[idx - 1];
          if (prev) expand(prev);
          return;
        }
        if (e.key === 'a') {
          if (editDate) handleApprove(expandedId);
          return;
        }
        if (e.key === 'r') {
          handleReject(expandedId);
          return;
        }
        if (e.key === 'd') {
          const current = visibleCandidates.find(c => c.id === expandedId);
          if (current?.matched_event_id) handleDuplicate(expandedId, current.matched_event_id);
          return;
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTab, expandedId, candidates, sourceFilter, actionLoading, editDate, editTitle, editStartTime, editEndTime, editVenue, editAddress, editPlaceId, editLat, editLng, editCategory, editTags, editDescription, editPrice]);

  // Compute unique source names
  const sourceNames = Array.from(new Set(
    candidates
      .map(c => c.newsletter_sources?.name || c.feed_sources?.name)
      .filter(Boolean) as string[]
  )).sort();

  // Filter candidates by source
  const filteredCandidates = sourceFilter
    ? candidates.filter(c => (c.newsletter_sources?.name || c.feed_sources?.name) === sourceFilter)
    : candidates;

  const selectedCandidates = candidates.filter(c => selectedIds.has(c.id));
  const selectedDates = selectedCandidates
    .map(c => c.start_date)
    .filter(Boolean)
    .sort() as string[];

  return (
    <div>
      {toast && (
        <div style={{
          position: 'fixed', top: 16, right: 16, padding: '10px 20px', borderRadius: 10,
          background: toast.startsWith('Error') ? colors.errorBg : colors.successBg,
          color: toast.startsWith('Error') ? colors.error : colors.success,
          fontSize: 14, fontWeight: 500, zIndex: 1000, boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
        }}>
          {toast}
        </div>
      )}

      {/* Stats bar */}
      {stats && (
        <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'baseline' }}>
          <span className="tnum" style={{ fontSize: '28px', fontWeight: 700, color: colors.heading }}>
            {stats.total_events}
          </span>
          <span style={{ fontSize: '13px', color: colors.dim, marginRight: '8px' }}>events</span>
          <span className="tnum" style={{ fontSize: '16px', fontWeight: 600, color: colors.accent }}>
            {stats.upcoming_7d}
          </span>
          <span style={{ fontSize: '12px', color: colors.dim, marginRight: '8px' }}>next 7 days</span>
          {Object.entries(stats.provenance)
            .sort(([, a], [, b]) => b - a)
            .map(([method, count]) => (
            <span key={method} style={{
              fontSize: '11px', color: colors.muted, background: colors.card,
              border: `1px solid ${colors.border}`, borderRadius: '100px',
              padding: '2px 8px',
            }}>
              <span className="tnum" style={{ color: colors.heading, marginRight: '3px', fontWeight: 500 }}>{count}</span>
              {method}
            </span>
          ))}
        </div>
      )}

      {/* Category distribution */}
      {stats?.category_distribution && (
        <div style={{ marginBottom: '16px' }}>
          <CategoryDistribution data={stats.category_distribution} total={stats.total_events} compact />
        </div>
      )}

      <h2 style={{ margin: '0 0 20px', fontSize: 20, fontWeight: 600 }}>Review</h2>

      {/* Status tabs + source filter */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {STATUS_TABS.map((tab) => {
          const sc = statusColors[tab] || { bg: '#f5f5f5', fg: '#666' };
          const active = activeTab === tab;
          return (
            <button key={tab} onClick={() => setActiveTab(tab)} style={{
              padding: '6px 16px', fontSize: 13, borderRadius: 20,
              border: active ? `2px solid ${sc.fg}` : `1px solid ${colors.border}`,
              background: active ? sc.bg : colors.card,
              color: active ? sc.fg : colors.muted,
              cursor: 'pointer', fontFamily: 'inherit', fontWeight: active ? 600 : 400,
              textTransform: 'capitalize',
            }}>
              {tab}
            </button>
          );
        })}
        {sourceNames.length > 1 && (
          <>
            <span style={{ width: '1px', height: '20px', background: colors.border, margin: '0 4px' }} />
            <button
              onClick={() => setSourceFilter(null)}
              style={{
                padding: '4px 12px', fontSize: 12, borderRadius: 16,
                border: `1px solid ${!sourceFilter ? colors.accent : colors.border}`,
                background: !sourceFilter ? colors.accentDim : 'transparent',
                color: !sourceFilter ? colors.accent : colors.dim,
                cursor: 'pointer', fontFamily: 'inherit', fontWeight: !sourceFilter ? 600 : 400,
              }}
            >
              All sources
            </button>
            {sourceNames.map(name => (
              <button
                key={name}
                onClick={() => setSourceFilter(sourceFilter === name ? null : name)}
                style={{
                  padding: '4px 12px', fontSize: 12, borderRadius: 16,
                  border: `1px solid ${sourceFilter === name ? colors.accent : colors.border}`,
                  background: sourceFilter === name ? colors.accentDim : 'transparent',
                  color: sourceFilter === name ? colors.accent : colors.dim,
                  cursor: 'pointer', fontFamily: 'inherit', fontWeight: sourceFilter === name ? 600 : 400,
                }}
              >
                {name}
              </button>
            ))}
          </>
        )}
      </div>

      {/* Keyboard shortcut hint */}
      <div style={{ fontSize: 11, color: colors.dim, marginBottom: 16 }}>
        <kbd style={{ padding: '1px 4px', borderRadius: 3, border: `1px solid ${colors.border}`, fontSize: 10 }}>j</kbd>/<kbd style={{ padding: '1px 4px', borderRadius: 3, border: `1px solid ${colors.border}`, fontSize: 10 }}>k</kbd> navigate
        {' '}<kbd style={{ padding: '1px 4px', borderRadius: 3, border: `1px solid ${colors.border}`, fontSize: 10 }}>a</kbd> approve
        {' '}<kbd style={{ padding: '1px 4px', borderRadius: 3, border: `1px solid ${colors.border}`, fontSize: 10 }}>r</kbd> reject
        {' '}<kbd style={{ padding: '1px 4px', borderRadius: 3, border: `1px solid ${colors.border}`, fontSize: 10 }}>d</kbd> duplicate
        {' '}<kbd style={{ padding: '1px 4px', borderRadius: 3, border: `1px solid ${colors.border}`, fontSize: 10 }}>esc</kbd> collapse
      </div>

      {/* Multi-select toolbar */}
      {activeTab === 'pending' && selectedIds.size >= 2 && !showSeriesForm && (
        <div style={{
          padding: '12px 16px', borderRadius: 10, background: colors.accentDim,
          border: `1px solid ${colors.accentBorder}`, marginBottom: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: colors.accent }}>
            {selectedIds.size} candidates selected
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={openSeriesForm} style={{
              padding: '6px 16px', borderRadius: 8, border: 'none',
              background: colors.accent, color: colors.card, cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
            }}>
              Approve as Series
            </button>
            <button onClick={() => setSelectedIds(new Set())} style={{
              padding: '6px 16px', borderRadius: 8, border: `1px solid ${colors.accentBorder}`,
              background: colors.card, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
            }}>
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Series approve form */}
      {showSeriesForm && (
        <div style={{
          padding: 20, borderRadius: 12, border: `2px solid ${colors.accent}`,
          background: colors.card, marginBottom: 20,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              Approve {selectedIds.size} candidates as a recurring series
            </h3>
            <button onClick={() => setShowSeriesForm(false)} style={{
              padding: '4px 12px', borderRadius: 6, border: `1px solid ${colors.border}`,
              background: colors.card, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
            }}>
              Cancel
            </button>
          </div>

          {/* Dates preview */}
          <div style={{
            padding: '10px 14px', borderRadius: 8, background: '#f5f5f5',
            marginBottom: 16, fontSize: 13,
          }}>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>Dates ({selectedDates.length}):</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {selectedDates.map(d => (
                <span key={d} style={{
                  padding: '2px 10px', borderRadius: 12, background: colors.accentDim,
                  color: colors.accent, fontSize: 12, fontWeight: 500,
                }}>
                  {new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                </span>
              ))}
            </div>
          </div>

          {/* Shared fields */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Series Title</label>
              <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Category</label>
              <select value={editCategory} onChange={(e) => setEditCategory(e.target.value)} style={inputStyle}>
                {PORTAL_CATEGORY_KEYS.map((key) => (
                  <option key={key} value={key}>{PORTAL_CATEGORIES[key].label}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Start Time</label>
                <input type="time" value={editStartTime} onChange={(e) => setEditStartTime(e.target.value)} style={inputStyle} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>End Time</label>
                <input type="time" value={editEndTime} onChange={(e) => setEditEndTime(e.target.value)} style={inputStyle} />
              </div>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Price</label>
              <input value={editPrice} onChange={(e) => setEditPrice(e.target.value)} placeholder="Free, $10, etc." style={inputStyle} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Venue</label>
              <PlaceAutocomplete
                value={editVenue}
                onChange={(val) => { setEditVenue(val); if (editPlaceId) { setEditPlaceId(undefined); } }}
                onSelect={(place: PlaceResult) => {
                  setEditVenue(place.name);
                  setEditAddress(place.address || '');
                  setEditPlaceId(place.place_id);
                  setEditLat(place.location?.latitude);
                  setEditLng(place.location?.longitude);
                }}
                placeholder="Search venue..."
                inputStyle={inputStyle}
              />
              {editPlaceId && (
                <div style={{ fontSize: 11, color: colors.success, marginTop: 2 }}>Matched to Google Place</div>
              )}
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Address</label>
              <input value={editAddress} onChange={(e) => setEditAddress(e.target.value)} style={inputStyle} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Description</label>
              <textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} rows={2}
                style={{ ...inputStyle, resize: 'vertical' as const }} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ display: 'block', fontSize: 12, marginBottom: 5, fontWeight: 500 }}>Tags</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {getTagsForCategory(editCategory).map((tag) => {
                  const active = editTags.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => setEditTags(prev => active ? prev.filter(t => t !== tag) : [...prev, tag])}
                      style={{
                        padding: '3px 10px', borderRadius: 12, fontSize: 12, cursor: 'pointer',
                        border: `1px solid ${active ? colors.accent : colors.border}`,
                        background: active ? colors.accentDim : colors.card,
                        color: active ? colors.accent : colors.muted,
                        fontWeight: active ? 600 : 400,
                      }}
                    >
                      {EVENT_TAGS[tag].label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button
              onClick={handleBatchApprove}
              disabled={actionLoading || !editTitle}
              style={{
                padding: '8px 24px', borderRadius: 8, border: 'none',
                background: colors.accent, color: colors.card, cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                opacity: actionLoading || !editTitle ? 0.5 : 1,
              }}
            >
              {actionLoading ? 'Creating series...' : `Approve ${selectedIds.size} as Series`}
            </button>
            <button onClick={() => setShowSeriesForm(false)} style={{
              padding: '8px 20px', borderRadius: 8, border: `1px solid ${colors.border}`,
              background: colors.card, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
            }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p style={{ color: colors.muted, fontSize: 14 }}>Loading candidates...</p>
      ) : filteredCandidates.length === 0 ? (
        <p style={{ color: colors.muted, fontSize: 14 }}>
          No {activeTab} candidates{sourceFilter ? ` from ${sourceFilter}` : ''}.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filteredCandidates.map((c) => {
            const isExpanded = expandedId === c.id;
            const isSelected = selectedIds.has(c.id);
            return (
              <div key={c.id} style={{
                borderRadius: 12,
                border: `1px solid ${isSelected ? colors.accent : isExpanded ? colors.accent : colors.border}`,
                background: isSelected ? '#f5f9ff' : colors.card,
                overflow: 'hidden',
              }}>
                {/* Card header */}
                <div style={{ display: 'flex', alignItems: 'flex-start' }}>
                  {/* Checkbox for multi-select (pending tab only) */}
                  {activeTab === 'pending' && (
                    <div
                      onClick={(e) => { e.stopPropagation(); toggleSelect(c.id); }}
                      style={{
                        padding: '16px 0 16px 14px', cursor: 'pointer',
                        display: 'flex', alignItems: 'flex-start', flexShrink: 0,
                      }}
                    >
                      <div style={{
                        width: 18, height: 18, borderRadius: 4,
                        border: `2px solid ${isSelected ? colors.accent : colors.border}`,
                        background: isSelected ? colors.accent : colors.card,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'all 0.15s',
                      }}>
                        {isSelected && (
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                            <path d="M2.5 6L5 8.5L9.5 3.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </div>
                    </div>
                  )}
                  <button
                    onClick={() => expand(c)}
                    style={{
                      flex: 1, padding: '14px 18px', textAlign: 'left', fontFamily: 'inherit',
                      background: 'none', border: 'none', cursor: 'pointer',
                      paddingLeft: activeTab === 'pending' ? '8px' : '18px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flex: 1, minWidth: 0 }}>
                        {c.candidate_image_url && (
                          <img
                            src={c.candidate_image_url}
                            alt=""
                            style={{
                              width: 56, height: 56, borderRadius: 8, objectFit: 'cover',
                              flexShrink: 0, background: colors.bg,
                            }}
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                          />
                        )}
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{c.title}</div>
                          <div style={{ fontSize: 13, color: colors.muted }}>
                            {c.start_date || 'No date'}
                            {c.start_time && ` at ${c.start_time}`}
                            {c.end_time && `–${c.end_time}`}
                            {c.location_name && ` · ${c.location_name}`}
                            {c.price && ` · ${c.price}`}
                          </div>
                          <div style={{ fontSize: 12, color: colors.muted, marginTop: 4 }}>
                            {(c.newsletter_sources?.name || c.feed_sources?.name) && `Source: ${c.newsletter_sources?.name || c.feed_sources?.name}`}
                            {c.newsletter_emails?.subject && ` · "${c.newsletter_emails.subject}"`}
                          </div>
                          {(() => {
                            const cat = c.category;
                            const tgs = Array.isArray(c.tags) ? c.tags : [];
                            if (!cat && tgs.length === 0) return null;
                            return (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                                {cat && cat !== 'community' && PORTAL_CATEGORIES[cat as keyof typeof PORTAL_CATEGORIES] && (
                                  <span style={{
                                    fontSize: 11, padding: '1px 8px', borderRadius: 10,
                                    background: colors.accentDim, color: colors.accent, fontWeight: 600,
                                  }}>
                                    {PORTAL_CATEGORIES[cat as keyof typeof PORTAL_CATEGORIES].label}
                                  </span>
                                )}
                                {tgs.slice(0, 4).map((tag: string) => (
                                  <span key={tag} style={{
                                    fontSize: 11, padding: '1px 7px', borderRadius: 10,
                                    background: '#f0f0f0', color: '#555',
                                  }}>
                                    {EVENT_TAGS[tag as EventTag]?.label || tag}
                                  </span>
                                ))}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                        {c.confidence != null && (
                          <span style={{ fontSize: 12, fontWeight: 600, color: confidenceColor(c.confidence) }}>
                            {confidenceLabel(c.confidence)} ({Math.round(c.confidence * 100)}%)
                          </span>
                        )}
                        {c.matched_event_id && (
                          <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#f3e5f5', color: '#6a1b9a', fontWeight: 500 }}>
                            Possible duplicate
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                </div>

                {/* Expanded edit/action panel */}
                {isExpanded && (
                  <div style={{ padding: '0 18px 18px', borderTop: `1px solid ${colors.border}` }}>
                    {c.description && (
                      <p style={{ fontSize: 13, color: colors.dim, margin: '12px 0' }}>{c.description}</p>
                    )}
                    {c.source_url && (
                      <p style={{ fontSize: 12, margin: '8px 0' }}>
                        <a href={c.source_url} target="_blank" rel="noopener noreferrer" style={{ color: colors.accent }}>
                          Source link
                        </a>
                      </p>
                    )}

                    {c.candidate_image_url && (
                      <div style={{ margin: '12px 0' }}>
                        <img
                          src={c.candidate_image_url}
                          alt={c.title}
                          style={{
                            maxWidth: '100%', maxHeight: 200, borderRadius: 8, objectFit: 'cover',
                            background: colors.bg,
                          }}
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                        <div style={{ fontSize: 11, color: colors.muted, marginTop: 4 }}>
                          Image from source page (will be re-encoded on approve)
                        </div>
                      </div>
                    )}

                    {/* Source email content */}
                    <div style={{
                      margin: '12px 0', padding: 14, borderRadius: 8, background: colors.bg,
                      border: `1px solid ${colors.border}`,
                    }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: colors.muted, marginBottom: 8 }}>
                        Source Email
                      </div>
                      {sourceLoading ? (
                        <p style={{ fontSize: 13, color: colors.muted, margin: 0 }}>Loading source...</p>
                      ) : sourceEmail ? (
                        <>
                          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 8 }}>
                            From: {sourceEmail.sender_email} &middot; Subject: {sourceEmail.subject}
                          </div>
                          <div
                            id="source-email-body"
                            style={{
                              fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap',
                              maxHeight: 300, overflowY: 'auto', color: colors.text,
                            }}
                          >
                            {renderEmailBodyWithHighlight(sourceEmail.body_plain || '(no plain text body)', highlightExcerpt)}
                          </div>
                        </>
                      ) : (
                        <p style={{ fontSize: 13, color: colors.muted, margin: 0 }}>Source email not available</p>
                      )}
                    </div>

                    {c.matched_event_id && (
                      <div style={{
                        padding: '8px 12px', borderRadius: 8, background: '#f3e5f5', marginBottom: 12, fontSize: 13,
                      }}>
                        Possible duplicate of existing event <code style={{ fontSize: 11 }}>{c.matched_event_id}</code>
                        {c.match_confidence != null && ` (${Math.round(c.match_confidence * 100)}% match)`}
                      </div>
                    )}

                    {activeTab === 'pending' && (
                      <>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
                          <div>
                            <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Title <FieldConfBadge field="title" meta={extractionMeta} onClickExcerpt={handleExcerptClick} /></label>
                            <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} style={inputStyle} />
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Category</label>
                            <select value={editCategory} onChange={(e) => setEditCategory(e.target.value)} style={inputStyle}>
                              {PORTAL_CATEGORY_KEYS.map((key) => (
                                <option key={key} value={key}>{PORTAL_CATEGORIES[key].label}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Date <FieldConfBadge field="date" meta={extractionMeta} onClickExcerpt={handleExcerptClick} /></label>
                            <input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} style={inputStyle} />
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <div style={{ flex: 1 }}>
                              <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Start <FieldConfBadge field="start_time" meta={extractionMeta} onClickExcerpt={handleExcerptClick} /></label>
                              <input type="time" value={editStartTime} onChange={(e) => setEditStartTime(e.target.value)} style={inputStyle} />
                            </div>
                            <div style={{ flex: 1 }}>
                              <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>End <FieldConfBadge field="end_time" meta={extractionMeta} onClickExcerpt={handleExcerptClick} /></label>
                              <input type="time" value={editEndTime} onChange={(e) => setEditEndTime(e.target.value)} style={inputStyle} />
                            </div>
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Venue <FieldConfBadge field="location" meta={extractionMeta} onClickExcerpt={handleExcerptClick} /></label>
                            <PlaceAutocomplete
                              value={editVenue}
                              onChange={(val) => { setEditVenue(val); if (editPlaceId) { setEditPlaceId(undefined); } }}
                              onSelect={(place: PlaceResult) => {
                                setEditVenue(place.name);
                                setEditAddress(place.address || '');
                                setEditPlaceId(place.place_id);
                                setEditLat(place.location?.latitude);
                                setEditLng(place.location?.longitude);
                              }}
                              placeholder="Search venue..."
                              inputStyle={inputStyle}
                            />
                            {editPlaceId && (
                              <div style={{ fontSize: 11, color: colors.success, marginTop: 2 }}>
                                Matched to Google Place
                              </div>
                            )}
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Address</label>
                            <input value={editAddress} onChange={(e) => setEditAddress(e.target.value)} style={inputStyle} />
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Price</label>
                            <input value={editPrice} onChange={(e) => setEditPrice(e.target.value)} placeholder="Free, $10, etc." style={inputStyle} />
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Description <FieldConfBadge field="description" meta={extractionMeta} onClickExcerpt={handleExcerptClick} /></label>
                            <textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} rows={2}
                              style={{ ...inputStyle, resize: 'vertical' as const }} />
                          </div>
                        </div>

                        {/* Tags */}
                        <div style={{ marginTop: 10 }}>
                          <label style={{ display: 'block', fontSize: 12, marginBottom: 5, fontWeight: 500 }}>Tags</label>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {getTagsForCategory(editCategory).map((tag) => {
                              const active = editTags.includes(tag);
                              return (
                                <button
                                  key={tag}
                                  type="button"
                                  onClick={() => setEditTags(prev => active ? prev.filter(t => t !== tag) : [...prev, tag])}
                                  style={{
                                    padding: '3px 10px', borderRadius: 12, fontSize: 12, cursor: 'pointer',
                                    border: `1px solid ${active ? colors.accent : colors.border}`,
                                    background: active ? colors.accentDim : colors.card,
                                    color: active ? colors.accent : colors.muted,
                                    fontWeight: active ? 600 : 400,
                                  }}
                                >
                                  {EVENT_TAGS[tag].label}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                          <button
                            onClick={() => handleApprove(c.id)}
                            disabled={actionLoading || !editDate}
                            style={{
                              padding: '8px 20px', borderRadius: 8, border: 'none',
                              background: colors.success, color: colors.card, cursor: 'pointer',
                              fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                              opacity: actionLoading || !editDate ? 0.5 : 1,
                            }}
                          >
                            {actionLoading ? 'Saving...' : 'Approve & Publish'}
                          </button>
                          <button
                            onClick={() => handleReject(c.id)}
                            disabled={actionLoading}
                            style={{
                              padding: '8px 20px', borderRadius: 8, border: `1px solid ${colors.error}`,
                              background: colors.card, color: colors.error, cursor: 'pointer',
                              fontFamily: 'inherit', fontSize: 13, fontWeight: 500,
                              opacity: actionLoading ? 0.5 : 1,
                            }}
                          >
                            Reject
                          </button>
                          {c.matched_event_id && (
                            <button
                              onClick={() => handleDuplicate(c.id, c.matched_event_id)}
                              disabled={actionLoading}
                              style={{
                                padding: '8px 20px', borderRadius: 8, border: `1px solid #6a1b9a`,
                                background: colors.card, color: '#6a1b9a', cursor: 'pointer',
                                fontFamily: 'inherit', fontSize: 13, fontWeight: 500,
                                opacity: actionLoading ? 0.5 : 1,
                              }}
                            >
                              Mark Duplicate
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
