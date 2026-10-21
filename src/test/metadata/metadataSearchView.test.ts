import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { MetadataSearchViewProvider } from '../../features/metadata/metadataSearchView';

/** Панель-заглушка: запоминает разметку, отправленные сообщения и обработчик входящих. */
function fakeView(): { view: vscode.WebviewView; posted: unknown[]; receive: (message: unknown) => void } {
	const posted: unknown[] = [];
	let handler: (message: unknown) => void = () => undefined;
	const webview = {
		options: {},
		html: '',
		postMessage: (message: unknown) => {
			posted.push(message);
			return Promise.resolve(true);
		},
		onDidReceiveMessage: (listener: (message: unknown) => void) => {
			handler = listener;
			return { dispose: () => undefined };
		},
	};
	const view = { webview, onDidDispose: () => ({ dispose: () => undefined }) } as unknown as vscode.WebviewView;
	return { view, posted, receive: (message) => handler(message) };
}

const EXTENSION_ROOT = vscode.Uri.file(path.resolve(__dirname, '../../..'));

suite('Поиск метаданных: поле после скрытия панели', () => {
	test('загруженная заново страница получает запрос, которым отобрано дерево', async () => {
		// Скрытая панель теряет страницу, и VS Code грузит её заново из той же разметки:
		// запрос в разметке остался бы тем, что был при первом показе
		let treeQuery = '';
		const provider = new MetadataSearchViewProvider(EXTENSION_ROOT, () => undefined, () => treeQuery);
		const { view, posted, receive } = fakeView();
		await provider.resolveWebviewView(view);
		treeQuery = 'Номенклатура';

		assert.ok(view.webview.html.includes("postMessage({ type: 'ready' })"), 'страница не сообщает о загрузке');
		receive({ type: 'ready' });
		assert.deepStrictEqual(posted, [{ type: 'setQuery', query: 'Номенклатура' }]);
	});

	test('набранный запрос уходит в дерево', async () => {
		const queries: string[] = [];
		const provider = new MetadataSearchViewProvider(EXTENSION_ROOT, (query) => queries.push(query));
		const { view, receive } = fakeView();
		await provider.resolveWebviewView(view);

		receive({ type: 'search', query: 'Товары' });
		assert.deepStrictEqual(queries, ['Товары']);
	});
});
