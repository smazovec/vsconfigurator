/**
 * Поле поиска над деревом метаданных: отдельный webview-view, потому что у TreeView
 * своего поля ввода нет.
 * @module metadataSearchView
 */
import * as vscode from 'vscode';
import { fillWebviewTemplate, loadWebviewTemplate } from '../../shared/webviewTemplate';

export const METADATA_SEARCH_VIEW_ID = '1c-platform-tools-metadata-search';

/** Задержка перед перестроением дерева: дерево не дёргается на каждый символ. */
const INPUT_DEBOUNCE_MS = 250;

export class MetadataSearchViewProvider implements vscode.WebviewViewProvider {
	private _view: vscode.WebviewView | undefined;

	/**
	 * @param _currentQuery Запрос, которым сейчас отобрано дерево. Скрытая панель теряет
	 * страницу, VS Code загружает её заново, и поле берёт запрос отсюда
	 */
	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _onQueryChanged: (query: string) => void,
		private readonly _currentQuery: () => string = () => ''
	) {}

	async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
		this._view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
		view.webview.html = await this.html();
		view.webview.onDidReceiveMessage((msg: unknown) => {
			const type = typeof msg === 'object' && msg !== null ? (msg as { type?: string }).type : undefined;
			if (type === 'ready') {
				this.showQuery(this._currentQuery());
			}
			if (type === 'search') {
				const query = (msg as { query?: unknown }).query;
				this._onQueryChanged(typeof query === 'string' ? query : '');
			}
		});
		view.onDidDispose(() => {
			this._view = undefined;
		});
	}

	/** Сбрасывает поле извне (например, командой очистки). */
	clear(): void {
		this._view?.webview.postMessage({ type: 'clear' });
		this._onQueryChanged('');
	}

	/** Показывает в поле запрос, введённый другим способом: поле и кнопка-лупа ищут одно и то же. */
	showQuery(query: string): void {
		this._view?.webview.postMessage({ type: 'setQuery', query });
	}

	private async html(): Promise<string> {
		const template = await loadWebviewTemplate(this._extensionUri, 'metadata-search.html');
		return fillWebviewTemplate(template, { DEBOUNCE_MS: String(INPUT_DEBOUNCE_MS) });
	}
}
