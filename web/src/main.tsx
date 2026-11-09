import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './hooks/useAuth';
import { listenForegroundPush } from './lib/messaging';
import { registerServiceWorker } from './lib/sw';
import { initTheme } from './lib/theme';
import { captureInstallPrompt } from './lib/install';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

initTheme();
captureInstallPrompt();
void registerServiceWorker();
void listenForegroundPush();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
