export interface ParsedSearchQuery {
    raw: string;
    term: string;
    textPattern: string;
    exact: boolean;
}

/**
 * IDEA-style query normalization: outer quotes request an exact text literal,
 * while name-based contributors still search using the unquoted term.
 */
export function parseSearchQuery(value: string): ParsedSearchQuery {
    const raw = value.trim();
    const quote = raw[0];
    const exact = raw.length >= 2 &&
        (quote === '"' || quote === "'") &&
        raw[raw.length - 1] === quote;
    const term = exact ? raw.slice(1, -1).trim() : raw;

    return {
        raw,
        term,
        textPattern: exact ? raw : term,
        exact
    };
}
