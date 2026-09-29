import { request, SESSION_AUTH } from './api.ts';
import type { SessionState } from './api.ts';

export type GoogleSignInConfig = { enabled: boolean; client_id?: string };
export type GoogleChallenge = { client_id: string; nonce: string; expires_at: string };
export type GoogleIdentity = {
  initialize: (options: {
    client_id: string;
    nonce: string;
    callback: (response: { credential?: string }) => void;
    auto_select: false;
    ux_mode: 'popup';
  }) => void;
  renderButton: (container: HTMLElement, options: {
    type: 'standard'; theme: 'outline'; size: 'large'; text: 'continue_with'; width: number;
  }) => void;
};

declare global {
  interface Window { google?: { accounts?: { id?: GoogleIdentity } } }
}

export const googleSignInConfig = (signal?: AbortSignal) => request<GoogleSignInConfig>(SESSION_AUTH, '/session/google/config', { cache: 'no-store', signal });
export const googleSignInChallenge = (signal?: AbortSignal) => request<GoogleChallenge>(SESSION_AUTH, '/session/google/challenge', { method: 'POST', signal });
export const completeGoogleSignIn = (credential: string) => request<SessionState>(SESSION_AUTH, '/session/google', { method: 'POST', body: JSON.stringify({ credential }) });

let loading: Promise<GoogleIdentity> | undefined;

// This function is invoked only by an explicit action on the account access page.
// The public demo never loads Google scripts or sends a Google authentication request.
export function loadGoogleIdentityServices(): Promise<GoogleIdentity> {
  const identity = window.google?.accounts?.id;
  if (identity) return Promise.resolve(identity);
  if (loading) return loading;
  loading = new Promise<GoogleIdentity>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    const failed = () => {
      clearTimeout(timeout);
      script.onload = null;
      script.onerror = null;
      script.remove();
      reject(new Error('Google sign-in could not load. Check your connection or browser settings, then retry. You can still use your passphrase.'));
    };
    const timeout = setTimeout(failed, 15000);
    script.onerror = failed;
    script.onload = () => {
      const loaded = window.google?.accounts?.id;
      if (!loaded) { failed(); return; }
      clearTimeout(timeout);
      script.onload = null;
      script.onerror = null;
      resolve(loaded);
    };
    document.head.append(script);
  }).catch(error => { loading = undefined; throw error; });
  return loading;
}
