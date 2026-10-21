/**
 * HTML-страницы webview лежат файлами в `resources/webview`, а не строками в коде.
 * @module webviewTemplate
 */

import * as vscode from 'vscode';

const decoder = new TextDecoder('utf-8');

/**
 * Читает страницу из `resources/webview`.
 *
 * @param extensionUri - Корень расширения
 * @param file - Имя файла страницы
 * @returns Разметка страницы
 */
export async function loadWebviewTemplate(extensionUri: vscode.Uri, file: string): Promise<string> {
	const uri = vscode.Uri.joinPath(extensionUri, 'resources', 'webview', file);
	return decoder.decode(await vscode.workspace.fs.readFile(uri));
}

/**
 * Подставляет значения в `{{ИМЯ}}` страницы.
 *
 * @param template - Разметка с местозаполнителями
 * @param values - Значения по именам
 * @returns Готовая разметка
 */
export function fillWebviewTemplate(template: string, values: Readonly<Record<string, string>>): string {
	return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (placeholder, name: string) => values[name] ?? placeholder);
}
