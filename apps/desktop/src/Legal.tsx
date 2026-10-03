import { useState } from 'react';
import Markdown from 'react-markdown';
import privacy from '../../../docs/privacy-policy.md?raw';
import terms from '../../../docs/terms-of-service.md?raw';
import notices from '../../../docs/third-party-notices.md?raw';
import license from '../../../LICENSE?raw';
import { externalClick } from './external';

const documents = { 'Privacy Policy': privacy, Terms: terms, Licenses: notices };
export default function Legal() {
  const [selected, setSelected] = useState<keyof typeof documents | null>(null);
  return (
    <section aria-label="Legal and source information">
      <h2>Privacy, terms and licenses</h2>
      <div className="filters legal-links">
        {(Object.keys(documents) as (keyof typeof documents)[]).map((name) => (
          <button
            key={name}
            aria-expanded={selected === name}
            onClick={() => setSelected(selected === name ? null : name)}
          >
            {name}
          </button>
        ))}
        <a
          className="button"
          href="https://github.com/iireborn/menu"
          target="_blank"
          rel="noreferrer"
          onClick={externalClick('https://github.com/iireborn/menu')}
        >
          Menu source
        </a>
        <a
          className="button"
          href="https://discord.gg/vVBXUNhKb"
          target="_blank"
          rel="noreferrer"
          onClick={externalClick('https://discord.gg/vVBXUNhKb')}
        >
          Support
        </a>
      </div>
      {selected && (
        <article className="legal-document" aria-label={selected}>
          <Markdown
            skipHtml
            components={{
              a: ({ href, children }) =>
                href?.startsWith('https://') ? (
                  <a href={href} target="_blank" rel="noreferrer" onClick={externalClick(href)}>
                    {children}
                  </a>
                ) : (
                  <span>{children}</span>
                ),
            }}
          >
            {documents[selected]}
          </Markdown>
          {selected === 'Licenses' && (
            <details>
              <summary>Full GPL-3.0 license</summary>
              <pre>{license}</pre>
            </details>
          )}
        </article>
      )}
    </section>
  );
}
