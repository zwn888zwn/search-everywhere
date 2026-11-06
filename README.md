<p align="center">
  <img width="150" height="150" src="https://github.com/persiyanov/search-everywhere/blob/main/assets/icon.png?raw=true">
</p>

# Search Everywhere for VSCode

A fast, fuzzy "Search Everywhere" feature for VSCode, inspired by the IntelliJ/PyCharm functionality. This extension provides a unified search interface for files, classes, symbols, and commands with intelligent prioritization and filtering.

## Features

- **Fast Fuzzy Search** across multiple sources:
  - Files in your workspace
  - Classes (classes, interfaces, enums)
  - Symbols (functions, methods, variables)
  - Commands/Actions in VSCode
  
- **PyCharm-Style Navigation**:
  - Tab-style filter categories (All, Classes, Files, Symbols, Actions)
  - Dedicated "Classes" filter for quick class navigation
  - Clean UI with category headers and line numbers
  - Instant results as you type
  - Filter reset when reopening the dialog

- **Intelligent Prioritization**:
  - Classes and methods prioritized over variables
  - Personalized results based on your activity
  - Cleaner results with duplicate removal
  - Relative file paths for better readability

- **Real-time Indexing**:
  - New symbols appear in search results immediately after file changes
  - Seamless tracking of file modifications, additions, and deletions
  - Intelligent debouncing to avoid excessive reindexing

- **Optimized Performance**:
  - Fast startup and search times
  - Background indexing to avoid UI freezes
  - Configurable fuzzy search libraries
  - Automatic exclusion of binary and output files
  
## Usage

1. Press `Shift+Shift` to open **Search Everywhere**.
2. Choose All, Classes, Files, Symbols, Actions, or Text and type your query.
3. **Single-click or use Up/Down** to select results. The lower code preview updates continuously while the query and candidate list remain available. Previewing never opens a source editor tab or executes an action.
4. **Double-click, press Enter, or click Open** to open the chosen result and close the search panel.
5. Use the preview button to hide or show the lower preview without losing the search, and drag the divider to resize it. `Escape` closes the search.

The integrated layout is inspired by IDEA's Search Everywhere preview. VS Code hosts it in a dedicated **editor panel**, not in its native floating Quick Pick. The panel reads context from the current document (including unsaved edits), shows real line numbers and syntax highlighting, and highlights the selected match. Large or binary files show a preview message and can still be opened explicitly.

The previous floating UI remains available as **Search Everywhere: Classic Quick Pick** in the Command Palette. Search providers, ranking, query syntax, exclusions, and result limits are shared by both interfaces.

## Configuration

### Indexing Options

Control what gets indexed and included in search results:

```json
"searchEverywhere.indexing.includeFiles": true,
"searchEverywhere.indexing.includeSymbols": true,
"searchEverywhere.indexing.includeCommands": true
```

### Exclusion Patterns

Configure global exclusion patterns that apply to all search providers (files, symbols, etc.):

```json
"searchEverywhere.exclusions": [
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
  "**/*.min.js"
]
```

These patterns are added to the built-in exclusions, which already filter out common binary files, build directories, and system files.

### Activity Tracking

Configure how user activity affects search results:

```json
"searchEverywhere.activity.enabled": true,
"searchEverywhere.activity.weight": 0.5
```

The weight value (0-1) determines how much your activity influences the results:

- `0`: Only relevance to search query matters
- `1`: Only frequency of use matters
- `0.5`: Equal balance between relevance and frequency

### Performance Settings

Optimize performance based on your needs:

```json
"searchEverywhere.performance.maxResults": 100
```

### Fuzzy Search Library

Choose between different fuzzy search implementations:

```json
"searchEverywhere.fuzzySearch.library": "fuzzysort"
```

Available options:

- `fuzzysort`: Generally faster, especially for large datasets
- `fuzzaldrin-plus`: May provide better relevance for certain queries

## Keyboard Shortcuts

- `Shift+Shift`: Open Search Everywhere

## Roadmap

- Add persistent activity history across sessions
- Add text search capability
- Add benchmark visualization
- Add custom search result templates
- Add search history
- Improve scoring algorithms for better relevance

## Development

### Building the Extension

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Build production extension files in dist/
npm run package

# Build an installable VS Code extension package
npm run vsix
```

The `npm run vsix` command creates a `.vsix` file in the project root, for example:

```text
search-everywhere-0.1.5.vsix
```

Install it manually with:

```bash
code --install-extension search-everywhere-0.1.5.vsix
```

### Testing the Extension

1. Press F5 in VSCode to launch a development host with the extension loaded
2. Run the "Search Everywhere" command

## License

MIT

## Acknowledgements

Inspired by JetBrains' "Search Everywhere" functionality in IntelliJ IDEA, PyCharm, and other IDEs.

Built by Cursor with ❤️, under human supervision.
