/**
 * Отдельная панель «Свойства»: показывает свойства того, что выделено, откуда бы выделение ни пришло.
 *
 * Содержимое описывается данными, а не разметкой: источник отдаёт группы и строки
 * (`PropertyPaletteState`), панель их рисует. Так один и тот же механизм обслуживает элементы
 * формы, объекты метаданных и всё, что появится дальше.
 *
 * @module propertyPaletteView
 */

import * as vscode from 'vscode';
import { registerFocusedSave, SAVE_REQUEST_MESSAGE } from '../editors/formPanels';
import { loadWebviewTemplate } from '../../shared/webviewTemplate';

export const PROPERTY_PALETTE_VIEW_ID = '1c-platform-tools-properties-palette';

/** Панель свойств в фокусе. */
export const PROPERTY_PALETTE_FOCUSED = '1c-platform-tools.propertiesPaletteFocused';

/** Вид редактора значения. */
export type PropertyControlKind = 'text' | 'multiline' | 'number' | 'boolean' | 'select' | 'reference';

/** Одно свойство: путь в модели источника, подпись и значение. */
export interface PropertyRow {
	readonly key: string;
	readonly label: string;
	readonly kind: PropertyControlKind;
	readonly value?: string;
	readonly options?: readonly { readonly value: string; readonly label: string }[];
	/** Свойство только для чтения: источник его не записывает. */
	readonly readonly?: boolean;
	/** От значения зависит состав строк: выбор перестраивает панель, не записывая файл. */
	readonly rebuilds?: boolean;
	/** Пояснение к свойству: показывается внизу панели у выделенной строки. */
	readonly hint?: string;
	/** Состояние свойства заимствованного узла: отметка под подписью. */
	readonly state?: { readonly label: string; readonly hint: string; readonly changed: boolean };
}

/** Изменённые значения: ключ строки -> новое значение. */
export type PropertyEdits = Readonly<Record<string, string>>;

/**
 * Записывает изменения источника.
 *
 * @returns Свойства после записи; источник перечитывает их сам.
 * @throws Текст ошибки показывается в панели.
 */
export type PropertyApplyHandler = (edits: PropertyEdits) => Promise<PropertyPaletteState | undefined>;

/**
 * Пересобирает свойства с наложенной правкой, не записывая файл.
 *
 * Нужен свойствам, от которых зависит состав строк: выбрали тип - под ним появились
 * его квалификаторы, как в конфигураторе.
 *
 * @returns Свойства с учётом правки или undefined, если пересобрать нечем
 */
export type PropertyPreviewHandler = (edits: PropertyEdits) => Promise<PropertyPaletteState | undefined>;

/** Группа свойств: заголовок и строки в порядке источника. */
export interface PropertyGroup {
	readonly title: string;
	readonly rows: readonly PropertyRow[];
}

/** Состояние панели: что выделено и какие у него свойства. */
export interface PropertyPaletteState {
	/** Кто выделен: имя элемента, объекта, реквизита. */
	readonly title: string;
	/** Вид выделенного: тип элемента формы, вид объекта метаданных. */
	readonly subtitle?: string;
	readonly groups: readonly PropertyGroup[];
	/** Что показать вместо списка, когда свойств нет: иначе панель скажет «ничего не выделено». */
	readonly emptyText?: string;
}

export class PropertyPaletteViewProvider implements vscode.WebviewViewProvider {
	private _view: vscode.WebviewView | undefined;
	private _state: PropertyPaletteState | undefined;
	/** Кто последним показал свойства: чужой источник не гасит чужое выделение. */
	private _ownerId: string | undefined;
	private _onApply: PropertyApplyHandler | undefined;
	private _onPreview: PropertyPreviewHandler | undefined;
	private readonly _onDidChangeVisibility = new vscode.EventEmitter<void>();
	/** Фокус в этой панели. */
	private _inputFocused = false;
	private _focusedSave: vscode.Disposable | undefined;

	/** Панель открыта: пока она закрыта, источникам незачем читать свойства. */
	readonly onDidChangeVisibility = this._onDidChangeVisibility.event;

	constructor(private readonly _extensionUri: vscode.Uri) {}

	get visible(): boolean {
		return this._view?.visible === true;
	}

	/** Кто сейчас показан: источник не должен перебивать чужое выделение без действия пользователя. */
	get owner(): string | undefined {
		return this._ownerId;
	}

	async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
		this._view = view;
		this._focusedSave?.dispose();
		this._focusedSave = registerFocusedSave(
			() => this._inputFocused,
			() => this.requestSave()
		);
		view.onDidChangeVisibility(() => this._onDidChangeVisibility.fire());
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'resources')],
		};
		view.webview.html = await this.html();
		view.webview.onDidReceiveMessage((message: unknown) => {
			const msg = message as { type?: string; edits?: PropertyEdits } | null;
			if (msg?.type === 'ready') {
				this.push();
			} else if (msg?.type === 'apply') {
				void this.apply(msg.edits ?? {});
			} else if (msg?.type === 'preview') {
				void this.preview(msg.edits ?? {});
			} else if (msg?.type === 'focus') {
				this.setInputFocused(true);
			} else if (msg?.type === 'blur') {
				this.setInputFocused(false);
			}
		});
		view.onDidDispose(() => {
			this._view = undefined;
			this._focusedSave?.dispose();
			this._focusedSave = undefined;
			this.setInputFocused(false);
		});
		this.push();
		this._onDidChangeVisibility.fire();
	}

	/**
	 * Показывает свойства выделенного.
	 *
	 * @param ownerId Источник выделения: панель гаснет только по его же команде.
	 * @param state Что показать.
	 * @param onApply Запись изменений; без него свойства только для чтения.
	 */
	show(
		ownerId: string,
		state: PropertyPaletteState,
		onApply?: PropertyApplyHandler,
		onPreview?: PropertyPreviewHandler
	): void {
		this._ownerId = ownerId;
		this._state = state;
		this._onApply = onApply;
		this._onPreview = onPreview;
		this.push();
		this.syncHeader();
	}

	/** Убирает свойства, если панель показывает выделение этого источника. */
	clear(ownerId: string): void {
		if (this._ownerId !== ownerId) {
			return;
		}
		this.reset();
	}

	/** Просит панель записать черновик. */
	requestSave(): void {
		void this._view?.webview.postMessage(SAVE_REQUEST_MESSAGE);
	}

	private setInputFocused(focused: boolean): void {
		this._inputFocused = focused;
		void vscode.commands.executeCommand('setContext', PROPERTY_PALETTE_FOCUSED, focused);
	}

	/** Убирает свойства, чьи бы они ни были: так панель гаснет при смене проекта. */
	reset(): void {
		this._ownerId = undefined;
		this._state = undefined;
		this._onApply = undefined;
		this._onPreview = undefined;
		this.push();
		this.syncHeader();
	}

	/**
	 * Пересобирает свойства с черновиком правок: файл не меняется, меняется только показ.
	 */
	private async preview(edits: PropertyEdits): Promise<void> {
		const handler = this._onPreview;
		if (!handler) {
			return;
		}
		try {
			const state = await handler(edits);
			if (state) {
				this._state = state;
				void this._view?.webview.postMessage({ type: 'rebuilt', state, edits });
			}
		} catch {
			// Пересборка показа не критична: панель останется с прежним составом строк
		}
	}

	/** Записывает изменения и показывает свойства заново: в файле лежит уже другое. */
	private async apply(edits: PropertyEdits): Promise<void> {
		const handler = this._onApply;
		if (!handler) {
			void this._view?.webview.postMessage({ type: 'applied', ok: false, error: 'Свойства только для чтения' });
			return;
		}
		try {
			const state = await handler(edits);
			if (state) {
				this._state = state;
			}
			void this._view?.webview.postMessage({ type: 'applied', ok: true, state: this._state });
			this.syncHeader();
		} catch (e) {
			void this._view?.webview.postMessage({
				type: 'applied',
				ok: false,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	/** В заголовке панели видно, чьи свойства показаны: имя выделенного рядом с названием плашки. */
	private syncHeader(): void {
		if (this._view) {
			this._view.description = this._state?.title;
		}
	}

	private push(): void {
		void this._view?.webview.postMessage({
			type: 'state',
			state: this._state,
			editable: this._onApply !== undefined,
		});
	}

	private async html(): Promise<string> {
		return loadWebviewTemplate(this._extensionUri, 'property-palette.html');
	}
}
