import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { createMetadataStartupOpener } from '../../app/projectLifecycle';
import * as fs from 'node:fs';
import * as path from 'node:path';

suite('Стартовый навигатор метаданных', () => {
	test('поиск раскрыт непосредственно перед штатным деревом, отбор изначально свёрнут, автооткрытие включено', () => {
		const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
		const views = pkg.contributes.views['1c-platform-tools-metadata'] as Array<{ id: string; type?: string; visibility?: string }>;
		assert.strictEqual(views[0].id, '1c-platform-tools-metadata-search');
		assert.strictEqual(views[0].visibility, 'visible');
		assert.strictEqual(views[1].id, '1c-platform-tools-metadata-tree');
		assert.strictEqual(views[1].type, undefined, 'дерево не заменено webview');
		assert.strictEqual(views[2].visibility, 'collapsed');
		const config = pkg.contributes.configuration.find((section: { id: string }) => section.id === '1c-platform-tools.metadata');
		assert.strictEqual(config.properties['1c-platform-tools.metadata.autoOpen'].default, true);
	});
	test('обычная папка не открывает панель, первое обнаружение открывает ровно один раз', async () => {
		let calls = 0;
		const open = createMetadataStartupOpener(() => true, async () => { calls++; });
		await open(false);
		await open(false);
		assert.strictEqual(calls, 0);
		await Promise.all([open(true), open(true)]);
		await open(false);
		await open(true);
		assert.strictEqual(calls, 1, 'смена проекта или повторное обнаружение не перехватывает фокус');
	});

	test('выключенная настройка расходует попытку и не включает панель задним числом', async () => {
		let enabled = false;
		let calls = 0;
		const open = createMetadataStartupOpener(() => enabled, async () => { calls++; });
		await open(true);
		enabled = true;
		await open(true);
		assert.strictEqual(calls, 0);
	});

	test('неудачный показ не повторяется при следующих обнаружениях', async () => {
		let calls = 0;
		const open = createMetadataStartupOpener(() => true, async () => { calls++; throw new Error('show'); });
		await assert.rejects(open(true), /show/);
		await open(true);
		assert.strictEqual(calls, 1);
	});

	test('VS Code регистрирует штатные focus-команды обоих contributed webview', async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const view of ['1c-platform-tools-metadata-search', '1c-platform-tools-metadata-filters']) {
			assert.ok(commands.includes(`${view}.focus`), `нет штатной команды ${view}.focus`);
		}
	});
});
