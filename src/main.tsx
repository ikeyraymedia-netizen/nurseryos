import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { LegalPage, readLegalPageFromPath } from './components/LegalPages';
import { PublicAvailabilityPage, readPublicAvailabilitySlugFromPath } from './components/PublicAvailabilityPage';
import { EstimateAcceptPage } from './components/EstimateAcceptPage';
import { readEstimateAcceptTokenFromPath } from './lib/estimateAccept';
import { bootstrapWorkspaceUrl } from './lib/workspaceUrl';
import './index.css';

bootstrapWorkspaceUrl();

const legalKind = readLegalPageFromPath();
const estimateAcceptToken = legalKind ? null : readEstimateAcceptTokenFromPath();
const publicSlug =
  legalKind || estimateAcceptToken ? null : readPublicAvailabilitySlugFromPath();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {legalKind ? (
      <LegalPage kind={legalKind} />
    ) : estimateAcceptToken ? (
      <EstimateAcceptPage token={estimateAcceptToken} />
    ) : publicSlug ? (
      <PublicAvailabilityPage slug={publicSlug} />
    ) : (
      <App />
    )}
  </StrictMode>,
);
