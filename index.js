import escapeStringRegexp from 'escape-string-regexp';
import transliterate from '@sindresorhus/transliterate';
import builtinOverridableReplacements from './overridable-replacements.js';

// Placeholders for preserved characters are allocated from the Unicode private use area, as those code points pass through transliteration, decamelization, and lowercasing untouched and cannot be produced by any of them.
const PRIVATE_USE_AREA_START = 0xE0_00;
const PRIVATE_USE_AREA_END = 0xF8_FF;

const decamelize = string => string
	// Separate capitalized words.
	// Each pattern captures the least leading context it needs, as a greedy quantifier there causes quadratic backtracking on long runs of the same character class.
	// `FOO360` → `FOO 360`
	.replaceAll(/([A-Z]{2})(\d+)/g, '$1 $2')
	// `foo360BAR` → `foo360 BAR`, `fooBar` → `foo Bar`
	.replaceAll(/([a-z\d])([A-Z])/g, '$1 $2')
	// `APISection` → `API Section`. A lowercase `s` right after the acronym is a plural marker rather than the start of a new word, unless another lowercase letter follows it, so `APIs` is left alone while `APIUsage` is still separated.
	.replaceAll(/([A-Z])([A-Z](?!s(?![a-z]))[a-z\d]+)/g, '$1 $2');

const removeMootSeparators = (string, separator) => {
	const escapedSeparator = escapeStringRegexp(separator);

	return string
		.replaceAll(new RegExp(`(?:${escapedSeparator}){2,}`, 'g'), separator)
		.replaceAll(new RegExp(`^(?:${escapedSeparator})|(?:${escapedSeparator})$`, 'g'), '');
};

// Strip the trailing counter groups from a slug, so `foo-1-2` becomes `foo`. This is done with a split rather than a `(?:-\d+)+$` regex, as that pattern is unanchored and so retries at every `-` in the string, which is quadratic on input such as `-1-1-1…-1a`.
const removeCounterSuffix = string => {
	const parts = string.split('-');

	while (parts.length > 1 && /^\d+$/.test(parts.at(-1))) {
		parts.pop();
	}

	return parts.join('-');
};

// Swap preserved characters for private-use placeholders so they pass through transliteration, custom replacements, decamelization, and lowercasing exactly as they are. Longer entries are masked first so that overlapping entries behave deterministically.
const maskPreservedCharacters = (string, preserveCharacters) => {
	const placeholders = new Map();
	let codePoint = PRIVATE_USE_AREA_START;

	for (const character of [...new Set(preserveCharacters)].sort((a, b) => b.length - a.length)) {
		let placeholder;
		do {
			if (codePoint > PRIVATE_USE_AREA_END) {
				throw new Error(`Too many preserved characters: ran out of placeholder code points for ${preserveCharacters}`);
			}

			placeholder = String.fromCodePoint(codePoint);
			codePoint++;
		} while (string.includes(placeholder) || placeholders.has(placeholder));

		placeholders.set(placeholder, character);
		string = string.replaceAll(character, placeholder);
	}

	return {string, placeholders};
};

const unmaskPreservedCharacters = (string, placeholders) => {
	for (const [placeholder, character] of placeholders) {
		string = string.replaceAll(placeholder, character);
	}

	return string;
};

const normalizeHooks = (hooks, optionName) => {
	if (hooks === undefined) {
		return [];
	}

	const hookArray = Array.isArray(hooks) ? hooks : [hooks];

	for (const hook of hookArray) {
		if (typeof hook !== 'function') {
			throw new TypeError(`Expected the \`${optionName}\` option to be a function or an array of functions, got \`${typeof hook}\``);
		}
	}

	return hookArray;
};

const applyHooks = (hooks, string, optionName) => {
	for (const hook of hooks) {
		string = hook(string);

		if (typeof string !== 'string') {
			throw new TypeError(`Expected a \`${optionName}\` hook to return a string, got \`${typeof string}\``);
		}
	}

	return string;
};

const buildPatternSlug = options => {
	let negationSetPattern = String.raw`a-z\d`;
	negationSetPattern += options.lowercase ? '' : 'A-Z';

	// When transliteration is disabled, preserve Unicode characters
	if (options.transliterate === false) {
		negationSetPattern += String.raw`\p{L}\p{N}`;
	}

	if (options.preserveCharacters.length > 0) {
		for (const character of options.preserveCharacters) {
			if (character === options.separator) {
				throw new Error(`The separator character \`${options.separator}\` cannot be included in preserved characters: ${options.preserveCharacters}`);
			}

			negationSetPattern += escapeStringRegexp(character);
		}
	}

	const flags = options.transliterate ? 'g' : 'gu';
	return new RegExp(`[^${negationSetPattern}]+`, flags);
};

export default function slugify(string, options) {
	if (typeof string !== 'string') {
		throw new TypeError(`Expected a string, got \`${typeof string}\``);
	}

	options = {
		separator: '-',
		lowercase: true,
		decamelize: true,
		customReplacements: [],
		preserveLeadingUnderscore: false,
		preserveTrailingDash: false,
		preserveCharacters: [],
		transliterate: true,
		...options,
	};

	const preprocessHooks = normalizeHooks(options.preprocess, 'preprocess');
	const postprocessHooks = normalizeHooks(options.postprocess, 'postprocess');

	string = applyHooks(preprocessHooks, string, 'preprocess');

	const shouldPrependUnderscore = options.preserveLeadingUnderscore && string.startsWith('_');
	const shouldAppendDash = options.preserveTrailingDash && string.endsWith('-');

	// Mask the preserved characters before anything can rewrite them, so they reach the slug exactly as they appeared in the input.
	const masked = maskPreservedCharacters(string, options.preserveCharacters);
	string = masked.string;

	if (options.transliterate) {
		const customReplacements = new Map([
			...builtinOverridableReplacements,
			...options.customReplacements,
		]);

		string = transliterate(string, {customReplacements, locale: options.locale});
	} else if (options.customReplacements.length > 0) {
		// Apply custom replacements even when transliteration is disabled
		for (const [key, value] of options.customReplacements) {
			string = string.replaceAll(key, value);
		}
	}

	if (options.decamelize) {
		string = decamelize(string);
	}

	const patternSlug = buildPatternSlug(options);

	if (options.lowercase) {
		string = options.locale ? string.toLocaleLowerCase(options.locale) : string.toLowerCase();
	}

	// Restore the preserved characters before contraction collapsing and stripping, both of which need to see the actual characters.
	string = unmaskPreservedCharacters(string, masked.placeholders);

	// Drop the apostrophe from contractions and possessives so that `Conway's Law` becomes `conways-law` rather than `conway-s-law`. Only a word-final `'t` or `'s` qualifies, so `foo'sbar` is left alone, and both straight and curly apostrophes are handled. What counts as a word character has to be what survives into the slug, so it widens to Unicode alongside `buildPatternSlug` when transliteration is disabled. The `i` flag covers `DON'T` when the `lowercase` option is disabled.
	const contractionPattern = options.transliterate
		? /([a-z\d])['\u2019]([ts])(?![a-z\d])/gi
		: /([\p{L}\p{N}])['\u2019]([ts])(?![\p{L}\p{N}])/giu;

	string = string.replaceAll(contractionPattern, '$1$2');

	string = string.replace(patternSlug, options.separator);

	// A preserved backslash survives the stripping above, so it must not be removed here either.
	if (!options.preserveCharacters.includes('\\')) {
		string = string.replaceAll('\\', '');
	}

	if (options.separator) {
		string = removeMootSeparators(string, options.separator);
	}

	if (shouldPrependUnderscore) {
		string = `_${string}`;
	}

	if (shouldAppendDash) {
		string = `${string}-`;
	}

	string = applyHooks(postprocessHooks, string, 'postprocess');

	return string;
}

export function slugifyWithCounter() {
	const occurrences = new Map();
	const returned = new Set();

	const countable = (string, options) => {
		string = slugify(string, options);

		if (!string) {
			return '';
		}

		const stringLower = string.toLowerCase();
		const numberless = occurrences.get(removeCounterSuffix(stringLower)) || 0;
		const counter = occurrences.get(stringLower);
		occurrences.set(stringLower, typeof counter === 'number' ? counter + 1 : 1);
		let newCounter = occurrences.get(stringLower) || 2;
		let result = newCounter >= 2 || numberless > 2 ? `${string}-${newCounter}` : string;

		// The counter is keyed on the incoming slug, so it cannot see a slug that was previously handed out by appending a counter to a *different* input. Without this loop, `foo`, `foo`, `foo 2` would return `foo-2` twice. Keep bumping the counter until the result is one that has not been returned before.
		while (returned.has(result.toLowerCase())) {
			newCounter += 1;
			occurrences.set(stringLower, newCounter);
			result = `${string}-${newCounter}`;
		}

		returned.add(result.toLowerCase());

		return result;
	};

	countable.reset = () => {
		occurrences.clear();
		returned.clear();
	};

	return countable;
}
