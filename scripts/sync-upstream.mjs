#!/usr/bin/env node

/**
 * Upstream sync helper for fork maintenance.
 *
 * Usage:
 *   node scripts/sync-upstream.mjs status          Show upstream commit count and summary
 *   node scripts/sync-upstream.mjs log             List new upstream commits
 *   node scripts/sync-upstream.mjs log <path>      List upstream commits touching a path
 *   node scripts/sync-upstream.mjs diff [path]     Show file-level diff stats from upstream
 *   node scripts/sync-upstream.mjs conflicts       Show files changed on both sides (conflict risk)
 *   node scripts/sync-upstream.mjs pick <sha...>   Cherry-pick one or more upstream commits
 *   node scripts/sync-upstream.mjs pick-range <a> <b>  Cherry-pick a range (a^..b)
 *   node scripts/sync-upstream.mjs grab <path...>  Checkout specific files from upstream/main
 *   node scripts/sync-upstream.mjs base            Print the merge-base SHA
 */

import { execSync } from "node:child_process";

const UPSTREAM = "upstream";
const UPSTREAM_BRANCH = `${UPSTREAM}/main`;
const LOCAL_BRANCH = "HEAD";

function run(cmd, opts = {}) {
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], ...opts }).trim();
	} catch (err) {
		const stderr = err.stderr?.trim();
		if (stderr) console.error(stderr);
		if (!opts.silent) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return "";
	}
}

function ensureUpstreamFetched() {
	const refs = run(`git rev-parse --verify ${UPSTREAM_BRANCH}`, { silent: true });
	if (!refs) {
		console.log("Fetching upstream...");
		run(`git fetch ${UPSTREAM}`);
	}
}

function getMergeBase() {
	return run(`git merge-base ${LOCAL_BRANCH} ${UPSTREAM_BRANCH}`);
}

function getUpstreamCount() {
	return run(`git rev-list --count ${LOCAL_BRANCH}..${UPSTREAM_BRANCH}`);
}

function getLocalCount() {
	return run(`git rev-list --count ${UPSTREAM_BRANCH}..${LOCAL_BRANCH}`);
}

// --- Commands ---

function cmdStatus() {
	ensureUpstreamFetched();
	const base = getMergeBase();
	const upCount = getUpstreamCount();
	const localCount = getLocalCount();

	console.log(`Merge base:     ${base}`);
	console.log(`Upstream ahead: ${upCount} commits`);
	console.log(`Local ahead:    ${localCount} commits`);
	console.log();

	if (Number(upCount) === 0) {
		console.log("Already up to date with upstream.");
		return;
	}

	console.log("=== Recent upstream commits (newest 15) ===");
	const log = run(`git log --oneline ${LOCAL_BRANCH}..${UPSTREAM_BRANCH} -15`);
	console.log(log);
	if (Number(upCount) > 15) {
		console.log(`... and ${Number(upCount) - 15} more`);
	}

	console.log();
	console.log("=== Upstream change summary ===");
	const stat = run(`git diff --stat ${LOCAL_BRANCH}..${UPSTREAM_BRANCH}`);
	const lines = stat.split("\n");
	const tail = lines.slice(-5);
	for (const line of tail) console.log(line);
}

function cmdLog(pathFilter) {
	ensureUpstreamFetched();
	const pathArg = pathFilter ? ` -- ${pathFilter}` : "";
	const log = run(`git log --oneline ${LOCAL_BRANCH}..${UPSTREAM_BRANCH}${pathArg}`);
	if (!log) {
		console.log(`No upstream commits${pathFilter ? ` touching ${pathFilter}` : ""}.`);
		return;
	}
	console.log(log);
}

function cmdDiff(pathFilter) {
	ensureUpstreamFetched();
	const pathArg = pathFilter ? ` -- ${pathFilter}` : "";
	const stat = run(`git diff --stat ${LOCAL_BRANCH}..${UPSTREAM_BRANCH}${pathArg}`);
	console.log(stat || "No differences.");
}

function cmdConflicts() {
	ensureUpstreamFetched();
	const base = getMergeBase();

	const localFiles = run(`git diff --name-only ${base}..${LOCAL_BRANCH}`)
		.split("\n")
		.filter(Boolean)
		.sort();
	const upstreamFiles = run(`git diff --name-only ${base}..${UPSTREAM_BRANCH}`)
		.split("\n")
		.filter(Boolean)
		.sort();

	const localSet = new Set(localFiles);
	const upstreamSet = new Set(upstreamFiles);

	const both = localFiles.filter((f) => upstreamSet.has(f));
	const localOnly = localFiles.filter((f) => !upstreamSet.has(f));
	const upstreamOnly = upstreamFiles.filter((f) => !localSet.has(f));

	console.log(`=== Files changed on BOTH sides (${both.length}) — conflict risk ===`);
	if (both.length === 0) {
		console.log("(none — safe to cherry-pick)");
	} else {
		for (const f of both) console.log(`  ${f}`);
	}

	console.log();
	console.log(`=== Changed only locally (${localOnly.length}) ===`);
	for (const f of localOnly.slice(0, 10)) console.log(`  ${f}`);
	if (localOnly.length > 10) console.log(`  ... and ${localOnly.length - 10} more`);

	console.log();
	console.log(`=== Changed only upstream (${upstreamOnly.length}) ===`);
	for (const f of upstreamOnly.slice(0, 10)) console.log(`  ${f}`);
	if (upstreamOnly.length > 10) console.log(`  ... and ${upstreamOnly.length - 10} more`);
}

function cmdPick(shas) {
	if (shas.length === 0) {
		console.error("Usage: sync-upstream pick <sha> [sha...]");
		process.exit(1);
	}

	ensureUpstreamFetched();
	const conflicts = getConflictingFiles();

	console.log(`Cherry-picking ${shas.length} commit(s)...`);
	console.log();

	for (const sha of shas) {
		const short = sha.substring(0, 8);
		const msg = run(`git log --oneline -1 ${sha}`, { silent: true });
		console.log(`> ${msg}`);

		const result = run(`git cherry-pick --no-commit ${sha}`, { silent: true });
		const status = run("git diff --name-only --cached", { silent: true });

		if (!status) {
			run("git cherry-pick --abort", { silent: true });
			console.log(`  Skipped (empty or already applied)`);
			continue;
		}

		const changedFiles = status.split("\n").filter(Boolean);
		const conflicting = changedFiles.filter((f) => conflicts.has(f));

		if (conflicting.length > 0) {
			console.log(`  WARNING: touches files you also changed:`);
			for (const f of conflicting) console.log(`    ${f}`);
			console.log(`  Review staged changes with: git diff --cached`);
			console.log(`  Commit manually when satisfied, or: git cherry-pick --abort`);
		} else {
			const commitMsg = run(`git log --format=%s -1 ${sha}`);
			run(`git commit -m "${commitMsg}"`);
			console.log(`  Applied cleanly`);
		}
		console.log();
	}
}

function cmdPickRange(startSha, endSha) {
	if (!startSha || !endSha) {
		console.error("Usage: sync-upstream pick-range <start-sha> <end-sha>");
		process.exit(1);
	}
	const shas = run(`git rev-list --reverse ${startSha}^..${endSha}`).split("\n").filter(Boolean);
	console.log(`Range ${startSha.substring(0, 8)}..${endSha.substring(0, 8)}: ${shas.length} commits`);
	cmdPick(shas);
}

function cmdGrab(paths) {
	if (paths.length === 0) {
		console.error("Usage: sync-upstream grab <path> [path...]");
		process.exit(1);
	}
	ensureUpstreamFetched();
	for (const p of paths) {
		console.log(`Checking out ${p} from ${UPSTREAM_BRANCH}...`);
		run(`git checkout ${UPSTREAM_BRANCH} -- ${p}`);
	}
	console.log();
	console.log("Files staged. Review with: git diff --cached");
	console.log("Commit when satisfied.");
}

function cmdBase() {
	ensureUpstreamFetched();
	console.log(getMergeBase());
}

function getConflictingFiles() {
	const base = getMergeBase();
	const localFiles = run(`git diff --name-only ${base}..${LOCAL_BRANCH}`)
		.split("\n")
		.filter(Boolean);
	return new Set(localFiles);
}

// --- Main ---

const [command, ...args] = process.argv.slice(2);

if (!command) {
	console.log(`Usage: node scripts/sync-upstream.mjs <command> [args...]

Commands:
  status              Show upstream commit count and recent changes
  log [path]          List new upstream commits (optionally filtered by path)
  diff [path]         Show file-level diff stats from upstream
  conflicts           Show files changed on both sides (conflict risk)
  pick <sha...>       Cherry-pick one or more upstream commits
  pick-range <a> <b>  Cherry-pick a commit range (a^..b)
  grab <path...>      Checkout specific files from upstream/main
  base                Print the merge-base SHA`);
	process.exit(0);
}

switch (command) {
	case "status":
		cmdStatus();
		break;
	case "log":
		cmdLog(args[0]);
		break;
	case "diff":
		cmdDiff(args[0]);
		break;
	case "conflicts":
		cmdConflicts();
		break;
	case "pick":
		cmdPick(args);
		break;
	case "pick-range":
		cmdPickRange(args[0], args[1]);
		break;
	case "grab":
		cmdGrab(args);
		break;
	case "base":
		cmdBase();
		break;
	default:
		console.error(`Unknown command: ${command}`);
		process.exit(1);
}
