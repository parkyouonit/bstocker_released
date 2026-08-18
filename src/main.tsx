import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// Cloudflare caches CSS assets for several hours; version the import so UI releases
// cannot mix a new component tree with an older stylesheet.
import './styles.css?v=20260812-robinhood-shadow-1'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
