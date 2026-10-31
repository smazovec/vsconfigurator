import * as vscode from 'vscode';
import { MD_BOILERPLATE_KIND_TO_XML_TAG, parseMdBoilerplateKindFromCommandArgs } from './metadataBoilerplateNames';
import {
	MetadataLeafTreeItem, MetadataMdGroupTreeItem, MetadataMdSubgroupTreeItem,
	MetadataObjectNodeTreeItem, MetadataObjectSectionTreeItem, MetadataSourceTreeItem,
	childNodeSupport,
} from './metadataTreeView';

export type MetadataObjectAction = 'add' | 'open' | 'duplicate' | 'delete';
export type MetadataToolbarAction = MetadataObjectAction | 'refresh' | 'filters' | 'clearFilter';
export type MetadataObjectCommands = Partial<Record<MetadataObjectAction, string>>;

const command = (name: string): string => `1c-platform-tools.metadata.${name}`;
const mutableTypes = new Set<string>([...Object.values(MD_BOILERPLATE_KIND_TO_XML_TAG), 'ExternalReport', 'ExternalDataProcessor']);

/** Только маршрутизация к действующим командам; проверка записи остаётся в их обработчиках. */
export function metadataObjectCommands(
	item: vscode.TreeItem | undefined,
	source: MetadataSourceTreeItem | undefined,
	writable: boolean
): MetadataObjectCommands {
	if (!item) {
		return {};
	}
	const result: MetadataObjectCommands = {};
	const tokens = new Set(item.contextValue?.split(/\s+/));
	if (item instanceof MetadataLeafTreeItem && item.resourceUri) {
		result.open = command('openProperties');
	} else if (item instanceof MetadataObjectNodeTreeItem && item.owner.resourceUri) {
		result.open = item.command?.command ?? command('openProperties');
	} else if (item instanceof MetadataSourceTreeItem && tokens.has('metadataSourceConfigLike')) {
		result.open = command('openProperties');
	}
	if (!writable) {
		return result;
	}
	if (item instanceof MetadataSourceTreeItem && tokens.has('metadataExtensionRoot')) {
		result.delete = command('deleteExtension');
	}
	if (source?.unsupportedSchemaVersion !== undefined) {
		return result;
	}
	const sourceLocked = source?.support === 'locked'
		|| (source?.contextValue?.split(/\s+/).includes('mdSupportRules') && source.supportEditingEnabled !== true);
	const sourceEditingOff = source?.contextValue?.split(/\s+/).includes('mdSupportRules') && source.supportEditingEnabled !== true;
	if (item instanceof MetadataMdGroupTreeItem || item instanceof MetadataMdSubgroupTreeItem) {
		if (source && !sourceLocked && parseMdBoilerplateKindFromCommandArgs([item])) {
			result.add = command('addObject');
		}
	} else if (item instanceof MetadataSourceTreeItem && tokens.has('metadataSourceExternalArtifact')) {
		result.add = command('addObject');
	} else if (item instanceof MetadataLeafTreeItem && item.resourceUri && item.support !== 'locked' && !sourceEditingOff) {
		if (mutableTypes.has(item.objectType)) {
			result.duplicate = command('duplicateObject');
			result.delete = command('deleteObject');
		}
	} else if (item instanceof MetadataObjectSectionTreeItem || item instanceof MetadataObjectNodeTreeItem) {
		if (item instanceof MetadataObjectNodeTreeItem && item.nodeKind === 'form') {
			if (item.owner.resourceUri && !sourceEditingOff && childNodeSupport(item.owner.support, item.support, true) !== 'locked') {
				result.delete = command('deleteChildNode');
			}
			return result;
		}
		if (!item.owner.resourceUri || item.owner.support === 'locked' || sourceEditingOff
			|| (item instanceof MetadataObjectNodeTreeItem && item.support === 'locked')) {
			return result;
		}
		if (tokens.has('mdSectionAdd') || tokens.has('mdChildAdd')) {
			result.add = command('addChildNode');
		}
		if (tokens.has('mdChildDuplicate')) {
			result.duplicate = command('duplicateChildNode');
		}
		if (tokens.has('mdChildEdit') || tokens.has('mdChildDelete')) {
			result.delete = command('deleteChildNode');
		}
	}
	return result;
}

/** Версия страницы не позволяет отложенному клику примениться к новому выделению. */
export class MetadataToolbarSelection {
	private item: vscode.TreeItem | undefined;
	private revision = 0;

	constructor(
		private readonly commandsFor: (item: vscode.TreeItem | undefined) => MetadataObjectCommands,
		private readonly execute: (command: string, item: vscode.TreeItem) => Thenable<unknown>
	) {}

	select(item: vscode.TreeItem | undefined): void {
		this.item = item;
		this.revision++;
	}

	state(): { revision: number; enabled: MetadataObjectAction[] } {
		return { revision: this.revision, enabled: Object.keys(this.commandsFor(this.item)) as MetadataObjectAction[] };
	}

	async run(action: MetadataObjectAction, revision: number): Promise<void> {
		if (!this.item || revision !== this.revision) {
			return;
		}
		const id = this.commandsFor(this.item)[action];
		if (id) {
			await this.execute(id, this.item);
		}
	}
}
