import { useState } from 'react';
import { apiRequest, ApiError } from './api';
import { useQueryClient } from '@tanstack/react-query';
import { EngineIcon } from './EngineIcon';
import { DeveloperOperations } from './DeveloperOperations';
import { CustomSelect } from './CustomSelect';
import { usePreferences } from './store';

type Kind = 'announcement' | 'release' | 'source' | 'notice';
type Draft = {
  kind: Kind;
  title: string;
  text: string;
  url: string;
  channel: 'stable' | 'beta' | 'developer';
  version: string;
  sha256: string;
  source_commit: string;
  manifest: string;
};
type Item = Draft & {
  id: string;
  revision: number;
  published_at: string | null;
  updated_at: string;
};
const empty: Draft = {
  kind: 'announcement',
  title: '',
  text: '',
  url: '',
  channel: 'stable',
  version: '',
  sha256: '',
  source_commit: '',
  manifest: '',
};

export default function Developer({
  demo,
  canPlanToggle = false,
  isPro = false,
}: {
  demo: boolean;
  canPlanToggle?: boolean;
  isPro?: boolean;
}) {
  const preferences = usePreferences();
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [draft, setDraft] = useState<Draft>(empty);
  const [selected, setSelected] = useState<Item | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [review, setReview] = useState(false);
  const queries = useQueryClient();
  const request = async (path: string, body?: unknown, key = token) => {
    try {
      return await (
        await apiRequest(
          '/v1/developer/' + path,
          {
            method: body ? 'POST' : 'GET',
            headers: { 'Content-Type': 'application/json', 'X-Developer-Token': key },
            body: body ? JSON.stringify(body) : undefined,
          },
          false,
        )
      ).json();
    } catch (e) {
      if (e instanceof ApiError && /Unlock the developer|Sign in|Session expired/.test(e.message)) {
        setToken('');
        setItems([]);
      }
      throw e;
    }
  };
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };
  const load = async (key = token) => setItems((await request('content', undefined, key)).items);
  const field = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft({ ...draft, [key]: value });
    setReview(false);
  };
  const save = () =>
    perform(async () => {
      const saved: Item = await request(selected ? 'content/' + selected.id : 'content', {
        ...draft,
        expected_revision: selected?.revision ?? 0,
      });
      setSelected(saved);
      setDraft(saved);
      setReview(false);
      await load();
      setMessage('Draft saved. Published content stays unchanged until you publish.');
    });
  const visibility = (publish: boolean) =>
    perform(async () => {
      if (!selected) return;
      const saved: Item = await request('content/' + selected.id + '/visibility', {
        publish,
        expected_revision: selected.revision,
      });
      setSelected(saved);
      setReview(false);
      await load();
      await queries.invalidateQueries({ queryKey: ['managed-content'] });
      setMessage(
        publish
          ? 'Published to this backend. Connected apps refresh automatically.'
          : 'Withdrawn from connected apps. Your draft is preserved.',
      );
    });
  const syncStable = () =>
    perform(async () => {
      const synced: Item = await request('sync-stable', {});
      setSelected(synced);
      setDraft(synced);
      setReview(false);
      await load();
      setMessage(
        `Official stable ${synced.version} is ready as a draft. Review before publishing.`,
      );
    });
  return (
    <section className="developer-panel">
      <div className="panel">
        <h2>
          <EngineIcon name="developer" />
          Developer workspace
        </h2>
        <p>
          Publish tested menu builds, control platform status, and manage member-facing content.
          Every change is recorded in the developer audit log.
        </p>
        {demo && (
          <div className="callout">
            Local sandbox. Changes affect this computer's demo database only.
          </div>
        )}
        {canPlanToggle && (
          <div className="dev-plan-switch panel" aria-label="Plan preview">
            <div>
              <span className="eyebrow">OWNER / ADMIN</span>
              <strong>Preview Free ↔ Pro</strong>
              <p>
                Switch how this PC acts for mods, Studio, and Customize. Doesn't change your Discord
                roles. Just a local preview.
              </p>
            </div>
            <div className="home-plan-switch-controls" role="group" aria-label="Plan preview">
              {(
                [
                  ['auto', 'Auto'],
                  ['free', 'Free'],
                  ['pro', 'Pro'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={preferences.planOverride === value ? 'primary' : ''}
                  aria-pressed={preferences.planOverride === value}
                  onClick={() => preferences.setPlanOverride(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <small className="home-plan-switch-state">
              Active preview: <strong>{isPro ? 'Pro' : 'Free'}</strong>
              {preferences.planOverride === 'auto' ? ' (from Discord entitlements)' : ' (forced)'}
            </small>
          </div>
        )}
        {canPlanToggle && (
          <div className="dev-plan-switch panel" aria-label="Tracker access preview">
            <div>
              <span className="eyebrow">OWNER / ADMIN</span>
              <strong>Tracker product access</strong>
              <p>
                Player Tracker, Target Tracker, and Tracker Scout require the ii Tracker role — not
                Engine Pro. Force them on/off here for local preview without changing Discord.
              </p>
            </div>
            <div className="home-plan-switch-controls" role="group" aria-label="Tracker access">
              {(
                [
                  ['auto', 'Auto'],
                  ['on', 'On'],
                  ['off', 'Off'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={preferences.trackerAccessOverride === value ? 'primary' : ''}
                  aria-pressed={preferences.trackerAccessOverride === value}
                  onClick={() => preferences.setTrackerAccessOverride(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <small className="home-plan-switch-state">
              Tracker pages:{' '}
              <strong>
                {preferences.trackerAccessOverride === 'on'
                  ? 'Forced on'
                  : preferences.trackerAccessOverride === 'off'
                    ? 'Forced off'
                    : 'Auto (ii Tracker role / staff)'}
              </strong>
            </small>
          </div>
        )}
        {!token ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                try {
                  const result = await request('unlock', { password });
                  setToken(result.token);
                  setEnabled(result.publishing_enabled);
                  await load(result.token);
                } finally {
                  setPassword('');
                }
              });
            }}
          >
            <label className="developer-field">
              Developer group password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={16}
                maxLength={256}
              />
            </label>
            <button className="primary" disabled={busy}>
              {busy ? 'Unlocking…' : 'Unlock developer panel'}
            </button>
            <p className="developer-hint">
              Unlock lasts 15 minutes. Online access also requires your Discord admin or owner role.
            </p>
          </form>
        ) : (
          <div className="developer-toolbar">
            <span>
              Unlocked · publishing {enabled ? 'enabled' : 'disabled pending owner review'}
            </span>
            <button
              onClick={() => {
                setToken('');
                setItems([]);
                setSelected(null);
                setDraft(empty);
                setError('');
                setMessage('');
              }}
            >
              Lock panel
            </button>
            <button disabled={busy} onClick={() => void perform(() => load())}>
              Refresh
            </button>
            <button disabled={busy} onClick={() => void syncStable()}>
              Sync latest stable release
            </button>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
        {message && <p role="status">{message}</p>}
      </div>
      {token && (
        <>
          <DeveloperOperations token={token} busy={busy} enabled={enabled} perform={perform} />
          <div className="developer-grid">
            <aside className="panel">
              <button
                onClick={() => {
                  setSelected(null);
                  setDraft(empty);
                  setReview(false);
                }}
              >
                New content
              </button>
              <div className="developer-items">
                {items.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      setSelected(item);
                      setDraft(item);
                      setReview(false);
                      setMessage('');
                    }}
                    aria-pressed={selected?.id === item.id}
                  >
                    <strong>{item.title}</strong>
                    <small>
                      {item.kind} · revision {item.revision} ·{' '}
                      {item.published_at ? 'Published + editable draft' : 'Draft'}
                    </small>
                  </button>
                ))}
              </div>
              {!items.length && <p>No content yet. Create your first announcement.</p>}
            </aside>
            <section className="panel">
              <h2>{selected ? 'Edit content' : 'Create content'}</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <div className="developer-form-row">
                  <label className="developer-field">
                    Type
                    <CustomSelect
                      label="Content type"
                      value={draft.kind}
                      disabled={!!selected}
                      onChange={(value) => field('kind', value as Kind)}
                      options={[
                        { value: 'announcement', label: 'Announcement' },
                        { value: 'release', label: 'Menu release post' },
                        { value: 'source', label: 'Menu source reference' },
                        { value: 'notice', label: 'Service notice' },
                      ]}
                    />
                  </label>
                  <label className="developer-field">
                    Audience
                    <CustomSelect
                      label="Content audience"
                      value={draft.channel}
                      onChange={(value) => field('channel', value as Draft['channel'])}
                      options={[
                        { value: 'stable', label: 'All members' },
                        { value: 'beta', label: 'Beta staff' },
                        { value: 'developer', label: 'Developers / staff' },
                      ]}
                    />
                  </label>
                </div>
                <label className="developer-field">
                  Title
                  <input
                    value={draft.title}
                    maxLength={120}
                    required
                    onChange={(e) => field('title', e.target.value)}
                  />
                </label>
                <label className="developer-field">
                  Message / release notes
                  <textarea
                    value={draft.text}
                    maxLength={6000}
                    rows={6}
                    onChange={(e) => field('text', e.target.value)}
                  />
                </label>
                <label className="developer-field">
                  HTTPS link
                  <input
                    type="url"
                    value={draft.url}
                    onChange={(e) => field('url', e.target.value)}
                    placeholder={
                      draft.kind === 'source'
                        ? 'https://github.com/iireborn/menu/tree/<commit>'
                        : 'https://'
                    }
                  />
                </label>
                {draft.kind === 'release' && (
                  <>
                    <div className="callout">
                      This creates a member-facing release post only. To distribute a DLL, use
                      Publish New Version above; posting here does not change anyone's installed
                      menu.
                    </div>
                    <label className="developer-field">
                      Menu version
                      <input
                        required
                        value={draft.version}
                        placeholder="1.0.3"
                        onChange={(e) => field('version', e.target.value)}
                      />
                    </label>
                    <label className="developer-field">
                      DLL SHA-256
                      <input
                        required
                        value={draft.sha256}
                        minLength={64}
                        maxLength={64}
                        onChange={(e) => field('sha256', e.target.value)}
                      />
                    </label>
                    <label className="developer-field">
                      Signed release manifest (optional for announcement-only posts)
                      <textarea
                        value={draft.manifest}
                        maxLength={16000}
                        rows={7}
                        onChange={(e) => field('manifest', e.target.value)}
                        placeholder="Paste the JSON artifact produced by the maintainer signing workflow"
                      />
                    </label>
                    <p className="developer-hint">
                      A valid signed manifest updates the selected release channel. The backend
                      checks the signature before publishing; the desktop must also verify it before
                      installation. Private signing keys never belong here.
                    </p>
                  </>
                )}
                {draft.kind === 'source' && (
                  <>
                    <p>
                      Reference reviewed source in the official GitHub repository. Compile and test
                      source changes before issuing a menu release.
                    </p>
                    <label className="developer-field">
                      Full source commit SHA
                      <input
                        required
                        minLength={40}
                        maxLength={40}
                        value={draft.source_commit}
                        onChange={(e) => field('source_commit', e.target.value)}
                      />
                    </label>
                  </>
                )}
                <div className="developer-toolbar">
                  <button className="primary" disabled={busy}>
                    Save draft
                  </button>
                  {selected && (
                    <button
                      type="button"
                      disabled={busy || !enabled}
                      onClick={() => setReview(true)}
                    >
                      Review saved draft
                    </button>
                  )}
                </div>
              </form>
              {review && selected && (
                <section className="developer-review" aria-label="Publication review">
                  <h3>{selected.title}</h3>
                  <p>{selected.text}</p>
                  <small>
                    Saved revision {selected.revision} · {selected.channel} · {selected.kind}
                  </small>
                  {selected.url && <p>{selected.url}</p>}
                  <p>
                    Publish this saved revision to{' '}
                    {demo ? 'the local sandbox' : 'connected app users'}?
                  </p>
                  <div className="developer-toolbar">
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => void visibility(true)}
                    >
                      Publish saved revision
                    </button>
                    {selected.published_at && (
                      <button disabled={busy} onClick={() => void visibility(false)}>
                        Withdraw published item
                      </button>
                    )}
                    <button onClick={() => setReview(false)}>Cancel</button>
                  </div>
                </section>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  );
}
