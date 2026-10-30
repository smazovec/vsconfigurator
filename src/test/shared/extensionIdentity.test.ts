import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { readManifestCommands } from '../../shared/commandCatalog';
import { SETTINGS_EXT } from '../../features/tools/settingsSections';

suite('идентичность VSConfigurator в Extension Host', () => {
	test('каталог читает команды установленного форка по новому ID', () => {
		const extension = vscode.extensions.getExtension('smazovec.vsconfigurator');
		assert.ok(extension, 'VS Code должен обнаружить пакет под собственным ID');
		const commands = extension.packageJSON.contributes.commands as Array<{ command: string; title: string }>;
		const catalog = readManifestCommands();
		assert.strictEqual(catalog.size, commands.length);
		for (const command of commands) {
			assert.strictEqual(catalog.get(command.command)?.title, command.title, command.command);
		}
	});

	test('фильтр настроек указывает на установленное расширение', () => {
		const id = SETTINGS_EXT.slice('@ext:'.length);
		const extension = vscode.extensions.getExtension(id);
		assert.ok(extension, 'фильтр должен находить расширение в чистом профиле');
		assert.strictEqual(extension.packageJSON.displayName, 'VSConfigurator');
	});
});
