import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// Version the stylesheet import so a browser refresh cannot mix release assets.
import './styles.css?v=20260812-robinhood-shadow-1'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
