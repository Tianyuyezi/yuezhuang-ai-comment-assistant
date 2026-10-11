#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Deliberately report positions and rule names only, never matched content.
export function forbiddenPublicPath(file) {
  const path = file.replaceAll('\\', '/');
  const name = path.split('/').at(-1);
  if (/(^|\/)(node_modules|dist|certs|output|coverage|\.sf|\.sfdx|\.codex|\.playwright-cli|test-results|playwright-report)(\/|$)/i.test(path)) return true;
  if (/^apps\/gateway\/data\//.test(path)) return true;
  if (/^model-config\.json(?:\.|$)/i.test(name)) return true;
  if (/^(README\.internal\.md|IMPLEMENTATION_STATUS\.md|FIND_DEMAND_PRD_v1\.md)$/i.test(name)) return true;
  if (/(?:\.pem|\.key|\.p12|\.pfx|\.sqlite3?|\.sqlite-.*|\.db|\.db-.*|\.log|\.zip)$/i.test(name)) return true;
  if (name === '.DS_Store') return true;
  if (/(?:^|\.)env(?:\.|$)/i.test(name) && !name.endsWith('.example')) return true;
  return false;
}

const rules = [
  ['api_key', /\bsk[-_][A-Za-z0-9_-]{16,}\b/g],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['gitlab_token', /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ['slack_token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['aws_access_key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['private_key', /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/g],
  ['url_credentials', /https?:\/\/[^\s/@:]+:[^\s/@]+@/g],
  ['nonempty_credential_env', /^[ \t]*(?:export[ \t]+)?(?:MODEL_API_KEY|OPENAI_API_KEY|GATEWAY_PAIRING_TOKEN|GITHUB_TOKEN|GH_TOKEN|AWS_SECRET_ACCESS_KEY|[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET))[ \t]*=[ \t]*(?![ \t]*(?:#|\r?$))(?!["']{2}[ \t]*(?:#.*)?\r?$)[^ \t\r\n#][^\r\n]*/gm],
  ['hardcoded_credential', /\b(?:MODEL_API_KEY|OPENAI_API_KEY|GATEWAY_PAIRING_TOKEN|api[_-]?key|access[_-]?token|auth[_-]?token|pairingToken|password|secret)\b["']?\s*[:=]\s*["'][A-Za-z0-9_+\/.=-]{16,}["']/gi],
  ['hardcoded_bearer', /\bBearer\s+[A-Za-z0-9_+\/.=-]{20,}/g],
  ['real_page_token', /[?&]xsec_token=[A-Za-z0-9_+%\/.=-]{16,}/g],
  ['machine_specific_path', /(?:\/Users\/[^/\s"']+\/|[A-Z]:\\Users\\[^\\\s"']+\\)/g],
];

function publicExampleIp(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.some((part) => part > 255)) return false;
  // Loopback and RFC documentation ranges are safe to show in public examples.
  return parts[0] === 127 || ip === '0.0.0.0' ||
    (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) ||
    (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) ||
    (parts[0] === 203 && parts[1] === 0 && parts[2] === 113);
}

export function scanPublicFile(file, content) {
  if (forbiddenPublicPath(file)) return [{ file, line: 1, rule: 'private_file' }];
  if (content.includes('\0')) return [{ file, line: 1, rule: 'unexpected_binary' }];
  const findings = [];
  const add = (index, rule) => findings.push({ file, line: content.slice(0, index).split('\n').length, rule });
  for (const [rule, pattern] of rules) {
    for (const match of content.matchAll(new RegExp(pattern.source, pattern.flags))) add(match.index, rule);
  }
  for (const match of content.matchAll(/https?:\/\/(\d{1,3}(?:\.\d{1,3}){3})(?=[:/\s"'`]|$)/g)) {
    if (!publicExampleIp(match[1])) add(match.index, 'private_service_address');
  }
  return [...new Map(findings.map((item) => [`${item.line}:${item.rule}`, item])).values()];
}

export function auditPublicFiles({ cwd = process.cwd(), mode = 'worktree' } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const root = git('rev-parse', '--show-toplevel').trim();
  const rootGit = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const args = mode === 'staged' ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] :
    mode === 'tracked' ? ['ls-files', '--cached', '-z'] :
      mode === 'worktree' ? ['ls-files', '--cached', '--others', '--exclude-standard', '-z'] : null;
  if (!args) throw new Error('Unknown audit mode');
  const files = [...new Set(rootGit(...args).split('\0').filter(Boolean))];
  const findings = [];
  for (const file of files) {
    if (forbiddenPublicPath(file)) {
      findings.push({ file, line: 1, rule: 'private_file' });
      continue;
    }
    try {
      let content;
      if (mode === 'worktree') {
        const stat = lstatSync(resolve(root, file));
        if (!stat.isFile() || stat.isSymbolicLink()) {
          findings.push({ file, line: 1, rule: 'nonregular_file' });
          continue;
        }
        content = readFileSync(resolve(root, file), 'utf8');
      } else {
        const entry = rootGit('ls-files', '--stage', '--', file);
        if (!/^100(?:644|755) /.test(entry)) {
          findings.push({ file, line: 1, rule: 'nonregular_file' });
          continue;
        }
        // Check the index blob, not a potentially different working copy.
        content = rootGit('show', `:${file}`);
      }
      findings.push(...scanPublicFile(file, content));
    } catch {
      // Do not forward shell error output: it may contain sensitive file contents.
      findings.push({ file, line: 1, rule: 'unreadable_file' });
    }
  }
  return { checked: files.length, findings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2).filter((arg) => arg !== '--');
    if (args.length > 1 || (args.length && !['--worktree', '--staged', '--tracked'].includes(args[0]))) {
      throw new Error('Usage: node scripts/check-public-secrets.mjs [--worktree|--staged|--tracked]');
    }
    const result = auditPublicFiles({ mode: args[0]?.slice(2) ?? 'worktree' });
    for (const item of result.findings) console.error(`${JSON.stringify(item.file)}:${item.line} [${item.rule}]`);
    if (!result.checked) console.error('No files to audit; nothing has been approved for publication.');
    if (result.findings.length || !result.checked) process.exitCode = 1;
    else console.log(`Public source audit passed: ${result.checked} files (positions only; no secret values printed).`);
  } catch {
    console.error('Public source audit failed. Check Git repository and command options; error details are intentionally hidden.');
    process.exitCode = 1;
  }
}
