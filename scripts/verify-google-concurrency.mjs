import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests the database boundary after Google verification, using synthetic
// subjects only. This does not mock a Google token or authenticate a real user.
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (!args.includes('--disposable') || !args.includes('--config')) {
  throw new Error('Pass --disposable --config <isolated .env> [--database <name_test>].');
}
const database = args.includes('--database') ? option('--database') : 'grimoire_test';
assert.match(database, /^[a-zA-Z][a-zA-Z0-9_]*_test$/, 'A disposable *_test database is required.');
const settings = {};
for (const line of (await readFile(resolve(option('--config')), 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/)) {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match) settings[match[1]] = match[2];
}
const host = settings.PGHOST ?? '127.0.0.1';
const port = settings.PGPORT;
assert.ok(['127.0.0.1', 'localhost', '::1'].includes(host), 'Only loopback PostgreSQL is allowed.');
assert.match(port ?? '', /^\d{1,5}$/, 'An explicit isolated PGPORT is required.');
assert.equal(settings.GRIMOIRE_DB_MODE, 'native', 'This test requires an isolated native PostgreSQL config.');
assert.ok(settings.POSTGRES_PASSWORD, 'POSTGRES_PASSWORD is required in the selected isolated config.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = resolve(root, '.tools', 'pgsql', 'bin', process.platform === 'win32' ? 'psql.exe' : 'psql');
const run = randomUUID();
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
const pause = ms => new Promise(done => setTimeout(done, ms));

function startSql(source, application = 'google_concurrency_guard', marker) {
  let output = '';
  let errors = '';
  let resolveMarker;
  let rejectMarker;
  const seenMarker = marker ? new Promise((yes, no) => { resolveMarker = yes; rejectMarker = no; }) : Promise.resolve();
  const child = spawn(executable, ['-X', '-A', '-t', '-q', '-w', '-h', host, '-p', port,
    '-U', settings.POSTGRES_USER ?? 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'], {
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PGPASSWORD: settings.POSTGRES_PASSWORD, PGAPPNAME: application,
      PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=10000' },
  });
  const done = new Promise((yes, no) => {
    child.stdout.setEncoding('utf8').on('data', data => {
      output += data;
      if (marker && output.split(/\r?\n/).includes(marker)) resolveMarker();
    });
    child.stderr.setEncoding('utf8').on('data', data => { errors += data; });
    child.once('error', error => { rejectMarker?.(error); no(error); });
    child.once('close', code => {
      if (code !== 0) {
        const error = new Error(`Synthetic PostgreSQL check failed (${code}): ${errors.trim()}`);
        rejectMarker?.(error);
        no(error);
      } else if (marker && !output.split(/\r?\n/).includes(marker)) {
        const error = new Error('First transaction ended without holding the expected race marker.');
        rejectMarker(error);
        no(error);
      } else yes(output.trim());
    });
  });
  // The marker is observed before done is awaited. Keep early child failures
  // handled while preserving rejection for the caller's final await.
  done.catch(() => {});
  child.stdin.end(source);
  return { done, seenMarker };
}
const sql = source => startSql(source).done;
const runtime = source => `SET ROLE grimoire_intake_app;\n${source}`;
const assertIdentity = output => {
  const identity = output.split(/\r?\n/).find(line => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(line));
  assert.ok(identity, 'Expected an identity UUID from the first synthetic login.');
  return identity;
};
const subjects = [`synthetic-google-concurrency-${run}-distinct`, `synthetic-google-concurrency-${run}-replay`];
const challenges = new Set();
const pending = [];

async function waitForLock(application) {
  const deadline = Date.now() + 2200;
  while (Date.now() < deadline) {
    const waiting = await sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE application_name=${quote(application)} AND wait_event_type='Lock');`);
    if (waiting === 't') return;
    await pause(50);
  }
  throw new Error('Second connection was not observed waiting on the first live transaction.');
}

async function race(subject, sameChallenge) {
  const challenge = hash();
  const secondChallenge = sameChallenge ? challenge : hash();
  challenges.add(challenge);
  challenges.add(secondChallenge);
  const nonce = hash();
  const secondNonce = sameChallenge ? nonce : hash();
  const firstSession = hash();
  const secondSession = hash();
  const create = (cookie, nonceHash) => `SELECT app.intake_google_challenge_create(
    ${quote(cookie)},${quote(nonceHash)},clock_timestamp()+interval '4 minutes',NULL);`;
  assert.equal(await sql(runtime(create(challenge, nonce))), 't');
  if (!sameChallenge) assert.equal(await sql(runtime(create(secondChallenge, secondNonce))), 't');
  const login = (cookie, nonceHash, session) => `SELECT COALESCE(app.intake_google_login(
    ${quote(cookie)},${quote(nonceHash)},${quote(subject)},'Synthetic concurrency Handler',
    ${quote(session)},clock_timestamp()+interval '1 hour')::text,'DENIED');`;
  const first = startSql(`BEGIN; SET LOCAL ROLE grimoire_intake_app;
    ${login(challenge, nonce, firstSession)}
    \\echo FIRST_LOGIN_HELD
    SELECT pg_sleep(3);
    COMMIT;`, `${run}_a`, 'FIRST_LOGIN_HELD');
  pending.push(first.done);
  await first.seenMarker;
  const application = `${run}_b`;
  const second = startSql(runtime(login(secondChallenge, secondNonce, secondSession)), application);
  pending.push(second.done);
  await waitForLock(application);
  const [firstOutput, secondOutput] = await Promise.all([first.done, second.done]);
  const identity = assertIdentity(firstOutput);
  assert.equal(secondOutput, sameChallenge ? 'DENIED' : identity);
  const stored = JSON.parse(await sql(`SELECT json_build_object(
    'identities',(SELECT count(*) FROM grimoire.handler_google_identities WHERE google_subject=${quote(subject)}),
    'sessions',(SELECT count(*) FROM grimoire.handler_sessions WHERE identity_id=${quote(identity)}::uuid),
    'memberships',(SELECT count(*) FROM grimoire.handler_organization_memberships WHERE identity_id=${quote(identity)}::uuid),
    'owner',(SELECT is_installation_owner FROM grimoire.handler_identities WHERE id=${quote(identity)}::uuid));`));
  assert.deepEqual(stored, { identities: 1, sessions: sameChallenge ? 1 : 2, memberships: 0, owner: false });
  console.log(sameChallenge
    ? 'PASS two live connections replaying one challenge create exactly one session'
    : 'PASS two live connections using one new Google subject create one identity and two independent sessions');
}

assert.equal(await sql('SELECT current_database();'), database);
assert.equal(await sql("SELECT to_regclass('grimoire.handler_google_identities') IS NOT NULL;"), 't');
console.log(`Target: loopback PostgreSQL ${port}, disposable database ${database}`);
try {
  await race(subjects[0], false);
  await race(subjects[1], true);
} finally {
  await Promise.allSettled(pending);
  const wanted = subjects.map(quote).join(',');
  const wantedChallenges = [...challenges].map(quote).join(',');
  // Delete only the two unguessable synthetic subjects created by this run.
  // Their exact sessions have no organization membership or agent work.
  await sql(`BEGIN;
    DELETE FROM grimoire.handler_google_challenges WHERE cookie_sha256 IN (${wantedChallenges});
    DELETE FROM grimoire.handler_sessions WHERE identity_id IN
      (SELECT identity_id FROM grimoire.handler_google_identities WHERE google_subject IN (${wanted}));
    WITH removed AS (DELETE FROM grimoire.handler_google_identities
      WHERE google_subject IN (${wanted}) RETURNING identity_id)
    DELETE FROM grimoire.handler_identities WHERE id IN (SELECT identity_id FROM removed);
    COMMIT;`);
  assert.equal(await sql(`SELECT count(*) FROM grimoire.handler_google_identities WHERE google_subject IN (${wanted});`), '0');
  console.log('PASS synthetic concurrency identities, sessions and challenges cleaned up');
}
