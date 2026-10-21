/**
 * Редактор хуков команд (custom editor поверх `.1cpt/hooks.json`).
 *
 * Слева команды, у которых заданы хуки, справа три раздела шагов: до команды,
 * после команды и при ошибке. Шаг - командная строка, поэтому полотно со
 * связями здесь ни к чему: ветвления у хуков нет, есть порядок.
 *
 * Каркас общий с редактором пайплайнов: список слева, панель действий сверху,
 * панель сохранения снизу. Правки живут в форме, файл меняется по кнопке.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { logger } from '../../shared/logger';
import { fillWebviewTemplate, loadWebviewTemplate } from '../../shared/webviewTemplate';
import { invalidateHooksCache, runHookPhaseDry } from '../../shared/commandHooks';
import { readCommandCatalog, CommandCatalogEntry } from '../../shared/commandCatalog';
import {
	normalizeHooks,
	serializeHooks,
	HOOKS_WILDCARD,
	HooksModel,
} from '../../shared/hooks/hooksModel';
import { chromeScript, chromeStyles, saveBarHtml, CHROME_LABELS } from '../editors/webviewChrome';
import { registerFormPanel } from '../editors/formPanels';

const log = logger.scope('hooks');

export const HOOKS_EDITOR_VIEW_TYPE = '1c-platform-tools.hooksEditor';

/** Корень проекта файла хуков: `<корень>/.1cpt/hooks.json`. */
function hooksProjectRoot(uri: vscode.Uri): string {
	return path.dirname(path.dirname(uri.fsPath));
}

/** Сообщения из формы в расширение */
type WebviewMessage =
	| { type: 'save'; data: HooksModel['hooks'] }
	| { type: 'pickCommand' }
	| { type: 'dryRun'; commandId: string; phase: 'pre' | 'post' | 'onError' }
	| { type: 'error'; message: string }
	| { type: 'openJson' };

/** Модель для формы */
interface EditorModel {
	hooks: HooksModel['hooks'];
	catalog: CommandCatalogEntry[];
	error?: string;
}

export class HooksEditorProvider implements vscode.CustomTextEditorProvider {
	/** Открытые формы: команда открытия просит выделить нужную команду */
	private static readonly panels = new Set<vscode.WebviewPanel>();

	/** Команда, которую нужно выделить, когда форма откроется */
	private static pending: string | undefined;

	/**
	 * Просит форму выделить команду с хуками.
	 *
	 * @param commandId - Идентификатор команды расширения
	 */
	static revealCommand(commandId: string): void {
		if (HooksEditorProvider.panels.size === 0) {
			HooksEditorProvider.pending = commandId;
			return;
		}
		for (const panel of HooksEditorProvider.panels) {
			void panel.webview.postMessage({ type: 'select', commandId });
		}
	}

	/**
	 * Регистрирует редактор хуков.
	 *
	 * @param extensionUri - Корень расширения с ресурсами webview
	 * @returns Disposable регистрации
	 */
	static register(extensionUri: vscode.Uri): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			HOOKS_EDITOR_VIEW_TYPE,
			new HooksEditorProvider(extensionUri),
			{ webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }
		);
	}

	constructor(private readonly extensionUri: vscode.Uri) {}

	/**
	 * Открывает документ формой.
	 *
	 * @param document - Файл хуков
	 * @param webviewPanel - Панель редактора
	 */
	async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel
	): Promise<void> {
		webviewPanel.webview.options = { enableScripts: true };
		webviewPanel.webview.html = await buildHtml(this.extensionUri);

		const post = (): void => {
			void webviewPanel.webview.postMessage({ type: 'model', model: this.buildModel(document) });
		};

		const subscription = vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.document.uri.toString() === document.uri.toString()) {
				post();
			}
		});
		HooksEditorProvider.panels.add(webviewPanel);
		registerFormPanel(webviewPanel);
		webviewPanel.onDidDispose(() => {
			HooksEditorProvider.panels.delete(webviewPanel);
			subscription.dispose();
		});

		webviewPanel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
			if (message.type === 'save') {
				await this.save(document, message.data);
				// Правка действует со следующей команды, а не после перезагрузки окна
				invalidateHooksCache(hooksProjectRoot(document.uri));
				void webviewPanel.webview.postMessage({ type: 'saved' });
				post();
				// Дерево команд показывает сохранённое: обновляем сразу, не дожидаясь наблюдателя за файлами
				await vscode.commands.executeCommand('1c-platform-tools.tools.refresh', { silent: true });
				return;
			}
			if (message.type === 'dryRun') {
				const root = hooksProjectRoot(document.uri);
				await document.save();
				invalidateHooksCache(root);
				const result = await runHookPhaseDry(root, message.commandId, message.phase);
				void webviewPanel.webview.postMessage({ type: 'dryRunResult', ...result });
				return;
			}
			if (message.type === 'pickCommand') {
				const commandId = await pickCommand(this.buildModel(document));
				if (commandId !== undefined) {
					void webviewPanel.webview.postMessage({ type: 'addCommand', commandId });
				}
				return;
			}
			if (message.type === 'error') {
				log.error(`Ошибка формы редактора: ${message.message}`);
				return;
			}
			if (message.type === 'openJson') {
				await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
			}
		});

		post();

		if (HooksEditorProvider.pending !== undefined) {
			void webviewPanel.webview.postMessage({ type: 'select', commandId: HooksEditorProvider.pending });
			HooksEditorProvider.pending = undefined;
		}
	}

	/**
	 * Строит модель формы по тексту документа.
	 *
	 * @param document - Файл хуков
	 * @returns Модель с хуками и каталогом команд
	 */
	private buildModel(document: vscode.TextDocument): EditorModel {
		const catalog = readCommandCatalog();
		const text = document.getText().trim();
		if (text === '') {
			return { hooks: {}, catalog };
		}
		try {
			return { hooks: normalizeHooks(JSON.parse(text)).hooks, catalog };
		} catch (error) {
			return {
				hooks: {},
				catalog,
				error: `Файл не разбирается как JSON: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	/**
	 * Записывает хуки в документ и сохраняет его.
	 *
	 * @param document - Файл хуков
	 * @param hooks - Новое содержимое
	 */
	private async save(document: vscode.TextDocument, hooks: HooksModel['hooks']): Promise<void> {
		const next = serializeHooks(normalizeHooks({ hooks }));
		if (next === document.getText()) {
			return;
		}
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), next);
		await vscode.workspace.applyEdit(edit);
		await document.save();
	}
}

/**
 * Спрашивает команду, на которую вешаются хуки.
 *
 * @param model - Текущая модель формы
 * @returns Идентификатор команды или undefined, если выбор отменён
 */
async function pickCommand(model: EditorModel): Promise<string | undefined> {
	const items: Array<vscode.QuickPickItem & { id: string }> = [
		{
			id: HOOKS_WILDCARD,
			label: 'Все команды',
			description: HOOKS_WILDCARD,
			detail: 'Шаги выполняются вокруг каждой команды расширения',
		},
		...model.catalog
			.filter((entry) => model.hooks[entry.id] === undefined)
			.map((entry) => ({
				id: entry.id,
				label: entry.title ?? entry.id,
				description: entry.category,
				detail: entry.id,
			})),
	];
	const picked = await vscode.window.showQuickPick(items, {
		title: 'Хуки команды',
		placeHolder: 'Выберите команду расширения',
		matchOnDetail: true,
	});
	return picked?.id;
}

/** HTML формы: рендер модели в инлайн-скрипте, правки уходят в extension. */
async function buildHtml(extensionUri: vscode.Uri): Promise<string> {
	const nonce = Math.random().toString(36).slice(2);
	const template = await loadWebviewTemplate(extensionUri, 'hooks-editor.html');
	return fillWebviewTemplate(template, {
		NONCE: nonce,
		CHROME_STYLES: chromeStyles(),
		JSON_LABEL: CHROME_LABELS.json,
		ADD_LABEL: CHROME_LABELS.add,
		SAVE_BAR: saveBarHtml(),
		CHROME_SCRIPT: chromeScript(),
		SAVED_LABEL: JSON.stringify(CHROME_LABELS.saved),
	});
}
