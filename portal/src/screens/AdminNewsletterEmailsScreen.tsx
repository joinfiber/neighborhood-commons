import { useState, useEffect } from 'react';
import { colors } from '../lib/styles';
import {
  adminFetchNewsletterEmails,
  adminFetchNewsletterEmail,
  adminFetchNewsletterSources,
} from '../lib/api';
import type { NewsletterEmail, NewsletterSource, EventCandidate } from '../lib/types';

interface Props {
  emailId?: string;
  onNavigate: (hash: string) => void;
  onBack: () => void;
}

const statusColors: Record<string, { bg: string; fg: string }> = {
  pending: { bg: '#fff3e0', fg: '#e65100' },
  processing: { bg: '#e3f2fd', fg: '#1565c0' },
  completed: { bg: '#e8f5e9', fg: '#2e7d32' },
  failed: { bg: '#ffebee', fg: '#c62828' },
};

function StatusBadge({ status }: { status: string }) {
  const c = statusColors[status] || { bg: '#f5f5f5', fg: '#666' };
  return (
    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 600, background: c.bg, color: c.fg }}>
      {status}
    </span>
  );
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function AdminNewsletterEmailsScreen({ emailId, onNavigate, onBack }: Props) {
  const [emails, setEmails] = useState<NewsletterEmail[]>([]);
  const [sources, setSources] = useState<NewsletterSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterSource, setFilterSource] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  // Detail view state
  const [detailEmail, setDetailEmail] = useState<NewsletterEmail | null>(null);
  const [detailCandidates, setDetailCandidates] = useState<EventCandidate[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  async function loadList() {
    setLoading(true);
    const [emailRes, sourceRes] = await Promise.all([
      adminFetchNewsletterEmails({
        source_id: filterSource || undefined,
        status: filterStatus || undefined,
      }),
      adminFetchNewsletterSources(),
    ]);
    if (emailRes.data?.emails) setEmails(emailRes.data.emails);
    if (sourceRes.data?.sources) setSources(sourceRes.data.sources);
    setLoading(false);
  }

  async function loadDetail(id: string) {
    setDetailLoading(true);
    const res = await adminFetchNewsletterEmail(id);
    if (res.data) {
      setDetailEmail(res.data.email);
      setDetailCandidates(res.data.candidates);
    }
    setDetailLoading(false);
  }

  useEffect(() => {
    if (emailId) {
      loadDetail(emailId);
    } else {
      loadList();
    }
  }, [emailId, filterSource, filterStatus]);

  // Detail view
  if (emailId || detailEmail) {
    if (detailLoading) return <p style={{ color: colors.muted }}>Loading email...</p>;
    if (!detailEmail) return <p>Email not found.</p>;

    return (
      <div>
        <button onClick={onBack} style={{
          background: 'none', border: 'none', cursor: 'pointer', fontSize: 14,
          color: colors.accent, fontFamily: 'inherit', padding: 0, marginBottom: 16,
        }}>
          &larr; Back to emails
        </button>

        <div style={{ marginBottom: 24 }}>
          <h2 style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 600 }}>{detailEmail.subject}</h2>
          <div style={{ fontSize: 13, color: colors.muted, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <span>From: {detailEmail.sender_email}</span>
            <span>Received: {formatDate(detailEmail.received_at)}</span>
            <StatusBadge status={detailEmail.processing_status} />
            {detailEmail.candidate_count != null && <span>{detailEmail.candidate_count} events extracted</span>}
          </div>
          {detailEmail.processing_error && (
            <p style={{ color: '#c00', fontSize: 13, marginTop: 8 }}>Error: {detailEmail.processing_error}</p>
          )}
        </div>

        {detailCandidates.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Extracted Events ({detailCandidates.length})</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {detailCandidates.map((c) => (
                <div key={c.id} style={{
                  padding: '12px 16px', borderRadius: 10, border: `1px solid ${colors.border}`, background: 'white',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{c.title}</span>
                    <StatusBadge status={c.status} />
                  </div>
                  <div style={{ fontSize: 13, color: colors.muted, marginTop: 4 }}>
                    {c.start_date || 'No date'} {c.start_time ? `at ${c.start_time}` : ''}
                    {c.location_name && ` · ${c.location_name}`}
                    {c.confidence != null && ` · ${Math.round(c.confidence * 100)}% confidence`}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {detailEmail.body_html && (
          <div style={{ marginBottom: 24 }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Email Body</h3>
            <div style={{
              padding: 16, borderRadius: 10, border: `1px solid ${colors.border}`,
              background: 'white', maxHeight: 500, overflow: 'auto', fontSize: 13,
            }}>
              <div dangerouslySetInnerHTML={{ __html: detailEmail.body_html }} />
            </div>
          </div>
        )}
      </div>
    );
  }

  // List view
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Inbound Emails</h2>
        <button onClick={() => onNavigate('#/admin/newsletters')} style={{
          padding: '8px 16px', fontSize: 13, borderRadius: 8, border: `1px solid ${colors.border}`,
          background: 'white', cursor: 'pointer', fontFamily: 'inherit',
        }}>
          &larr; Sources
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <select
          value={filterSource}
          onChange={(e) => setFilterSource(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${colors.border}`, fontSize: 13, fontFamily: 'inherit' }}
        >
          <option value="">All sources</option>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${colors.border}`, fontSize: 13, fontFamily: 'inherit' }}
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="processing">Processing</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      {loading ? (
        <p style={{ color: colors.muted, fontSize: 14 }}>Loading emails...</p>
      ) : emails.length === 0 ? (
        <p style={{ color: colors.muted, fontSize: 14 }}>No inbound emails yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {emails.map((email) => (
            <button
              key={email.id}
              onClick={() => onNavigate(`#/admin/newsletters/emails/${email.id}`)}
              style={{
                padding: '14px 18px', borderRadius: 10, border: `1px solid ${colors.border}`,
                background: 'white', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                display: 'flex', alignItems: 'center', gap: 12, width: '100%',
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{email.subject}</div>
                <div style={{ fontSize: 13, color: colors.muted }}>
                  {email.sender_email}
                  {email.newsletter_sources?.name && ` · ${email.newsletter_sources.name}`}
                  {' · '}
                  {formatDate(email.received_at)}
                </div>
              </div>
              <StatusBadge status={email.processing_status} />
              {email.candidate_count != null && (
                <span style={{ fontSize: 13, color: colors.muted }}>{email.candidate_count} events</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
