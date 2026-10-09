import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { auditPublicFiles, forbiddenPublicPath, scanPublicFile } from './check-public-secrets.mjs';

const fakeKey = () => ['sk', 'a'.repeat(32)].join('-');
const assignment = (name, value) => `${name}=${value}\n`;

test('private config and runtime files are excluded, empty templates are allowed', () => {
  for (const file of ['gateway.env', '.env.local', 'apps/gateway/data/demands.sqlite', '.sf/orgs/cache.json', 'certs/local.pem', 'local.key', 'output/profile/state.json', 'README.internal.md', 'IMPLEMENTATION_STATUS.md']) {
    assert.equal(forbiddenPublicPath(file), true, file);
  }
  for (const file of ['gateway.env.example', '.env.example', '.env.local.example', 'apps/gateway/src/server.ts', 'pnpm-lock.yaml']) assert.equal(forbiddenPublicPath(file), false, file);
  assert.deepEqual(scanPublicFile('gateway.env.example', assignment('MODEL_API_KEY', '') + assignment('GATEWAY_PAIRING_TOKEN', '') + assignment('MODEL_API_ORIGIN', '')), []);
  assert.deepEqual(scanPublicFile('gateway.env.example', assignment('MODEL_API_KEY', '""')), []);
  assert.deepEqual(scanPublicFile('gateway.env.example', assignment('MODEL_API_KEY', '  # enter locally') + assignment('MODEL_ID', 'example-model')), []);
  assert.deepEqual(scanPublicFile('gateway.env.example', assignment('MODEL_API_KEY', '') + assignment('MODEL_ID', 'example-model')), []);
});

test('common keys are detected even in fixtures without returning the value', () => {
  const examples = [fakeKey(), ['ghp', 'b'.repeat(36)].join('_'), ['github_pat', 'c'.repeat(40)].join('_'), ['glpat', 'd'.repeat(30)].join('-')];
  for (const value of examples) {
    const findings = scanPublicFile('fixtures/test.ts', `// mock\n${value}`);
    assert.ok(findings.length > 0);
    assert.equal(findings[0].line, 2);
    assert.equal(JSON.stringify(findings).includes(value), false);
    assert.deepEqual(Object.keys(findings[0]), ['file', 'line', 'rule']);
  }
});

test('nonempty configuration tokens and long literal credentials are rejected', () => {
  for (const name of ['MODEL_API_KEY', 'OPENAI_API_KEY', 'GATEWAY_PAIRING_TOKEN']) {
    const findings = scanPublicFile('gateway.env.example', assignment(name, 'not-a-production-key'));
    assert.ok(findings.some((item) => item.rule === 'nonempty_credential_env'));
  }
  const literal = `const ${'apiKey'} = '${'q'.repeat(32)}';`;
  assert.ok(scanPublicFile('src/config.ts', literal).some((item) => item.rule === 'hardcoded_credential'));
  assert.deepEqual(scanPublicFile('src/test.ts', `const ${'apiKey'} = 'test-only';`), []);
});

test('private material, real page tokens and credential URLs are rejected', () => {
  const privateKeyHeader = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  const pageToken = `https://example.test/?${'xsec_token'}=${'z'.repeat(40)}`;
  const authUrl = 'https://' + ['username', 'password'].join(':') + '@example.test';
  for (const content of [privateKeyHeader, pageToken, authUrl]) assert.ok(scanPublicFile('src/config.ts', content).length > 0);
  for (const value of ['test', 'example', 'fixture']) assert.deepEqual(scanPublicFile('fixtures/test.html', `https://example.test/?${'xsec_token'}=${value}`), []);
});

test('machine-specific endpoints are rejected but loopback and documentation endpoints pass', () => {
  const privateOrigin = `https://${[10, 20, 30, 40].join('.')}`;
  const machinePath = ['/', 'Users', '/', 'example', '/', 'config'].join('');
  assert.ok(scanPublicFile('README.md', privateOrigin).some((item) => item.rule === 'private_service_address'));
  assert.ok(scanPublicFile('README.md', machinePath).some((item) => item.rule === 'machine_specific_path'));
  for (const ip of ['127.0.0.1', '192.0.2.10', '198.51.100.10', '203.0.113.10']) assert.deepEqual(scanPublicFile('README.md', `https://${ip}`), []);
});

test('the staged audit reads index content, not cleaned working files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuezhuang-audit-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  try {
    git('init', '-q');
    const file = join(dir, 'config.txt');
    writeFileSync(file, fakeKey());
    git('add', 'config.txt');
    writeFileSync(file, 'safe public configuration');
    assert.ok(auditPublicFiles({ cwd: dir, mode: 'staged' }).findings.length > 0);
    assert.equal(auditPublicFiles({ cwd: dir, mode: 'worktree' }).findings.length, 0);
    git('add', 'config.txt');
    writeFileSync(file, fakeKey());
    assert.equal(auditPublicFiles({ cwd: dir, mode: 'staged' }).findings.length, 0);
    assert.ok(auditPublicFiles({ cwd: dir, mode: 'worktree' }).findings.length > 0);
    assert.equal(auditPublicFiles({ cwd: dir, mode: 'tracked' }).findings.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forced private files, symlinks and unexpected binary files fail the audit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuezhuang-audit-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  try {
    git('init', '-q');
    writeFileSync(join(dir, '.gitignore'), 'gateway.env\n');
    writeFileSync(join(dir, 'gateway.env'), 'ignored private config');
    writeFileSync(join(dir, 'asset.bin'), Buffer.from([0, 1, 2]));
    symlinkSync('gateway.env', join(dir, 'config-link'));
    git('add', '.gitignore', 'asset.bin', 'config-link');
    git('add', '-f', 'gateway.env');
    const findings = auditPublicFiles({ cwd: dir, mode: 'staged' }).findings;
    assert.ok(findings.some((item) => item.file === 'gateway.env' && item.rule === 'private_file'));
    assert.ok(findings.some((item) => item.file === 'config-link' && item.rule === 'nonregular_file'));
    assert.ok(findings.some((item) => item.file === 'asset.bin' && item.rule === 'unexpected_binary'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
