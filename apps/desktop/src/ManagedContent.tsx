import { useQuery } from '@tanstack/react-query';
import { apiRequest } from './api';
import { externalClick } from './external';

type Published = {
  id: string;
  kind: string;
  title: string;
  text: string;
  url: string;
  version: string;
  published_at: string;
};
export default function ManagedContent() {
  const query = useQuery({
    queryKey: ['managed-content'],
    queryFn: async () => (await (await apiRequest('/v1/content')).json()) as { items: Published[] },
    refetchInterval: 30000,
  });
  if (query.isPending) {
    return (
      <section className="dashboard-card managed-content">
        <div className="card-heading">
          <h2>From the developers</h2>
          <small>Loading…</small>
        </div>
      </section>
    );
  }
  if (query.isError) {
    return (
      <section className="dashboard-card managed-content">
        <div className="card-heading">
          <h2>From the developers</h2>
          <small>Unavailable</small>
        </div>
        <p className="managed-content-status">App notices are temporarily unavailable.</p>
      </section>
    );
  }
  if (!query.data.items.length) {
    return (
      <section className="dashboard-card managed-content">
        <div className="card-heading">
          <h2>From the developers</h2>
          <small>Featured</small>
        </div>
        <p className="managed-content-status">No featured posts yet. Check back soon.</p>
      </section>
    );
  }
  return (
    <section className="dashboard-card managed-content">
      <div className="card-heading">
        <h2>From the developers</h2>
        <small>Refreshes automatically</small>
      </div>
      {query.data.items.map((item) => (
        <article key={item.id}>
          <small>
            {item.kind} · {new Date(item.published_at).toLocaleDateString()}
          </small>
          <h3>
            {item.title}
            {item.version ? ` · ${item.version}` : ''}
          </h3>
          <p>{item.text}</p>
          {item.url.startsWith('https://') && (
            <a href={item.url} target="_blank" rel="noreferrer" onClick={externalClick(item.url)}>
              {item.kind === 'source' ? 'View source' : 'View details'}
            </a>
          )}
        </article>
      ))}
    </section>
  );
}
