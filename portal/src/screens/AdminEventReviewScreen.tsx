import { useState, useEffect } from 'react';
import { colors } from '../lib/styles';
import { PORTAL_CATEGORIES, PORTAL_CATEGORY_KEYS } from '../lib/categories';
import {
  adminFetchEventCandidates,
  adminFetchCandidateDetail,
  adminApproveCandidate,
  adminRejectCandidate,
  adminMarkCandidateDuplicate,
} from '../lib/api';
import type { EventCandidate } from '../lib/types';

interface Props {
  onNavigate: (hash: string) => void;
}

const STATUS_TABS = ['pending', 'approved', 'rejected', 'duplicate'] as const;

const statusColors: Record<string, { bg: string; fg: string }> = {
  pending: { bg: '#fff3e0', fg: '#e65100' },
  approved: { bg: '#e8f5e9', fg: '#2e7d32' },
  rejected: { bg: '#ffebee', fg: '#c62828' },
  duplicate: { bg: '#f3e5f5', fg: '#6a1b9a' },
};

function confidenceLabel(c: number | null): string {
  if (c == null) return '';
  if (c >= 0.8) return 'High';
  if (c >= 0.5) return 'Medium';
  return 'Low';
}

function confidenceColor(c: number | null): string {
  if (c == null) return colors.muted;
  if (c >= 0.8) return '#2e7d32';
  if (c >= 0.5) return '#e65100';
  return '#c62828';
}

function renderEmailBodyWithHighlight(body: string, excerpt: string | null) {
  if (!excerpt) return body;
  const idx = body.toLowerCase().indexOf(excerpt.toLowerCase());
  if (idx === -1) return body;
  return (
    <>
      {body.substring(0, idx)}
      <mark id="excerpt-highlight" style={{ background: '#fff3cd', padding: '1px 2px', borderRadius: 2 }}>
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
  const color = conf >= 0.8 ? '#2e7d32' : conf >= 0.5 ? '#e65100' : '#999';

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

export function AdminEventReviewScreen({ onNavigate }: Props) {
  const [candidates, setCandidates] = useState<EventCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<string>('pending');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Edit state for approve-with-edits
  const [editTitle, setEditTitle] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editStartTime, setEditStartTime] = useState('');
  const [editEndTime, setEditEndTime] = useState('');
  const [editVenue, setEditVenue] = useState('');
  const [editAddress, setEditAddress] = useState('');
  const [editCategory, setEditCategory] = useState('community');
  const [editDescription, setEditDescription] = useState('');
  const [editPrice, setEditPrice] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [sourceEmail, setSourceEmail] = useState<{ subject: string; body_plain: string | null; body_html: string | null; sender_email: string; received_at: string } | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [extractionMeta, setExtractionMeta] = useState<{ field_confidence: Record<string, number>; excerpts: Record<string, string | null> } | null>(null);
  const [highlightExcerpt, setHighlightExcerpt] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const res = await adminFetchEventCandidates({ status: activeTab });
    if (res.data?.candidates) setCandidates(res.data.candidates);
    setLoading(false);
  }

  useEffect(() => { load(); }, [activeTab]);

  function handleExcerptClick(excerpt: string) {
    setHighlightExcerpt(excerpt);
    // Scroll to the highlight after render
    setTimeout(() => {
      const el = document.getElementById('excerpt-highlight');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  }

  function expand(candidate: EventCandidate) {
    if (expandedId === candidate.id) {
      setExpandedId(null);
      setSourceEmail(null);
      return;
    }
    setExpandedId(candidate.id);
    setEditTitle(candidate.title);
    setEditDate(candidate.start_date || '');
    setEditStartTime(candidate.start_time || '');
    setEditEndTime(candidate.end_time || '');
    setEditVenue(candidate.location_name || '');
    setEditAddress(candidate.location_address || '');
    setEditCategory('community');
    setEditDescription(candidate.description || '');
    setEditPrice('');

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
      category: editCategory,
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

  return (
    <div>
      {toast && (
        <div style={{
          position: 'fixed', top: 16, right: 16, padding: '10px 20px', borderRadius: 10,
          background: toast.startsWith('Error') ? '#ffebee' : '#e8f5e9',
          color: toast.startsWith('Error') ? '#c62828' : '#2e7d32',
          fontSize: 14, fontWeight: 500, zIndex: 1000, boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
        }}>
          {toast}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Event Review Queue</h2>
        <button onClick={() => onNavigate('#/admin/newsletters')} style={{
          padding: '8px 16px', fontSize: 13, borderRadius: 8, border: `1px solid ${colors.border}`,
          background: 'white', cursor: 'pointer', fontFamily: 'inherit',
        }}>
          &larr; Sources
        </button>
      </div>

      {/* Status tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
        {STATUS_TABS.map((tab) => {
          const sc = statusColors[tab] || { bg: '#f5f5f5', fg: '#666' };
          const active = activeTab === tab;
          return (
            <button key={tab} onClick={() => setActiveTab(tab)} style={{
              padding: '6px 16px', fontSize: 13, borderRadius: 20,
              border: active ? `2px solid ${sc.fg}` : `1px solid ${colors.border}`,
              background: active ? sc.bg : 'white',
              color: active ? sc.fg : colors.muted,
              cursor: 'pointer', fontFamily: 'inherit', fontWeight: active ? 600 : 400,
              textTransform: 'capitalize',
            }}>
              {tab}
            </button>
          );
        })}
      </div>

      {loading ? (
        <p style={{ color: colors.muted, fontSize: 14 }}>Loading candidates...</p>
      ) : candidates.length === 0 ? (
        <p style={{ color: colors.muted, fontSize: 14 }}>
          No {activeTab} candidates.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {candidates.map((c) => {
            const isExpanded = expandedId === c.id;
            return (
              <div key={c.id} style={{
                borderRadius: 12, border: `1px solid ${isExpanded ? colors.accent : colors.border}`,
                background: 'white', overflow: 'hidden',
              }}>
                {/* Card header */}
                <button
                  onClick={() => expand(c)}
                  style={{
                    width: '100%', padding: '14px 18px', textAlign: 'left', fontFamily: 'inherit',
                    background: 'none', border: 'none', cursor: 'pointer',
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
                        </div>
                        <div style={{ fontSize: 12, color: colors.muted, marginTop: 4 }}>
                          {c.newsletter_sources?.name && `Source: ${c.newsletter_sources.name}`}
                          {c.newsletter_emails?.subject && ` · "${c.newsletter_emails.subject}"`}
                        </div>
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
                            <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
                              style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${colors.border}`, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Category</label>
                            <select value={editCategory} onChange={(e) => setEditCategory(e.target.value)}
                              style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${colors.border}`, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }}>
                              {PORTAL_CATEGORY_KEYS.map((key) => (
                                <option key={key} value={key}>{PORTAL_CATEGORIES[key].label}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Date <FieldConfBadge field="date" meta={extractionMeta} onClickExcerpt={handleExcerptClick} /></label>
                            <input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)}
                              style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${colors.border}`, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <div style={{ flex: 1 }}>
                              <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Start <FieldConfBadge field="start_time" meta={extractionMeta} onClickExcerpt={handleExcerptClick} /></label>
                              <input type="time" value={editStartTime} onChange={(e) => setEditStartTime(e.target.value)}
                                style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${colors.border}`, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                            </div>
                            <div style={{ flex: 1 }}>
                              <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>End <FieldConfBadge field="end_time" meta={extractionMeta} onClickExcerpt={handleExcerptClick} /></label>
                              <input type="time" value={editEndTime} onChange={(e) => setEditEndTime(e.target.value)}
                                style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${colors.border}`, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                            </div>
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Venue <FieldConfBadge field="location" meta={extractionMeta} onClickExcerpt={handleExcerptClick} /></label>
                            <input value={editVenue} onChange={(e) => setEditVenue(e.target.value)}
                              style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${colors.border}`, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Address</label>
                            <input value={editAddress} onChange={(e) => setEditAddress(e.target.value)}
                              style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${colors.border}`, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Price</label>
                            <input value={editPrice} onChange={(e) => setEditPrice(e.target.value)} placeholder="Free, $10, etc."
                              style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${colors.border}`, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }} />
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: 12, marginBottom: 3, fontWeight: 500 }}>Description <FieldConfBadge field="description" meta={extractionMeta} onClickExcerpt={handleExcerptClick} /></label>
                            <textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} rows={2}
                              style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${colors.border}`, fontSize: 13, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }} />
                          </div>
                        </div>

                        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                          <button
                            onClick={() => handleApprove(c.id)}
                            disabled={actionLoading || !editDate}
                            style={{
                              padding: '8px 20px', borderRadius: 8, border: 'none',
                              background: '#2e7d32', color: 'white', cursor: 'pointer',
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
                              padding: '8px 20px', borderRadius: 8, border: `1px solid #c62828`,
                              background: 'white', color: '#c62828', cursor: 'pointer',
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
                                background: 'white', color: '#6a1b9a', cursor: 'pointer',
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
