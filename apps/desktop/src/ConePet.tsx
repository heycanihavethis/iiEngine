import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import cone from '../../../packages/brand/cone.svg';
import coneEmber from '../../../packages/brand/cone-ember.svg';
import { usePreferences } from './store';
import { randomConeSaying } from './conePetSayings';

export default function ConePet() {
  const prefs = usePreferences();
  const look = prefs.appearance.conePetLook ?? 'default';
  const custom = prefs.appearance.customIconDataUrl;
  const [line, setLine] = useState('');
  const [blink, setBlink] = useState(false);
  const [lookDir, setLookDir] = useState(0);
  const bubbleTimer = useRef<number | null>(null);

  useEffect(() => {
    const blinkTimer = window.setInterval(
      () => {
        setBlink(true);
        window.setTimeout(() => setBlink(false), 140);
      },
      3200 + Math.random() * 2400,
    );
    const lookTimer = window.setInterval(
      () => {
        setLookDir((Math.random() - 0.5) * 14);
      },
      2600 + Math.random() * 2200,
    );
    return () => {
      window.clearInterval(blinkTimer);
      window.clearInterval(lookTimer);
      if (bubbleTimer.current) window.clearTimeout(bubbleTimer.current);
    };
  }, []);

  const src = look === 'ember' ? coneEmber : look === 'custom' && custom ? custom : cone;

  function speak() {
    const next = randomConeSaying(line);
    setLine(next);
    if (bubbleTimer.current) window.clearTimeout(bubbleTimer.current);
    bubbleTimer.current = window.setTimeout(() => setLine(''), 4200);
  }

  return (
    <div className="cone-pet-root">
      <div className="cone-pet-stage">
        <button
          type="button"
          className="cone-pet-drag"
          aria-label="Drag cone pet"
          onMouseDown={() => {
            if (isTauri()) void invoke('start_dragging_window');
          }}
        />
        <button
          type="button"
          className="cone-pet-body"
          onClick={speak}
          aria-label="Talk to cone pet"
        >
          <img
            src={src}
            alt=""
            className={`cone-pet-img ${blink ? 'blink' : ''}`}
            style={{ transform: `translateX(${lookDir}px) rotate(${lookDir * 0.35}deg)` }}
          />
          {blink && <span className="cone-pet-eyes">— —</span>}
        </button>
        {line && (
          <div className="cone-pet-bubble" role="status">
            {line}
          </div>
        )}
      </div>
    </div>
  );
}
