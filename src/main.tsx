import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { PublicAvailabilityPage, readPublicAvailabilitySlugFromPath } from './components/PublicAvailabilityPage';
import { bootstrapWorkspaceUrl } from './lib/workspaceUrl';
import './index.css';

bootstrapWorkspaceUrl();

const publicSlug = readPublicAvailabilitySlugFromPath();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {publicSlug ? <PublicAvailabilityPage slug={publicSlug} /> : <App />}
  </StrictMode>,
);
