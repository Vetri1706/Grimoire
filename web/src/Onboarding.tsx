import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { SESSION_AUTH, request } from './api';
import type { SessionState } from './api';
import GoogleSignIn from './GoogleSignIn';
import GrimoireLogo from './GrimoireLogo';
import './onboarding.css';

const errorText = (error: unknown) => error instanceof Error ? error.message : 'The request failed. Please retry.';

function Shell({ step, title, description, appearance, children, centered = false }: { step: string; title: string; description: string; appearance: ReactNode; children: ReactNode; centered?: boolean }) {
  const progress = <ol className="onboarding-steps" aria-label="Onboarding progress"><li data-current={step.startsWith('STEP 1 ') || undefined} aria-current={step.startsWith('STEP 1 ') ? 'step' : undefined}>Handler identity</li><li data-current={step.startsWith('STEP 2 ') || undefined} aria-current={step.startsWith('STEP 2 ') ? 'step' : undefined}>Organization</li><li data-current={step.startsWith('STEP 3 ') || undefined} aria-current={step.startsWith('STEP 3 ') ? 'step' : undefined}>First Scion</li></ol>;
  return <main className={`onboarding-page${centered ? ' onboarding-creation-page' : ''}`}>
    <header className="onboarding-brand"><GrimoireLogo size={36} /><span>GRIMOIRE</span><span className="local-tag">WORKSPACE</span>{appearance}</header>
    <div className="onboarding-layout">
      <section className="onboarding-intro">{centered && progress}<p className="eyebrow">{step}</p><h1>{title}</h1><p>{description}</p>{!centered && progress}</section>
      {children}
    </div>
    <footer className="connection-footer">SCION INTAKE <span>PostgreSQL-backed workspaces</span></footer>
  </main>;
}

export function IdentityAccess({ setupRequired, appearance, onReady }: { setupRequired: boolean; appearance: ReactNode; onReady: (state: SessionState) => void }) {
  const [mode, setMode] = useState<'login' | 'signup' | 'owner'>('login');
  const [displayName, setDisplayName] = useState('');
  const [loginName, setLoginName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const pending = useRef(false);
  const accepted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const creatingIdentity = mode !== 'login';
  function changeMode(next: typeof mode) { if (pending.current || accepted.current) return; setMode(next); setError(''); setPassphrase(''); }
  function begin() {
    if (!mounted.current || pending.current || accepted.current) return false;
    pending.current = true; setBusy(true); setError(''); return true;
  }
  function end() { pending.current = false; if (mounted.current && !accepted.current) setBusy(false); }
  function ready(state: SessionState) {
    if (!mounted.current || !pending.current || accepted.current) return;
    accepted.current = true; onReady(state);
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!begin()) return;
    try {
      const state = await request<SessionState>(SESSION_AUTH, mode === 'owner' ? '/setup/owner' : mode === 'signup' ? '/session/signup' : '/session/login', {
        method: 'POST',
        body: JSON.stringify(creatingIdentity ? { login_name: loginName, display_name: displayName, passphrase } : { login_name: loginName, passphrase }),
      });
      ready(state);
    } catch (failure) { if (mounted.current && !accepted.current) setError(errorText(failure)); } finally { end(); }
  }
  return <Shell step="STEP 1 OF 3 · HANDLER" title={mode === 'owner' ? 'Set up your workspace.' : mode === 'signup' ? 'Your next decision starts here.' : 'Welcome to Grimoire.'} description={mode === 'owner' ? 'Create the Handler identity that owns this installation. This setup happens once.' : mode === 'signup' ? 'One account for your organizations, projects, and decisions.' : 'Open your workspace. Pick up where you left off.'} appearance={appearance}>
    <div className="onboarding-access">
    <form className="onboarding-card onboarding-identity-card" aria-label={mode === 'owner' ? 'Installation owner setup' : mode === 'signup' ? 'Create your account' : 'Sign in to Grimoire'} onSubmit={submit}>
      <div className="onboarding-access-tabs" aria-label="Account access"><button type="button" aria-label="Use sign in form" aria-pressed={mode === 'login'} disabled={busy} onClick={() => changeMode('login')}>Sign in</button><button type="button" aria-label="Use create account form" aria-pressed={mode === 'signup'} disabled={busy} onClick={() => changeMode('signup')}>Create account</button></div>
      {mode === 'owner' && <><p className="eyebrow">ONE-TIME INSTALLATION SETUP</p><h2>Who is the installation owner?</h2></>}
      <div className="onboarding-fields">
      {creatingIdentity && <div className="onboarding-field"><label htmlFor="handler-name">Handler name</label><input id="handler-name" value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={120} required autoComplete="name" autoFocus placeholder="Your name" /></div>}
      <div className="onboarding-field"><label htmlFor="login-name">Login name</label><input id="login-name" value={loginName} onChange={event => setLoginName(event.target.value)} minLength={3} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{2,63}" required autoFocus={!creatingIdentity} autoComplete="username" autoCapitalize="none" autoCorrect="off" placeholder="your.login" /></div>
      <div className="onboarding-field"><label htmlFor="handler-passphrase">Passphrase</label><input id="handler-passphrase" type="password" value={passphrase} onChange={event => setPassphrase(event.target.value)} minLength={12} maxLength={72} required autoComplete={creatingIdentity ? 'new-password' : 'current-password'} placeholder="12–72 characters" /></div>
      </div>
      {error && <div className="error-message" role="alert">{error}</div>}
      <button className="button primary full" aria-label={mode === 'signup' && !busy ? 'Create account and continue' : undefined} disabled={busy || !loginName.trim() || passphrase.length < 12 || (creatingIdentity && !displayName.trim())}>{busy ? 'Continuing…' : mode === 'owner' ? 'Create Handler identity' : mode === 'signup' ? 'Create account' : 'Sign in'}<span aria-hidden="true">→</span></button>
      {mode !== 'owner' && <GoogleSignIn key={mode} busy={busy} onBegin={begin} onEnd={end} onReady={ready} />}
      <details className="onboarding-boundary"><summary>Workspace access only. Approvals stay separate.</summary><p>This identity receives no engineering, commercial, sourcing, or approval authority. Joining an existing organization still requires authorization, including when you sign in with Google.</p></details>
    </form>
    <nav className="onboarding-access-footer" aria-label="Other ways to explore Grimoire">
      <a className="onboarding-demo-link" href="/demo"><strong>Explore the judge demo <span aria-hidden="true">↗</span></strong><span>Read-only · No account needed</span></a>
      {setupRequired && mode !== 'owner' && <button className="text-button onboarding-owner-link" type="button" disabled={busy} onClick={() => changeMode('owner')}>Set up this installation</button>}
    </nav>
    </div>
  </Shell>;
}

export function OrganizationOnboarding({ session, appearance, allowCancel, onReady, onCancel }: { session: SessionState; appearance: ReactNode; allowCancel: boolean; onReady: (state: SessionState) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const retry = useRef<{ name: string; key: string } | null>(null);
  const pending = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (pending.current || !name.trim()) return;
    pending.current = true; setBusy(true); setError('');
    const normalized = name.trim();
    if (retry.current?.name !== normalized) retry.current = { name: normalized, key: crypto.randomUUID() };
    try {
      const state = await request<SessionState>(SESSION_AUTH, '/organizations', { method: 'POST', headers: { 'Idempotency-Key': retry.current.key }, body: JSON.stringify({ name: normalized }) });
      onReady(state);
    } catch (failure) { setError(errorText(failure)); } finally { pending.current = false; setBusy(false); }
  }
  return <Shell centered step="STEP 2 OF 3 · ORGANIZATION" title="What is your organization called?" description={`${session.handler.display_name}, give your team's private workspace a name.`} appearance={appearance}>
    <form className="onboarding-card onboarding-organization-card" aria-label={allowCancel ? 'Create another organization' : 'Create your first organization'} onSubmit={submit}>
      <label htmlFor="organization-name">Organization name</label><input id="organization-name" value={name} onChange={event => { setName(event.target.value); setError(''); }} maxLength={160} required autoFocus disabled={busy} placeholder="e.g. Northwind Labs" aria-describedby="organization-access-note" />
      {error && <div className="error-message" role="alert">{error}</div>}
      <div className="onboarding-actions">{allowCancel ? <button className="button secondary" type="button" onClick={onCancel} disabled={busy}>Cancel</button> : <span />}<button className="button primary" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create organization'}<span aria-hidden="true">→</span></button></div>
      <details className="onboarding-boundary" id="organization-access-note"><summary>A private workspace. Human approvals stay separate.</summary><p>You administer this organization. That does not grant engineering, commercial, sourcing, or approval authority.</p></details>
    </form>
  </Shell>;
}
