/*
Classify the lines of a diff as test code or not.

Whole files are recognised by path conventions. Rust, Zig and D keep unit tests
beside the code they test, so for those languages the file contents are scanned
for test blocks (`#[cfg(test)]` modules, `#[test]` functions, `test {}` blocks,
`unittest {}` blocks) and only the lines inside them are counted as test lines.
*/

type Range = [start: number, end: number]; // 1-based, inclusive

const testDirectory = /(?:^|\/)(?:tests?|__tests__|__mocks__|__snapshots__|__fixtures__|specs?|testing|test-?data|fixtures|e2e)\//i;

const testFilePatterns: RegExp[] = [
	/\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/, // JS, TS
	/\.(?:test|spec)\.(?:vue|svelte)$/,
	/\.snap$/,
	/_test\.go$/,
	/(?:^|\/)test_[^/]*\.py$/,
	/_tests?\.py$/,
	/(?:^|\/)(?:conftest|tests)\.py$/,
	/(?:^|\/)src\/\w*[Tt]est\w*\//, // Java, Kotlin, Scala: src/test, src/androidTest, src/integrationTest, src/testFixtures
	/(?:Tests?|IT)\.(?:java|kt|kts|scala|cs|php|swift)$/,
	/(?:Spec|Suite)\.scala$/,
	/\.Tests?\//, // C# test projects
	/_(?:spec|test)\.rb$/,
	/_test\.exs$/,
	/(?:_test|_unittest)\.(?:c|cc|cpp|cxx|h|hpp)$/,
	/(?:^|\/)test_[^/]*\.(?:c|cc|cpp|cxx|h|hpp)$/,
	/(?:^|\/)(?:tests?|[^/]+_tests?)\.rs$/, // `mod tests;` declared next to the code
	/(?:^|\/)benches\//,
];

export function isTestPath(path: string): boolean {
	return testDirectory.test(path) || testFilePatterns.some(pattern => pattern.test(path));
}

/** Offset just past the block comment starting at `start` */
function blockCommentEnd(code: string, start: number, isNesting: boolean): number {
	let depth = 0;
	let cursor = start;
	while (cursor < code.length) {
		const pair = code.slice(cursor, cursor + 2);
		if (pair === '/*') {
			depth++;
			cursor += 2;
		} else if (pair === '*/') {
			depth--;
			cursor += 2;
			if (depth === 0 || !isNesting) {
				return cursor;
			}
		} else {
			cursor++;
		}
	}

	return cursor;
}

/** Length of the character literal at `index`, or 0, as with a Rust lifetime or label like 'a */
function characterLiteralLength(code: string, index: number): number {
	if (code[index] !== '\'') {
		return 0;
	}

	const literal = /^'(?:\\(?:u\{[\da-f]+\}|x[\da-f]{2}|.)|[^\n'\\])'/i.exec(code.slice(index, index + 12));
	return literal ? literal[0].length : 0;
}

/** Blank out comments and the contents of string and character literals, keeping newlines and length */
export function maskCode(code: string, language: 'rust' | 'c-like'): string {
	const output = code.split(''); // UTF-16 units, to keep offsets aligned with `code`
	const blank = (from: number, to: number): void => {
		for (let index = from; index < to; index++) {
			if (output[index] !== '\n') {
				output[index] = ' ';
			}
		}
	};

	let index = 0;
	while (index < code.length) {
		const char = code[index];
		const next = code[index + 1];

		if (char === '/' && next === '/') {
			const end = code.indexOf('\n', index);
			const stop = end === -1 ? code.length : end;
			blank(index, stop);
			index = stop;
			continue;
		}

		if (char === '/' && next === '*') {
			const cursor = blockCommentEnd(code, index, language === 'rust');
			blank(index, cursor);
			index = cursor;
			continue;
		}

		if (language === 'rust' && (char === 'r' || (char === 'b' && next === 'r'))) {
			const raw = /^b?r(?<hashes>#*)"/.exec(code.slice(index, index + 260));
			if (raw && !/\w/.test(code[index - 1] ?? '')) {
				const closing = '"' + raw.groups!.hashes;
				const contentStart = index + raw[0].length;
				const end = code.indexOf(closing, contentStart);
				const stop = end === -1 ? code.length : end;
				blank(contentStart, stop);
				index = stop + closing.length;
				continue;
			}
		}

		if (char === '"') {
			let cursor = index + 1;
			while (cursor < code.length && code[cursor] !== '"') {
				cursor += code[cursor] === '\\' ? 2 : 1;
			}

			blank(index + 1, cursor);
			index = cursor + 1;
			continue;
		}

		const literalLength = characterLiteralLength(code, index);
		if (literalLength > 0) {
			blank(index + 1, index + literalLength - 1);
			index += literalLength;
			continue;
		}

		index++;
	}

	return output.join('');
}

function lineStarts(code: string): number[] {
	const starts = [0];
	for (const match of code.matchAll(/\n/g)) {
		starts.push(match.index + 1);
	}

	return starts;
}

function lineOf(starts: number[], offset: number): number {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (starts[middle] <= offset) {
			low = middle;
		} else {
			high = middle - 1;
		}
	}

	return low + 1;
}

const closers = new Map([['(', ')'], ['[', ']'], ['{', '}']]);

/** Offset of the bracket that closes the one at `open`, in masked code */
function matchBracket(masked: string, open: number): number {
	const stack: string[] = [];
	for (let index = open; index < masked.length; index++) {
		const char = masked[index];
		if (closers.has(char)) {
			stack.push(closers.get(char)!);
		} else if (')]}'.includes(char)) {
			stack.pop();
			if (stack.length === 0) {
				return index;
			}
		}
	}

	return masked.length - 1;
}

/** End offset of the item starting at `from`: its closing `}` or its `;`, whichever comes first at depth 0 */
function itemEnd(masked: string, from: number): number {
	for (let index = from; index < masked.length; index++) {
		const char = masked[index];
		if (char === ';') {
			return index;
		}

		if (char === '{') {
			return matchBracket(masked, index);
		}

		if (char === '(' || char === '[') {
			index = matchBracket(masked, index);
		}
	}

	return masked.length - 1;
}

/** Whether a `cfg(...)` predicate can only hold when compiling tests */
function configRequiresTest(predicate: string): boolean {
	predicate = predicate.trim();
	const call = /^(?<operator>all|any|not)\s*\((?<inner>[\s\S]*)\)$/.exec(predicate);
	if (!call) {
		return predicate === 'test';
	}

	const {operator, inner} = call.groups!;
	if (operator === 'not') {
		return false;
	}

	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const char of inner) {
		if (char === ',' && depth === 0) {
			parts.push(current);
			current = '';
			continue;
		}

		depth += char === '(' ? 1 : char === ')' ? -1 : 0;
		current += char;
	}

	parts.push(current);
	const predicates = parts.filter(part => part.trim());
	return operator === 'all'
		? predicates.some(part => configRequiresTest(part))
		: predicates.length > 0 && predicates.every(part => configRequiresTest(part));
}

// Attributes that turn a function into a test: #[test], #[tokio::test], #[test_case(…)], #[rstest], …
const rustTestMacro = /^(?:\w+::)*(?:test|test_case|test_log|rstest|quickcheck|wasm_bindgen_test|bench)\b/;

export function isRustTestAttribute(content: string): boolean {
	content = content.trim();
	const config = /^cfg\s*\((?<predicate>[\s\S]*)\)$/.exec(content);
	if (config) {
		return configRequiresTest(config.groups!.predicate);
	}

	return rustTestMacro.test(content);
}

function mergeRanges(ranges: Range[]): Range[] {
	const merged: Range[] = [];
	for (const [start, end] of ranges.toSorted((a, b) => a[0] - b[0])) {
		const last = merged.at(-1);
		if (last && start <= last[1] + 1) {
			last[1] = Math.max(last[1], end);
		} else {
			merged.push([start, end]);
		}
	}

	return merged;
}

/** Offset of the `{` that encloses `offset`, or -1 at the top level */
function enclosingBrace(masked: string, offset: number): number {
	let depth = 0;
	for (let index = offset - 1; index >= 0; index--) {
		if (masked[index] === '}') {
			depth++;
		} else if (masked[index] === '{') {
			if (depth === 0) {
				return index;
			}

			depth--;
		}
	}

	return -1;
}

export function rustTestRanges(code: string): Range[] {
	const masked = maskCode(code, 'rust');
	const starts = lineStarts(masked);
	const ranges: Range[] = [];
	const attribute = /#(?<inner>!?)\[/g;
	for (const match of masked.matchAll(attribute)) {
		const open = match.index + match[0].length - 1;
		const close = matchBracket(masked, open);
		// Use the original code so `cfg(feature = "x")` keeps its value
		if (!isRustTestAttribute(code.slice(open + 1, close))) {
			continue;
		}

		const attributeStart = match.index;
		if (match.groups!.inner) {
			// Inner attribute: the whole enclosing module, or the whole file
			const enclosing = enclosingBrace(masked, attributeStart);
			if (enclosing === -1) {
				return [[1, starts.length]];
			}

			const lineStart = masked.lastIndexOf('\n', enclosing) + 1;
			ranges.push([lineOf(starts, lineStart), lineOf(starts, matchBracket(masked, enclosing))]);
			continue;
		}

		// Skip any further attributes on the same item, then find its end
		let cursor = close + 1;
		while (true) {
			const rest = /^\s*#\[/.exec(masked.slice(cursor, cursor + 2000));
			if (!rest) {
				break;
			}

			cursor = matchBracket(masked, cursor + rest[0].length - 1) + 1;
		}

		ranges.push([lineOf(starts, attributeStart), lineOf(starts, itemEnd(masked, cursor))]);
	}

	return mergeRanges(ranges);
}

/** Zig `test "name" {}` and D `unittest {}` blocks */
function blockTestRanges(code: string, keyword: RegExp): Range[] {
	const masked = maskCode(code, 'c-like');
	const starts = lineStarts(masked);
	const ranges: Range[] = [];
	for (const match of masked.matchAll(keyword)) {
		const open = masked.indexOf('{', match.index);
		if (open === -1) {
			continue;
		}

		ranges.push([lineOf(starts, match.index), lineOf(starts, matchBracket(masked, open))]);
	}

	return mergeRanges(ranges);
}

const inlineTestFinders: Record<string, (code: string) => Range[]> = {
	rs: rustTestRanges,
	zig: code => blockTestRanges(code, /^[\t ]*test\b[^\n;{]*(?=\{)/gm),
	d: code => blockTestRanges(code, /^[\t ]*(?:@\w+\s+|\w+\s+)*unittest\s*(?=\{)/gm),
};

export function getInlineTestFinder(path: string): ((code: string) => Range[]) | undefined {
	const extension = /\.(?<extension>\w+)$/.exec(path)?.groups!.extension;
	return extension ? inlineTestFinders[extension] : undefined;
}

export function isInRanges(line: number, ranges: Range[]): boolean {
	return ranges.some(([start, end]) => start <= line && line <= end);
}

export type PatchLine = {
	type: '+' | '-' | ' ';
	text: string;
	oldLine?: number;
	newLine?: number;
};

export type Hunk = {
	oldStart: number;
	newStart: number;
	lines: PatchLine[];
};

/** Parse the `patch` field of the REST files API: a unified diff with no file headers */
export function parsePatch(patch: string): Hunk[] {
	const hunks: Hunk[] = [];
	let oldLine = 0;
	let newLine = 0;
	for (const raw of patch.split('\n')) {
		const header = /^@@ -(?<oldStart>\d+)(?:,\d+)? \+(?<newStart>\d+)(?:,\d+)? @@/.exec(raw);
		if (header) {
			oldLine = Number(header.groups!.oldStart);
			newLine = Number(header.groups!.newStart);
			hunks.push({oldStart: oldLine, newStart: newLine, lines: []});
			continue;
		}

		const hunk = hunks.at(-1);
		const type = raw[0] as PatchLine['type'];
		if (!hunk || !['+', '-', ' '].includes(type)) {
			continue; // Includes "\ No newline at end of file"
		}

		const text = raw.slice(1);
		if (type === '+') {
			hunk.lines.push({type, text, newLine: newLine++});
		} else if (type === '-') {
			hunk.lines.push({type, text, oldLine: oldLine++});
		} else {
			hunk.lines.push({type, text, oldLine: oldLine++, newLine: newLine++});
		}
	}

	return hunks;
}

/** Rebuild the old file from the new one by undoing each hunk */
export function reconstructOld(newCode: string, hunks: Hunk[]): string {
	const newLines = newCode.split('\n');
	const oldLines: string[] = [];
	let cursor = 1; // Next new line to copy
	for (const hunk of hunks) {
		// An empty side reports start 0, meaning "after line 0"
		const firstNewLine = hunk.lines.find(line => line.newLine !== undefined)?.newLine ?? (hunk.newStart + 1);
		while (cursor < firstNewLine) {
			oldLines.push(newLines[cursor - 1]);
			cursor++;
		}

		for (const line of hunk.lines) {
			if (line.type !== '+') {
				oldLines.push(line.text);
			}

			if (line.type !== '-') {
				cursor++;
			}
		}
	}

	while (cursor <= newLines.length) {
		oldLines.push(newLines[cursor - 1]);
		cursor++;
	}

	return oldLines.join('\n');
}

export type FileTestLines = {
	additions: number;
	deletions: number;
};

/**
Count the added and removed lines of one file that are test code.
`newCode` is only needed for modified files with an inline finder; added and deleted files are fully contained in the patch.
*/
export function countInlineTestLines(
	hunks: Hunk[],
	finder: (code: string) => Range[],
	status: 'added' | 'removed' | 'modified',
	newCode?: string,
): FileTestLines {
	const allLines = hunks.flatMap(hunk => hunk.lines);
	const patchSide = (type: '+' | '-'): string => allLines.filter(line => line.type !== (type === '+' ? '-' : '+')).map(line => line.text).join('\n');
	const newSource = status === 'removed' ? '' : (status === 'added' ? patchSide('+') : newCode!);
	const oldSource = status === 'added' ? '' : (status === 'removed' ? patchSide('-') : reconstructOld(newSource, hunks));
	const newRanges = newSource ? finder(newSource) : [];
	const oldRanges = oldSource ? finder(oldSource) : [];

	let additions = 0;
	let deletions = 0;
	for (const line of allLines) {
		if (line.type === '+' && isInRanges(line.newLine!, newRanges)) {
			additions++;
		} else if (line.type === '-' && isInRanges(line.oldLine!, oldRanges)) {
			deletions++;
		}
	}

	return {additions, deletions};
}
