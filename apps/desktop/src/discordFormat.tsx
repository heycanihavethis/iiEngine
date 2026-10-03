import type { ReactNode } from 'react';
import { externalClick } from './external';

type Mentions = Record<string, string>;

const TOKEN =
  /(```[\s\S]*?```|`[^`\n]+`|\|\|[\s\S]*?\|\||\*\*\*[^*\n]+?\*\*\*|\*\*[^*\n]+?\*\*|__[^_\n]+?__|~~[^~\n]+?~~|\*[^*\n]+?\*|_[^_\n]+?_|https:\/\/[^\s]+|<@!?\d{15,20}>|<@&\d{15,20}>|<#\d{15,20}>)/g;

function Spoiler({ children }: { children: ReactNode }) {
  return (
    <span
      className="discord-spoiler"
      tabIndex={0}
      role="button"
      aria-label="Spoiler — click to reveal"
    >
      <span className="discord-spoiler-inner">{children}</span>
    </span>
  );
}

function formatInline(text: string, mentions: Mentions, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  const pattern = new RegExp(TOKEN.source, 'g');
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (token.startsWith('```') && token.endsWith('```')) {
      const body = token.slice(3, -3).replace(/^\w*\n/, '');
      nodes.push(
        <pre className="discord-code-block" key={key}>
          <code>{body}</code>
        </pre>,
      );
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code className="discord-inline-code" key={key}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('||') && token.endsWith('||')) {
      nodes.push(
        <Spoiler key={key}>{formatInline(token.slice(2, -2), mentions, `${key}-s`)}</Spoiler>,
      );
    } else if (token.startsWith('***') && token.endsWith('***')) {
      nodes.push(
        <strong key={key}>
          <em>{formatInline(token.slice(3, -3), mentions, `${key}-bi`)}</em>
        </strong>,
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(
        <strong key={key}>{formatInline(token.slice(2, -2), mentions, `${key}-b`)}</strong>,
      );
    } else if (token.startsWith('__') && token.endsWith('__')) {
      nodes.push(<u key={key}>{formatInline(token.slice(2, -2), mentions, `${key}-u`)}</u>);
    } else if (token.startsWith('~~') && token.endsWith('~~')) {
      nodes.push(<s key={key}>{formatInline(token.slice(2, -2), mentions, `${key}-t`)}</s>);
    } else if (
      (token.startsWith('*') && token.endsWith('*') && token.length > 2) ||
      (token.startsWith('_') && token.endsWith('_') && token.length > 2 && !token.startsWith('__'))
    ) {
      nodes.push(<em key={key}>{formatInline(token.slice(1, -1), mentions, `${key}-i`)}</em>);
    } else if (/^https:\/\//.test(token)) {
      const href = token.replace(/[),.;!?]+$/, '');
      const suffix = token.slice(href.length);
      nodes.push(
        <span key={key}>
          <a href={href} onClick={externalClick(href)}>
            {href}
          </a>
          {suffix}
        </span>,
      );
    } else if (/^<[@#]/.test(token)) {
      const fallback = token.startsWith('<#')
        ? '#channel'
        : token.startsWith('<@&')
          ? '@role'
          : '@member';
      nodes.push(
        <span className="discord-mention" key={key}>
          {mentions[token] ?? fallback}
        </span>,
      );
    } else {
      nodes.push(token);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function headingLevel(line: string): { level: number; rest: string } | null {
  const match = /^(#{1,3})\s+(.+)$/.exec(line);
  if (!match) return null;
  return { level: match[1].length, rest: match[2] };
}

export function DiscordFormattedText({
  text,
  mentions = {},
  className = 'announcement-text',
}: {
  text: string;
  mentions?: Mentions;
  className?: string;
}) {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let key = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const chunk = paragraph.join('\n');
    paragraph = [];
    blocks.push(
      <p className={className} key={`p-${key++}`}>
        {formatInline(chunk, mentions, `p${key}`)}
      </p>,
    );
  };

  for (const line of lines) {
    const heading = headingLevel(line.trimEnd());
    if (heading) {
      flushParagraph();
      const Tag = `h${Math.min(heading.level + 2, 5)}` as 'h3' | 'h4' | 'h5';
      blocks.push(
        <Tag className={`discord-heading discord-h${heading.level}`} key={`h-${key++}`}>
          {formatInline(heading.rest, mentions, `h${key}`)}
        </Tag>,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushParagraph();
      blocks.push(
        <blockquote className="discord-quote" key={`q-${key++}`}>
          {formatInline(line.replace(/^>\s?/, ''), mentions, `q${key}`)}
        </blockquote>,
      );
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();

  if (!blocks.length) {
    return <p className={className}>{formatInline(text, mentions, 'empty')}</p>;
  }

  return <div className="discord-formatted">{blocks}</div>;
}
