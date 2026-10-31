import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import {
	MetadataLeafTreeItem, MetadataMdGroupTreeItem, MetadataMdSubgroupTreeItem,
	MetadataObjectNodeTreeItem, MetadataObjectSectionTreeItem, MetadataSourceTreeItem,
	type MetadataTreeDataProvider,
} from './metadataTreeView';

/** Контракт выбора/перехода, общий для команд и палитры; renderer в него не входит. */
export interface MetadataTreeSelection {
	readonly selection: readonly vscode.TreeItem[];
	readonly onDidChangeSelection: vscode.Event<vscode.TreeViewSelectionChangeEvent<vscode.TreeItem>>;
	reveal(item: vscode.TreeItem, options?: { select?: boolean; focus?: boolean; expand?: boolean | number }): Thenable<void>;
}

export interface NavigatorState {
	expanded: string[];
	collapsed: string[];
	selected?: string;
	selectedPages?: { parent?: string; offset: number }[];
}

export interface NavigatorNode {
	id: string;
	label: string;
	description?: string;
	tooltip?: string;
	expandable: boolean;
	expanded: boolean;
	selected: boolean;
	openable: boolean;
	icon?: { light: string; dark: string };
	themeIcon?: string;
}

export interface NavigatorPage {
	epoch: number;
	parent?: string;
	offset: number;
	total: number;
	nodes: NavigatorNode[];
}

/** Стабильный ключ UI. Пути, TreeItem и аргументы команд клиент не получает. */
export function metadataNodeId(item: vscode.TreeItem): string {
	let key: unknown;
	if (item instanceof MetadataSourceTreeItem) {
		key = ['source', item.sourceId];
	} else if (item instanceof MetadataMdSubgroupTreeItem) {
		key = ['subgroup', item.sourceId, item.groupId, item.subgroupId];
	} else if (item instanceof MetadataMdGroupTreeItem) {
		key = ['group', item.sourceId, item.groupId];
	} else if (item instanceof MetadataLeafTreeItem) {
		key = ['leaf', item.sourceId, item.objectType, item.resourceUri?.toString() ?? item.relativePath ?? item.name];
	} else if (item instanceof MetadataObjectSectionTreeItem || item instanceof MetadataObjectNodeTreeItem) {
		key = ['child', metadataNodeId(item.owner), item.key];
	} else {
		key = [item.contextValue, item.id, item.label];
	}
	return createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 32);
}

/** Ленивый адаптер прежнего провайдера. Дочерний состав читает исключительно getChildren. */
export class MetadataNavigatorModel implements MetadataTreeSelection, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly selectionChanged = new vscode.EventEmitter<vscode.TreeViewSelectionChangeEvent<vscode.TreeItem>>();
	readonly onDidChangeSelection = this.selectionChanged.event;
	private readonly expanded = new vscode.EventEmitter<vscode.TreeViewExpansionEvent<vscode.TreeItem>>();
	readonly onDidExpandElement = this.expanded.event;
	private readonly collapsed = new vscode.EventEmitter<vscode.TreeViewExpansionEvent<vscode.TreeItem>>();
	readonly onDidCollapseElement = this.collapsed.event;
	private readonly revealed = new vscode.EventEmitter<{ id: string; focus: boolean; pages: NavigatorPage[] }>();
	readonly onDidReveal = this.revealed.event;
	private readonly items = new Map<string, vscode.TreeItem>();
	private readonly children = new Map<string, Promise<vscode.TreeItem[]>>();
	private readonly locations = new Map<string, { parent?: string; offset: number }>();
	private state: NavigatorState = { expanded: [], collapsed: [] };
	private selected: vscode.TreeItem | undefined;
	private generation = 0;
	private readonly subscription: vscode.Disposable;

	constructor(
		readonly provider: Pick<MetadataTreeDataProvider, 'getChildren' | 'getParent' | 'onDidChangeTreeData'>,
		private readonly icon: (item: vscode.TreeItem) => Pick<NavigatorNode, 'icon' | 'themeIcon'> = () => ({}),
		private readonly save: (state: NavigatorState) => void = () => undefined,
		private readonly searching: () => boolean = () => false
	) {
		this.subscription = provider.onDidChangeTreeData(() => this.invalidate());
	}

	get epoch(): number { return this.generation; }
	get selection(): readonly vscode.TreeItem[] { return this.selected ? [this.selected] : []; }
	get snapshot(): NavigatorState { return { ...this.state, expanded: [...this.state.expanded], collapsed: [...this.state.collapsed] }; }

	restore(state: NavigatorState): void {
		this.state = { expanded: [...state.expanded], collapsed: [...state.collapsed], selected: state.selected, selectedPages: state.selectedPages };
		this.invalidate();
	}

	invalidate(): void {
		this.generation++;
		this.items.clear();
		this.children.clear();
		this.locations.clear();
		this.selected = undefined;
		this.selectionChanged.fire({ selection: [] });
		this.changed.fire();
	}

	item(id: string, epoch: number): vscode.TreeItem | undefined {
		return epoch === this.generation ? this.items.get(id) : undefined;
	}

	/** Страница ограничена 100 узлами, даже если группа содержит десятки тысяч объектов. */
	async page(parent: string | undefined, offset: number, epoch: number): Promise<NavigatorPage | undefined> {
		if (epoch !== this.generation || !Number.isSafeInteger(offset) || offset < 0 || (parent && !this.items.has(parent))) {
			return undefined;
		}
		const key = parent ?? '';
		let reading = this.children.get(key);
		if (!reading) {
			reading = Promise.resolve(this.provider.getChildren(parent ? this.items.get(parent) : undefined));
			this.children.set(key, reading);
			void reading.catch(() => { if (epoch === this.generation) { this.children.delete(key); } });
		}
		const children = await reading;
		if (epoch !== this.generation) {
			return undefined;
		}
		const nodes = children.slice(offset, offset + 100).map(item => this.dto(item));
		nodes.forEach(node => this.locations.set(node.id, { parent, offset }));
		return { epoch, parent, offset, total: children.length, nodes };
	}

	private dto(item: vscode.TreeItem): NavigatorNode {
		const id = metadataNodeId(item);
		this.items.set(id, item);
		if (this.state.selected === id && this.selected !== item) {
			this.selected = item;
			this.selectionChanged.fire({ selection: [item] });
		}
		return {
			id, label: typeof item.label === 'string' ? item.label : item.label?.label ?? '',
			description: typeof item.description === 'string' ? item.description : undefined,
			tooltip: typeof item.tooltip === 'string' ? item.tooltip : item.tooltip?.value,
			expandable: item.collapsibleState !== vscode.TreeItemCollapsibleState.None && item.collapsibleState !== undefined,
			expanded: this.searching() ? item.collapsibleState === vscode.TreeItemCollapsibleState.Expanded
				: this.state.expanded.includes(id) || (!this.state.collapsed.includes(id) && item.collapsibleState === vscode.TreeItemCollapsibleState.Expanded),
			selected: this.state.selected === id, openable: !!item.command, ...this.icon(item),
		};
	}

	select(id: string, epoch: number): vscode.TreeItem | undefined {
		const item = this.item(id, epoch);
		if (!item) { return undefined; }
		this.selected = item;
		this.state.selected = id;
		const pages: { parent?: string; offset: number }[] = [];
		let location = this.locations.get(id);
		while (location && pages.length < 50) { pages.unshift(location); location = location.parent ? this.locations.get(location.parent) : undefined; }
		this.state.selectedPages = pages;
		this.save(this.snapshot);
		this.selectionChanged.fire({ selection: [item] });
		return item;
	}

	/** Восстанавливает только страницы пути к выбору, включая объект после первой сотни. */
	async restoreSelection(): Promise<void> {
		const epoch = this.epoch;
		const id = this.state.selected;
		if (!id || !this.state.selectedPages?.length || this.searching()) { return; }
		const pages: NavigatorPage[] = [];
		for (const location of this.state.selectedPages.slice(0, 50)) {
			const page = await this.page(location.parent, location.offset, epoch);
			if (!page) { return; }
			pages.push(page);
		}
		if (epoch === this.epoch && this.items.has(id)) { this.revealed.fire({ id, focus: false, pages }); }
	}

	setExpanded(id: string, value: boolean, epoch: number): void {
		const item = this.item(id, epoch);
		if (!item || item.collapsibleState === vscode.TreeItemCollapsibleState.None) { return; }
		this.state.expanded = this.state.expanded.filter(key => key !== id);
		this.state.collapsed = this.state.collapsed.filter(key => key !== id);
		(value ? this.state.expanded : this.state.collapsed).push(id);
		(value ? this.expanded : this.collapsed).fire({ element: item });
		this.save(this.snapshot);
	}

	collapseAll(): void {
		const collapsed = new Set([...this.state.collapsed, ...this.state.expanded]);
		for (const [id, item] of this.items) {
			if (item.collapsibleState !== undefined && item.collapsibleState !== vscode.TreeItemCollapsibleState.None) {
				collapsed.add(id);
				if (item instanceof MetadataSourceTreeItem) { this.collapsed.fire({ element: item }); }
			}
		}
		this.state.expanded = []; this.state.collapsed = [...collapsed]; this.save(this.snapshot);
		this.changed.fire();
	}

	async reveal(item: vscode.TreeItem, options: { select?: boolean; focus?: boolean; expand?: boolean | number } = {}): Promise<void> {
		const epoch = this.epoch;
		const path: vscode.TreeItem[] = [item];
		let parent = this.provider.getParent(item);
		while (parent) {
			path.unshift(parent);
			parent = this.provider.getParent(parent);
		}
		// Внешние файлы у прежнего провайдера лежат непосредственно под источником.
		const roots = await this.provider.getChildren();
		if (epoch !== this.epoch) { return; }
		roots.forEach(root => this.dto(root));
		const first = path[0];
		if (!(first instanceof MetadataSourceTreeItem) && first instanceof MetadataLeafTreeItem) {
			const source = roots.find(root => root instanceof MetadataSourceTreeItem && root.sourceId === first.sourceId);
			if (source) { path.unshift(source); }
		}
		const pages: NavigatorPage[] = [];
		for (let index = 0; index < path.length; index++) {
			if (epoch !== this.epoch) { return; }
			const current = path[index];
			this.dto(current);
			const parentId = index > 0 ? metadataNodeId(path[index - 1]) : undefined;
			const key = parentId ?? '';
			let reading = this.children.get(key);
			if (!reading) { reading = Promise.resolve(this.provider.getChildren(index > 0 ? path[index - 1] : undefined)); this.children.set(key, reading); }
			const siblings = await reading;
			if (epoch !== this.epoch) { return; }
			const position = siblings.findIndex(sibling => metadataNodeId(sibling) === metadataNodeId(current));
			const page = await this.page(parentId, Math.max(0, Math.floor(position / 100) * 100), epoch);
			if (page) { pages.push(page); }
			if (index < path.length - 1 || options.expand) {
				this.setExpanded(metadataNodeId(current), true, epoch);
			}
		}
		if (options.select !== false) { this.select(metadataNodeId(item), epoch); }
		for (const page of pages) { page.nodes = page.nodes.map(node => this.dto(this.items.get(node.id)!)); }
		this.changed.fire();
		this.revealed.fire({ id: metadataNodeId(item), focus: options.focus === true, pages });
	}

	dispose(): void {
		this.generation++;
		this.subscription.dispose();
		this.changed.dispose(); this.selectionChanged.dispose(); this.expanded.dispose(); this.collapsed.dispose(); this.revealed.dispose();
		this.items.clear(); this.children.clear(); this.locations.clear();
	}
}
