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
        const normalizedQuery = normalize(query);

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
    const label = normalize(item.label);
    const pathText = normalize(`${item.description || ''}`);
    let matchScore = scoreText(label, query, 10000);

    if (pathText) {
        matchScore = Math.max(matchScore, scoreText(pathText, query, 6500));
    }

    return matchScore > 0 ? matchScore + (item.priority || 0) : 0;
}

function scoreText(text: string, query: string, base: number): number {
    if (!text) {
        return 0;
    }

    if (text === query) {
        return base;
    }

    if (text.startsWith(query)) {
        return base - 500;
    }

    const index = text.indexOf(query);

    if (index >= 0) {
        return base - 1500 - Math.min(index, 500);
    }

    return scoreSubsequence(text, query, base - 3500);
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

function normalize(value: string): string {
    return value.trim().toLowerCase();
}
