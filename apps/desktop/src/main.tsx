import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource/teko/600.css';
import './styles.css';
import './ui/system.css';

const params = new URLSearchParams(window.location.search);
const isConePet = params.get('cone-pet') === '1';

const client = new QueryClient({
  defaultOptions: {
    queries: { retry: 2, retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30000) },
  },
});

async function boot() {
  const Root = isConePet ? (await import('./ConePet')).default : (await import('./App')).default;
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={client}>
        <Root />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

void boot();
