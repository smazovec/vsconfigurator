import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { fillWebviewTemplate, loadWebviewTemplate } from '../../shared/webviewTemplate';
import { logger } from '../../shared/logger';
import { MetadataNavigatorModel, type NavigatorNode, type NavigatorState } from './metadataNavigatorModel';
import type { MetadataSearchToolbar } from './metadataSearchView';
import { navigatorMenu } from './metadataNavigatorMenu';

export const METADATA_NAVIGATOR_VIEW_ID = '1c-platform-tools-metadata-tree';

/** Единственный renderer. Команды и TreeItem остаются в extension host. */
export class MetadataNavigatorView implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private readonly subscriptions: vscode.Disposable[] = [];
	private viewSubscriptions: vscode.Disposable[] = [];
	private configurationTitle = 'Метаданные';
	readonly model: MetadataNavigatorModel;
	toolbar: MetadataSearchToolbar | undefined;
	private menu: { id: string; epoch: number; entries: { command: string; title: string }[] } | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		provider: ConstructorParameters<typeof MetadataNavigatorModel>[0],
		private readonly query: (value: string) => void,
		private readonly currentQuery: () => string,
		private readonly execute: (item: vscode.TreeItem) => Thenable<unknown>,
		save?: (state: NavigatorState) => void
	) {
		this.model = new MetadataNavigatorModel(provider, item => this.icon(item), save, () => !!this.currentQuery());
		this.subscriptions.push(this.model, this.model.onDidChange(() => { this.menu = undefined; this.reset(); }),
			this.model.onDidReveal(event => { if (event.focus) { this.view?.show(false); } this.post({ type: 'reveal', ...event }); }));
	}

	set title(value: string) {
		this.configurationTitle = value;
		if (this.view) { this.view.title = value; }
	}

	async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
		this.viewSubscriptions.forEach(subscription => subscription.dispose());
		this.viewSubscriptions = [];
		this.view = view;
		view.title = this.configurationTitle;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'resources'),
				vscode.Uri.joinPath(this.context.globalStorageUri, 'metadata-tree-icons')],
		};
		const nonce = randomBytes(24).toString('base64');
		const resource = (name: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'webview', name)).toString();
		this.viewSubscriptions.push(view.webview.onDidReceiveMessage((message: unknown) => {
			const epoch = this.model.epoch;
			void this.receive(message).catch((error: unknown) => {
				logger.scope('метаданные').error(String(error));
				if (epoch === this.model.epoch) { this.post({ type: 'error', epoch, message: error instanceof Error ? error.message : String(error) }); }
			});
		}), view.onDidDispose(() => { if (this.view === view) { this.view = undefined; } }));
		const template = await loadWebviewTemplate(this.context.extensionUri, 'metadata-navigator.html');
		view.webview.html = fillWebviewTemplate(template, {
			NONCE: nonce, CSP_SOURCE: view.webview.cspSource,
			SCRIPT_URI: resource('metadata-navigator.js'), STYLE_URI: resource('metadata-navigator.css'),
		});
	}

	private icon(item: vscode.TreeItem): Pick<NavigatorNode, 'icon' | 'themeIcon'> {
		const icon = item.iconPath;
		const webview = this.view?.webview;
		if (!icon || !webview || typeof icon === 'string') { return {}; }
		if (icon instanceof vscode.ThemeIcon) { return { themeIcon: icon.id }; }
		const themed = icon instanceof vscode.Uri ? { light: icon, dark: icon } : icon;
		if (!('light' in themed) || !(themed.light instanceof vscode.Uri) || !(themed.dark instanceof vscode.Uri)) { return {}; }
		return { icon: { light: webview.asWebviewUri(themed.light).toString(), dark: webview.asWebviewUri(themed.dark).toString() } };
	}

	private async receive(message: unknown): Promise<void> {
		if (!message || typeof message !== 'object') { return; }
		const msg = message as Record<string, unknown>;
		if (msg.type === 'ready') { this.reset(); return; }
		if (msg.epoch !== this.model.epoch) { return; }
		if (msg.type === 'children' && (msg.parent === undefined || typeof msg.parent === 'string') && typeof msg.offset === 'number') {
			const page = await this.model.page(msg.parent, msg.offset, msg.epoch as number);
			if (page) { this.post({ type: 'children', ...page }); }
		} else if (msg.type === 'select' && typeof msg.id === 'string') {
			this.model.select(msg.id, this.model.epoch);
		} else if (msg.type === 'expand' && typeof msg.id === 'string' && typeof msg.expanded === 'boolean') {
			this.model.setExpanded(msg.id, msg.expanded, this.model.epoch);
		} else if (msg.type === 'open' && typeof msg.id === 'string') {
			const item = this.model.select(msg.id, this.model.epoch);
			if (item) { await this.execute(item); }
		} else if (msg.type === 'search' && typeof msg.query === 'string' && msg.query.length <= 1000) {
			this.query(msg.query);
		} else if (msg.type === 'action' && typeof msg.action === 'string' && Number.isSafeInteger(msg.revision)
			&& ['add', 'open', 'duplicate', 'delete', 'refresh', 'filters', 'clearFilter'].includes(msg.action)) {
			await this.toolbar?.run(msg.action as Parameters<MetadataSearchToolbar['run']>[0], msg.revision as number);
		} else if (msg.type === 'context' && typeof msg.id === 'string') {
			const item = this.model.select(msg.id, this.model.epoch);
			if (!item) { return; }
			const entries = navigatorMenu(this.context.extension.packageJSON, item, !!this.toolbar?.state().filterCaption);
			this.menu = { id: msg.id, epoch: this.model.epoch, entries };
			this.post({ type: 'menu', id: msg.id, entries: entries.map((entry, index) => ({ index, title: entry.title })) });
		} else if (msg.type === 'menuAction' && typeof msg.id === 'string' && Number.isSafeInteger(msg.index)) {
			const menu = this.menu;
			this.menu = undefined;
			if (!menu || menu.id !== msg.id || menu.epoch !== this.model.epoch) { return; }
			const item = this.model.item(menu.id, menu.epoch);
			const entry = menu.entries[msg.index as number];
			if (item && entry && this.model.selection[0] === item) { await vscode.commands.executeCommand(entry.command, item); }
		}
	}

	private post(message: unknown): void { void this.view?.webview.postMessage(message); }
	reset(): void {
		this.post({ type: 'reset', epoch: this.model.epoch, query: this.currentQuery() }); this.updateToolbar();
		if (this.view) { void this.model.restoreSelection().catch(error => logger.scope('метаданные').warn(String(error))); }
	}
	updateToolbar(): void { if (this.toolbar) { this.post({ type: 'toolbar', ...this.toolbar.state() }); } }
	clear(): void { this.query(''); this.showQuery(''); }
	showQuery(query: string): void { this.post({ type: 'setQuery', query }); }
	focusSearch(): void { this.post({ type: 'focusSearch' }); }
	dispose(): void {
		this.viewSubscriptions.forEach(subscription => subscription.dispose());
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.view = undefined;
	}
}
