import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import PublicDemo from './PublicDemo';
import { ThemeProvider } from './theme';
import './styles.css';
import './workbench.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ThemeProvider>{/^\/demo\/?$/.test(window.location.pathname) ? <PublicDemo /> : <App />}</ThemeProvider></React.StrictMode>,
);
