import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { LegalPage, readLegalPageFromPath } from './components/LegalPages';
import { PublicAvailabilityPage, readPublicAvailabilitySlugFromPath } from './components/PublicAvailabilityPage';
import { bootstrapWorkspaceUrl } from './lib/workspaceUrl';
import './index.css';

bootstrapWorkspaceUrl();

const legalKind = readLegalPageFromPath();
const publicSlug = legalKind ? null : readPublicAvailabilitySlugFromPath();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {legalKind ? (
      <LegalPage kind={legalKind} />
    ) : publicSlug ? (
      <PublicAvailabilityPage slug={publicSlug} />
    ) : (
      <App />
    )}
  </StrictMode>,
);
