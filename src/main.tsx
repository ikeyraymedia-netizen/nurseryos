import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { bootstrapWorkspaceUrl } from './lib/workspaceUrl';
import './index.css';

// Restore ?tab=/order=/truck= from sessionStorage before AuthGate mounts,
// so a refresh never loses the workspace while Firebase auth is loading.
bootstrapWorkspaceUrl();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
