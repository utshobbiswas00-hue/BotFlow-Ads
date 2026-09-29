import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { initTelegram } from './lib/telegram';
import App from './App';
import './index.css';
import './mono-theme.css';
initTelegram();

/*
 * NOTE: there is deliberately NO <BrowserRouter> here.
 *
 * App renders a <RouterProvider> built from createBrowserRouter (see
 * router.tsx), and a RouterProvider IS a router. Wrapping it in BrowserRouter
 * nests one router inside another, which React Router rejects with the
 * invariant "You cannot render a <Router> inside another <Router>". That
 * throws during the very first render, so #root stays empty and the Mini App
 * shows a blank (black) screen with nothing in the console unless you look.
 *
 * The data router owns history and navigation, so it must be the single
 * top-level router. Keep it that way: add routes to router.tsx, not here.
 */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
