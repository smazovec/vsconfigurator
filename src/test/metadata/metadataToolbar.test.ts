import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { MetadataToolbarSelection, metadataObjectCommands } from '../../features/metadata/metadataToolbar';
import {
	MetadataLeafTreeItem, MetadataMdGroupTreeItem, MetadataObjectNodeTreeItem,
	MetadataObjectSectionTreeItem, MetadataSourceTreeItem,
} from '../../features/metadata/metadataTreeView';

const root = path.resolve(__dirname, 'synthetic-project');
const uri = vscode.Uri.file(root);
const configuration = path.join(root, 'Configuration.xml');
const source = new MetadataSourceTreeItem('cf', 'Конфигурация', 'main', configuration, root);
const leaf = (type = 'Catalog', support?: string): MetadataLeafTreeItem => new MetadataLeafTreeItem(
	'cf', 'catalogs', undefined, type, 'Товары', 'Catalogs/Товары.xml', undefined,
	root, uri, configuration, root, undefined, support
);

suite('Панель метаданных: доступность и адресация', () => {
	test('добавление доступно для реализованной группы, но не произвольного узла', () => {
		const group = new MetadataMdGroupTreeItem('cf', 'catalogs', 'Справочники', '', true, false, configuration, root);
		assert.strictEqual(metadataObjectCommands(group, source, true).add, '1c-platform-tools.metadata.addObject');
		const locked = new MetadataSourceTreeItem('cf', 'Конфигурация', 'main', configuration, root, true, 'locked', false);
		assert.deepStrictEqual(metadataObjectCommands(group, locked, true), {});
		assert.deepStrictEqual(metadataObjectCommands(new vscode.TreeItem('Ошибка'), source, true), {});
		assert.deepStrictEqual(metadataObjectCommands(undefined, source, true), {});
	});

	test('запрет записи и поддержка блокируют мутации, просмотр остаётся', () => {
		assert.deepStrictEqual(Object.keys(metadataObjectCommands(leaf(), source, true)).sort(), ['delete', 'duplicate', 'open']);
		assert.deepStrictEqual(Object.keys(metadataObjectCommands(leaf(), source, false)), ['open']);
		assert.deepStrictEqual(Object.keys(metadataObjectCommands(leaf('Catalog', 'locked'), source, true)), ['open']);
		assert.deepStrictEqual(Object.keys(metadataObjectCommands(leaf('InformationRegister'), source, true)), ['open']);
	});

	test('раздел, реквизит и форма вызывают команды своего вида', () => {
		const owner = leaf();
		const section = new MetadataObjectSectionTreeItem('attributes', 'attributes', 'Реквизиты', false, uri, owner);
		assert.strictEqual(metadataObjectCommands(section, source, true).add, '1c-platform-tools.metadata.addChildNode');
		const attribute = new MetadataObjectNodeTreeItem('attribute', 'attribute', 'Код', 'Код', false, uri, owner);
		assert.strictEqual(metadataObjectCommands(attribute, source, true).duplicate, '1c-platform-tools.metadata.duplicateChildNode');
		assert.strictEqual(metadataObjectCommands(attribute, source, true).delete, '1c-platform-tools.metadata.deleteChildNode');
		const form = new MetadataObjectNodeTreeItem('form', 'form', 'Форма', 'Форма', false, uri, owner);
		assert.strictEqual(metadataObjectCommands(form, source, true).open, '1c-platform-tools.metadata.openForm');
		assert.strictEqual(metadataObjectCommands(form, source, true).duplicate, undefined);
		const locked = new MetadataObjectNodeTreeItem('locked', 'attribute', 'Код', 'Код', false, uri, leaf('Catalog', 'locked'));
		assert.deepStrictEqual(Object.keys(metadataObjectCommands(locked, source, true)), ['open']);
		const editableForm = new MetadataObjectNodeTreeItem('editableForm', 'form', 'Форма', 'Форма', false, uri, leaf('Catalog', 'locked'), undefined, 'editable');
		assert.strictEqual(metadataObjectCommands(editableForm, source, true).delete, '1c-platform-tools.metadata.deleteChildNode');
		const lockedForm = new MetadataObjectNodeTreeItem('lockedForm', 'form', 'Форма', 'Форма', false, uri, owner, undefined, 'locked');
		assert.strictEqual(metadataObjectCommands(lockedForm, source, true).delete, undefined);
	});

	test('клик передаёт точный экземпляр, устаревшее выделение и смена прав отклоняются', async () => {
		const calls: unknown[][] = [];
		let writable = true;
		const selection = new MetadataToolbarSelection(
			(item) => metadataObjectCommands(item, source, writable),
			async (...args) => { calls.push(args); }
		);
		const first = leaf();
		selection.select(first);
		const revision = selection.state().revision;
		await selection.run('duplicate', revision);
		assert.deepStrictEqual(calls, [['1c-platform-tools.metadata.duplicateObject', first]]);
		selection.select(leaf());
		await selection.run('delete', revision);
		writable = false;
		await selection.run('delete', selection.state().revision);
		selection.select(undefined);
		await selection.run('open', selection.state().revision);
		assert.strictEqual(calls.length, 1);
	});
});
