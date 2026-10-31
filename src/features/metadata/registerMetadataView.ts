import * as vscode from 'vscode';
import {
	MetadataLeafTreeItem,
	MetadataObjectNodeTreeItem,
	MetadataObjectSectionTreeItem,
	MetadataSourceTreeItem,
	MetadataTreeDataProvider,
} from './metadataTreeView';
import { METADATA_SEARCH_VIEW_ID, MetadataSearchViewProvider } from './metadataSearchView';
import { METADATA_FILTERS_VIEW_ID, MetadataFilterViewProvider, type FilterSelection } from './metadataFilterView';
import { computeSubsystemFilter } from './metadataSubsystemFilter';
import { bindProjectDescription } from '../projects/projectViewDescription';
import { MetadataToolbarSelection, metadataObjectCommands } from './metadataToolbar';
import { onDidChangeCurrentProject } from '../../shared/workspaceProjects';

/** Отмеченные подсистемы применяются сразу: пустой набор снимает отбор. */
function applyFilterSelection(metadataTreeProvider: MetadataTreeDataProvider, selection: FilterSelection): void {
	if (selection.checkedPaths.size === 0) {
		metadataTreeProvider.clearSubsystemFilter();
		return;
	}
	const result = computeSubsystemFilter(selection.roots, selection.checkedPaths, selection);
	const single = selection.checkedPaths.size === 1;
	const label = single ? [...result.subsystemNames][0] ?? 'подсистема' : `подсистем: ${selection.checkedPaths.size}`;
	const caption = single ? undefined : `подсистемы (${selection.checkedPaths.size})`;
	metadataTreeProvider.setSubsystemFilter(label, result.names, result.keys, result.subsystemNames, caption);
}

/** Действующий отбор по подсистемам виден над деревом и включает кнопку сброса. */
function bindSubsystemFilterMessage(
	metadataTreeProvider: MetadataTreeDataProvider,
	metadataTreeView: vscode.TreeView<vscode.TreeItem>
): vscode.Disposable {
	let shown: string | undefined;
	return metadataTreeProvider.onDidChangeTreeData(() => {
		const caption = metadataTreeProvider.getSubsystemFilterCaption();
		if (caption === shown) {
			return;
		}
		shown = caption;
		metadataTreeView.message = caption ? `Отбор: ${caption}` : undefined;
		void vscode.commands.executeCommand(
			'setContext',
			'1c-platform-tools.metadata.subsystemFilterActive',
			caption !== undefined
		);
	});
}

export interface MetadataViewRegistration {
	metadataTreeProvider: MetadataTreeDataProvider;
	metadataTreeView: vscode.TreeView<vscode.TreeItem>;
	metadataSearchProvider: MetadataSearchViewProvider;
	metadataFilterProvider: MetadataFilterViewProvider;
}

/**
 * Регистрирует tree view панели «1С: Метаданные» и базовые UI-контексты выбора.
 */
export function registerMetadataView(
	context: vscode.ExtensionContext
): MetadataViewRegistration {
	const metadataTreeProvider = new MetadataTreeDataProvider(context);
	const metadataTreeView = vscode.window.createTreeView('1c-platform-tools-metadata-tree', {
		treeDataProvider: metadataTreeProvider,
		showCollapseAll: true,
	});
	context.subscriptions.push(
		metadataTreeView,
		bindProjectDescription(metadataTreeView),
		bindSubsystemFilterMessage(metadataTreeProvider, metadataTreeView)
	);
	// Раскрытие верхнего уровня переживает обновление дерева: оно перестраивается целиком.
	context.subscriptions.push(
		metadataTreeView.onDidExpandElement((e) => {
			if (e.element instanceof MetadataSourceTreeItem) {
				metadataTreeProvider.rememberSourceExpanded(e.element.sourceId, true);
			}
		}),
		metadataTreeView.onDidCollapseElement((e) => {
			if (e.element instanceof MetadataSourceTreeItem) {
				metadataTreeProvider.rememberSourceExpanded(e.element.sourceId, false);
			}
		})
	);

	const toolbar = new MetadataToolbarSelection(
		(item) => {
			if (!metadataTreeProvider.getCachedTree()) {
				return {};
			}
			let source = item instanceof MetadataObjectNodeTreeItem || item instanceof MetadataObjectSectionTreeItem
				? item.owner as vscode.TreeItem : item;
			while (source && !(source instanceof MetadataSourceTreeItem)) {
				source = metadataTreeProvider.getParent(source);
			}
			return metadataObjectCommands(item, source, vscode.workspace.isTrusted && vscode.workspace.fs.isWritableFileSystem('file') === true);
		},
		(id, item) => vscode.commands.executeCommand(id, item)
	);
	const metadataSearchProvider = new MetadataSearchViewProvider(
		context.extensionUri,
		(query) => {
			metadataTreeProvider.setTextFilter(query);
		},
		() => metadataTreeProvider.getTextFilter() ?? '',
		{
			state: () => ({ ...toolbar.state(), filterCaption: metadataTreeProvider.getSubsystemFilterCaption() }),
			run: async (action, revision) => {
				if (action === 'refresh') {
					await vscode.commands.executeCommand('1c-platform-tools.metadata.refresh');
				} else if (action === 'filters') {
					await vscode.commands.executeCommand(`${METADATA_FILTERS_VIEW_ID}.focus`);
				} else if (action === 'clearFilter') {
					await vscode.commands.executeCommand('1c-platform-tools.metadata.clearSubsystemFilter');
				} else {
					await toolbar.run(action, revision);
				}
			},
		}
	);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(METADATA_SEARCH_VIEW_ID, metadataSearchProvider)
	);
	context.subscriptions.push(
		metadataTreeView.onDidChangeSelection(() => {
			toolbar.select(metadataTreeView.selection.length === 1 ? metadataTreeView.selection[0] : undefined);
			metadataSearchProvider.updateToolbar();
		}),
		// Перестроенное дерево может содержать уже другие экземпляры узлов.
		metadataTreeProvider.onDidChangeTreeData(() => {
			toolbar.select(undefined);
			metadataSearchProvider.updateToolbar();
		}),
		onDidChangeCurrentProject(() => {
			toolbar.select(undefined);
			metadataSearchProvider.updateToolbar();
		}),
		metadataTreeView.onDidChangeVisibility(({ visible }) => {
			if (visible) {
				metadataSearchProvider.show();
			}
		})
	);

	const metadataFilterProvider = new MetadataFilterViewProvider(context, metadataTreeProvider, (selection) => {
		applyFilterSelection(metadataTreeProvider, selection);
	});
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(METADATA_FILTERS_VIEW_ID, metadataFilterProvider),
		// Панель открывается раньше, чем дерево прочитано: без этого список подсистем остаётся пустым.
		metadataTreeProvider.onDidChangeTreeData(() => {
			metadataFilterProvider.refresh();
		})
	);

	const syncMetadataCatalogSelectionContext = (): void => {
		const has = metadataTreeView.selection.some(
			(selection) =>
				selection instanceof MetadataLeafTreeItem &&
				selection.objectType === 'Catalog'
		);
		void vscode.commands.executeCommand(
			'setContext',
			'1c-platform-tools.metadata.catalogSelected',
			has
		);

		const hasSubsystem = metadataTreeView.selection.some(
			(selection) =>
				selection instanceof MetadataLeafTreeItem &&
				selection.objectType === 'Subsystem'
		);
		void vscode.commands.executeCommand(
			'setContext',
			'1c-platform-tools.metadata.subsystemSelected',
			hasSubsystem
		);
	};

	void vscode.commands.executeCommand(
		'setContext',
		'1c-platform-tools.metadata.catalogSelected',
		false
	);
	void vscode.commands.executeCommand(
		'setContext',
		'1c-platform-tools.metadata.subsystemSelected',
		false
	);
	void vscode.commands.executeCommand(
		'setContext',
		'1c-platform-tools.metadata.subsystemFilterActive',
		false
	);

	context.subscriptions.push(
		metadataTreeView.onDidChangeSelection(syncMetadataCatalogSelectionContext)
	);

	return { metadataTreeProvider, metadataTreeView, metadataSearchProvider, metadataFilterProvider };
}
