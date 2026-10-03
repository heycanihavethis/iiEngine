import { useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, Bot, Upload } from 'lucide-react';
import { apiRequest, errorMessage } from './api';
import { extractDllStrings } from './dllStrings';
import { reportEngineError, trackFeature, recordAiTranscript } from './telemetry';

export default function AiModChecker({ demo }: { demo: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState('');
  const [disclaimer, setDisclaimer] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  async function analyze(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError('');
    setReport('');
    setDisclaimer('');
    try {
      const extracted = await extractDllStrings(file);
      if (demo) {
        setDisclaimer(
          'AI mod checks are advisory only. They miss obfuscated threats, false-positive, and are not a security guarantee. Do not rely on this alone.',
        );
        setReport(
          [
            '**Functionality Map**',
            '- Features: Sample check. Sign in on desktop for a live scan',
            '- Hooks: n/a',
            '- Targeted game systems/classes: n/a',
            '**Risk Score**',
            '0/100',
            '**Malicious Indicators**',
            '- None in this sample',
            '**Obfuscation & Protection**',
            '- Not evaluated',
            '**Network & External Calls**',
            '- None found',
            '**Final Verdict**',
            'Safe',
            'Sample result. Use the desktop app while signed in for a real check.',
          ].join('\n'),
        );
        trackFeature('health', 'ai_mod_check_demo');
        return;
      }
      const response = await apiRequest('/v1/ai/mod-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          sha256: extracted.sha256,
          strings: extracted.strings,
          share_telemetry: false,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const payload = (await response.json()) as {
        report?: string;
        disclaimer?: string;
      };
      setReport(payload.report || 'No report returned.');
      setDisclaimer(
        payload.disclaimer ||
          'AI mod checks are advisory only and are not always right. Do not rely on them alone.',
      );
      recordAiTranscript(
        'mod_check',
        `DLL ${file.name} sha256=${extracted.sha256}`,
        payload.report || '',
      );
      trackFeature('health', 'ai_mod_check');
    } catch (reason) {
      setError(errorMessage(reason, 'Could not analyze this DLL.'));
      void reportEngineError({
        feature: 'ai_mod_check',
        message: errorMessage(reason, 'Could not analyze this DLL.'),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel ai-mod-checker" aria-label="AI mod checker">
      <div className="ai-mod-checker-head">
        <span className="eyebrow">
          <Bot size={14} aria-hidden /> AI mod checker
        </span>
        <h3>Drop a DLL for an advisory review</h3>
        <p className="disclaimer ai-mod-warning">
          <AlertTriangle size={14} aria-hidden /> This is not something to rely on and is not always
          right. It only looks at extracted strings/metadata. Obfuscated malware can hide. Treat
          every verdict as a hint, not a guarantee.
        </p>
      </div>
      <form className="ai-mod-actions" onSubmit={(event) => void analyze(event)}>
        <label className="file-pick ai-mod-file">
          <Upload size={16} aria-hidden />
          <span>{file ? file.name : 'Choose a .dll to analyze'}</span>
          <input
            ref={inputRef}
            type="file"
            accept=".dll,application/x-msdownload"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <button className="primary ai-mod-run" disabled={busy || !file}>
          {busy ? 'Analyzing…' : 'Run AI check'}
        </button>
      </form>
      {disclaimer && (
        <p className="disclaimer" role="note">
          {disclaimer}
        </p>
      )}
      {report && (
        <pre className="ai-mod-report" role="status">
          {report}
        </pre>
      )}
      {error && (
        <p className="inline-alert error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
