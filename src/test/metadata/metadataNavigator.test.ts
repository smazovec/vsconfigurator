import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { MetadataNavigatorModel, metadataNodeId } from '../../features/metadata/metadataNavigatorModel';
import { navigatorMenu, navigatorWhen } from '../../features/metadata/metadataNavigatorMenu';
import { MetadataLeafTreeItem, MetadataSourceTreeItem } from '../../features/metadata/metadataTreeView';
import { MetadataNavigatorView } from '../../features/metadata/metadataNavigatorView';

const leaf = (name: string) => new MetadataLeafTreeItem('cf', 'catalogs', undefined, 'Catalog', name,
	`Catalogs/${name}.xml`, undefined, 'D:/project', vscode.Uri.file('D:/project'), 'D:/project/Configuration.xml', 'D:/project');

suite('Адаптер единого навигатора', () => {
	test('стабильные ID различают источники/объекты, DTO не содержит пути и команды', async () => {
		assert.strictEqual(metadataNodeId(leaf('Один')), metadataNodeId(leaf('Один')));
		assert.notStrictEqual(metadataNodeId(leaf('Один')), metadataNodeId(leaf('Два')));
		const emitter = new vscode.EventEmitter<void>();
		const item = leaf('<img onerror=alert(1)>');
		const model = new MetadataNavigatorModel({ getChildren: async () => [item], getParent: () => undefined, onDidChangeTreeData: emitter.event });
		try {
			const page = await model.page(undefined, 0, model.epoch);
			assert.ok(page); assert.strictEqual(page.nodes[0].label, item.name);
			assert.ok(!('command' in page.nodes[0])); assert.ok(!('resourceUri' in page.nodes[0]));
			assert.strictEqual(model.select(page.nodes[0].id, model.epoch), item);
			assert.strictEqual(model.selection[0], item);
		} finally { model.dispose(); emitter.dispose(); }
	});

	test('20 000 узлов: страница <=100, дети ленивы, параллельные запросы объединены', async () => {
		const emitter = new vscode.EventEmitter<void>();
		const root = new vscode.TreeItem('Корень', vscode.TreeItemCollapsibleState.Collapsed);
		const items = Array.from({ length: 20000 }, (_, index) => new vscode.TreeItem(`Объект${index}`));
		let calls = 0;
		const model = new MetadataNavigatorModel({ onDidChangeTreeData: emitter.event, getParent: () => root,
			getChildren: async item => { calls++; return item ? items : [root]; } });
		try {
			const page = await model.page(undefined, 0, 0); assert.ok(page); assert.strictEqual(calls, 1);
			const id = page.nodes[0].id;
			const pages = await Promise.all([model.page(id, 0, 0), model.page(id, 100, 0)]);
			assert.strictEqual(calls, 2); assert.strictEqual(pages[0]?.total, 20000);
			assert.strictEqual(pages[0]?.nodes.length, 100); assert.strictEqual(pages[1]?.nodes[0].label, 'Объект100');
			assert.strictEqual(await model.page('forged', 0, 0), undefined);
			assert.strictEqual(await model.page(id, -1, 0), undefined);
			assert.strictEqual(await model.page(id, 0.5, 0), undefined);
		} finally { model.dispose(); emitter.dispose(); }
	});

	test('смена проекта отклоняет запоздалую страницу и старый выбор', async () => {
		const emitter = new vscode.EventEmitter<void>();
		let finish!: (items: vscode.TreeItem[]) => void;
		const model = new MetadataNavigatorModel({ getChildren: () => new Promise(resolve => { finish = resolve; }), getParent: () => undefined, onDidChangeTreeData: emitter.event });
		try {
			const pending = model.page(undefined, 0, 0); emitter.fire(); finish([leaf('Старый')]);
			assert.strictEqual(await pending, undefined); assert.strictEqual(model.epoch, 1);
			assert.strictEqual(model.select(metadataNodeId(leaf('Старый')), 0), undefined);
			assert.deepStrictEqual(model.selection, []);
		} finally { model.dispose(); emitter.dispose(); }
	});

	test('reveal и восстановление выбора загружают страницу за первой сотней, без обхода объектов', async () => {
		const emitter = new vscode.EventEmitter<void>();
		const source = new MetadataSourceTreeItem('cf', 'Источник', 'main', 'D:/project/Configuration.xml', 'D:/project');
		const objects = Array.from({ length: 250 }, (_, index) => leaf(`Узел${index}`));
		const model = new MetadataNavigatorModel({ getChildren: async item => item ? objects : [source], getParent: item => item === source ? undefined : source, onDidChangeTreeData: emitter.event });
		try {
			let pages: number[] = [];
			model.onDidReveal(event => { pages = event.pages.map(page => page.offset); });
			await model.reveal(objects[225], { focus: true });
			assert.deepStrictEqual(pages, [0, 200]); assert.strictEqual(model.selection[0], objects[225]);
			const state = model.snapshot; model.restore(state); assert.deepStrictEqual(model.selection, []);
			await model.restoreSelection(); assert.strictEqual(model.selection[0], objects[225]);
			assert.ok(model.snapshot.expanded.includes(metadataNodeId(source)));
		} finally { model.dispose(); emitter.dispose(); }
	});

	test('меню повторяет manifest, не принимает команду клиента и закрывает неизвестное when', () => {
		const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
		const commands = navigatorMenu(manifest, leaf('Товары'), false).map(entry => entry.command);
		assert.ok(commands.includes('1c-platform-tools.metadata.renameObject'));
		assert.ok(commands.includes('1c-platform-tools.metadata.copyObjectName'));
		assert.ok(!commands.includes('1c-platform-tools.metadata.deleteExtension'));
		assert.strictEqual(navigatorWhen('unknown && viewItem =~ /x/', { viewItem: 'x' }), false);
		assert.strictEqual(navigatorWhen('viewItem =~ /x/ || (a == b && !flag)', { viewItem: 'x' }), true);
		assert.strictEqual(navigatorWhen('viewItem > x', { viewItem: 'x' }), false);
		assert.strictEqual(navigatorWhen('viewItem =~ /[/', { viewItem: 'x' }), false);
	});

	test('протокол принимает только известный ID/epoch; клиент не задаёт команду или аргументы', async () => {
		const emitter = new vscode.EventEmitter<void>();
		const item = leaf('Один'), another = leaf('Два');
		const opened: vscode.TreeItem[] = [], queries: string[] = [];
		let calls = 0;
		const command = '1c-platform-tools.metadata.testNavigatorContext';
		const disposable = vscode.commands.registerCommand(command, selected => { assert.strictEqual(selected, item); calls++; });
		const context = { extension: { packageJSON: { contributes: { commands: [{ command, title: 'Тест' }], menus: { 'view/item/context': [{ command, when: 'view == 1c-platform-tools-metadata-tree' }] } } } } } as unknown as vscode.ExtensionContext;
		const view = new MetadataNavigatorView(context, { getChildren: async () => [item, another], getParent: () => undefined, onDidChangeTreeData: emitter.event }, query => queries.push(query), () => '', selected => { opened.push(selected); return Promise.resolve(); });
		const receive = (message: unknown) => (view as unknown as { receive(message: unknown): Promise<void> }).receive(message);
		try {
			await view.model.page(undefined, 0, 0);
			const id = metadataNodeId(item);
			await receive({ type: 'command', command, args: ['forged'], epoch: 0 });
			await receive({ type: 'open', id: 'forged', epoch: 0 });
			await receive({ type: 'open', id, epoch: -1 });
			assert.deepStrictEqual(opened, []); assert.strictEqual(calls, 0);
			await receive({ type: 'open', id, epoch: 0 }); assert.deepStrictEqual(opened, [item]);
			await receive({ type: 'search', query: 'x'.repeat(1001), epoch: 0 }); assert.deepStrictEqual(queries, []);
			await receive({ type: 'context', id, epoch: 0 });
			await receive({ type: 'select', id: metadataNodeId(another), epoch: 0 });
			await receive({ type: 'menuAction', id, index: 0, epoch: 0 }); assert.strictEqual(calls, 0);
			await receive({ type: 'context', id, epoch: 0 });
			await receive({ type: 'menuAction', id, index: 0, epoch: 0 }); assert.strictEqual(calls, 1);
			emitter.fire(); await receive({ type: 'open', id, epoch: 0 }); assert.strictEqual(opened.length, 1);
		} finally { view.dispose(); disposable.dispose(); emitter.dispose(); }
	});
});
