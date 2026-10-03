import { useEffect, useState } from 'react';
import { Gift, Loader2 } from 'lucide-react';
import { apiRequest, errorMessage } from './api';

type InviteStatus = {
  code: string | null;
  code_hint: string | null;
  authorized_count: number;
  required: number;
  completed: boolean;
  invitee_trial_days: number;
  inviter_trial_days: number;
};

export default function InviteSettings({ demo }: { demo: boolean }) {
  const [status, setStatus] = useState<InviteStatus | null>(null);
  const [createdCode, setCreatedCode] = useState('');
  const [redeemCode, setRedeemCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function refresh() {
    if (demo) {
      setStatus({
        code: null,
        code_hint: null,
        authorized_count: 0,
        required: 4,
        completed: false,
        invitee_trial_days: 1,
        inviter_trial_days: 5,
      });
      return;
    }
    const response = await apiRequest('/v1/invites/mine');
    const payload = (await response.json()) as InviteStatus;
    setStatus(payload);
    if (payload.code) setCreatedCode(payload.code);
  }

  useEffect(() => {
    void refresh().catch((reason) =>
      setError(errorMessage(reason, 'Could not load invite status.')),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo]);

  async function createCode() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (demo) {
        setCreatedCode('IIDEMO01');
        setNotice('Invite code created. Share it with the person who should redeem it.');
        setStatus((current) =>
          current
            ? { ...current, code: 'IIDEMO01', code_hint: 'IIDE…', authorized_count: 0 }
            : current,
        );
        return;
      }
      const response = await apiRequest('/v1/invites/mine', { method: 'POST' });
      const payload = (await response.json()) as InviteStatus;
      setStatus(payload);
      setCreatedCode(payload.code ?? '');
      setNotice('Invite code saved on ii Engine. You can reopen it here anytime.');
    } catch (reason) {
      setError(errorMessage(reason, 'Could not create an invite code.'));
    } finally {
      setBusy(false);
    }
  }

  async function redeem() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (demo) {
        setNotice('Invite redeemed. Sign in with Discord if Engine asks you to.');
        return;
      }
      const response = await apiRequest('/v1/invites/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: redeemCode.trim() }),
      });
      const payload = (await response.json()) as { message?: string };
      setNotice(payload.message || 'Invite redeemed.');
      setRedeemCode('');
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason, 'Could not redeem that invite.'));
    } finally {
      setBusy(false);
    }
  }

  const shownCode = createdCode || status?.code || '';

  return (
    <div className="invite-settings">
      <h3>
        <Gift size={16} /> Invite friends (one-time)
      </h3>
      <p>
        Invite 4 people who download ii Engine and authorize Discord. When all 4 finish, they each
        get Pro for {status?.invitee_trial_days ?? 1} day and you get Pro for{' '}
        {status?.inviter_trial_days ?? 5} days. This deal can only be completed once.
      </p>
      {status && (
        <p className="customize-note" role="status">
          Progress: {status.authorized_count}/{status.required}
          {status.completed ? ' · Complete' : ''}
          {status.code_hint && !shownCode ? ` · Your code ${status.code_hint}` : ''}
        </p>
      )}
      {shownCode && (
        <p className="invite-code-reveal">
          Your invite code: <code>{shownCode}</code>
        </p>
      )}
      <div className="invite-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || status?.completed || Boolean(status?.code_hint || shownCode)}
          onClick={() => void createCode()}
        >
          {busy ? <Loader2 size={14} className="spin" /> : null}
          {status?.code_hint || shownCode ? 'Code already created' : 'Create invite code'}
        </button>
      </div>
      <label>
        Redeem an invite code
        <input
          value={redeemCode}
          maxLength={32}
          placeholder="Paste a friend’s code"
          onChange={(event) => setRedeemCode(event.target.value.toUpperCase())}
        />
      </label>
      <button
        type="button"
        disabled={busy || redeemCode.trim().length < 6}
        onClick={() => void redeem()}
      >
        Redeem invite
      </button>
      {notice && (
        <p className="customize-note" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="inline-alert error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
