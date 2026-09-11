import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadViewConfig } from './useFilterText';
import './styles.css';

// Read the view config before the first render, so rows hidden by an
// `--exclude` seed never flash into the table.
loadViewConfig().then((config) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App config={config} />
    </StrictMode>
  );
});
