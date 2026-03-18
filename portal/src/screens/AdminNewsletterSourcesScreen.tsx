import { useState, useEffect } from 'react';
import { colors } from '../lib/styles';
import {
  adminFetchNewsletterSources,
  adminCreateNewsletterSource,
  adminUpdateNewsletterSource,
} from '../lib/api';
import type { NewsletterSource } from '../lib/types';

interface Props {
  onNavigate: (hash: string) => void;
}

export function AdminNewsletterSourcesScreen({ onNavigate }: Props) {
  const [sources, setSources] = useState<NewsletterSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [senderEmail, setSenderEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    const res = await adminFetchNewsletterSources();
    if (res.data?.sources) setSources(res.data.sources);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function startEdit(source: NewsletterSource) {
    setEditId(source.id);
    setName(source.name);
    setSenderEmail(source.sender_email || '');
    setNotes(source.notes || '');
    setShowForm(true);
  }

  function resetForm() {
    setEditId(null);
    setName('');
    setSenderEmail('');
    setNotes('');
    setShowForm(false);
    setError('');
  }

  async function handleSave() {
    if (!name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError('');

    if (editId) {
      const res = await adminUpdateNewsletterSource(editId, {
        name: name.trim(),
        sender_email: senderEmail.trim() || null,
        notes: notes.trim() || null,
      } as Partial<NewsletterSource>);
      if (res.error) { setError(res.error.message); setSaving(false); return; }
    } else {
      const res = await adminCreateNewsletterSource({
        name: name.trim(),
        sender_email: senderEmail.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      if (res.error) { setError(res.error.message); setSaving(false); return; }
    }

    setSaving(false);
    resetForm();
    load();
  }

  async function toggleStatus(source: NewsletterSource) {
    const newStatus = source.status === 'active' ? 'paused' : 'active';
    await adminUpdateNewsletterSource(source.id, { status: newStatus } as Partial<NewsletterSource>);
    load();
  }

  function formatDate(d: string | null) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Newsletter Sources</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => onNavigate('#/admin/newsletters/review')}
            style={{
              padding: '8px 16px', fontSize: 13, borderRadius: 8, border: `1px solid ${colors.border}`,
              background: 'white', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            Review Queue
          </button>
          <button
            onClick={() => onNavigate('#/admin/newsletters/emails')}
            style={{
              padding: '8px 16px', fontSize: 13, borderRadius: 8, border: `1px solid ${colors.border}`,
              background: 'white', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            Inbound Emails
          </button>
          <button
            onClick={() => { resetForm(); setShowForm(true); }}
            style={{
              padding: '8px 16px', fontSize: 13, borderRadius: 8, border: 'none',
              background: colors.accent, color: 'white', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600,
            }}
          >
            + Add Source
          </button>
        </div>
      </div>

      {showForm && (
        <div style={{
          padding: 20, borderRadius: 12, border: `1px solid ${colors.border}`,
          background: colors.surfaceLight, marginBottom: 20,
        }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 600 }}>
            {editId ? 'Edit Source' : 'Add Newsletter Source'}
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: 13, marginBottom: 4, fontWeight: 500 }}>Name</label>
              <input
                value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Portland Mercury Events"
                style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1px solid ${colors.border}`, fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 13, marginBottom: 4, fontWeight: 500 }}>Sender Email</label>
              <input
                value={senderEmail} onChange={(e) => setSenderEmail(e.target.value)}
                placeholder="newsletter@example.com"
                style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1px solid ${colors.border}`, fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' }}
              />
              <p style={{ fontSize: 12, color: colors.textMuted, margin: '4px 0 0' }}>Incoming emails from this address will be matched to this source.</p>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 13, marginBottom: 4, fontWeight: 500 }}>Notes</label>
              <textarea
                value={notes} onChange={(e) => setNotes(e.target.value)}
                placeholder="Admin notes about this source..."
                rows={3}
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
                {saving ? 'Saving...' : editId ? 'Save Changes' : 'Add Source'}
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
        <p style={{ color: colors.textMuted, fontSize: 14 }}>Loading sources...</p>
      ) : sources.length === 0 ? (
        <p style={{ color: colors.textMuted, fontSize: 14 }}>No newsletter sources yet. Add one to start ingesting events from email newsletters.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sources.map((source) => (
            <div key={source.id} style={{
              padding: '16px 20px', borderRadius: 12, border: `1px solid ${colors.border}`,
              background: 'white', display: 'flex', alignItems: 'center', gap: 16,
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontWeight: 600, fontSize: 15 }}>{source.name}</span>
                  <span style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 600,
                    background: source.status === 'active' ? '#e8f5e9' : source.status === 'paused' ? '#fff3e0' : '#f5f5f5',
                    color: source.status === 'active' ? '#2e7d32' : source.status === 'paused' ? '#e65100' : '#666',
                  }}>
                    {source.status}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: colors.textMuted }}>
                  {source.sender_email || 'No sender email set'}
                  {' · '}
                  Last received: {formatDate(source.last_received_at)}
                </div>
                {source.notes && <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 4 }}>{source.notes}</div>}
              </div>
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
          ))}
        </div>
      )}
    </div>
  );
}
