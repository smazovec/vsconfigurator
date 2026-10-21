import * as vscode from 'vscode';
import type { MeasureResults } from './measure';
import { fillWebviewTemplate, loadWebviewTemplate } from '../../shared/webviewTemplate';

interface MeasureRow {
	path: string;
	module: string;
	line: number;
	code: string;
	count: number;
	ms: number;
	ownMs: number;
	percent: number;
	server: boolean;
}

let panel: vscode.WebviewPanel | undefined;

/**
 * Таблица результатов замера производительности: модуль, строка, код, число выполнений,
 * время и доля от общего. Клик по строке открывает модуль на нужной позиции.
 */
export async function showMeasureResultsPanel(results: MeasureResults, extensionUri: vscode.Uri): Promise<void> {
	const rows = await buildRows(results);

	if (!panel) {
		panel = vscode.window.createWebviewPanel(
			'1c-platform-tools.measureResults',
			'Замер производительности',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
			{ enableScripts: true, retainContextWhenHidden: true }
		);
		panel.onDidDispose(() => {
			panel = undefined;
		});
		panel.webview.onDidReceiveMessage(async (msg: { path?: string; line?: number }) => {
			if (!msg.path || !msg.line) {
				return;
			}
			try {
				const doc = await vscode.workspace.openTextDocument(msg.path);
				const editor = await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
				const position = new vscode.Position(msg.line - 1, 0);
				editor.selection = new vscode.Selection(position, position);
				editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
			} catch {
				void vscode.window.showWarningMessage(`Не удалось открыть модуль: ${msg.path}`);
			}
		});
	}

	panel.webview.html = await renderHtml(extensionUri, results.totalSeconds, rows);
	panel.reveal(undefined, true);
}

export function disposeMeasureResultsPanel(): void {
	panel?.dispose();
	panel = undefined;
}

async function buildRows(results: MeasureResults): Promise<MeasureRow[]> {
	const rows: MeasureRow[] = [];
	const total = results.totalSeconds;

	for (const module of results.modules) {
		let doc: vscode.TextDocument | undefined;
		try {
			doc = await vscode.workspace.openTextDocument(module.path);
		} catch {
			// Модуль вне рабочей области — строки покажем без текста кода.
		}
		const relative = vscode.workspace.asRelativePath(module.path);

		for (const line of module.lines) {
			rows.push({
				path: module.path,
				module: relative,
				line: line.line,
				code: doc && line.line >= 1 && line.line <= doc.lineCount ? doc.lineAt(line.line - 1).text.trim() : '',
				count: line.count,
				ms: line.seconds * 1000,
				ownMs: line.ownSeconds * 1000,
				percent: total > 0 ? (line.seconds / total) * 100 : 0,
				server: line.serverCall,
			});
		}
	}

	return rows;
}

async function renderHtml(extensionUri: vscode.Uri, totalSeconds: number, rows: MeasureRow[]): Promise<string> {
	// «</script>» внутри данных не должен разрывать встроенный скрипт.
	const data = JSON.stringify(rows).replace(/</g, '\\u003c');
	const total = totalSeconds >= 1 ? `${totalSeconds.toFixed(2)} с` : `${(totalSeconds * 1000).toFixed(1)} мс`;
	const template = await loadWebviewTemplate(extensionUri, 'measure-results.html');
	return fillWebviewTemplate(template, { TOTAL: total, DATA: data });
}
