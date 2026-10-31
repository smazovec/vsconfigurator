// Изолированный smoke-тест штатных команд view в VS Code, без проекта и md-sparrow.
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

exports.run = async function () {
	const vscode = require('vscode');
	await vscode.workspace.getConfiguration('1c-platform-tools').update('components.autoload.metadataJar', false, vscode.ConfigurationTarget.Workspace);
	await vscode.workspace.getConfiguration('1c-platform-tools').update('ipc.enabled', false, vscode.ConfigurationTarget.Workspace);
	const extension = vscode.extensions.getExtension('smazovec.vsconfigurator');
	assert.ok(extension);
	await extension.activate();
	const ids = await vscode.commands.getCommands(true);
	for (const id of ['1c-platform-tools-metadata-search.focus', '1c-platform-tools-metadata-filters.focus']) {
		assert.ok(ids.includes(id), id);
	}
	await vscode.commands.executeCommand('setContext', '1c-platform-tools.is1CProject', true);
	await vscode.commands.executeCommand('1c-platform-tools-metadata-search.focus');
	await vscode.commands.executeCommand('1c-platform-tools-metadata-filters.focus');
	await vscode.commands.executeCommand('workbench.view.explorer');
	await vscode.commands.executeCommand('setContext', '1c-platform-tools.is1CProject', false);
	console.log(`NAVIGATOR_SMOKE_OK: VS Code ${vscode.version}; расширение активировано, search.focus, filters.focus и Explorer выполнены`);
};

if (require.main === module) {
	const { runTests } = require('@vscode/test-electron');
	const root = path.resolve(__dirname, '..');
	const workspace = path.join(root, '.vscode-test', 'navigator-smoke-workspace');
	fs.mkdirSync(workspace, { recursive: true });
	runTests({
		version: '1.125.0',
		extensionDevelopmentPath: root,
		extensionTestsPath: __filename,
		launchArgs: [workspace, '--user-data-dir=' + path.join(root, '.vscode-test', 'navigator-smoke-profile'),
			'--disable-extensions', '--skip-release-notes', '--skip-welcome', '--disable-workspace-trust'],
	}).catch(error => { console.error(error); process.exitCode = 1; });
}
