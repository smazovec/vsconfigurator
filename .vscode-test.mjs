import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	version: '1.125.0',
	files: 'out/test/**/*.test.js',
	workspaceFolder: '.',
});
