import type { ReactNode } from 'react';

export default function PageHero({
  title,
  subtitle,
  children,
  compact = false,
  className = '',
  label,
  kicker = 'II ENGINE',
  words = [],
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  compact?: boolean;
  className?: string;
  label?: string;
  kicker?: string;
  words?: string[];
}) {
  return (
    <header
      className={`premium-hero ${compact ? 'compact' : ''} ${className}`.trim()}
      aria-label={label || 'Page header'}
    >
      <div className="premium-hero-glow" aria-hidden="true" />
      <div className="premium-hero-streak" aria-hidden="true" />
      <div className="premium-hero-shards" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="premium-hero-main">
        {kicker && <p className="premium-hero-kicker">{kicker}</p>}
        {title && <h1 className="premium-hero-title">{title}</h1>}
        {subtitle && <p className="premium-hero-subtitle">{subtitle}</p>}
        {children}
      </div>
      {words.length > 0 && (
        <div className="premium-hero-words" aria-hidden="true">
          {words.map((word) => (
            <span key={word}>{word}</span>
          ))}
          <i className="premium-hero-rule" />
        </div>
      )}
    </header>
  );
}
