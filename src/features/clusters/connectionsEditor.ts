/**
 * Форма подключений к серверам администрирования и учётных данных.
 *
 * Подключение заводится и правится в обычной форме — вкладкой редактора, а не
 * цепочкой диалогов: полей полдесятка, и видеть их вместе важнее, чем отвечать
 * на вопросы по одному. Здесь же кнопка проверки: она отвечает сразу, найдена ли
 * утилита и отвечает ли сервер.
 *
 * Наборы учётных данных живут в этой же форме, второй секцией списка слева:
 * доступ к кластеру настраивают там же, где и сам кластер, — отдельная вкладка
 * заставляла бы искать вторую форму. Пароль после сохранения не показывается;
 * привязки набора к базам видны у выбранного набора и снимаются здесь, а
 * назначаются — из дерева.
 *
 * Форма собрана на общем каркасе редакторов служебных файлов (webviewChrome),
 * поэтому список слева, панель сохранения снизу и подписи кнопок такие же, как
 * у пайплайнов и хуков.
 */

import * as vscode from 'vscode';
import { notifyQuiet } from '../../shared/notify';
import { fillWebviewTemplate, loadWebviewTemplate } from '../../shared/webviewTemplate';
import { registerFormPanel } from '../editors/formPanels';
import { CHROME_LABELS, chromeScript, chromeStyles, saveBarHtml } from '../editors/webviewChrome';
import { DEFAULT_RAS_PORT } from './constants';
import { projectPlatformRoots } from '../../shared/platformSettings';
import { listRacVersions } from './racLocator';
import type { ClusterService } from './clusterService';
import type { ClustersProvider } from './clustersProvider';
import type { ConnectionStore } from './connectionStore';
import type { ClusterConnection } from './model';
import {
	CREDENTIAL_ROLE_COLORS,
	validateCredentialSetInput,
	type ClusterBinding,
	type ClusterCredentialStore,
	type CredentialRole,
	type CredentialSet,
	type InfobaseBinding,
} from './credentials';

/** Подключение в форме. */
export interface ConnectionDraft {
	/** Идентификатор сохранённого подключения; пусто у нового. */
	id: string;
	name: string;
	host: string;
	port: number;
	platformVersion: string;
	/** Набор администратора кластера для этого подключения; пусто — не задан. */
	clusterSetId: string;
	/** Набор администратора центрального сервера; пусто — не задан. */
	agentSetId: string;
}

/** Набор учётных данных в форме: без пароля, но со сведениями о нём. */
export interface CredentialSetDraft {
	id: string;
	name: string;
	user: string;
	/** Роль набора: она же группа в списке. */
	kind: CredentialRole;
	hasPassword: boolean;
	/** Введённый пароль; undefined — не трогали. */
	password?: string;
}

/** Что выбрано в форме: подключение или набор. */
export interface EditorSelection {
	kind: 'connection' | 'set' | '';
	id: string;
	/** Роль создаваемого набора, когда `id: 'new'`. */
	setKind?: CredentialRole;
}

/** На чём открыть форму; `id: 'new'` — добавить запись. */
export interface EditorTarget {
	kind: 'connection' | 'set';
	id?: string;
	/** Для наборов: какую группу открыть или какой роли запись создать. */
	setKind?: CredentialRole;
}

/** Модель формы. */
interface EditorModel {
	connections: ConnectionDraft[];
	sets: CredentialSetDraft[];
	selected: EditorSelection;
}

/** Сообщение из формы. */
type EditorMessage =
	| { type: 'save'; data: EditorModel }
	| { type: 'check'; data: ConnectionDraft }
	| { type: 'checkSet'; data: CredentialSetDraft }
	| { type: 'bindSet'; setId: string }
	| { type: 'bindSetCluster'; setId: string }
	| { type: 'bindSetServer'; setId: string }
	| { type: 'unbind'; binding: InfobaseBinding }
	| { type: 'unbindCluster'; binding: ClusterBinding }
	| { type: 'unbindServer'; connectionId: string; setId: string }
	| { type: 'error'; message: string };

/**
 * Пустая заготовка подключения: ещё не начали заполнять.
 *
 * Заготовка появляется при открытии формы кнопкой «плюс» и не должна ни
 * сохраняться, ни мешать сохранению остального: свежая форма с нетронутой
 * заготовкой — обычное состояние, а не ошибка ввода.
 */
export function isBlankConnectionDraft(draft: ConnectionDraft): boolean {
	return draft.name.trim() === '' && draft.host.trim() === '';
}

/** Пустая заготовка набора: см. {@link isBlankConnectionDraft}. */
export function isBlankSetDraft(draft: CredentialSetDraft): boolean {
	return draft.name.trim() === '' && draft.user.trim() === '' && !draft.password;
}

/**
 * Проверяет заполненность подключения.
 *
 * Форма позволяет ввести что угодно, поэтому перед записью проверяются
 * обязательные поля: без адреса подключение бесполезно, а пустое имя сделало бы
 * в дереве безымянную ветку.
 *
 * @param draft - Подключение из формы
 * @returns Список замечаний; пустой список — можно сохранять
 */
export function validateConnectionDraft(draft: ConnectionDraft): string[] {
	const problems: string[] = [];
	if (draft.name.trim() === '') {
		problems.push('не задано название');
	}
	if (draft.host.trim() === '') {
		problems.push('не задан адрес сервера администрирования');
	}
	if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) {
		problems.push('порт должен быть числом от 1 до 65535');
	}
	if (draft.platformVersion.trim() !== '' && !/^\d+(\.\d+){0,3}$/.test(draft.platformVersion.trim())) {
		problems.push('версия платформы указывается цифрами, например 8.3.27');
	}
	return problems;
}

/**
 * Собирает подключение формы из сохранённого.
 *
 * @param connection - Сохранённое подключение
 * @returns Запись для формы
 */
export function toConnectionDraft(connection: ClusterConnection): ConnectionDraft {
	return {
		id: connection.id,
		name: connection.name,
		host: connection.host,
		port: connection.port,
		platformVersion: connection.platformVersion ?? '',
		clusterSetId: '',
		agentSetId: '',
	};
}

/**
 * Собирает набор формы из сохранённого.
 *
 * @param set - Сохранённый набор
 * @param hasPassword - Есть ли пароль в защищённом хранилище
 * @returns Запись для формы
 */
export function toCredentialSetDraft(set: CredentialSet, hasPassword: boolean): CredentialSetDraft {
	return {
		id: set.id,
		name: set.name,
		user: set.user,
		kind: set.kind,
		hasPassword,
	};
}

/**
 * Решает, что выбрать в форме при открытии.
 *
 * Просьба открыть несуществующую или пустую секцию не остаётся пустым экраном:
 * выбирается первая запись нужного вида, а в пустой секции — заготовка новой,
 * чтобы по кнопке уведомления сразу открылись поля для ввода.
 *
 * @param target - На чём просили открыть форму
 * @param connectionIds - Идентификаторы сохранённых подключений
 * @param setIds - Идентификаторы сохранённых наборов
 * @returns Выбор для модели формы; `id: 'new'` — форма создаст запись
 */
export function resolveEditorSelection(
	target: EditorTarget | undefined,
	connectionIds: string[],
	setIds: string[]
): EditorSelection {
	const kind = target?.kind ?? 'connection';
	const ids = kind === 'set' ? setIds : connectionIds;
	if (target?.id === 'new') {
		return { kind, id: 'new' };
	}
	if (target?.id !== undefined && ids.includes(target.id)) {
		return { kind, id: target.id };
	}
	if (ids.length > 0) {
		return { kind, id: ids[0] };
	}
	// Другая секция не подменяет запрошенную: спрашивали учётные данные —
	// открываются учётные данные, пусть и пустые.
	return { kind, id: 'new' };
}

/** Форма подключений и учётных данных: одна вкладка на окно. */
export class ClusterConnectionsEditor {
	private panel: vscode.WebviewPanel | undefined;

	constructor(
		private readonly store: ConnectionStore,
		private readonly credentials: ClusterCredentialStore,
		private readonly service: ClusterService,
		private readonly provider: ClustersProvider,
		private readonly extensionUri: vscode.Uri
	) {}

	/**
	 * Открывает форму, при необходимости создавая вкладку.
	 *
	 * @param target - Подключение или набор, на котором открыть форму
	 */
	async open(target?: EditorTarget): Promise<void> {
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(
				'1cClusterConnections',
				'Подключения к кластерам 1С',
				vscode.ViewColumn.Active,
				{ enableScripts: true, retainContextWhenHidden: true }
			);
			this.panel.webview.html = await buildHtml(this.extensionUri);
			registerFormPanel(this.panel);
			this.panel.webview.onDidReceiveMessage((message: EditorMessage) =>
				this.handleMessage(message)
			);
			this.panel.onDidDispose(() => {
				this.panel = undefined;
			});
		} else {
			this.panel.reveal(vscode.ViewColumn.Active);
		}
		await this.postModel(target);
	}

	/** Перечитывает наборы и привязки в открытую форму, не меняя выбор в ней. */
	async refresh(): Promise<void> {
		if (this.panel) {
			await this.postModel(undefined, { keepSelection: true });
		}
	}

	dispose(): void {
		this.panel?.dispose();
		this.panel = undefined;
	}

	/**
	 * Отправляет в форму текущие списки подключений и наборов.
	 *
	 * @param target - Запись, которая должна быть выбрана
	 * @param options - `replace` — заменить черновик даже с несохранёнными
	 * правками: после записи хранилище главнее формы; `keepSelection` — оставить
	 * выбор формы
	 */
	private async postModel(
		target?: EditorTarget,
		options?: { replace?: boolean; keepSelection?: boolean }
	): Promise<void> {
		const connections = this.store.list().map((connection) => ({
			...toConnectionDraft(connection),
			clusterSetId: this.credentials.boundConnectionSet(connection.id, 'cluster')?.id ?? '',
			agentSetId: this.credentials.boundConnectionSet(connection.id, 'agent')?.id ?? '',
		}));
		const sets: CredentialSetDraft[] = [];
		for (const set of this.credentials.list()) {
			const password = await this.credentials.password(set.id);
			sets.push(toCredentialSetDraft(set, password !== undefined && password !== ''));
		}
		// Просьба открыть группу наборов без записи ведёт к первому набору этой
		// группы, а в пустой группе — к заготовке того же вида.
		let effective = target;
		if (target?.kind === 'set' && target.id === undefined && target.setKind) {
			const first = sets.find((set) => set.kind === target.setKind);
			effective = { kind: 'set', id: first ? first.id : 'new', setKind: target.setKind };
		}
		let selected = resolveEditorSelection(
			effective,
			connections.map((item) => item.id),
			sets.map((item) => item.id)
		);
		if (selected.kind === 'set' && selected.id === 'new') {
			selected = {
				...selected,
				setKind: effective?.kind === 'set' ? (effective.setKind ?? 'cluster') : 'cluster',
			};
		}
		// Привязки «набор для сервера»: те же записи, что правят селекты
		// подключения, но с именами для карточки набора
		const serverBindings = this.credentials.listConnectionBindings().map((binding) => ({
			...binding,
			connectionName: this.store.get(binding.connectionId)?.name ?? binding.connectionId,
		}));
		void this.panel?.webview.postMessage({
			type: 'model',
			replace: options?.replace === true,
			keepSelection: options?.keepSelection === true,
			model: { connections, sets, selected },
			bindings: this.credentials.listBindings(),
			clusterBindings: this.credentials.listClusterBindings(),
			serverBindings,
			defaultPort: DEFAULT_RAS_PORT,
			// Версии перечитываются при каждом открытии: платформу могли доустановить,
			// пока форма была закрыта.
			versions: listRacVersions(projectPlatformRoots()),
		});
	}

	/**
	 * Обрабатывает сообщение формы.
	 *
	 * @param message - Сообщение
	 */
	private async handleMessage(message: EditorMessage): Promise<void> {
		if (message.type === 'error') {
			void vscode.window.showErrorMessage(`Форма подключений: ${message.message}`);
			return;
		}
		if (message.type === 'unbind') {
			await this.credentials.unbindInfobase(message.binding.connectionId, message.binding.infobaseId);
			this.provider.refresh();
			await this.postModel({ kind: 'set', id: message.binding.setId });
			return;
		}
		if (message.type === 'unbindCluster') {
			await this.credentials.unbindCluster(
				message.binding.connectionId,
				message.binding.clusterId
			);
			this.provider.refresh();
			await this.postModel({ kind: 'set', id: message.binding.setId });
			return;
		}
		if (message.type === 'unbindServer') {
			await this.credentials.bindConnectionRole(message.connectionId, 'agent', '');
			this.provider.refresh();
			await this.postModel({ kind: 'set', id: message.setId });
			return;
		}
		if (message.type === 'check') {
			await this.checkConnection(message.data);
			return;
		}
		if (message.type === 'checkSet') {
			await this.checkSet(message.data);
			return;
		}
		if (message.type === 'bindSet') {
			await this.pickBinding(message.setId);
			return;
		}
		if (message.type === 'bindSetCluster') {
			await this.pickClusterBinding(message.setId);
			return;
		}
		if (message.type === 'bindSetServer') {
			await this.pickServerBinding(message.setId);
			return;
		}
		await this.save(message.data);
	}

	/**
	 * Предлагает выбрать сервер и назначает ему набор центрального сервера.
	 *
	 * Пишет ту же привязку, что и выбор в карточке подключения: это два входа в
	 * одну настройку, со стороны набора и со стороны сервера.
	 *
	 * @param setId - Идентификатор сохранённого набора
	 */
	private async pickServerBinding(setId: string): Promise<void> {
		const set = this.credentials.get(setId);
		if (!set) {
			notifyQuiet('Сначала сохраните набор: привязка хранится по сохранённой записи');
			return;
		}
		const connections = this.store.list();
		if (connections.length === 0) {
			notifyQuiet('Сначала создайте подключение к кластеру');
			return;
		}
		const picked = await vscode.window.showQuickPick(
			connections.map((connection) => {
				const current = this.credentials.boundConnectionSet(connection.id, 'agent');
				return {
					label: connection.name,
					description: `${connection.host}:${connection.port}`,
					detail: current ? `сейчас назначен набор «${current.name}»` : undefined,
					connection,
				};
			}),
			{ title: `Сервер для набора «${set.name}»`, placeHolder: 'Подключение' }
		);
		if (!picked) {
			return;
		}
		await this.credentials.bindConnectionRole(picked.connection.id, 'agent', setId);
		this.provider.refresh();
		await this.postModel({ kind: 'set', id: setId });
	}

	/**
	 * Предлагает выбрать кластер и привязывает к нему административный набор.
	 *
	 * @param setId - Идентификатор сохранённого набора
	 */
	private async pickClusterBinding(setId: string): Promise<void> {
		const set = this.credentials.get(setId);
		if (!set) {
			notifyQuiet('Сначала сохраните набор: привязка хранится по сохранённой записи');
			return;
		}

		interface ClusterPick extends vscode.QuickPickItem {
			connection: ClusterConnection;
			clusterId: string;
			clusterName: string;
		}
		const items: ClusterPick[] = [];
		const failures: string[] = [];
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: 'Читаю список кластеров' },
			async () => {
				for (const connection of this.store.list()) {
					const clusters = await this.service.listClusters(connection);
					if (!clusters.ok) {
						failures.push(`${connection.name}: ${clusters.failure.message}`);
						continue;
					}
					for (const cluster of clusters.value) {
						const bound = this.credentials.boundClusterSet(connection.id, cluster.id);
						items.push({
							label: cluster.name || cluster.host,
							description: connection.name,
							detail: bound ? `сейчас привязан набор «${bound.name}»` : undefined,
							connection,
							clusterId: cluster.id,
							clusterName: cluster.name || cluster.host,
						});
					}
				}
			}
		);
		if (items.length === 0) {
			void vscode.window.showWarningMessage(
				failures[0] ?? 'Кластеров не нашлось: проверьте подключения.'
			);
			return;
		}

		const picked = await vscode.window.showQuickPick(items, {
			title: `Кластер для набора «${set.name}»`,
			placeHolder: 'Кластер',
		});
		if (!picked) {
			return;
		}
		await this.credentials.bindCluster({
			connectionId: picked.connection.id,
			clusterId: picked.clusterId,
			setId,
			connectionName: picked.connection.name,
			clusterName: picked.clusterName,
		});
		this.provider.refresh();
		await this.postModel({ kind: 'set', id: setId });
	}

	/**
	 * Предлагает выбрать информационную базу и привязывает к ней набор.
	 *
	 * Список баз читается по всем подключениям на месте: администратор привязывает
	 * набор там же, где его заводит, а не идёт искать базу в дереве.
	 *
	 * @param setId - Идентификатор сохранённого набора
	 */
	private async pickBinding(setId: string): Promise<void> {
		const set = this.credentials.get(setId);
		if (!set) {
			notifyQuiet('Сначала сохраните набор: привязка хранится по сохранённой записи');
			return;
		}

		interface InfobasePick extends vscode.QuickPickItem {
			connection: ClusterConnection;
			clusterId: string;
			infobaseId: string;
			infobaseName: string;
		}
		const items: InfobasePick[] = [];
		const failures: string[] = [];
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: 'Читаю список информационных баз' },
			async () => {
				for (const connection of this.store.list()) {
					const clusters = await this.service.listClusters(connection);
					if (!clusters.ok) {
						failures.push(`${connection.name}: ${clusters.failure.message}`);
						continue;
					}
					for (const cluster of clusters.value) {
						const infobases = await this.service.listInfobases(connection, cluster.id);
						if (!infobases.ok) {
							failures.push(`${connection.name}: ${infobases.failure.message}`);
							continue;
						}
						for (const infobase of infobases.value) {
							const bound = this.credentials.boundSetName(connection.id, infobase.id);
							items.push({
								label: infobase.name,
								description: `${cluster.name || cluster.host} · ${connection.name}`,
								detail: bound ? `сейчас привязан набор «${bound}»` : undefined,
								connection,
								clusterId: cluster.id,
								infobaseId: infobase.id,
								infobaseName: infobase.name,
							});
						}
					}
				}
			}
		);
		if (items.length === 0) {
			void vscode.window.showWarningMessage(
				failures[0] ?? 'Информационных баз не нашлось: проверьте подключения.'
			);
			return;
		}

		const picked = await vscode.window.showQuickPick(items, {
			title: `База для набора «${set.name}»`,
			placeHolder: 'Информационная база',
		});
		if (!picked) {
			return;
		}
		await this.credentials.bindInfobase({
			connectionId: picked.connection.id,
			clusterId: picked.clusterId,
			infobaseId: picked.infobaseId,
			setId,
			connectionName: picked.connection.name,
			infobaseName: picked.infobaseName,
		});
		this.provider.refresh();
		await this.postModel({ kind: 'set', id: setId });
	}

	/**
	 * Записывает правки формы в хранилища.
	 *
	 * Порядок важен: сначала проверка всего, потом запись. Наполовину применённый
	 * список хуже отклонённого — администратор увидел бы в дереве часть правок.
	 *
	 * @param model - Модель формы
	 */
	private async save(model: EditorModel): Promise<void> {
		// Нетронутые заготовки не сохраняются и не мешают сохранению остального
		const connections = model.connections.filter((draft) => !isBlankConnectionDraft(draft));
		const sets = model.sets.filter((draft) => !isBlankSetDraft(draft));

		const problems: string[] = [];
		for (const draft of connections) {
			for (const problem of validateConnectionDraft(draft)) {
				problems.push(`«${draft.name || draft.host || 'без названия'}»: ${problem}`);
			}
		}
		for (const draft of sets) {
			for (const problem of validateCredentialSetInput(draft)) {
				problems.push(`«${draft.name || draft.user || 'без названия'}»: ${problem}`);
			}
		}
		if (problems.length > 0) {
			void this.panel?.webview.postMessage({
				type: 'saveFailed',
				message: problems.join('; '),
			});
			return;
		}

		// Наборы сохраняются первыми: привязки подключений ссылаются на их
		// идентификаторы, а у новых записей те появляются только при записи.
		const savedSets = new Map<string, string>();
		for (const draft of sets) {
			const input = {
				name: draft.name.trim(),
				user: draft.user.trim(),
				kind: draft.kind,
			};
			const saved = draft.id && this.credentials.get(draft.id)
				? await this.credentials.update(draft.id, input, draft.password)
				: await this.credentials.add(input, draft.password ?? '');
			if (saved) {
				savedSets.set(draft.id, saved.id);
			}
		}
		const keptSets = new Set(savedSets.values());
		for (const existing of this.credentials.list()) {
			if (!keptSets.has(existing.id)) {
				await this.credentials.remove(existing.id);
			}
		}
		const savedConnections = new Map<string, string>();
		for (const draft of connections) {
			const input = {
				name: draft.name.trim(),
				host: draft.host.trim(),
				port: draft.port,
				platformVersion: draft.platformVersion.trim() || undefined,
			};
			const saved = draft.id && this.store.get(draft.id)
				? await this.store.update(draft.id, input)
				: await this.store.add(input);
			if (saved) {
				savedConnections.set(draft.id, saved.id);
			}
		}
		const keptConnections = new Set(savedConnections.values());
		for (const existing of this.store.list()) {
			if (!keptConnections.has(existing.id)) {
				await this.store.remove(existing.id);
				await this.credentials.forgetConnection(existing.id);
			}
		}

		// Привязки наборов к подключениям: пустой выбор снимает привязку
		for (const draft of connections) {
			const connectionId = savedConnections.get(draft.id);
			if (!connectionId) {
				continue;
			}
			await this.credentials.bindConnectionRole(
				connectionId,
				'cluster',
				savedSets.get(draft.clusterSetId) ?? draft.clusterSetId
			);
			await this.credentials.bindConnectionRole(
				connectionId,
				'agent',
				savedSets.get(draft.agentSetId) ?? draft.agentSetId
			);
		}

		this.provider.refresh();
		await this.postModel(
			model.selected.kind === '' ? undefined : { kind: model.selected.kind, id: model.selected.id },
			{ replace: true }
		);
		void this.panel?.webview.postMessage({ type: 'saved' });
	}

	/**
	 * Проверяет подключение и сообщает итог в форму.
	 *
	 * @param draft - Проверяемое подключение
	 */
	private async checkConnection(draft: ConnectionDraft): Promise<void> {
		const problems = validateConnectionDraft(draft);
		if (problems.length > 0) {
			void this.panel?.webview.postMessage({
				type: 'checkResult',
				ok: false,
				message: problems.join('; '),
			});
			return;
		}

		const connection: ClusterConnection = {
			id: draft.id || 'draft',
			name: draft.name.trim(),
			host: draft.host.trim(),
			port: draft.port,
			platformVersion: draft.platformVersion.trim() || undefined,
		};
		const result = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: 'Проверяю подключение к кластеру' },
			() => this.service.checkConnection(connection)
		);
		void this.panel?.webview.postMessage(
			result.ok
				? {
						type: 'checkResult',
						ok: true,
						message: result.value.adminChecked
							? `Сервер отвечает, кластеров: ${result.value.clusters.length}; администратор принят`
							: `Сервер отвечает, кластеров: ${result.value.clusters.length}`,
					}
				: { type: 'checkResult', ok: false, message: result.failure.message }
		);
	}

	/** Подключение, которому набор назначен для роли: проверка идёт по нему. */
	private connectionBoundTo(setId: string, role: 'cluster' | 'agent'): ClusterConnection | undefined {
		if (!setId) {
			return undefined;
		}
		return this.store
			.list()
			.find((connection) => this.credentials.boundConnectionSet(connection.id, role)?.id === setId);
	}

	/**
	 * Проверяет набор пробой его роли и сообщает итог в форму.
	 *
	 * Единой пробы на все наборы нет: администратора кластера проверяет список
	 * баз, администратора центрального сервера — список его администраторов, а
	 * администратора базы — чтение привязанной базы. Проверять набор «для баз»
	 * через кластер значило бы всегда получать отказ на честных данных.
	 * Привязка задаёт, по какому кластеру, серверу или базе идёт проба.
	 *
	 * @param draft - Проверяемый набор
	 */
	private async checkSet(draft: CredentialSetDraft): Promise<void> {
		const report = (ok: boolean, message: string) =>
			void this.panel?.webview.postMessage({ type: 'checkResult', ok, message });

		const problems = validateCredentialSetInput(draft);
		if (problems.length > 0) {
			report(false, problems.join('; '));
			return;
		}

		const connection = this.store.list()[0];
		if (!connection) {
			report(false, 'Сначала создайте подключение к кластеру');
			return;
		}

		let password = draft.password;
		if (password === undefined && draft.id) {
			password = await this.credentials.password(draft.id);
		}
		const auth = { user: draft.user.trim(), password: password ?? '' };

		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: 'Проверяю учётные данные' },
			async () => {
				if (draft.kind === 'cluster') {
					const clusterBinding = draft.id
						? this.credentials.clusterBindingsForSet(draft.id)[0]
						: undefined;
					if (clusterBinding) {
						const target = this.store.get(clusterBinding.connectionId) ?? connection;
						const result = await this.service.checkClusterAdmin(
							target,
							clusterBinding.clusterId,
							auth
						);
						report(
							result.ok,
							result.ok
								? `Кластер «${clusterBinding.clusterName || clusterBinding.clusterId}»: администратор принят`
								: result.failure.message
						);
						return;
					}
					const target = this.connectionBoundTo(draft.id, 'cluster') ?? connection;
					const result = await this.service.checkConnection(target, auth);
					if (!result.ok) {
						report(false, result.failure.message);
					} else if (result.value.adminChecked) {
						report(true, `Сервер отвечает, кластеров: ${result.value.clusters.length}; администратор принят`);
					} else {
						report(false, 'На сервере нет кластеров, проверить не на чем');
					}
					return;
				}
				if (draft.kind === 'agent') {
					const target = this.connectionBoundTo(draft.id, 'agent') ?? connection;
					const result = await this.service.checkAgentAdmin(target, auth);
					report(
						result.ok,
						result.ok ? 'Администратор центрального сервера принят' : result.failure.message
					);
					return;
				}
				const binding = draft.id ? this.credentials.bindingsForSet(draft.id)[0] : undefined;
				if (!binding) {
					report(false, 'Привяжите набор к базе, чтобы было что проверить');
					return;
				}
				const target = this.store.get(binding.connectionId) ?? connection;
				const result = await this.service.checkInfobaseAdmin(
					target,
					binding.clusterId,
					binding.infobaseId,
					auth
				);
				report(
					result.ok,
					result.ok
						? `База «${binding.infobaseName || binding.infobaseId}»: администратор принят`
						: result.failure.message
				);
			}
		);
	}
}

/** Разметка и скрипт формы. */
async function buildHtml(extensionUri: vscode.Uri): Promise<string> {
	const nonce = Math.random().toString(36).slice(2);
	const template = await loadWebviewTemplate(extensionUri, 'cluster-connections.html');
	return fillWebviewTemplate(template, {
		NONCE: nonce,
		CHROME_STYLES: chromeStyles(),
		ADD_LABEL: CHROME_LABELS.add,
		SAVE_BAR: saveBarHtml(),
		CHROME_SCRIPT: chromeScript(),
		DEFAULT_RAS_PORT: String(DEFAULT_RAS_PORT),
		SET_COLORS: JSON.stringify(CREDENTIAL_ROLE_COLORS),
		SAVED_LABEL: JSON.stringify(CHROME_LABELS.saved),
	});
}
