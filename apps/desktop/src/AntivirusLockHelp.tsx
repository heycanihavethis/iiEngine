import { useState } from 'react';
import { EngineIcon } from './EngineIcon';
import { antivirusLockTitle, openWindowsSecurityThreatSettings } from './antivirusHelp';
import { trackFeature } from './telemetry';
import manageSettingsShot from './assets/av-guide/manage-settings.png';
import realtimeOnShot from './assets/av-guide/realtime-on.png';
import realtimeOffShot from './assets/av-guide/realtime-off.png';

export default function AntivirusLockHelp({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState('');
  const [actionError, setActionError] = useState('');

  async function openSecurity() {
    setBusy(true);
    setActionError('');
    setHint('');
    try {
      const result = await openWindowsSecurityThreatSettings();
      setHint(result);
      trackFeature('av_lock_help', 'open_windows_security');
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="av-lock-help" role="alert">
      <p className="av-lock-help-message">{antivirusLockTitle(message)}</p>
      <p className="av-lock-help-lead">
        Turn off Windows <strong>real-time protection</strong> for a minute, install the menu, then
        turn it back on.
      </p>

      <ol className="av-lock-guide">
        <li className="av-lock-guide-step">
          <div className="av-lock-guide-copy">
            <span className="av-lock-guide-num" aria-hidden="true">
              1
            </span>
            <div>
              <strong>Open Virus &amp; threat protection</strong>
              <p>
                Then click <em>Manage settings</em>.
              </p>
            </div>
          </div>
          <img
            className="av-lock-guide-shot"
            src={manageSettingsShot}
            alt="Virus & threat protection settings with Manage settings highlighted"
            loading="lazy"
            decoding="async"
          />
        </li>
        <li className="av-lock-guide-step">
          <div className="av-lock-guide-copy">
            <span className="av-lock-guide-num" aria-hidden="true">
              2
            </span>
            <div>
              <strong>Turn Real-time protection Off</strong>
              <p>Confirm the Windows prompt if it asks.</p>
            </div>
          </div>
          <div className="av-lock-guide-shots">
            <figure>
              <img
                className="av-lock-guide-shot"
                src={realtimeOnShot}
                alt="Real-time protection toggle currently On"
                loading="lazy"
                decoding="async"
              />
              <figcaption>On</figcaption>
            </figure>
            <span className="av-lock-guide-arrow" aria-hidden="true">
              →
            </span>
            <figure>
              <img
                className="av-lock-guide-shot"
                src={realtimeOffShot}
                alt="Real-time protection toggle set to Off"
                loading="lazy"
                decoding="async"
              />
              <figcaption>Off</figcaption>
            </figure>
          </div>
        </li>
        <li className="av-lock-guide-step">
          <div className="av-lock-guide-copy">
            <span className="av-lock-guide-num" aria-hidden="true">
              3
            </span>
            <div>
              <strong>Retry Install, then turn it back On</strong>
              <p>Windows often turns protection back on by itself after a short time.</p>
            </div>
          </div>
        </li>
      </ol>

      <div className="av-lock-help-actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void openSecurity()}
        >
          <EngineIcon name="shield" size={15} />
          {busy ? 'Opening…' : 'Open Virus & threat protection'}
        </button>
        {onRetry && (
          <button type="button" className="secondary" disabled={busy} onClick={onRetry}>
            <EngineIcon name="refresh" size={15} />
            Retry install
          </button>
        )}
      </div>
      <p className="av-lock-help-note">
        Using a third-party antivirus? Pause real-time / shield protection there instead.
      </p>
      {hint && (
        <p className="av-lock-help-hint" role="status">
          {hint}
        </p>
      )}
      {actionError && (
        <p className="av-lock-help-action-error" role="alert">
          {actionError}
        </p>
      )}
    </div>
  );
}
