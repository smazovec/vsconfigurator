import * as vscode from 'vscode';
import {
	MetadataLeafTreeItem, MetadataObjectNodeTreeItem, MetadataObjectSectionTreeItem,
	MetadataSourceTreeItem, MetadataTreeDataProvider,
} from './metadataTreeView';
import { METADATA_SEARCH_VIEW_ID } from './metadataSearchView';
import { METADATA_FILTERS_VIEW_ID, MetadataFilterViewProvider, type FilterSelection } from './metadataFilterView';
import { computeSubsystemFilter } from './metadataSubsystemFilter';
import { MetadataToolbarSelection, metadataObjectCommands } from './metadataToolbar';
import { currentRoot, onDidChangeCurrentProject } from '../../shared/workspaceProjects';
import { MetadataNavigatorView, METADATA_NAVIGATOR_VIEW_ID } from './metadataNavigatorView';
import type { MetadataNavigatorModel, NavigatorState } from './metadataNavigatorModel';
import { metadataConfigurationTitle } from './metadataNavigatorTitle';
import { logger } from '../../shared/logger';

/** Отмеченные подсистемы применяются сразу: пустой набор снимает отбор. */
function applyFilterSelection(provider: MetadataTreeDataProvider, selection: FilterSelection): void {
	if (selection.checkedPaths.size === 0) { provider.clearSubsystemFilter(); return; }
	const result = computeSubsystemFilter(selection.roots, selection.checkedPaths, selection);
	const single = selection.checkedPaths.size === 1;
	const label = single ? [...result.subsystemNames][0] ?? 'подсистема' : `подсистем: ${selection.checkedPaths.size}`;
	provider.setSubsystemFilter(label, result.names, result.keys, result.subsystemNames, single ? undefined : `подсистемы (${selection.checkedPaths.size})`);
}

export interface MetadataViewRegistration {
	metadataTreeProvider: MetadataTreeDataProvider;
	metadataTreeView: MetadataNavigatorModel;
	metadataSearchProvider: MetadataNavigatorView;
	metadataFilterProvider: MetadataFilterViewProvider;
}

/** Один WebviewView; прежний провайдер, TreeItem и все предметные обработчики. */
export function registerMetadataView(context: vscode.ExtensionContext): MetadataViewRegistration {
	const provider = new MetadataTreeDataProvider(context);
	let project = currentRoot();
	const stateKey = () => `metadata.navigator:${project ?? ''}`;
	const navigator = new MetadataNavigatorView(context, provider,
		query => provider.setTextFilter(query), () => provider.getTextFilter() ?? '',
		item => item.command ? vscode.commands.executeCommand(item.command.command, ...item.command.arguments ?? []) : Promise.resolve(),
		state => { if (project) { void context.workspaceState.update(stateKey(), state); } });
	const tree = navigator.model;
	const restore = () => tree.restore(context.workspaceState.get<NavigatorState>(stateKey(), { expanded: [], collapsed: [] }));
	restore();
	const filters = new MetadataFilterViewProvider(context, provider, selection => applyFilterSelection(provider, selection));
	const toolbar = new MetadataToolbarSelection(item => {
		if (!provider.getCachedTree()) { return {}; }
		let source = item instanceof MetadataObjectNodeTreeItem || item instanceof MetadataObjectSectionTreeItem ? item.owner as vscode.TreeItem : item;
		while (source && !(source instanceof MetadataSourceTreeItem)) { source = provider.getParent(source); }
		return metadataObjectCommands(item, source, vscode.workspace.isTrusted && vscode.workspace.fs.isWritableFileSystem('file') === true);
	}, (id, item) => vscode.commands.executeCommand(id, item));
	navigator.toolbar = {
		state: () => ({ ...toolbar.state(), filterCaption: provider.getSubsystemFilterCaption() }),
		run: async (action, revision) => {
			if (action === 'refresh') { await vscode.commands.executeCommand('1c-platform-tools.metadata.refresh'); }
			else if (action === 'filters') { await filters.show(); }
			else if (action === 'clearFilter') { await vscode.commands.executeCommand('1c-platform-tools.metadata.clearSubsystemFilter'); }
			else { await toolbar.run(action, revision); }
		},
	};
	let titleGeneration = 0;
	let disposed = false;
	const updateTitle = async () => {
		const generation = ++titleGeneration;
		const cfg = provider.configurationXml;
		const root = provider.resolveCfRoot();
		if (!cfg || !root) { navigator.title = 'Метаданные'; return; }
		try {
			const title = await metadataConfigurationTitle(context, cfg, root);
			if (!disposed && generation === titleGeneration && cfg === provider.configurationXml) { navigator.title = title; }
		} catch (error) {
			if (!disposed && generation === titleGeneration) { navigator.title = 'Метаданные'; logger.scope('метаданные').warn(`Имя конфигурации: ${String(error)}`); }
		}
	};
	const syncSelection = () => {
		toolbar.select(tree.selection.length === 1 ? tree.selection[0] : undefined);
		navigator.updateToolbar();
		void vscode.commands.executeCommand('setContext', '1c-platform-tools.metadata.catalogSelected', tree.selection.some(item => item instanceof MetadataLeafTreeItem && item.objectType === 'Catalog'));
		void vscode.commands.executeCommand('setContext', '1c-platform-tools.metadata.subsystemSelected', tree.selection.some(item => item instanceof MetadataLeafTreeItem && item.objectType === 'Subsystem'));
	};
	context.subscriptions.push(navigator, filters,
		vscode.commands.registerCommand('1c-platform-tools.metadata.collapseAll', () => tree.collapseAll()),
		vscode.window.registerWebviewViewProvider(METADATA_NAVIGATOR_VIEW_ID, navigator),
		// Публичные focus-ID старых view остаются совместимыми командами.
		vscode.commands.registerCommand(`${METADATA_SEARCH_VIEW_ID}.focus`, async () => { await vscode.commands.executeCommand(`${METADATA_NAVIGATOR_VIEW_ID}.focus`); navigator.focusSearch(); }),
		vscode.commands.registerCommand(`${METADATA_FILTERS_VIEW_ID}.focus`, () => filters.show()),
		tree.onDidChangeSelection(syncSelection),
		tree.onDidExpandElement(({ element }) => { if (element instanceof MetadataSourceTreeItem) { provider.rememberSourceExpanded(element.sourceId, true); } }),
		tree.onDidCollapseElement(({ element }) => { if (element instanceof MetadataSourceTreeItem) { provider.rememberSourceExpanded(element.sourceId, false); } }),
		provider.onDidChangeTreeData(() => {
			navigator.updateToolbar(); filters.refresh(); void updateTitle();
			void vscode.commands.executeCommand('setContext', '1c-platform-tools.metadata.subsystemFilterActive', provider.getSubsystemFilterCaption() !== undefined);
		}),
		onDidChangeCurrentProject(() => { titleGeneration++; navigator.title = 'Метаданные'; project = currentRoot(); restore(); }),
		{ dispose() { disposed = true; titleGeneration++; } });
	syncSelection();
	void vscode.commands.executeCommand('setContext', '1c-platform-tools.metadata.subsystemFilterActive', false);
	return { metadataTreeProvider: provider, metadataTreeView: tree, metadataSearchProvider: navigator, metadataFilterProvider: filters };
}
