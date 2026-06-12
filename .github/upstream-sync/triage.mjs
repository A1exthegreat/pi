#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(__dirname, 'processed-commits.txt');
const MAX_DIFF_CHARS = 8000;
const UPSTREAM_REMOTE = 'upstream';
const UPSTREAM_BRANCH = 'main';
const UPSTREAM_URL = 'https://github.com/badlogic/pi-mono';

const baseUrl = (process.env.OPENAI_BASE_URL).replace(/\/+$/, '');
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.AI_MODEL;

const isBootstrap = process.argv.includes('--bootstrap');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function logError(msg) {
  console.error(`[${new Date().toISOString()}] ERROR: ${msg}`);
}

function exec(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, ...opts }).trim();
}


function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return new Set();
  const set = new Set();
  for (const line of readFileSync(BASELINE_PATH, 'utf-8').split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    set.add(line.split(' ')[0]);
  }
  return set;
}

function appendBaseline(hash, decision) {
  appendFileSync(BASELINE_PATH, `${hash} ${decision} ${new Date().toISOString()}\n`);
}

function fetchUpstream() {
  log('Fetching upstream...');
  exec('git', ['fetch', UPSTREAM_REMOTE, UPSTREAM_BRANCH]);
}

function getNewCommits(baseline) {
  const output = exec('git', ['cherry', 'main', `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`, '--abbrev=40']);
  if (!output) return [];
  const commits = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const prefix = line[0];
    const sha = line.slice(2, 42);
    if (prefix === '+' && !baseline.has(sha)) {
      commits.push(sha);
    }
  }
  return commits.reverse();
}

function getCommitInfo(hash) {
  const subject = exec('git', ['log', '-1', '--format=%s', hash]);
  const body = exec('git', ['log', '-1', '--format=%b', hash]);
  const author = exec('git', ['log', '-1', '--format=%an <%ae>', hash]);
  const date = exec('git', ['log', '-1', '--format=%aI', hash]);
  let diff = '';
  try {
    diff = exec('git', ['diff', `${hash}^`, hash]);
  } catch {
    try {
      diff = exec('git', ['diff-tree', '-p', hash]);
    } catch {
      diff = '';
    }
  }
  return { hash, subject, body, author, date, diff };
}

const TRIAGE_SCHEMA = {
  name: 'triage_decision',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['pick', 'ignore', 'manual'] },
      reasoning: { type: 'string' },
      prTitle: { type: 'string' },
    },
    required: ['decision', 'reasoning', 'prTitle'],
    additionalProperties: false,
  },
};

async function classifyCommit(info) {
  if (!info.diff.trim()) {
    return { decision: 'ignore', reasoning: 'Empty diff (merge commit or no-op)', prTitle: '' };
  }

  let diff = info.diff;
  let truncated = false;
  if (diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS) + `\n... [truncated — full diff: ${UPSTREAM_URL}/commit/${info.hash}]`;
    truncated = true;
  }

  const systemPrompt = [
    'You are a code review assistant for a fork of the pi-mono monorepo.',
    'The fork tracks upstream commits from the original repository.',
    'Classify each upstream commit into one of three categories:',
    '',
    '- "pick": Safe to automatically cherry-pick. Includes: bug fixes, documentation updates, chores, dependency updates, non-breaking feature additions, test improvements.',
    '- "ignore": Not relevant for the fork. Includes: release/version bump commits, CI configuration changes specific to the upstream repo, upstream-specific metadata, merge commits already represented by their constituent commits.',
    '- "manual": Requires human review. Includes: breaking API changes, large refactors touching many files, security-sensitive changes (auth, crypto, permissions), changes to build/binary infrastructure, changes to monorepo structure, or any commit where the correct merge strategy is unclear.',
    truncated ? 'NOTE: The diff was truncated due to size. If you cannot fully assess the change, lean toward "manual".' : '',
  ].filter(Boolean).join('\n');

  const userPrompt = [
    `Commit: ${info.hash}`,
    `Subject: ${info.subject}`,
    `Author: ${info.author}`,
    `Date: ${info.date}`,
    '',
    info.body,
    '',
    '--- Diff ---',
    diff,
  ].join('\n');

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_schema', json_schema: TRIAGE_SCHEMA },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM API ${response.status}: ${text}`);
  }

  const data = await response.json();
  return JSON.parse(data.choices[0].message.content);
}

async function retryWithBackoff(fn, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = Math.min(1000 * 2 ** attempt, 10000);
      logError(`Attempt ${attempt + 1} failed, retrying in ${delay}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function tryCherryPick(hash) {
  try {
    exec('git', ['cherry-pick', hash]);
    return { success: true, conflicts: [] };
  } catch {
    let conflicts = [];
    try {
      const status = exec('git', ['diff', '--name-only', '--diff-filter=U']);
      conflicts = status.split('\n').filter(Boolean);
    } catch {}

    if (conflicts.length === 0) {
      try { exec('git', ['cherry-pick', '--abort']); } catch {}
      return { success: false, conflicts: [], empty: true };
    }

    exec('git', ['add', '-A']);
    exec('git', ['commit', '--no-edit']);
    return { success: false, conflicts };
  }
}

function prExists(branch) {
  try {
    const out = exec('gh', ['pr', 'list', '--head', branch, '--json', 'number', '--jq', 'length']);
    return out !== '0';
  } catch {
    return false;
  }
}

function buildPrBody(info, classification, decision, conflicts) {
  const shortHash = info.hash.slice(0, 7);
  const commitUrl = `${UPSTREAM_URL}/commit/${info.hash}`;
  const isManual = decision === 'manual';

  const lines = [
    isManual
      ? `## Upstream Sync: ${classification.prTitle} [NEEDS REVIEW]`
      : `## Upstream Sync: ${classification.prTitle}`,
    '',
    `**Upstream commit:** [\`${shortHash}\`](${commitUrl})`,
    `**Author:** ${info.author}`,
    `**Decision:** ${isManual ? 'Manual review required' : 'Auto-pick'}`,
    '',
    '### Analysis',
    classification.reasoning,
    '',
    '### Original Commit Message',
    `${info.subject}`,
    '',
    info.body,
  ];

  if (conflicts.length > 0) {
    lines.push(
      '',
      '### Conflict Files',
      ...conflicts.map(f => `- \`${f}\``),
      '',
      'This PR was created as a draft because the cherry-pick had conflicts.',
      'Conflict markers are present in the committed files.',
    );
  }

  lines.push('', '---', isManual ? '*Automated by Upstream Triage — please review*' : '*Automated by Upstream Triage*');
  return lines.join('\n');
}

function createPr(branch, title, body, isDraft, labels) {
  const tmpFile = `/tmp/upstream-triage-pr-${process.pid}-${Date.now()}.md`;
  writeFileSync(tmpFile, body);
  try {
    const args = ['pr', 'create', '--head', branch, '--title', title, '--body-file', tmpFile];
    if (isDraft) args.push('--draft');
    for (const label of labels) args.push('--label', label);
    exec('gh', args);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

function ensureLabel(name, description, color) {
  try {
    exec('gh', ['label', 'create', name, '--description', description, '--color', color, '--force']);
  } catch {
    logError(`Failed to ensure label "${name}", PR creation may fail if label does not exist`);
  }
}

function bootstrap() {
  fetchUpstream();
  const baseline = loadBaseline();
  const output = exec('git', ['cherry', 'main', `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`, '--abbrev=40']);
  if (!output) {
    log('No upstream commits to bootstrap');
    return;
  }
  let count = 0;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const sha = line.slice(2, 42);
    if (!baseline.has(sha)) {
      appendBaseline(sha, 'ignore');
      baseline.add(sha);
      count++;
    }
  }
  log(`Bootstrapped ${count} commits as ignore`);
}

async function main() {
  if (isBootstrap) {
    bootstrap();
    return;
  }

  if (!apiKey) {
    logError('OPENAI_API_KEY is required');
    process.exit(1);
  }

  fetchUpstream();

  const baseline = loadBaseline();
  const commits = getNewCommits(baseline);

  if (commits.length === 0) {
    log('No new upstream commits to process');
    return;
  }

  log(`Found ${commits.length} new commit(s) to process`);

  ensureLabel('needs-review', 'Needs human review before merging', 'd73a4a');
  ensureLabel('upstream-sync', 'Automated upstream sync PR', '0e8a16');

  const baselineUpdates = [];

  for (const hash of commits) {
    const shortHash = hash.slice(0, 7);
    log(`Processing ${shortHash}...`);

    const info = getCommitInfo(hash);

    let classification;
    try {
      classification = await retryWithBackoff(() => classifyCommit(info));
    } catch (err) {
      logError(`LLM classification failed for ${shortHash}: ${err.message}`);
      logError('Skipping — will retry on next run');
      continue;
    }

    log(`  Decision: ${classification.decision} — ${classification.reasoning}`);

    if (classification.decision === 'ignore') {
      baselineUpdates.push({ hash, decision: 'ignore' });
      continue;
    }

    const branch = `upstream-sync/${shortHash}`;

    try {
      exec('git', ['checkout', '-b', branch, 'main']);
    } catch {
      logError(`  Branch ${branch} already exists, skipping`);
      baselineUpdates.push({ hash, decision: classification.decision });
      exec('git', ['checkout', 'main']);
      continue;
    }

    const result = tryCherryPick(hash);
    let decision = classification.decision;

    if (result.empty) {
      log(`  Cherry-pick resulted in empty commit, skipping`);
      exec('git', ['checkout', 'main']);
      exec('git', ['branch', '-D', branch]);
      baselineUpdates.push({ hash, decision: 'ignore' });
      continue;
    }

    if (!result.success && result.conflicts.length > 0) {
      log(`  Conflicts in: ${result.conflicts.join(', ')}`);
      decision = 'manual';
    }

    try {
      exec('git', ['push', '-u', 'origin', branch]);
    } catch (err) {
      logError(`  Push failed: ${err.message}`);
      exec('git', ['checkout', 'main']);
      exec('git', ['branch', '-D', branch]);
      continue;
    }

    if (!prExists(branch)) {
      const title = `${classification.prTitle} (upstream ${shortHash})`;
      const body = buildPrBody(info, classification, decision, result.conflicts);
      const isDraft = decision === 'manual';
      const labels = ['upstream-sync', ...(decision === 'manual' ? ['needs-review'] : [])];

      try {
        createPr(branch, title, body, isDraft, labels);
        log(`  Created ${isDraft ? 'draft ' : ''}PR: ${title}`);
      } catch (err) {
        logError(`  PR creation failed: ${err.message}`);
      }
    } else {
      log(`  PR already exists for ${branch}`);
    }

    baselineUpdates.push({ hash, decision });
    exec('git', ['checkout', 'main']);
  }

  for (const { hash, decision } of baselineUpdates) {
    appendBaseline(hash, decision);
  }

  log(`Done. Processed ${baselineUpdates.length} commit(s)`);
}

main().catch(err => {
  logError(`Fatal: ${err.message}`);
  process.exit(1);
});
