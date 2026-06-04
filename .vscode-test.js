const path = require('path');
const fs = require('fs');
const { defineConfig } = require('@vscode/test-cli');

function resolveVsCodeExecutable() {
    const candidates = [
        process.env.VSCODE_TEST_EXECUTABLE,
        '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
        '/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Electron'
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

const vscodeExecutable = resolveVsCodeExecutable();

module.exports = defineConfig({
    files: 'out/test/**/*.test.js',
    extensionDevelopmentPath: __dirname,
    workspaceFolder: path.join(__dirname, 'test-fixtures', 'sample-workspace'),
    useInstallation: vscodeExecutable
        ? { fromPath: vscodeExecutable }
        : { fromMachine: true },
    launchArgs: [
        '--disable-extensions'
    ],
    mocha: {
        timeout: 30000
    }
});
