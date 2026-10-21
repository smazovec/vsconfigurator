/**
 * Списки кластера таблицей: базы, сеансы, соединения и блокировки.
 *
 * В дереве видно устройство кластера, но не видно, кто его нагружает и какая
 * база закрыта: чтобы сравнить два десятка сеансов по памяти или пробежать
 * глазами блокировки баз, значения нужно видеть рядом и уметь сортировать.
 * Поэтому те же списки показываются таблицей — со столбцами, поиском,
 * выгрузкой и действиями по строке.
 *
 * Строки выделяются как в списках VS Code — щелчком, Ctrl и Shift, Ctrl+A: пачка
 * сеансов завершается одним действием, а обслуживание базы редко заканчивается
 * одним сеансом.
 *
 * Число строк стоит в подзаголовке рядом с подключением: в дереве оно видно
 * у группы, а из таблицы его не увидеть, пока не прокрутишь список. Поиск
 * не прячет размер — подпись показывает, сколько строк прошло отбор.
 *
 * Панель одна на окно: повторный вызов обновляет уже открытую вкладку, а не
 * плодит новые.
 */

import * as vscode from 'vscode';
import { logger } from '../../shared/logger';
import { notifyQuiet } from '../../shared/notify';
import { fillWebviewTemplate, loadWebviewTemplate } from '../../shared/webviewTemplate';
import { chromeStyles } from '../editors/webviewChrome';
import {
	activityColumns,
	activityCsv,
	activityRowCountLabel,
	buildActivityRows,
	type ActivityKind,
	type ActivityRow,
} from './activityTable';
import { activityKinds, type ActivityTarget } from './activityRequest';
import type { ClusterService } from './clusterService';
import type { ClustersProvider } from './clustersProvider';
import type { InfobaseInfo } from './model';
import { InfobaseNode } from './nodes';
import { confirmAction, confirmSessionAction } from './prompts';
import type { RacRecord } from './racOutput';
import { readClustersSettings } from './settings';

/** Соединение, выбранное в таблице: разрыв требует рабочего процесса. */
interface ConnectionRef {
	id: string;
	processId: string;
}

/** Сообщение из панели. */
type PanelMessage =
	| { type: 'load'; kind: ActivityKind }
	| { type: 'terminate'; id: string; label: string }
	| { type: 'interrupt'; id: string; label: string }
	| { type: 'disconnect'; id: string; processId: string; label: string }
	| { type: 'terminateMany'; ids: string[] }
	| { type: 'disconnectMany'; items: ConnectionRef[] }
	| { type: 'infobaseProperties'; id: string }
	| { type: 'infobaseDrop'; id: string }
	| { type: 'copyCsv'; kind: ActivityKind; rows: ActivityRow[] }
	| { type: 'error'; message: string };

/** Подпись кнопки журнала в сообщении о неудаче. */
const SHOW_LOG_ACTION = 'Показать журнал';

/** Панель списков: одна вкладка на окно. */
export class ClusterActivityPanel {
	private panel: vscode.WebviewPanel | undefined;
	private target: ActivityTarget | undefined;
	/** Базы последней загрузки: по ним команды строки находят объект. */
	private infobases: InfobaseInfo[] = [];

	constructor(
		private readonly service: ClusterService,
		private readonly provider: ClustersProvider,
		private readonly extensionUri: vscode.Uri
	) {}

	/**
	 * Открывает панель для кластера или информационной базы.
	 *
	 * @param target - Что показывать
	 * @param kind - Какой список открыть
	 */
	async open(target: ActivityTarget, kind: ActivityKind): Promise<void> {
		this.target = target;
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(
				'1cClusterActivity',
				'Списки кластера',
				vscode.ViewColumn.Active,
				{ enableScripts: true, retainContextWhenHidden: true }
			);
			this.panel.webview.html = await buildHtml(this.extensionUri);
			this.panel.webview.onDidReceiveMessage((message: PanelMessage) =>
				this.handleMessage(message)
			);
			this.panel.onDidDispose(() => {
				this.panel = undefined;
				this.target = undefined;
			});
		} else {
			this.panel.reveal(vscode.ViewColumn.Active);
		}
		this.panel.title = `Списки: ${target.title}`;
		await this.load(kind);
	}

	dispose(): void {
		this.panel?.dispose();
		this.panel = undefined;
	}

	/**
	 * Загружает список и отправляет его в панель.
	 *
	 * @param kind - Какой список показать
	 */
	private async load(kind: ActivityKind): Promise<void> {
		const target = this.target;
		if (!target || !this.panel) {
			return;
		}
		const kinds = activityKinds(target);
		const shown = kinds.includes(kind) ? kind : kinds[0];
		void this.panel.webview.postMessage({ type: 'loading' });

		const result = await this.read(target, shown);
		if (!result.ok) {
			void this.panel.webview.postMessage({ type: 'failed', message: result.message, kinds });
			return;
		}
		void this.panel.webview.postMessage({
			type: 'data',
			kind: shown,
			kinds,
			columns: activityColumns(shown),
			rows: result.rows,
			subtitle: `${target.connection.name} · ${target.connection.host}:${target.connection.port}`,
		});
	}

	/**
	 * Читает объекты списка и превращает их в строки таблицы.
	 *
	 * @param target - Кластер или база
	 * @param kind - Какой список читать
	 * @returns Промис, который разрешается строками либо причиной неудачи
	 */
	private async read(
		target: ActivityTarget,
		kind: ActivityKind
	): Promise<{ ok: true; rows: ActivityRow[] } | { ok: false; message: string }> {
		const { connection, clusterId, infobaseId } = target;
		if (kind === 'locks') {
			const locks = await this.service.listLocks(connection, clusterId, infobaseId);
			return locks.ok
				? { ok: true, rows: buildActivityRows(locks.value.map((item) => item.record), kind) }
				: { ok: false, message: locks.failure.message };
		}

		// Имена баз подставляются вместо идентификаторов: администратор мыслит
		// базами, а не GUID.
		const infobases = await this.service.listInfobases(connection, clusterId);
		if (!infobases.ok) {
			return { ok: false, message: infobases.failure.message };
		}
		this.infobases = infobases.value;
		const infobaseNames: Record<string, string> = {};
		for (const item of infobases.value) {
			infobaseNames[item.id] = item.name;
		}

		if (kind === 'infobases') {
			const records = await this.service.infobaseRecords(
				connection,
				clusterId,
				infobases.value.map((item) => item.id)
			);
			// Краткий список знает имя и описание, полные сведения — режим работы и
			// размещение; у базы с администратором вторых может не быть.
			const merged: RacRecord[] = infobases.value.map((item) => ({
				...item.record,
				...(records.get(item.id) ?? {}),
			}));
			return { ok: true, rows: buildActivityRows(merged, kind, infobaseNames) };
		}

		const result =
			kind === 'sessions'
				? await this.service.listSessions(connection, clusterId, infobaseId)
				: await this.service.listConnections(connection, clusterId, {
						infobaseId,
						infobaseName: infobaseId ? infobaseNames[infobaseId] : undefined,
					});
		return result.ok
			? {
					ok: true,
					rows: buildActivityRows(result.value.map((item) => item.record), kind, infobaseNames),
				}
			: { ok: false, message: result.failure.message };
	}

	/**
	 * Обрабатывает сообщение панели.
	 *
	 * @param message - Сообщение
	 */
	private async handleMessage(message: PanelMessage): Promise<void> {
		if (!this.target) {
			return;
		}
		switch (message.type) {
			case 'load':
				await this.load(message.kind);
				return;
			case 'error':
				void vscode.window.showErrorMessage(`Списки кластера: ${message.message}`);
				return;
			case 'copyCsv':
				await vscode.env.clipboard.writeText(
					activityCsv(activityColumns(message.kind), message.rows)
				);
				void vscode.window.setStatusBarMessage(
					`Скопировано строк: ${message.rows.length}`,
					3000
				);
				return;
			case 'infobaseProperties':
				await this.runInfobaseCommand('1c-platform-tools.clusters.properties', message.id);
				return;
			case 'infobaseDrop':
				await this.runInfobaseCommand('1c-platform-tools.clusters.dropInfobase', message.id);
				return;
			case 'terminate':
			case 'interrupt':
			case 'disconnect':
				await this.runSingleAction(message);
				return;
			case 'terminateMany':
				await this.terminateMany(message.ids);
				return;
			case 'disconnectMany':
				await this.disconnectMany(message.items);
				return;
			default: {
				const unknown: never = message;
				logger.warn(`[clusters] неизвестное сообщение панели: ${JSON.stringify(unknown)}`);
			}
		}
	}

	/**
	 * Выполняет команду дерева над базой из строки таблицы.
	 *
	 * Карточка свойств и подтверждение удаления уже описаны командами дерева, и
	 * узел для них собирается здесь: повторять их в панели значило бы держать два
	 * набора формулировок.
	 *
	 * @param command - Идентификатор команды
	 * @param infobaseId - Идентификатор базы
	 */
	private async runInfobaseCommand(command: string, infobaseId: string): Promise<void> {
		const target = this.target;
		const infobase = this.infobases.find((item) => item.id === infobaseId);
		if (!target || !infobase) {
			return;
		}
		await vscode.commands.executeCommand(
			command,
			new InfobaseNode(target.connection, target.clusterId, infobase)
		);
		await this.load('infobases');
	}

	/**
	 * Выполняет действие над одной строкой.
	 *
	 * @param message - Сообщение панели с объектом действия
	 */
	private async runSingleAction(
		message:
			| { type: 'terminate'; id: string; label: string }
			| { type: 'interrupt'; id: string; label: string }
			| { type: 'disconnect'; id: string; processId: string; label: string }
	): Promise<void> {
		const target = this.target;
		if (!target) {
			return;
		}
		const titles: Record<typeof message.type, string> = {
			terminate: `Завершить ${message.label}?`,
			interrupt: `Прервать текущий вызов: ${message.label}?`,
			disconnect: `Разорвать ${message.label}?`,
		};
		const details: Record<typeof message.type, string> = {
			terminate: 'Несохранённые данные сеанса будут потеряны.',
			interrupt: 'Сеанс продолжит работу, прервётся только выполняемый серверный вызов.',
			disconnect: 'Приложение потеряет связь с информационной базой.',
		};
		let errorMessage: string | undefined;
		if (readClustersSettings().confirmDestructiveActions) {
			const choice = await confirmSessionAction(titles[message.type], details[message.type]);
			if (!choice.confirmed) {
				return;
			}
			errorMessage = choice.errorMessage;
		}

		const { connection, clusterId } = target;
		const result =
			message.type === 'terminate'
				? await this.service.terminateSession(connection, clusterId, message.id, errorMessage)
				: message.type === 'interrupt'
					? await this.service.interruptSessionCall(
							connection,
							clusterId,
							message.id,
							errorMessage
						)
					: await this.service.disconnectConnection(connection, clusterId, {
							processId: message.processId,
							connectionId: message.id,
						});

		if (!result.ok) {
			void vscode.window.showErrorMessage(result.failure.message);
			return;
		}
		await this.afterAction(message.type === 'disconnect' ? 'connections' : 'sessions');
	}

	/**
	 * Завершает выбранные сеансы.
	 *
	 * Подтверждение спрашивается всегда, даже когда подтверждения отключены:
	 * пачка сеансов — это пачка потерянных документов у разных пользователей.
	 *
	 * @param ids - Идентификаторы сеансов
	 */
	private async terminateMany(ids: string[]): Promise<void> {
		const target = this.target;
		if (!target || ids.length === 0) {
			return;
		}
		const choice = await confirmSessionAction(
			`Завершить сеансов: ${ids.length}?`,
			'Несохранённые данные пользователей будут потеряны.'
		);
		if (!choice.confirmed) {
			return;
		}
		const failures = await this.runBatch('Завершаю сеансы', ids.length, (index) =>
			this.service.terminateSession(
				target.connection,
				target.clusterId,
				ids[index] as string,
				choice.errorMessage
			)
		);
		this.report('Завершено сеансов', ids.length - failures, failures);
		await this.afterAction('sessions');
	}

	/**
	 * Разрывает выбранные соединения.
	 *
	 * @param items - Соединения вместе с их рабочими процессами
	 */
	private async disconnectMany(items: ConnectionRef[]): Promise<void> {
		const target = this.target;
		if (!target || items.length === 0) {
			return;
		}
		const confirmed = await confirmAction(
			`Разорвать соединений: ${items.length}?`,
			'Приложения потеряют связь с информационной базой.',
			'Разорвать'
		);
		if (!confirmed) {
			return;
		}
		const failures = await this.runBatch('Разрываю соединения', items.length, (index) => {
			const item = items[index] as ConnectionRef;
			return this.service.disconnectConnection(target.connection, target.clusterId, {
				processId: item.processId,
				connectionId: item.id,
			});
		});
		this.report('Разорвано соединений', items.length - failures, failures);
		await this.afterAction('connections');
	}

	/**
	 * Выполняет действие над каждым выбранным объектом.
	 *
	 * Объекты идут по одному: у rac нет команды для списка, и параллельные
	 * вызовы к тому же смешали бы сообщения о неудачах.
	 *
	 * @param title - Что происходит
	 * @param count - Сколько объектов обработать
	 * @param action - Действие над объектом по его номеру
	 * @returns Промис, который разрешается числом неудач
	 */
	private async runBatch(
		title: string,
		count: number,
		action: (index: number) => Promise<{ ok: boolean; failure?: { message: string } }>
	): Promise<number> {
		return vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title },
			async () => {
				let failures = 0;
				for (let index = 0; index < count; index += 1) {
					const result = await action(index);
					if (!result.ok) {
						failures += 1;
						logger.error(`[clusters] ${title}: ${result.failure?.message ?? 'неизвестная ошибка'}`);
					}
				}
				return failures;
			}
		);
	}

	/**
	 * Сообщает итог массового действия.
	 *
	 * @param title - Что сделано, без числа
	 * @param done - Сколько удалось
	 * @param failures - Сколько не удалось
	 */
	private report(title: string, done: number, failures: number): void {
		if (failures === 0) {
			notifyQuiet(`${title}: ${done}`);
			return;
		}
		void vscode.window
			.showWarningMessage(`${title}: ${done}, не удалось: ${failures}.`, SHOW_LOG_ACTION)
			.then((choice) => {
				if (choice === SHOW_LOG_ACTION) {
					logger.show();
				}
			});
	}

	/**
	 * Обновляет дерево и таблицу после действия.
	 *
	 * @param kind - Список, который перечитать
	 */
	private async afterAction(kind: ActivityKind): Promise<void> {
		// Дерево показывает те же объекты: без обновления там осталась бы строка,
		// которой на сервере уже нет.
		this.provider.refresh();
		await this.load(kind);
	}
}

/**
 * Разметка и скрипт таблицы.
 *
 * Подпись числа строк — та же функция, что проверяют тесты. Поиск считается
 * в панели на каждое нажатие, и вторая копия формулы разъехалась бы с отбором.
 */
async function buildHtml(extensionUri: vscode.Uri): Promise<string> {
	const nonce = Math.random().toString(36).slice(2);
	const template = await loadWebviewTemplate(extensionUri, 'cluster-activity.html');
	return fillWebviewTemplate(template, {
		NONCE: nonce,
		CHROME_STYLES: chromeStyles(),
		ROW_COUNT_LABEL: activityRowCountLabel.toString(),
	});
}
