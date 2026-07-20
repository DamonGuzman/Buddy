import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApprovalApp } from './App';
import '../panel/styles.css';
import './approval.css';

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <ApprovalApp />
    </StrictMode>,
  );
}
