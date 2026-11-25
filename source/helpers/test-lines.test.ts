import {assert, test} from 'vitest';

import {
	countInlineTestLines,
	getInlineTestFinder,
	isRustTestAttribute,
	isTestPath,
	parsePatch,
	reconstructOld,
	rustTestRanges,
} from './test-lines.js';

test('isTestPath', () => {
	assert.isTrue(isTestPath('source/foo.test.ts'));
	assert.isTrue(isTestPath('pkg/server_test.go'));
	assert.isTrue(isTestPath('tests/integration.rs'));
	assert.isTrue(isTestPath('src/parser/tests.rs'));
	assert.isTrue(isTestPath('app/src/test/java/FooTest.java'));
	assert.isTrue(isTestPath('lib/__snapshots__/a.ts.snap'));
	assert.isFalse(isTestPath('src/lib.rs'));
	assert.isFalse(isTestPath('source/features/latest-tag.tsx'));
	assert.isFalse(isTestPath('src/contest.py'));
});

test('isRustTestAttribute', () => {
	assert.isTrue(isRustTestAttribute('test'));
	assert.isTrue(isRustTestAttribute('tokio::test(flavor = "multi_thread")'));
	assert.isTrue(isRustTestAttribute('cfg(test)'));
	assert.isTrue(isRustTestAttribute('cfg(all(test, feature = "x"))'));
	assert.isTrue(isRustTestAttribute('cfg(any(test, all(test, unix)))'));
	assert.isFalse(isRustTestAttribute('cfg(not(test))'));
	assert.isFalse(isRustTestAttribute('cfg(any(test, feature = "x"))'));
	assert.isFalse(isRustTestAttribute('cfg_attr(test, derive(Debug))'));
	assert.isFalse(isRustTestAttribute('derive(Debug)'));
	assert.isFalse(isRustTestAttribute('testing'));
});

const rust = `fn main() {
    let s = "#[cfg(test)] mod fake { }";
    let c = '}';
}

/* a comment with #[test] and { */
fn helper<'a>(x: &'a str) -> &'a str { x }

#[cfg(test)]
#[allow(dead_code)]
mod tests {
    use super::*;

    #[test]
    fn works() {
        let raw = r#"}"#;
        assert_eq!(helper("x"), "x");
    }
}

#[cfg(not(test))]
fn production() {}
`;

test('rustTestRanges', () => {
	assert.deepEqual(rustTestRanges(rust), [[9, 19]]);
	assert.deepEqual(rustTestRanges('#![cfg(test)]\nfn a() {}\n'), [[1, 3]]);
	assert.deepEqual(rustTestRanges('#[cfg(test)]\nmod tests;\nfn a() {}'), [[1, 2]]);
	assert.deepEqual(rustTestRanges('mod a {\n    #![cfg(test)]\n    fn b() {}\n}\nfn c() {}'), [[1, 4]]);
});

test('zig and d finders', () => {
	const zig = getInlineTestFinder('src/main.zig')!;
	assert.deepEqual(zig('fn a() void {}\ntest "a {" {\n    try a();\n}\n'), [[2, 4]]);
	const d = getInlineTestFinder('source/app.d')!;
	assert.deepEqual(d('void a() {}\nunittest\n{\n    a();\n}\n'), [[2, 5]]);
	assert.isUndefined(getInlineTestFinder('src/main.ts'));
});

test('reconstructOld', () => {
	const oldCode = 'a\nb\nc\nd\ne\nf\ng';
	const newCode = 'a\nB\nc\nd\ne\ng\nh';
	const patch = [
		'@@ -1,3 +1,3 @@',
		' a',
		'-b',
		'+B',
		' c',
		'@@ -5,3 +5,3 @@',
		' e',
		'-f',
		' g',
		'+h',
		'\\ No newline at end of file',
	].join('\n');
	assert.equal(reconstructOld(newCode, parsePatch(patch)), oldCode);

	// A file that gained lines at the very top
	assert.equal(reconstructOld('x\na', parsePatch('@@ -0,0 +1 @@\n+x')), 'a');
});

test('countInlineTestLines', () => {
	const newCode = 'fn a() {}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() {}\n}';
	const patch = [
		'@@ -1,4 +1,7 @@',
		'-fn old() {}',
		'+fn a() {}',
		' ',
		' #[cfg(test)]',
		' mod tests {',
		'+    #[test]',
		'+    fn t() {}',
		'+}',
	].join('\n');
	const counts = countInlineTestLines(parsePatch(patch), rustTestRanges, 'modified', newCode);
	assert.deepEqual(counts, {additions: 3, deletions: 0});

	const added = countInlineTestLines(parsePatch('@@ -0,0 +1,3 @@\n+fn a() {}\n+#[test]\n+fn t() {}'), rustTestRanges, 'added');
	assert.deepEqual(added, {additions: 2, deletions: 0});
});
