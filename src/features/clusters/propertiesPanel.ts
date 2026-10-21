/**
 * Карточка свойств объекта кластера.
 *
 * Карточек в консоли две — у информационной базы и у самого кластера, — и ведут
 * они себя одинаково: читают объект, показывают разделы с полями, сохраняют
 * только изменённые значения. Поэтому панель здесь одна, а что показывать и
 * куда отправлять, ей сообщает описание объекта.
 */

import * as vscode from 'vscode';
import { fillWebviewTemplate, loadWebviewTemplate } from '../../shared/webviewTemplate';
import { registerFormPanel } from '../editors/formPanels';
import { CHROME_LABELS, chromeScript, chromeStyles, saveBarHtml } from '../editors/webviewChrome';
import type { PropertySection, PropertyValues } from './propertiesForm';

/** Учётные данные объекта: наборы на выбор и текущая привязка. */
export interface AccessState {
	sets: Array<{ id: string; name: string; user: string }>;
	/** Привязанный набор; пусто — не назначен. */
	boundId?: string;
	/** Цвет точки наборов. */
	color: string;
}

/** Выбор набора: сохранённый или данные нового. */
export type AccessChoice = { setId: string } | { name: string; user: string; password: string };

/** Учётные данные, с которыми карточка читает объект. */
export interface PropertiesAccess {
	state: () => AccessState;
	/** Проверяет набор и привязывает его. */
	grant: (choice: AccessChoice) => Promise<{ ok: true } | { ok: false; message: string }>;
	/** Снимает привязку. */
	revoke: () => Promise<void>;
}

/** Итог чтения объекта. */
export type PropertiesLoadResult =
	| { ok: true; values: PropertyValues }
	| {
			ok: false;
			message: string;
			/** Объект не читается без учётных данных: карточка предлагает их на месте. */
			accessRequired?: boolean;
	  };

/** Что делает карточка: чем наполняется и куда сохраняет. */
export interface PropertiesDescriptor {
	/**
	 * Ключ объекта: у каждого своя вкладка.
	 *
	 * Повторное открытие того же объекта переиспользует вкладку, а разные
	 * объекты открываются рядом — свойства двух соединений сравнивают глазами.
	 */
	key: string;
	/** Заголовок вкладки. */
	title: string;
	/** Пояснение в шапке: подключение и адрес. */
	subtitle: string;
	/** Разделы с полями. */
	sections: PropertySection[];
	/** Читает значения объекта. */
	load: () => Promise<PropertiesLoadResult>;
	/** Учётные данные объекта: блок над разделами. */
	access?: PropertiesAccess;
	/** Проверяет значения перед отправкой. */
	validate: (values: PropertyValues) => string[];
	/**
	 * Сохраняет правки.
	 *
	 * Получает прочитанные и набранные значения целиком: что из них изменилось и
	 * как перевести это в параметры rac, знает описание объекта.
	 */
	save: (
		before: PropertyValues,
		after: PropertyValues
	) => Promise<{ ok: true; changed: boolean } | { ok: false; message: string }>;
}

/**
 * Находит поля, которые платформа не применила.
 *
 * Сравниваются набранные значения и то, что сервер отдал после сохранения:
 * расхождение означает, что параметр не принят, хотя вызов прошёл без ошибки.
 *
 * @param sections - Разделы карточки
 * @param requested - Значения, отправленные на сервер
 * @param actual - Значения, прочитанные после сохранения
 * @returns Подписи непринятых полей
 */
export function unappliedFields(
	sections: PropertySection[],
	requested: PropertyValues,
	actual: PropertyValues
): string[] {
	const titles: string[] = [];
	for (const section of sections) {
		for (const field of section.fields) {
			if (field.kind === 'readonly') {
				continue;
			}
			const want = (requested[field.key] ?? '').trim();
			const got = (actual[field.key] ?? '').trim();
			if (want !== got) {
				titles.push(field.title);
			}
		}
	}
	return titles;
}

/** Сообщение из карточки. */
type PanelMessage =
	| { type: 'save'; data: PropertyValues }
	| { type: 'reload' }
	| { type: 'grantAccess'; choice: AccessChoice }
	| { type: 'revokeAccess' }
	| { type: 'error'; message: string };

/** Открытая карточка: вкладка вместе с тем, что она показывает. */
interface OpenCard {
	panel: vscode.WebviewPanel;
	descriptor: PropertiesDescriptor;
	/** Значения, прочитанные с сервера: с ними сравниваются правки формы. */
	baseline: PropertyValues;
	/** Прочитан ли объект последним чтением. */
	loaded: boolean;
}

/**
 * Карточки свойств объектов кластера.
 *
 * Каждому объекту достаётся своя вкладка: свойства двух соединений или сеансов
 * администратор сравнивает рядом, и общая вкладка, перерисовывающая себя под
 * последний выбранный объект, такое сравнение сделала бы невозможным. Повторное
 * открытие того же объекта переиспользует его вкладку, а не плодит копии.
 */
export class PropertiesPanel {
	/** Открытые карточки по ключу объекта. */
	private readonly cards = new Map<string, OpenCard>();

	/**
	 * @param viewType - Тип вкладки для восстановления раскладки VS Code
	 */
	constructor(
		private readonly viewType: string,
		private readonly extensionUri: vscode.Uri
	) {}

	/**
	 * Открывает карточку объекта.
	 *
	 * @param descriptor - Что показывать и куда сохранять
	 */
	async open(descriptor: PropertiesDescriptor): Promise<void> {
		const existing = this.cards.get(descriptor.key);
		if (existing) {
			existing.descriptor = descriptor;
			existing.panel.title = descriptor.title;
			existing.panel.reveal(existing.panel.viewColumn);
			await this.load(descriptor.key);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			this.viewType,
			descriptor.title,
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true }
		);
		panel.webview.html = await buildHtml(this.extensionUri);
		registerFormPanel(panel);
		panel.webview.onDidReceiveMessage((message: PanelMessage) =>
			this.handleMessage(descriptor.key, message)
		);
		panel.onDidDispose(() => {
			this.cards.delete(descriptor.key);
		});
		this.cards.set(descriptor.key, { panel, descriptor, baseline: {}, loaded: false });
		await this.load(descriptor.key);
	}

	dispose(): void {
		for (const card of this.cards.values()) {
			card.panel.dispose();
		}
		this.cards.clear();
	}

	/**
	 * Читает объект и отправляет значения в форму.
	 *
	 * @param key - Ключ открытой карточки
	 */
	private async load(key: string): Promise<void> {
		const card = this.cards.get(key);
		if (!card) {
			return;
		}
		const result = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: `Читаю: ${card.descriptor.title}` },
			() => card.descriptor.load()
		);
		const access = card.descriptor.access?.state();
		card.loaded = result.ok;
		if (!result.ok) {
			void card.panel.webview.postMessage({
				type: 'failed',
				message: result.message,
				access: result.accessRequired ? access : undefined,
				subtitle: card.descriptor.subtitle,
			});
			return;
		}
		card.baseline = result.values;
		void card.panel.webview.postMessage({
			type: 'model',
			sections: card.descriptor.sections,
			values: card.baseline,
			subtitle: card.descriptor.subtitle,
			access,
		});
	}

	/**
	 * Привязывает набор или снимает привязку.
	 *
	 * Прочитанную карточку не перечитывает: перечитывание сбросило бы
	 * несохранённые правки в полях.
	 *
	 * @param key - Ключ открытой карточки
	 * @param choice - Набор; пусто — снять привязку
	 */
	private async changeAccess(key: string, choice: AccessChoice | undefined): Promise<void> {
		const card = this.cards.get(key);
		const access = card?.descriptor.access;
		if (!card || !access) {
			return;
		}
		if (choice) {
			const result = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Window, title: `Проверяю учётные данные: ${card.descriptor.title}` },
				() => access.grant(choice)
			);
			if (!result.ok) {
				void card.panel.webview.postMessage({ type: 'accessFailed', message: result.message });
				return;
			}
		} else {
			await access.revoke();
		}
		if (card.loaded) {
			void card.panel.webview.postMessage({ type: 'access', access: access.state() });
			return;
		}
		await this.load(key);
	}

	/**
	 * Обрабатывает сообщение карточки.
	 *
	 * @param key - Ключ открытой карточки
	 * @param message - Сообщение
	 */
	private async handleMessage(key: string, message: PanelMessage): Promise<void> {
		const card = this.cards.get(key);
		if (!card) {
			return;
		}
		if (message.type === 'reload') {
			await this.load(key);
			return;
		}
		if (message.type === 'error') {
			void vscode.window.showErrorMessage(`${card.descriptor.title}: ${message.message}`);
			return;
		}
		if (message.type === 'grantAccess' || message.type === 'revokeAccess') {
			await this.changeAccess(key, message.type === 'grantAccess' ? message.choice : undefined);
			return;
		}

		const problems = card.descriptor.validate(message.data);
		if (problems.length > 0) {
			void card.panel.webview.postMessage({ type: 'saveFailed', message: problems.join('; ') });
			return;
		}

		const requested = message.data;
		const result = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: `Сохраняю: ${card.descriptor.title}` },
			() => card.descriptor.save(card.baseline, requested)
		);
		if (!result.ok) {
			void card.panel.webview.postMessage({ type: 'saveFailed', message: result.message });
			return;
		}
		if (result.changed) {
			await this.load(key);
		}
		// Часть параметров платформа принимает молча, но не применяет: вызов
		// завершается успешно, а значение остаётся прежним. Молчать об этом нельзя —
		// иначе «Сохранено» врёт, и поле необъяснимо возвращается к старому виду.
		const ignored = unappliedFields(card.descriptor.sections, requested, card.baseline);
		void card.panel.webview.postMessage({
			type: 'saved',
			message:
				ignored.length > 0 ? `Сохранено; платформа не приняла: ${ignored.join(', ')}` : undefined,
		});
	}
}

/** Разметка и скрипт карточки. */
async function buildHtml(extensionUri: vscode.Uri): Promise<string> {
	const nonce = Math.random().toString(36).slice(2);
	const template = await loadWebviewTemplate(extensionUri, 'cluster-properties.html');
	return fillWebviewTemplate(template, {
		NONCE: nonce,
		CHROME_STYLES: chromeStyles(),
		SAVE_BAR: saveBarHtml(),
		CHROME_SCRIPT: chromeScript(),
		SAVED_LABEL: JSON.stringify(CHROME_LABELS.saved),
	});
}
