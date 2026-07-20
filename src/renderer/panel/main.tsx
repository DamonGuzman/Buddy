import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { hasNativeGlass } from '../native-glass-mode';
import './styles.css';

if (hasNativeGlass(window.location.search)) {
  document.documentElement.dataset['nativeGlass'] = 'true';
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
