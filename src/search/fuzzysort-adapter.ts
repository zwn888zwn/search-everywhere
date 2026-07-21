import { FuzzySearcher, SearchItem } from '../core/types';

/**
 * Fast name/path matcher used for Search Everywhere.
 *
 * The old implementation allocated a new fuzzysort target object for every item
 * on every keystroke. In large workspaces that makes input feel blocked. This
 * matcher keeps the hot path allocation-light and scores only label + relative
 * path, similar to IDE "go to name" search.
 */
export class FuzzysortAdapter implements FuzzySearcher {
    public readonly name = 'fuzzysort';

    /**
     * Search items using fuzzysort
     */
    public async search(items: SearchItem[], query: string, limit = 100): Promise<SearchItem[]> {
        const normalizedQuery = query.trim();

        if (!normalizedQuery) {
            return items.slice(0, limit);
        }

        const matches: Array<{ item: SearchItem; score: number }> = [];
        const trimAt = Math.max(limit * 4, limit + 50);

        for (const item of items) {
            const score = scoreItem(item, normalizedQuery);

            if (score <= 0) {
                continue;
            }

            item.score = score / 10000;
            matches.push({ item, score });

            if (matches.length > trimAt) {
                matches.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));
                matches.length = limit;
            }
        }

        matches.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));

        return matches.slice(0, limit).map(match => match.item);
    }
}

function scoreItem(item: SearchItem, query: string): number {
    const label = item.label || '';
    const pathText = `${item.description || ''}`;
    let matchScore = scoreText(label, query, 10000);

    if (pathText) {
        matchScore = Math.max(matchScore, scoreText(pathText, query, 6500));
    }

    return matchScore > 0 ? matchScore + (item.priority || 0) : 0;
}

function scoreText(text: string, query: string, base: number): number {
    const normalizedText = normalize(text);
    const normalizedQuery = normalize(query);

    if (!normalizedText || !normalizedQuery) {
        return 0;
    }

    if (normalizedText === normalizedQuery) {
        return text === query ? base + 250 : base;
    }

    if (normalizedText.startsWith(normalizedQuery)) {
        return text.startsWith(query) ? base - 350 : base - 500;
    }

    const index = normalizedText.indexOf(normalizedQuery);

    if (index >= 0) {
        return base - 1500 - Math.min(index, 500);
    }

    return Math.max(
        getIdeaNameMatchScore(text, query, base - 2500),
        scoreSubsequence(normalizedText, normalizedQuery, base - 3500)
    );
}

/**
 * IDEA-style lowercase camel-hump matcher.
 *
 * A pattern may continue inside a word or jump to the start of a later word.
 * Word starts include camel-case transitions, separators and letter/digit
 * transitions. The search backtracks across possible humps, so `replmap` can
 * skip `Macro` and match the later `Map` in `ReplacePathToMacroMap`.
 */
export function getIdeaNameMatchScore(name: string, pattern: string, base = 7500): number {
    const trimmedPattern = pattern.trim();

    if (!name || !trimmedPattern || trimmedPattern.length > 100) {
        return 0;
    }

    const meaningfulLength = [...trimmedPattern].filter(char => char !== '*' && char !== ' ').length;

    if (meaningfulLength === 0 || meaningfulLength > name.length) {
        return 0;
    }

    const memo = new Map<string, number>();

    const matchFrom = (patternIndex: number, previousNameIndex: number, jumpMode: number): number => {
        while (patternIndex < trimmedPattern.length && (trimmedPattern[patternIndex] === '*' || trimmedPattern[patternIndex] === ' ')) {
            jumpMode = trimmedPattern[patternIndex] === '*' ? 2 : Math.max(jumpMode, 1);
            patternIndex++;
        }

        if (patternIndex >= trimmedPattern.length) {
            return 1;
        }

        const memoKey = `${patternIndex}:${previousNameIndex}:${jumpMode}`;
        const cached = memo.get(memoKey);

        if (cached !== undefined) {
            return cached;
        }

        const patternChar = trimmedPattern[patternIndex];
        const startIndex = previousNameIndex + 1;
        let best = 0;

        for (let nameIndex = startIndex; nameIndex < name.length; nameIndex++) {
            if (!equalsIgnoreCase(name[nameIndex], patternChar)) {
                continue;
            }

            const isFirstMatch = previousNameIndex < 0;
            const isContiguous = nameIndex === startIndex;
            const isHumpStart = isWordStart(name, nameIndex);
            const canMatchHere = isContiguous || jumpMode === 2 || isHumpStart;

            if (!canMatchHere || (isFirstMatch && jumpMode !== 2 && !isHumpStart)) {
                continue;
            }

            if (patternIndex > 0 && /\d/.test(patternChar) && /\d/.test(trimmedPattern[patternIndex - 1]) && !isContiguous) {
                continue;
            }

            const remainder = matchFrom(patternIndex + 1, nameIndex, 0);

            if (remainder <= 0) {
                continue;
            }

            const gap = previousNameIndex < 0 ? nameIndex : nameIndex - previousNameIndex - 1;
            let score = remainder + (isContiguous ? 80 : 25) + (isHumpStart ? 70 : 0);

            if (isFirstMatch && nameIndex === 0) {
                score += 300;
            }

            if (name[nameIndex] === patternChar) {
                score += /[A-Z]/.test(patternChar) ? 50 : 20;
            }

            if (patternIndex === trimmedPattern.length - 1 && nameIndex === name.length - 1) {
                score += 10;
            }

            score -= Math.min(gap, 50) * 3;
            best = Math.max(best, score);
        }

        memo.set(memoKey, best);

        return best;
    };

    const quality = matchFrom(0, -1, trimmedPattern.startsWith('*') ? 2 : 0);

    return quality > 0 ? Math.max(1, base + quality - Math.min(name.length, 300)) : 0;
}

function scoreSubsequence(text: string, query: string, base: number): number {
    let firstMatch = -1;
    let lastMatch = -1;
    let score = base;

    for (const char of query) {
        const match = text.indexOf(char, lastMatch + 1);

        if (match === -1) {
            return 0;
        }

        if (firstMatch === -1) {
            firstMatch = match;
        }

        if (lastMatch >= 0) {
            score -= Math.min(match - lastMatch - 1, 20) * 20;
        }

        if (isBoundary(text, match)) {
            score += 250;
        }

        lastMatch = match;
    }

    const span = lastMatch - firstMatch + 1;

    if (span > query.length * 4 + 16) {
        return 0;
    }

    return Math.max(1, score - Math.min(text.length, 300));
}

function isBoundary(text: string, index: number): boolean {
    if (index === 0) {
        return true;
    }

    const previous = text[index - 1];

    return previous === '/' ||
        previous === '_' ||
        previous === '-' ||
        previous === '.' ||
        previous === ' ';
}

function isWordStart(text: string, index: number): boolean {
    if (index === 0) {
        return true;
    }

    const current = text[index];
    const previous = text[index - 1];
    const next = text[index + 1] || '';

    if (!/[A-Za-z0-9]/.test(previous)) {
        return true;
    }

    if (/\d/.test(current)) {
        return true;
    }

    if (/\d/.test(previous) && /[A-Za-z]/.test(current)) {
        return true;
    }

    if (/[a-z]/.test(previous) && /[A-Z]/.test(current)) {
        return true;
    }

    return /[A-Z]/.test(previous) && /[A-Z]/.test(current) && /[a-z]/.test(next);
}

function equalsIgnoreCase(left: string, right: string): boolean {
    return left === right || left.toLowerCase() === right.toLowerCase();
}

function normalize(value: string): string {
    return value.trim().toLowerCase();
}
