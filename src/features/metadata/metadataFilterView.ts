/**
 * Панель «Фильтры»: поле поиска и дерево подсистем с флажками — отбор дерева метаданных.
 * Строки повторяют дерево метаданных: тот же значок подсистемы и та же геометрия узлов.
 * Подсистемы и их состав приходят от md-sparrow одной операцией на источник.
 * @module metadataFilterView
 */
import * as vscode from 'vscode';
import { loadSubsystemTrees, type SubsystemNode } from './metadataSubsystemFilter';
import type { MetadataTreeDataProvider } from './metadataTreeView';
import { fillWebviewTemplate, loadWebviewTemplate } from '../../shared/webviewTemplate';

export const METADATA_FILTERS_VIEW_ID = '1c-platform-tools-metadata-filters';

/** Пауза перед применением: подсистемы отмечают пачкой, состав читаем один раз. */
const APPLY_DEBOUNCE_MS = 350;

export type FilterOptionKey = 'includeNested' | 'includeParents';

export interface FilterSelection {
	/** Прочитанное дерево подсистем: по нему считается состав отбора. */
	readonly roots: readonly SubsystemNode[];
	/** Пути к XML отмеченных подсистем. */
	readonly checkedPaths: ReadonlySet<string>;
	readonly includeNested: boolean;
	readonly includeParents: boolean;
}

/** Узел дерева подсистем для webview: только то, что нужно нарисовать. */
interface SubsystemTreeNode {
	readonly key: string;
	readonly name: string;
	readonly children: SubsystemTreeNode[];
}

function toWebviewNodes(nodes: readonly SubsystemNode[]): SubsystemTreeNode[] {
	return [...nodes]
		.sort((a, b) => a.name.localeCompare(b.name, 'ru'))
		.map((node) => ({ key: node.xmlPath, name: node.name, children: toWebviewNodes(node.children) }));
}

export class MetadataFilterViewProvider implements vscode.WebviewViewProvider {
	private _view: vscode.WebviewView | undefined;
	private _roots: SubsystemNode[] = [];
	private _loading: Promise<void> | undefined;
	/** Дерево метаданных сменилось, пока подсистемы читались: прочитанное устарело. */
	private _reloadRequested = false;
	private readonly _checked = new Set<string>();
	private readonly _options: Record<FilterOptionKey, boolean> = { includeNested: true, includeParents: false };
	private _applyTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _treeProvider: MetadataTreeDataProvider,
		private readonly _onSelectionChanged: (selection: FilterSelection) => void
	) {}

	get roots(): readonly SubsystemNode[] {
		return this._roots;
	}

	async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
		this._view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'resources')],
		};
		view.webview.html = await this.html(view.webview);
		view.webview.onDidReceiveMessage((msg: unknown) => this.onMessage(msg));
		view.onDidChangeVisibility(() => {
			if (view.visible) {
				void this.reload();
			}
		});
		view.onDidDispose(() => {
			this._view = undefined;
		});
		void this.reload();
	}

	/** Перечитывает подсистемы: дерево метаданных могло обновиться. */
	refresh(): void {
		void this.reload();
	}

	/**
	 * Читает подсистемы через md-sparrow. Вызов во время чтения не запускает второе, а
	 * повторяет чтение после текущего: прочитанное по прежнему дереву не показывается.
	 */
	private reload(): Promise<void> {
		this._reloadRequested = true;
		this._loading ??= this.readWhileRequested().finally(() => {
			this._loading = undefined;
		});
		return this._loading;
	}

	private async readWhileRequested(): Promise<void> {
		while (this._reloadRequested) {
			this._reloadRequested = false;
			const roots = await loadSubsystemTrees(this._context, this._treeProvider);
			if (!this._reloadRequested) {
				this._roots = roots;
				this.pushTree();
			}
		}
	}

	collapseAll(): void {
		void this._view?.webview.postMessage({ type: 'collapseAll' });
	}

	/** Снимает флажки и сбрасывает отбор. */
	clear(): void {
		this._checked.clear();
		void this._view?.webview.postMessage({ type: 'clearChecked' });
		this.scheduleApply();
	}

	/**
	 * Сменился проект: флажки и подсистемы прежнего проекта убираются, отбор снимается
	 * сразу, без паузы перед применением.
	 */
	resetForProject(): void {
		if (this._applyTimer) {
			clearTimeout(this._applyTimer);
			this._applyTimer = undefined;
		}
		this._checked.clear();
		this._roots = [];
		if (this._loading) {
			this._reloadRequested = true;
		}
		this.pushTree();
		this._onSelectionChanged({
			roots: [],
			checkedPaths: new Set(),
			includeNested: this._options.includeNested,
			includeParents: this._options.includeParents,
		});
	}

	private onMessage(msg: unknown): void {
		if (typeof msg !== 'object' || msg === null) {
			return;
		}
		const message = msg as { type?: string; key?: string; checked?: boolean; option?: FilterOptionKey };
		if (message.type === 'toggle' && typeof message.key === 'string') {
			if (message.checked) {
				this._checked.add(message.key);
			} else {
				this._checked.delete(message.key);
			}
			this.scheduleApply();
			return;
		}
		if (message.type === 'option' && message.option) {
			this._options[message.option] = message.checked === true;
			this.scheduleApply();
			return;
		}
		if (message.type === 'ready') {
			this.pushTree();
		}
	}

	private scheduleApply(): void {
		if (this._applyTimer) {
			clearTimeout(this._applyTimer);
		}
		this._applyTimer = setTimeout(() => {
			this._applyTimer = undefined;
			this._onSelectionChanged({
				roots: this._roots,
				checkedPaths: new Set(this._checked),
				includeNested: this._options.includeNested,
				includeParents: this._options.includeParents,
			});
		}, APPLY_DEBOUNCE_MS);
	}

	private pushTree(): void {
		if (!this._view) {
			return;
		}
		void this._view.webview.postMessage({
			type: 'tree',
			nodes: toWebviewNodes(this._roots),
			checked: [...this._checked],
			options: this._options,
		});
	}

	private iconUri(webview: vscode.Webview, ...parts: string[]): string {
		return webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'resources', ...parts)).toString();
	}

	private async html(webview: vscode.Webview): Promise<string> {
		// Значок подсистемы — тот же файл, что и в дереве метаданных.
		const iconLight = this.iconUri(webview, 'metadata-tree-icons', 'subsystem.svg');
		const iconDark = this.iconUri(webview, 'metadata-tree-icons', 'dark', 'subsystem.svg');
		const template = await loadWebviewTemplate(this._context.extensionUri, 'metadata-filters.html');
		return fillWebviewTemplate(template, { ICON_LIGHT: iconLight, ICON_DARK: iconDark });
	}
}
