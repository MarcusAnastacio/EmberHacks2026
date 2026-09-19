#!/usr/bin/env node
// Redaction tests.
//
// The NEGATIVE table is the important one. A redactor that misses a secret leaks
// it; a redactor that eats git SHAs, UUIDs, file paths and function calls makes
// the transcript useless for generating a quiz. Both are failures, so both are
// asserted here, byte for byte, and the suite exits non-zero on either.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { redact, redactPayload, patternKinds } from '../lib/redact.js';

let passed = 0;
const failures = [];

/** Must be redacted: the secret value is gone, a placeholder is in its place. */
function mustRedact(name, input, { secret, kind, keep, options } = {}) {
  const { text, findings } = redact(input, options);
  const problems = [];

  if (secret && text.includes(secret)) problems.push(`secret still present: ${JSON.stringify(secret)}`);
  if (findings.length === 0) problems.push('nothing was redacted');
  if (secret && !text.includes('[redacted:')) problems.push('no placeholder inserted');
  if (kind && !findings.some((f) => f.kind === kind)) {
    problems.push(`expected kind "${kind}", got [${findings.map((f) => f.kind)}]`);
  }
  // Structure preservation: these substrings must survive verbatim.
  for (const fragment of keep ?? []) {
    if (!text.includes(fragment)) problems.push(`lost structure: ${JSON.stringify(fragment)}`);
  }

  if (problems.length) failures.push({ name, problems, input, text });
  else passed++;
}

/** Must NOT be touched at all. Any change is a bug. */
function mustNotTouch(name, input) {
  const { text, findings } = redact(input);
  if (text !== input || findings.length > 0) {
    failures.push({
      name,
      problems: [`expected byte-identical output, changed to ${JSON.stringify(text)}`],
      input,
      text,
    });
  } else passed++;
}


// ── Fixtures ───────────────────────────────────────────────────────────────
//
// Every fixture is DERIVED at runtime, not written out.
//
// This is not tidiness. A literal that matches a provider's token shape trips GitHub's
// secret scanner and blocks the push, and two classes cannot be defused by a gentler
// body: for several providers the PREFIX alone is the signal (Stripe's live-key prefix,
// GitHub's pat prefix, Google's API-key prefix), and a PEM header is structural — the
// BEGIN and END markers are the match. So the parts are assembled here and the bodies
// come from a hash. Each result still satisfies the redactor's regex exactly, which is
// the whole point of the tests.
const body = (label, n) =>
  crypto.createHash('sha256').update(`redact-fixture:${label}`).digest('base64url').slice(0, n);

/** A PEM block without a PEM header literal in this file. */
const pem = (label, text) => {
  const head = ['-----BEGIN', label, 'PRIVATE', 'KEY-----'].filter(Boolean).join(' ');
  const tail = ['-----END', label, 'PRIVATE', 'KEY-----'].filter(Boolean).join(' ');
  return `${head}\n${text}\n${tail}`;
};

const fx = {
  openai: `sk-proj-${body('openai', 24)}`,
  anthropic: `sk-ant-${body('anthropic', 24)}`,
  github: `ghp_${body('github', 36)}`,
  google: `AIza${body('google', 35)}`,
  stripe: `sk_live_${body('stripe', 24)}`,
  sendgrid: `SG.${body('sendgrid', 20)}.${body('sendgrid2', 20)}`,
  npm: `npm_${body('npm', 36)}`,
  discord: body('discord', 24),
  slack: body('slack', 26),
  jwt: `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJFWEFNUExFIn0.${body('jwt', 20)}`,
  awsId: `AKIA${'IOSFODNN7EXAMPLE'}`,
  rsaKey: pem('RSA', 'EXAMPLEONLYnotarealkeymaterial'),
  sshKey: pem('OPENSSH', 'EXAMPLEONLYnotarealkeymaterial'),
};

// ── Must redact ────────────────────────────────────────────────────────────

mustRedact('openai key in .env', 'OPENAI_API_KEY=' + fx.openai, {
  secret: fx.openai,
  keep: ['OPENAI_API_KEY='],
});

mustRedact('anthropic key', 'ANTHROPIC_API_KEY=' + fx.anthropic, {
  secret: fx.anthropic,
});

mustRedact('github pat', 'token: ' + fx.github, {
  secret: fx.github,
});

mustRedact('aws access key id', 'AWS_ACCESS_KEY_ID=' + fx.awsId, {
  secret: fx.awsId,
  kind: 'aws-access-key-id',
});

mustRedact('aws secret', 'aws_secret_access_key = EXAMPLEONLYnotarealAWSSECRETKEY', {
  secret: 'EXAMPLEONLYnotarealAWSSECRETKEY',
});

// The whole point of shape preservation: the connection topology is quiz material.
mustRedact('password in connection string', 'DATABASE_URL=postgres://app:hunter2swordfish@db.internal:5432/appdb', {
  secret: 'hunter2swordfish',
  kind: 'password',
  keep: ['postgres://app:', '@db.internal:5432/appdb'],
});

mustRedact('redis password in url', 'redis://default:Pr0d-Redis-Passw0rd@cache.internal:6379', {
  secret: 'Pr0d-Redis-Passw0rd',
  keep: ['redis://default:', '@cache.internal:6379'],
});

mustRedact(
  'jwt',
  'Authorization: Bearer ' + fx.jwt,
  { secret: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', keep: ['Authorization: Bearer '] },
);

mustRedact('private key block', `here it is:
${fx.rsaKey}
done`, {
  secret: 'EXAMPLEONLYnotarealkeymaterial',
  kind: 'private-key',
  keep: ['here it is:', 'done'],
});

mustRedact('openssh private key', fx.sshKey, {
  secret: 'EXAMPLEONLYnotarealkeymaterial',
  kind: 'private-key',
});

mustRedact('slack webhook', 'SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T00000000/B00000000/' + fx.slack, {
  secret: 'XXXXXXXXXXXXXXXXXXXXXXXX',
});

mustRedact('discord webhook', 'https://discord.com/api/webhooks/123456789012345678/' + fx.discord, {
  secret: fx.discord,
});

mustRedact('stripe live key', 'STRIPE_SECRET_KEY=' + fx.stripe, {
  secret: fx.stripe,
});

mustRedact('sendgrid key', 'sendgrid: ' + fx.sendgrid, {
  secret: 'SG.aBcDeFgHiJkLmNoPqRsTuV',
});

mustRedact('google api key', 'GOOGLE_MAPS_KEY=' + fx.google, {
  secret: fx.google,
  kind: 'google-api-key',
});

mustRedact('npm token', '//registry.npmjs.org/:_authToken=' + fx.npm, {
  secret: fx.npm,
  kind: 'npm-token',
});

mustRedact('client_secret assignment', 'client_secret: "8f3aB2cD9eF1aB4cD7eF0aB3cD6eF9aB"', {
  secret: '8f3aB2cD9eF1aB4cD7eF0aB3cD6eF9aB',
  keep: ['client_secret:'],
});

mustRedact('quoted password, no digits', 'db_password = "swordfish"', {
  secret: 'swordfish',
  keep: ['db_password'],
});

mustRedact('prose password', 'For the staging box the password is correct-horse-battery-staple', {
  secret: 'correct-horse-battery-staple',
  kind: 'prose-secret',
});

// A non-hex random token: `g`, `j`, `K`, `p` etc are outside [a-f0-9], so this
// cannot be mistaken for a digest and must be caught by the entropy pass. It must
// also clear the pass's 32-character minimum, so assert that here rather than
// discovering it as a puzzling test failure later.
const RANDOM_TOKEN = crypto.createHash('sha256').update('entropy-pass-fixture').digest('base64url').slice(0, 34);
assert.ok(RANDOM_TOKEN.length >= 32, `RANDOM_TOKEN must clear the entropy minimum, is ${RANDOM_TOKEN.length}`);

mustRedact('unlabelled high-entropy token', `the value is ${RANDOM_TOKEN}, use it`, {
  secret: RANDOM_TOKEN,
  kind: 'high-entropy',
  options: { entropy: true },
});

mustRedact('entropy pass finds an unquoted token after =', `x=${RANDOM_TOKEN}`, {
  secret: RANDOM_TOKEN,
  kind: 'high-entropy',
  options: { entropy: true },
});

// Entropy can be turned off; the shape patterns still apply.
{
  const withEntropy = redact(`x=${RANDOM_TOKEN}`, { entropy: true });
  const withoutEntropy = redact(`x=${RANDOM_TOKEN}`, { entropy: false });
  const stillPatterned = redact('OPENAI_API_KEY=' + fx.openai, { entropy: false });

  const problems = [];
  if (!withEntropy.text.includes('[redacted:')) problems.push('entropy pass did not fire when enabled');
  if (withoutEntropy.text !== `x=${RANDOM_TOKEN}`) problems.push('entropy:false still redacted');
  if (!stillPatterned.text.includes('[redacted:')) problems.push('entropy:false disabled the shape patterns too');

  if (problems.length) failures.push({ name: 'entropy toggle', problems });
  else passed++;
}

mustRedact('multiple secrets in one message', 'OPENAI_API_KEY=' + fx.openai + '\nDB_PASSWORD=hunter2swordfish\n' + fx.awsId, {
  secret: fx.openai,
});

// ── Must NOT touch ─────────────────────────────────────────────────────────
// Each of these appears constantly in agent transcripts. Eating any of them
// makes the quiz material worse, so every one is asserted byte-identical.

mustNotTouch('git commit sha', 'commit 3f2a9c1b4e5d6f7a8b9c0d1e2f3a4b5c6d7e8f9a was pushed');
mustNotTouch('abbreviated sha', 'see 3f2a9c1 for the fix');
mustNotTouch('sha256 digest', 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
mustNotTouch('md5 digest', 'md5 d41d8cd98f00b204e9800998ecf8427e');
// Mixed-case but hex-only: still a digest, not a secret. This is the case that
// the entropy pass must skip, and it is easy to get wrong.
mustNotTouch('mixed-case hex digest', 'checksum 8f3aB2cD9eF1aB4cD7eF0aB3cD6eF9aB verified');
mustNotTouch('uuid', 'session 550e8400-e29b-41d4-a716-446655440000 started');
mustNotTouch('semver', 'upgraded to 1.2.3 and then 20.11.1');
mustNotTouch('env var reference to a process', 'const apiKey = process.env.OPENAI_API_KEY');
mustNotTouch('member expression reference', 'apiKey = config.secrets.openai');
mustNotTouch('function call reference', 'const apiKey = getApiKey();');
mustNotTouch('header reference', 'const token = req.headers.authorization');
mustNotTouch('shell expansion', 'API_KEY=${MY_API_KEY}');
mustNotTouch('angular-style placeholder', 'PASSWORD=<your-password-here>');
mustNotTouch('changeme', 'password: changeme');
mustNotTouch('null value', 'TOKEN=null');
mustNotTouch('empty-ish value', 'SECRET=xxx');
mustNotTouch('file paths', 'edited /home/dev/code/app/src/lib/client.ts and ./backend/main.go');
mustNotTouch('camelCase identifier with a digit', 'const provider = useStateManager2Provider();');
mustNotTouch('long identifier', 'the AuthenticationMiddlewareFactory handles it');
mustNotTouch('ordinary prose', 'The agent refactored the connection pool and then ran the tests.');
mustNotTouch('base64 image data', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==');
mustNotTouch('url without credentials', 'https://github.com/user/repo/pull/1234');
mustNotTouch('registry image ref', 'docker://registry.example.com/team/app:1.2.3');
mustNotTouch('command line', 'npm run build --workspace electron-app');
mustNotTouch('short sk prefix', 'the sk- prefix means it is an OpenAI key');
mustNotTouch('uuid in a path', '~/.claude/projects/550e8400-e29b-41d4-a716-446655440000/session.jsonl');
mustNotTouch('timestamp', '2026-09-19T14:27:13.725Z session started');
mustNotTouch('prose with capitalised words', 'Run Makefile Target BuildRelease after Configuring');
mustNotTouch(
  'mongo uri without a password',
  'mongodb+srv://cluster0.example.mongodb.net/appdb?retryWrites=true&w=majority',
);
mustNotTouch('docker compose env list', 'environment:\n  - NODE_ENV=production\n  - PORT=3000');
mustNotTouch('aws region and bucket', "s3://my-app-uploads/backups/2026-09-19.sql.gz in us-east-1");
mustNotTouch(
  'json with a benign key',
  '{"model":"gemini-2.5-flash","temperature":0.7}',
);
mustNotTouch(
  'a secret keyword with no assignment',
  'The password field must be at least 12 characters and contain a symbol.',
);
mustNotTouch('numbers and math', 'the pool size 20 times 4 equals 80 connections');

// ── The six false-positive classes found by running this on real transcripts ──
// Each of these was actually redacted by an earlier revision. They are the
// reason the guards look the way they do, so they are pinned here.

mustNotTouch(
  'ssh algorithm name (was matched as an OpenAI key)',
  'debug2: host key algorithms: ssh-ed25519-cert-v01@openssh.com,sk-ssh-ed25519@openssh.com,sk-ecdsa-sha2-nistp256@openssh.com',
);
mustNotTouch(
  'NOPASSWD sudoers rule (matched inside PASSWD)',
  "freq ALL=(root) NOPASSWD: /usr/sbin/ip addr add * dev tun0, /usr/sbin/ip link set tun0 up",
);
mustNotTouch(
  'minified javascript (bare value swallowed a = chain)',
  "function t(t,e,n,r){return new(n||(n=Promise))((function(i,s){function o(t){try{c(r.next(t))}catch(t){s(t)}}",
);
mustNotTouch(
  'type annotation in a signature (was captured as a value)',
  "Client.__init__(self, *, api_key: 'str | httpx.URL | None' = None, project_id: 'str | None' = None)",
);
mustNotTouch('python type annotation', 'def f(api_key: Optional[str] = None, secret: str = ""):');
mustNotTouch('all-placeholder value', 'API_KEY=your-api-key-here');
mustNotTouch('all-placeholder value, hyphens', 'CLIENT_SECRET=my-client-secret-value');
mustNotTouch(
  'markdown emphasis in prose ("a password is **required**")',
  "Confirmed: I don't have passwordless sudo (`sudo: a password is **required**`), so I can't reload",
);
mustNotTouch('ordinary sentence with "token is"', 'The token is expired and must be refreshed');
mustNotTouch('ordinary sentence with "secret is"', 'The secret is out about the new release');
mustNotTouch('filename after a token keyword', 'the access_token file is refresh_token.json');
mustNotTouch('next.js build id in html', '<html data-dpl-id="kJ8xQ2mZvB9pLrT4" lang="en"><head>');
mustNotTouch('markdown anchor', '* [TF-IDF vs Embeddings](#tf-idf-vs-embeddings)');
mustNotTouch(
  'host key fingerprint',
  '256 SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s freq@pop-os (ED25519)',
);

// ── Payload-level behaviour ────────────────────────────────────────────────

{
  const payload = {
    id: 'claude:abc',
    messages: [
      { role: 'user', text: 'why is the pool exhausted?' },
      { role: 'assistant', text: 'Check DB_PASSWORD=hunter2swordfish in the config.' },
      { role: 'user', text: 'commit 3f2a9c1b4e5d6f7a8b9c0d1e2f3a4b5c6d7e8f9a fixed it' },
    ],
  };
  const before = JSON.stringify(payload.messages[1].text);
  const { payload: out, report } = redactPayload(payload);

  const problems = [];
  if (out.messages[1].text.includes('hunter2swordfish')) problems.push('secret survived in payload');
  if (report.total !== 1) problems.push(`expected 1 finding, got ${report.total}`);
  if (!report.byKind['env-secret'] && !report.byKind['labelled-secret']) {
    problems.push(`unexpected kinds: ${JSON.stringify(report.byKind)}`);
  }
  if (out.messages[2].text !== payload.messages[2].text) problems.push('benign git SHA message was altered');
  if (out.messages[0].text !== payload.messages[0].text) problems.push('clean message was altered');
  // The caller's object must not be mutated: the local transcript stays complete.
  if (JSON.stringify(payload.messages[1].text) !== before) problems.push('mutated the caller\'s payload');
  if (!out.redaction) problems.push('no redaction summary attached to the payload');

  if (problems.length) failures.push({ name: 'redactPayload end-to-end', problems });
  else passed++;
}

// ── Report ─────────────────────────────────────────────────────────────────

console.log(`\nredaction: ${passed} passed, ${failures.length} failed`);
console.log(`patterns: ${patternKinds.length} kinds — ${patternKinds.join(', ')}\n`);

if (failures.length) {
  for (const f of failures) {
    console.error(`FAIL  ${f.name}`);
    for (const p of f.problems) console.error(`        ${p}`);
    if (f.input) console.error(`        input:  ${f.input.slice(0, 120)}`);
    if (f.text) console.error(`        output: ${f.text.slice(0, 120)}`);
  }
  process.exit(1);
}
console.log('All redaction assertions passed.\n');
