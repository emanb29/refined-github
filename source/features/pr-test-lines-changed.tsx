import React from 'dom-chef';
import * as pageDetect from 'github-url-detection';
import BeakerIcon from 'octicons-plain-react/Beaker';

import {$optional} from 'select-dom';
import {withTooltipRef} from '../components/tooltip.js';
import features from '../feature-manager.js';
import api from '../github-helpers/api.js';
import {getConversationNumber} from '../github-helpers/index.js';
import looseParseInt from '../helpers/loose-parse-int.js';
import observe from '../helpers/selector-observer.js';
import {
	countInlineTestLines,
	type FileTestLines,
	getInlineTestFinder,
	isTestPath,
	parsePatch,
} from '../helpers/test-lines.js';

type PullFile = {
	filename: string;
	previous_filename?: string;
	status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
	additions: number;
	deletions: number;
	sha: string;
	patch?: string;
};

type Summary = {
	additions: number;
	deletions: number;
	testAdditions: number;
	testDeletions: number;
	unanalyzedFiles: number;
};

async function getBlob(sha: string): Promise<string> {
	const {content} = await api.v3(`git/blobs/${sha}`, {
		headers: {accept: 'application/vnd.github.raw+json'},
		responseFormat: 'text',
	});
	return content as string;
}

async function countFile(file: PullFile): Promise<FileTestLines | undefined> {
	const additions = isTestPath(file.filename) ? file.additions : 0;
	const deletions = isTestPath(file.previous_filename ?? file.filename) ? file.deletions : 0;
	if (additions === file.additions && deletions === file.deletions) {
		return {additions, deletions};
	}

	const finder = getInlineTestFinder(file.filename);
	if (!finder) {
		return {additions, deletions};
	}

	if (!file.patch) {
		// GitHub omits the patch of large files
		return undefined;
	}

	const status = file.status === 'added' || file.status === 'removed' ? file.status : 'modified';
	const newCode = status === 'modified' ? await getBlob(file.sha) : undefined;
	return countInlineTestLines(parsePatch(file.patch), finder, status, newCode);
}

async function getSummary(): Promise<Summary> {
	const files: PullFile[] = [];
	for await (const page of api.v3paginated(`pulls/${getConversationNumber()!}/files?per_page=100`)) {
		files.push(...page as unknown as PullFile[]);
	}

	const summary: Summary = {additions: 0, deletions: 0, testAdditions: 0, testDeletions: 0, unanalyzedFiles: 0};
	const counts = await Promise.all(files.map(async file => countFile(file)));
	for (const [index, file] of files.entries()) {
		summary.additions += file.additions;
		summary.deletions += file.deletions;
		const count = counts[index];
		if (count) {
			summary.testAdditions += count.additions;
			summary.testDeletions += count.deletions;
		} else {
			summary.unanalyzedFiles++;
		}
	}

	return summary;
}

const format = (number: number): string => number.toLocaleString('en-US');

async function add(diffstat: HTMLElement): Promise<void> {
	const summary = await getSummary();
	const tooltip = [
		`In tests: +${format(summary.testAdditions)} −${format(summary.testDeletions)}`,
		`Outside tests: +${format(summary.additions - summary.testAdditions)} −${format(summary.deletions - summary.testDeletions)}`,
	];

	// The files API stops at 3000 files, so the totals may not match GitHub's
	const shownAdditions = $optional(':scope > .color-fg-success', diffstat);
	const shownDeletions = $optional(':scope > .color-fg-danger', diffstat);
	const isIncomplete = looseParseInt(shownAdditions) !== summary.additions || looseParseInt(shownDeletions) !== summary.deletions;
	if (summary.unanalyzedFiles > 0) {
		tooltip.push(`${summary.unanalyzedFiles} large files not analyzed`);
	} else if (isIncomplete) {
		tooltip.push('Some files not analyzed');
	}

	diffstat.append(
		<span
			ref={withTooltipRef({label: tooltip.join(' · '), direction: 's'})}
			className="rgh-test-lines-changed ml-2 tmp-ml-2 color-fg-muted"
		>
			<BeakerIcon className="v-align-middle" />{' '}
			<span className="color-fg-success">+{format(summary.testAdditions)}</span>{' '}
			<span className="color-fg-danger">−{format(summary.testDeletions)}</span>
		</span>,
	);
}

function init(signal: AbortSignal): void {
	observe('#diffstat', add, {signal});
}

void features.add(import.meta.url, {
	include: [
		pageDetect.isPRFiles,
	],
	exclude: [
		pageDetect.isPRCommit,
		// Commit ranges, e.g. /pull/1/files/abc..def
		() => /\/pull\/\d+\/files\/./.test(location.pathname),
	],
	init,
});

/*

Test URLs:

Rust inline tests: https://togithub.com/rust-lang/rust-clippy/pull/14000/files
JS test files: https://github.com/refined-github/refined-github/pull/10378/files
No tests: https://github.com/refined-github/refined-github/pull/10394/files

*/
