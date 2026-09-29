import { useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { SESSION_AUTH, request } from './api';
import type { SessionState } from './api';
import './onboarding.css';

const errorText = (error: unknown) => error instanceof Error ? error.message : 'The request failed. Please retry.';

function Shell({ step, title, description, appearance, children }: { step: string; title: string; description: string; appearance: ReactNode; children: ReactNode }) {
  return <main className="onboarding-page">
    <header className="onboarding-brand"><span className="onboarding-mark" aria-hidden="true">G</span><span>GRIMOIRE</span><span className="local-tag">LOCAL WORKSPACE</span>{appearance}</header>
    <div className="onboarding-layout">
      <section className="onboarding-intro"><p className="eyebrow">{step}</p><h1>{title}</h1><p>{description}</p><ol className="onboarding-steps" aria-label="Onboarding progress"><li data-current={step.startsWith('STEP 1 ') || undefined}>Handler identity</li><li data-current={step.startsWith('STEP 2 ') || undefined}>Organization</li><li data-current={step.startsWith('STEP 3 ') || undefined}>First Scion</li></ol></section>
      {children}
    </div>
    <footer className="connection-footer">SCION INTAKE <span>Local installation · PostgreSQL-backed</span></footer>
  </main>;
}

export function IdentityAccess({ setupRequired, appearance, onReady }: { setupRequired: boolean; appearance: ReactNode; onReady: (state: SessionState) => void }) {
  const [displayName, setDisplayName] = useState('');
  const [loginName, setLoginName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const state = await request<SessionState>(SESSION_AUTH, setupRequired ? '/setup/owner' : '/session/login', {
        method: 'POST',
        body: JSON.stringify(setupRequired ? { login_name: loginName, display_name: displayName, passphrase } : { login_name: loginName, passphrase }),
      });
      onReady(state);
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  }
  return <Shell step="STEP 1 OF 3 · HANDLER" title={setupRequired ? 'Set up your Handler identity.' : 'Welcome back.'} description={setupRequired ? 'Create the human identity that owns this local installation. No token file is needed.' : 'Sign in to continue with your organizations and Scions.'} appearance={appearance}>
    <form className="onboarding-card" onSubmit={submit}>
      <p className="eyebrow">{setupRequired ? 'ONE-TIME INSTALLATION SETUP' : 'HANDLER SIGN IN'}</p>
      <h2>{setupRequired ? 'Who is the installation owner?' : 'Open Grimoire'}</h2>
      {setupRequired && <><label htmlFor="handler-name">Handler name</label><input id="handler-name" value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={120} required autoFocus placeholder="Your name" /></>}
      <label htmlFor="login-name">Login name</label><input id="login-name" value={loginName} onChange={event => setLoginName(event.target.value)} minLength={3} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{2,63}" required autoFocus={!setupRequired} autoCapitalize="none" autoCorrect="off" placeholder="owner" />
      <label htmlFor="handler-passphrase">Passphrase</label><input id="handler-passphrase" type="password" value={passphrase} onChange={event => setPassphrase(event.target.value)} minLength={12} maxLength={72} required autoComplete={setupRequired ? 'new-password' : 'current-password'} placeholder="12–72 characters" />
      {error && <div className="error-message" role="alert">{error}</div>}
      <button className="button primary full" disabled={busy || !loginName.trim() || passphrase.length < 12 || (setupRequired && !displayName.trim())}>{busy ? 'Continuing…' : setupRequired ? 'Create Handler identity' : 'Sign in'}<span aria-hidden="true">→</span></button>
      <p className="onboarding-boundary">This identity can manage its workspaces. It receives no engineering, commercial, sourcing, or approval authority.</p>
    </form>
  </Shell>;
}

export function OrganizationOnboarding({ session, appearance, allowCancel, onReady, onCancel }: { session: SessionState; appearance: ReactNode; allowCancel: boolean; onReady: (state: SessionState) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const retry = useRef<{ name: string; key: string } | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    const normalized = name.trim();
    if (retry.current?.name !== normalized) retry.current = { name: normalized, key: crypto.randomUUID() };
    try {
      const state = await request<SessionState>(SESSION_AUTH, '/organizations', { method: 'POST', headers: { 'Idempotency-Key': retry.current.key }, body: JSON.stringify({ name: normalized }) });
      onReady(state);
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  }
  return <Shell step="STEP 2 OF 3 · ORGANIZATION" title="Name your organization." description={`Hello, ${session.handler.display_name}. This creates an empty, isolated workspace and makes your organization-scoped principal its administrator.`} appearance={appearance}>
    <form className="onboarding-card" onSubmit={submit}>
      <p className="eyebrow">EMPTY WORKSPACE</p><h2>{allowCancel ? 'Create another organization' : 'Create your first organization'}</h2>
      <label htmlFor="organization-name">Organization name</label><input id="organization-name" value={name} onChange={event => { setName(event.target.value); setError(''); }} maxLength={160} required autoFocus placeholder="Organization name" />
      {error && <div className="error-message" role="alert">{error}</div>}
      <div className="onboarding-actions">{allowCancel && <button className="button secondary" type="button" onClick={onCancel} disabled={busy}>Cancel</button>}<button className="button primary" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create organization'}<span aria-hidden="true">→</span></button></div>
      <p className="onboarding-boundary">Organization administration manages this workspace only. It does not grant engineering, commercial, sourcing, or approval authority.</p>
    </form>
  </Shell>;
}
