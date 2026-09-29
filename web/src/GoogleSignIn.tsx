import { useEffect, useRef, useState } from 'react';
import type { SessionState } from './api';
import { completeGoogleSignIn, googleSignInChallenge, googleSignInConfig, loadGoogleIdentityServices } from './google-auth';
import type { GoogleSignInConfig } from './google-auth';

type Phase = 'checking' | 'disabled' | 'available' | 'preparing' | 'ready' | 'verifying' | 'error';
type Props = {
  busy: boolean;
  onBegin: () => boolean;
  onEnd: () => void;
  onReady: (state: SessionState) => void;
};

export default function GoogleSignIn({ busy, onBegin, onEnd, onReady }: Props) {
  const [config, setConfig] = useState<GoogleSignInConfig | null>(null);
  const [phase, setPhase] = useState<Phase>('checking');
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const active = useRef(false);
  const verifying = useRef(false);
  const preparing = useRef(false);
  const expiry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);
  const props = useRef({ busy, onBegin, onEnd, onReady });
  props.current = { busy, onBegin, onEnd, onReady };

  function invalidate() {
    generation.current++;
    preparing.current = false;
    abort.current?.abort();
    abort.current = null;
    clearTimeout(expiry.current);
    container.current?.replaceChildren();
  }

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    let current = true;
    setPhase('checking'); setError(''); setConfig(null);
    googleSignInConfig(controller.signal).then(value => {
      if (!current) return;
      setConfig(value);
      setPhase(value.enabled && value.client_id ? 'available' : 'disabled');
    }).catch(() => {
      if (!current) return;
      setError('Google sign-in availability could not be checked. Your passphrase still works.');
      setPhase('error');
    });
    return () => { current = false; active.current = false; controller.abort(); invalidate(); };
  }, [reload]);

  useEffect(() => {
    if (busy && !verifying.current) {
      invalidate();
      if (config?.enabled && config.client_id) { setPhase('available'); setError(''); }
    }
  }, [busy, config]);

  async function prepare() {
    if (!active.current || props.current.busy || preparing.current || verifying.current || !config?.enabled || !config.client_id) return;
    invalidate();
    preparing.current = true;
    const attempt = generation.current;
    const current = () => active.current && generation.current === attempt;
    const controller = new AbortController();
    abort.current = controller;
    setError(''); setPhase('preparing');
    try {
      const identity = await loadGoogleIdentityServices();
      if (!current() || props.current.busy) return;
      const challenge = await googleSignInChallenge(controller.signal);
      if (!current() || props.current.busy) return;
      const remaining = Date.parse(challenge.expires_at) - Date.now();
      if (challenge.client_id !== config.client_id || !challenge.nonce || !Number.isFinite(remaining) || remaining <= 0) {
        throw new Error('Google sign-in needs a fresh challenge. Refresh this page and try again.');
      }
      let consumed = false;
      identity.initialize({
        client_id: challenge.client_id, nonce: challenge.nonce, auto_select: false, ux_mode: 'popup',
        callback: response => {
          if (!current() || consumed || props.current.busy || !response.credential) return;
          // One synchronous lock protects both password and Google POSTs. Ignoring
          // a late UI response alone would not prevent a racing session cookie.
          if (!props.current.onBegin()) return;
          consumed = true; verifying.current = true;
          clearTimeout(expiry.current);
          container.current?.replaceChildren();
          setPhase('verifying'); setError('');
          void completeGoogleSignIn(response.credential).then(state => {
            if (current()) props.current.onReady(state);
          }).catch(failure => {
            if (current()) { setError(failure instanceof Error ? failure.message : 'Google sign-in failed. Please retry.'); setPhase('error'); }
          }).finally(() => {
            verifying.current = false;
            if (current()) props.current.onEnd();
          });
        },
      });
      if (!container.current) return;
      identity.renderButton(container.current, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', width: Math.max(200, Math.min(400, Math.floor(container.current.parentElement?.clientWidth ?? 300))) });
      setPhase('ready');
      expiry.current = setTimeout(() => {
        if (!current() || consumed) return;
        invalidate(); setPhase('error'); setError('Google sign-in expired. Start again for a fresh sign-in.');
      }, remaining);
    } catch (failure) {
      if (current()) { setError(failure instanceof Error ? failure.message : 'Google sign-in is unavailable. Please retry.'); setPhase('error'); }
    } finally { if (current()) preparing.current = false; }
  }

  return <section className="onboarding-google" aria-label="Google account access" aria-busy={phase === 'preparing' || phase === 'verifying'}>
    <div className="onboarding-divider"><span>or</span></div>
    {phase === 'checking' && <p className="onboarding-google-status" role="status">Checking Google sign-in availability...</p>}
    {phase === 'disabled' && <p className="onboarding-google-status">Google sign-in is not configured for this installation.</p>}
    {phase === 'available' && <button className="button secondary full" type="button" disabled={busy} onClick={() => void prepare()}>Load Google sign-in</button>}
    {phase === 'preparing' && <p className="onboarding-google-status" role="status">Preparing Google sign-in...</p>}
    {phase === 'verifying' && <p className="onboarding-google-status" role="status">Verifying Google sign-in...</p>}
    <div ref={container} className="onboarding-google-button" hidden={phase !== 'ready'} />
    {phase === 'ready' && <p className="onboarding-google-status">Popup closed or did not open? <button type="button" className="text-button" disabled={busy} onClick={() => void prepare()}>Refresh Google sign-in</button></p>}
    {error && <><p className="error-message" role="alert">{error}</p><button type="button" className="text-button" disabled={busy} onClick={() => config?.enabled ? void prepare() : setReload(value => value + 1)}>{config?.enabled ? 'Try Google again' : 'Check Google availability'}</button></>}
  </section>;
}
