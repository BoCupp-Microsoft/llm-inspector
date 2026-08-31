import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/app.css';

const root = createRoot(document.getElementById('root')!);
const params = new URLSearchParams(location.search);

if (params.has('perf')) {
  // Lazy-load the perf lab so it stays out of the normal app bundle path.
  import('./perf-lab').then(({ PerfLab }) => {
    // No StrictMode here: its intentional double-render/double-effect would distort perf timings
    // and DOM-node counts the lab is trying to measure.
    root.render(<PerfLab />);
  });
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
