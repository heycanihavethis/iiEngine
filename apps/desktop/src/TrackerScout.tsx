import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { errorMessage } from './api';
import { EngineIcon } from './EngineIcon';
import { trackFeature } from './telemetry';
import { TrackerPaywall } from './TrackerPaywall';
import {
  askTrackerScout,
  formatScoutSeen,
  scoutColorCss,
  type TrackerScoutPlayer,
} from './trackerScoutApi';
import type { Page } from './store';

const DOT_COUNT = 24;

const SCOUT_EXAMPLES = [
  'Who was playing an hour ago?',
  'Find me blue players',
  'Who are some cool people online?',
  'Anyone in ghost troll codes?',
  'Where was Flower last seen?',
  'Who was in room HI around 2pm UTC?',
];

function OrbitDots({ busy }: { busy: boolean }) {
  const dots = Array.from({ length: DOT_COUNT }, (_, index) => {
    const angle = (index / DOT_COUNT) * Math.PI * 2 - Math.PI / 2;
    const x = 50 + Math.cos(angle) * 44;
    const y = 50 + Math.sin(angle) * 44;
    return { x, y, delay: `${(index / DOT_COUNT) * -4.2}s` };
  });
  return (
    <svg
      className={`scout-orbit ${busy ? 'is-busy' : ''}`}
      viewBox="0 0 100 100"
      aria-hidden="true"
    >
      <circle className="scout-orbit-ring" cx="50" cy="50" r="44" />
      <g className="scout-orbit-dots">
        {dots.map((dot, index) => (
          <circle
            key={index}
            className="scout-orbit-dot"
            cx={dot.x}
            cy={dot.y}
            r="1.85"
            style={{ animationDelay: dot.delay }}
          />
        ))}
      </g>
    </svg>
  );
}

function ScoutPlayerPill({ player }: { player: TrackerScoutPlayer }) {
  const colorCss = scoutColorCss(player.color);
  const seen = formatScoutSeen(player.lastSeen);
  return (
    <li
      className={`scout-pill ${colorCss ? 'has-color' : ''}`}
      style={colorCss ? ({ ['--scout-pill-color']: colorCss } as CSSProperties) : undefined}
    >
      <div className="scout-pill-top">
        <strong>{player.username}</strong>
        {seen ? <time dateTime={player.lastSeen}>{seen}</time> : null}
      </div>
      <div className="scout-pill-tags">
        {player.room ? (
          <span className="scout-pill-tag">
            <EngineIcon name="trackerRoom" size={12} />
            {player.room}
          </span>
        ) : null}
        {player.playerId ? (
          <span className="scout-pill-tag" title={player.playerId}>
            <EngineIcon name="trackerId" size={12} />
            {player.playerId.length > 10 ? `${player.playerId.slice(0, 8)}…` : player.playerId}
          </span>
        ) : null}
        {player.color ? (
          <span className="scout-pill-tag">
            <span
              className="scout-pill-swatch"
              style={colorCss ? { background: colorCss } : undefined}
              aria-hidden="true"
            />
            {player.color}
          </span>
        ) : null}
        {player.region ? <span className="scout-pill-tag">{player.region}</span> : null}
        {player.sightings > 1 ? (
          <span className="scout-pill-tag">{player.sightings} hits</span>
        ) : null}
      </div>
    </li>
  );
}

function RotatingPlaceholder({ active, examples }: { active: boolean; examples: string[] }) {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (!active || examples.length < 2) return;
    let fadeTimer = 0;
    const tick = window.setInterval(() => {
      setVisible(false);
      fadeTimer = window.setTimeout(() => {
        setIndex((current) => (current + 1) % examples.length);
        setVisible(true);
      }, 280);
    }, 3200);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(fadeTimer);
    };
  }, [active, examples.length]);

  if (!active) return null;
  return (
    <span className={`scout-placeholder ${visible ? 'is-in' : 'is-out'}`} aria-hidden="true">
      {examples[index]}
    </span>
  );
}

export default function TrackerScout({
  hasIiTracker = false,
  navigate,
}: {
  hasIiTracker?: boolean;
  navigate?: (page: Page) => void;
}) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [players, setPlayers] = useState<TrackerScoutPlayer[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  const [dailyLimit, setDailyLimit] = useState<number | null>(null);
  const [mode, setMode] = useState('');
  const [inputFocused, setInputFocused] = useState(false);
  const coreRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!hasIiTracker) return;
    trackFeature('tracker_scout', 'open');
  }, [hasIiTracker]);

  useLayoutEffect(() => {
    const core = coreRef.current;
    const measure = measureRef.current;
    if (!core || !measure) return;
    const next = Math.min(Math.max(measure.scrollHeight + 8, 72), window.innerHeight * 0.68);
    core.style.setProperty('--scout-core-height', `${next}px`);
  }, [answer, busy, error, question, players]);

  const reset = () => {
    setAnswer('');
    setPlayers([]);
    setError('');
    setMode('');
    setQuestion('');
    setInputFocused(false);
    window.setTimeout(() => inputRef.current?.focus(), 40);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !hasIiTracker) return;
    const text = question.trim();
    if (!text) return;
    setBusy(true);
    setError('');
    setAnswer('');
    setPlayers([]);
    setQuestion('');
    setMode('');
    try {
      const result = await askTrackerScout(text);
      setAnswer(result.answer);
      setPlayers(result.players);
      setMode(result.mode);
      if (typeof result.remaining === 'number') setRemaining(result.remaining);
      if (typeof result.dailyLimit === 'number') setDailyLimit(result.dailyLimit);
      trackFeature('tracker_scout', result.mode === 'search' ? 'search' : 'chat');
    } catch (reason) {
      setError(errorMessage(reason, 'Tracker Scout is unavailable right now.'));
    } finally {
      setBusy(false);
    }
  };

  const showComposer = hasIiTracker && !answer && !busy && !error;
  const showOrbit = showComposer;
  const showPlaceholder = showComposer && !question && !inputFocused;

  if (!hasIiTracker) {
    return (
      <section className="scout-page scout-page-locked" aria-label="Tracker Scout">
        <TrackerPaywall product="scout" navigate={navigate} />
      </section>
    );
  }

  return (
    <section className="scout-page" aria-label="Tracker Scout">
      <header className="scout-brand">
        <h1>
          Tracker Scout <span className="scout-beta">BETA</span>
        </h1>
        <p>
          Ask anything about lobbies from the last ~5 days
          {dailyLimit != null ? ` · ${dailyLimit} Scout prompts/day` : ''}
          {remaining != null ? ` · ${remaining} left today` : ''}
        </p>
      </header>

      <div
        className={`scout-stage ${showOrbit ? 'has-orbit' : 'no-orbit'} ${busy ? 'is-busy' : ''} ${
          answer || error || busy ? 'is-expanded' : ''
        }`}
      >
        {showOrbit ? <OrbitDots busy={false} /> : null}
        <div
          ref={coreRef}
          className={`scout-core ${answer ? 'has-answer' : ''} ${busy ? 'is-thinking' : ''}`}
        >
          <div ref={measureRef} className="scout-core-measure">
            {showComposer ? (
              <form className="scout-form" onSubmit={(event) => void onSubmit(event)}>
                <div className="scout-input-shell">
                  <RotatingPlaceholder active={showPlaceholder} examples={SCOUT_EXAMPLES} />
                  <input
                    ref={inputRef}
                    value={question}
                    maxLength={500}
                    placeholder=""
                    onChange={(event) => setQuestion(event.target.value)}
                    onFocus={() => setInputFocused(true)}
                    onBlur={() => setInputFocused(false)}
                    aria-label="Ask Tracker Scout"
                    autoComplete="off"
                  />
                </div>
                <button type="submit" disabled={!question.trim()} aria-label="Send">
                  Ask
                </button>
              </form>
            ) : null}
            {busy ? (
              <p className="scout-thinking" role="status">
                Scanning indexed sightings…
              </p>
            ) : null}
            {error ? (
              <div className="scout-error" role="alert">
                <div className="scout-scroll-panel">
                  <p>{error}</p>
                </div>
                <button type="button" className="scout-again" onClick={reset}>
                  Try again
                </button>
              </div>
            ) : null}
            {answer ? (
              <div className="scout-answer-wrap">
                <div className="scout-scroll-panel">
                  <pre className="scout-answer" role="status">
                    {answer}
                  </pre>
                  {players.length > 0 ? (
                    <div className="scout-pills-block">
                      <p className="scout-meta">
                        {players.length} player{players.length === 1 ? '' : 's'} from indexed
                        sightings
                      </p>
                      <ul className="scout-pill-list" aria-label="Matching players">
                        {players.map((player) => (
                          <ScoutPlayerPill key={player.key} player={player} />
                        ))}
                      </ul>
                    </div>
                  ) : mode === 'search' ? (
                    <p className="scout-meta">Pulled from retained lobby sightings</p>
                  ) : null}
                </div>
                <button type="button" className="scout-again" onClick={reset}>
                  Ask again
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
