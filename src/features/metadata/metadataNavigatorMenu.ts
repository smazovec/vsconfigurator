import * as vscode from 'vscode';

interface MenuEntry { command: string; when?: string; group?: string }
interface Manifest { contributes: { commands: { command: string; title: string }[]; menus: Record<string, MenuEntry[]> } }

/** Подмножество when, используемое прежним меню дерева. Неизвестный синтаксис закрывает пункт. */
export function navigatorWhen(expression: string, values: Readonly<Record<string, string | boolean>>): boolean {
	const tokens = expression.match(/\/(?:[^/\\]|\\.)*\/[a-z]*|&&|\|\||==|!=|=~|!~|[()!]|[^\s()=!&|]+/g) ?? [];
	let cursor = 0;
	const atom = (): boolean => {
		const left = tokens[cursor++];
		if (left === '!') { return !atom(); }
		if (left === '(') { const result = or(); if (tokens[cursor++] !== ')') { throw new Error('when'); } return result; }
		if (!left) { throw new Error('when'); }
		const op = tokens[cursor];
		if (['==', '!=', '=~', '!~'].includes(op)) {
			cursor++;
			const right = tokens[cursor++];
			if (!right) { throw new Error('when'); }
			if (op === '=~' || op === '!~') {
				const end = right.lastIndexOf('/');
				if (right[0] !== '/' || end === 0) { throw new Error('when'); }
				const result = new RegExp(right.slice(1, end), right.slice(end + 1)).test(String(values[left] ?? ''));
				return op === '=~' ? result : !result;
			}
			const result = String(values[left] ?? '') === right.replace(/^['"]|['"]$/g, '');
			return op === '==' ? result : !result;
		}
		return values[left] === true;
	};
	const and = (): boolean => { let result = atom(); while (tokens[cursor] === '&&') { cursor++; const next = atom(); result = result && next; } return result; };
	const or = (): boolean => { let result = and(); while (tokens[cursor] === '||') { cursor++; const next = and(); result = result || next; } return result; };
	try { const result = or(); return cursor === tokens.length && result; } catch { return false; }
}

/** Меню берётся из прежних contributions, команды не поступают от webview. */
export function navigatorMenu(manifest: Manifest, item: vscode.TreeItem, filterActive: boolean): { command: string; title: string }[] {
	const values = { view: '1c-platform-tools-metadata-tree', viewItem: item.contextValue ?? '', '1c-platform-tools.metadata.subsystemFilterActive': filterActive };
	const titles = new Map(manifest.contributes.commands.map(entry => [entry.command, entry.title]));
	const seen = new Set<string>();
	return (manifest.contributes.menus['view/item/context'] ?? [])
		.filter(entry => entry.when?.includes('1c-platform-tools-metadata-tree') && navigatorWhen(entry.when, values))
		.sort((a, b) => (a.group ?? '').localeCompare(b.group ?? ''))
		.filter(entry => !seen.has(entry.command) && !!seen.add(entry.command))
		.map(entry => ({ command: entry.command, title: titles.get(entry.command) ?? entry.command }));
}
