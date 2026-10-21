/**
 * Загрузка fat-JAR md-sparrow с GitHub Releases (через общий {@link githubReleaseLoader})
 * и portable JRE (Eclipse Temurin) той версии, на которой собирается md-sparrow.
 * @module mdSparrowBootstrap
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import { logger } from '../../shared/logger';
import { projectConfiguration } from '../../shared/projectConfiguration';
import { currentRoot } from '../../shared/workspaceProjects';
import {
	type ReleaseComponentSpec,
	cachedReleaseComponent,
	cachedReleaseTag,
	checkReleaseUpdateInBackground,
	clearReleaseCache,
	ensureReleaseComponent,
	extractArchive,
	installBaseDir,
	resolveGithubToken,
	showStatus,
	streamDownload,
} from '../../shared/githubReleaseLoader';
import {
	MD_SPARROW_DEFAULT_REPO,
	MD_SPARROW_JAR_REGEX,
	adoptiumBinaryUrl,
} from './mdSparrowConstants';
import { readJarJavaVersion } from './jarJavaVersion';
import { stopMdSparrowResidents } from './mdSparrowRunner';
import { cachedJava, cachedJreVersion, clearJre, installJre, tidyJreCache } from './portableJre';

const log = logger.scope('md-sparrow');

export interface MdSparrowRuntime {
	/** Полный путь к исполняемому java */
	java: string;
	/** Полный путь к md-sparrow-*-all.jar */
	jarPath: string;
	/** Тег релиза (если скачан с GitHub) */
	releaseTag?: string;
	/** Java не указана в настройках: её путь меняется вместе с portable JRE. */
	autoJava?: boolean;
	/** Версия Java, под которую собран JAR. */
	javaVersion: number;
}

const MD_SPARROW_SPEC: ReleaseComponentSpec = {
	repoSlug: MD_SPARROW_DEFAULT_REPO,
	cacheSubdir: 'md-sparrow',
	stampName: '.jar-info.json',
	assetRegex: MD_SPARROW_JAR_REGEX,
	label: 'md-sparrow',
	extract: false,
	beforeReplace: () => stopMdSparrowResidents(),
};

/** Каталог кэша portable JRE. */
function jreRootOf(baseDir: string, javaVersion: number): string {
	return path.join(baseDir, `jre-temurin-${javaVersion}`);
}

/** Качает архив Temurin в каталог установки и распаковывает его там же. */
async function downloadJreInto(dir: string, javaVersion: number): Promise<void> {
	const archiveName = process.platform === 'win32' ? `temurin-jre-${javaVersion}.zip` : `temurin-jre-${javaVersion}.tar.gz`;
	const archivePath = path.join(dir, archiveName);
	await streamDownload(adoptiumBinaryUrl(javaVersion), archivePath, { 'User-Agent': 'vscode-1c-platform-tools' });
	await extractArchive(archivePath, dir);
	await fs.rm(archivePath, { force: true });
}

async function ensurePortableJre(
	baseDir: string,
	download: boolean,
	javaOverride: string,
	javaVersion: number
): Promise<string> {
	const trimmed = javaOverride.trim();
	if (trimmed) {
		return trimmed;
	}

	const jreRoot = jreRootOf(baseDir, javaVersion);
	const cached = cachedJava(jreRoot);
	if (cached !== undefined) {
		log.debug(`JRE из кэша: ${cached}`);
		tidyJreCache(jreRoot);
		return cached;
	}
	if (!download) {
		// автозагрузка выключена намеренно: работаем на java из PATH
		return 'java';
	}

	return preparedOnce(`jre-install|${jreRoot}`, async () => {
		log.info(`загрузка portable JRE ${javaVersion} (Eclipse Temurin)…`);
		const status = showStatus(`md-sparrow: загружаем JRE ${javaVersion}...`);
		try {
			const java = await installJre(jreRoot, (dir) => downloadJreInto(dir, javaVersion));
			log.info(`JRE готова: ${java}`);
			return java;
		} finally {
			status.dispose();
		}
	});
}

async function ensureJar(
	baseDir: string,
	download: boolean,
	jarOverride: string,
	githubToken: string
): Promise<{ jarPath: string; tag?: string }> {
	const trimmed = jarOverride.trim();
	if (trimmed) {
		if (trimmed.includes('${')) {
			throw new Error('components.path.metadataJar: укажите полный путь к md-sparrow-*-all.jar.');
		}
		if (!fssync.existsSync(trimmed)) {
			throw new Error(
				`components.path.metadataJar не найден: ${trimmed}. Соберите артефакт: в каталоге md-sparrow выполните ./gradlew shadowJar (build/libs/md-sparrow-*-all.jar).`
			);
		}
		return { jarPath: trimmed };
	}
	if (!download) {
		const cached = await cachedReleaseComponent(baseDir, MD_SPARROW_SPEC);
		if (cached) {
			return { jarPath: cached.assetPath, tag: cached.tag };
		}
		throw new Error('Укажите components.path.metadataJar или включите components.autoload.metadataJar.');
	}

	const ensured = await ensureReleaseComponent(baseDir, MD_SPARROW_SPEC, githubToken);
	return { jarPath: ensured.assetPath, tag: ensured.tag };
}

/**
 * Гарантирует наличие JRE и JAR согласно настройкам проекта.
 *
 * @param context - Контекст расширения
 * @param root - Корень проекта, для которого читаются настройки компонентов
 * @returns Пути к java и jar с тегом релиза
 */
export async function ensureMdSparrowRuntime(
	context: vscode.ExtensionContext,
	root: string | undefined = currentRoot()
): Promise<MdSparrowRuntime> {
	const cfg = projectConfiguration(root);
	const download = cfg.get<boolean>('components.autoload.metadataJar', true);
	const downloadJre = cfg.get<boolean>('components.autoload.java', true);
	const jarPathSetting = cfg.get<string>('components.path.metadataJar', '').trim();
	const javaPathSetting = cfg.get<string>('components.path.java', '').trim();
	if (javaPathSetting.includes('${')) {
		throw new Error('components.path.java: укажите полный путь к java или оставьте поле пустым.');
	}

	const base = installBaseDir(context);
	await fs.mkdir(base, { recursive: true });
	// Параллельные обращения с одинаковыми настройками ждут одну подготовку
	const { jarPath, tag } = await preparedOnce(`jar|${base}|${download}|${jarPathSetting}`, () =>
		ensureJar(base, download, jarPathSetting, resolveGithubToken())
	);
	// Версию Java задаёт сборка md-sparrow
	const javaVersion = await readJarJavaVersion(jarPath);
	const java = await preparedOnce(
		`jre|${base}|${downloadJre}|${javaPathSetting}|${javaVersion}`,
		() => ensurePortableJre(base, downloadJre, javaPathSetting, javaVersion)
	);

	return { java, jarPath, releaseTag: tag, autoJava: javaPathSetting === '', javaVersion };
}

/** Идущие сейчас подготовки по ключу настроек. */
const preparationsInFlight = new Map<string, Promise<unknown>>();

/**
 * Запускает подготовку, если с тем же ключом она ещё не идёт.
 *
 * @param key - Что готовится и с какими настройками
 * @param prepare - Подготовка
 */
function preparedOnce<T>(key: string, prepare: () => Promise<T>): Promise<T> {
	const running = preparationsInFlight.get(key) as Promise<T> | undefined;
	if (running !== undefined) {
		return running;
	}
	const started = prepare().finally(() => {
		preparationsInFlight.delete(key);
	});
	preparationsInFlight.set(key, started);
	return started;
}

/**
 * Фоновая проверка наличия нового релиза md-sparrow; при обнаружении чистит кэш JAR и зовёт колбэк.
 *
 * @param context - Контекст расширения
 * @param onUpdateApplied - Вызывается после очистки кэша
 * @param root - Корень проекта, для которого читаются настройки компонентов
 */
export function checkMdSparrowUpdateInBackground(
	context: vscode.ExtensionContext,
	onUpdateApplied: () => void,
	root: string | undefined = currentRoot()
): void {
	const cfg = projectConfiguration(root);
	if (cfg.get<string>('components.path.metadataJar', '').trim()) {
		return;
	}
	if (!cfg.get<boolean>('components.autoload.metadataJar', true)) {
		return;
	}
	checkReleaseUpdateInBackground(installBaseDir(context), MD_SPARROW_SPEC, resolveGithubToken(), onUpdateApplied);
}

/**
 * Загружает jar md-sparrow, не глядя на `components.path.metadataJar` и автозагрузку.
 *
 * @param context - Контекст расширения
 * @returns Путь к загруженному jar
 */
export async function downloadMdSparrowJar(context: vscode.ExtensionContext): Promise<string> {
	const ensured = await ensureReleaseComponent(installBaseDir(context), MD_SPARROW_SPEC, resolveGithubToken());
	return ensured.assetPath;
}

/**
 * Загружает portable JRE для JAR md-sparrow, не глядя на `components.path.java` и автозагрузку.
 *
 * @param context - Контекст расширения
 * @returns Путь к java
 */
export async function downloadPortableJre(context: vscode.ExtensionContext): Promise<string> {
	const base = installBaseDir(context);
	await fs.mkdir(base, { recursive: true });
	const jarPathSetting = projectConfiguration(currentRoot())
		.get<string>('components.path.metadataJar', '')
		.trim();
	const jarPath =
		jarPathSetting !== '' && fssync.existsSync(jarPathSetting)
			? jarPathSetting
			: ((await cachedMdSparrowPath(context)) ?? (await downloadMdSparrowJar(context)));
	const javaVersion = await readJarJavaVersion(jarPath);
	return ensurePortableJre(base, true, '', javaVersion);
}

/** Тег релиза md-sparrow в кэше; undefined — не загружен. */
export async function cachedMdSparrowTag(context: vscode.ExtensionContext): Promise<string | undefined> {
	return cachedReleaseTag(installBaseDir(context), MD_SPARROW_SPEC);
}

/** Путь JAR md-sparrow в кэше; undefined — не загружен. */
export async function cachedMdSparrowPath(context: vscode.ExtensionContext): Promise<string | undefined> {
	return (await cachedReleaseComponent(installBaseDir(context), MD_SPARROW_SPEC))?.assetPath;
}

/** Сброс кэша JAR — следующий вызов ensure скачает заново. */
export async function clearMdSparrowJarCache(context: vscode.ExtensionContext): Promise<void> {
	await clearReleaseCache(installBaseDir(context), MD_SPARROW_SPEC);
}

/** Каталоги кэша JRE: по одному на версию Java. */
function jreRoots(baseDir: string): string[] {
	try {
		return fssync
			.readdirSync(baseDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && /^jre-temurin-\d+$/.test(entry.name))
			.map((entry) => path.join(baseDir, entry.name));
	} catch {
		return [];
	}
}

/** Каталог JRE для версии из JAR; undefined — JAR или JRE ещё не загружены. */
async function cachedJreRoot(context: vscode.ExtensionContext): Promise<string | undefined> {
	const jarPath = await cachedMdSparrowPath(context);
	if (jarPath === undefined) {
		return undefined;
	}
	const root = jreRootOf(installBaseDir(context), await readJarJavaVersion(jarPath));
	return cachedJava(root) === undefined ? undefined : root;
}

/**
 * Версия загруженной portable JRE.
 *
 * @param context - Контекст расширения
 * @returns Версия JRE или undefined, если она не загружена
 */
export async function portableJreVersion(context: vscode.ExtensionContext): Promise<string | undefined> {
	const root = await cachedJreRoot(context);
	return root === undefined ? undefined : cachedJreVersion(root);
}

/**
 * Путь к java загруженной portable JRE.
 *
 * @param context - Контекст расширения
 * @returns Путь или undefined, если JRE не загружена
 */
export async function portableJreJavaPath(context: vscode.ExtensionContext): Promise<string | undefined> {
	const root = await cachedJreRoot(context);
	return root === undefined ? undefined : cachedJava(root);
}

/**
 * Сброс кэша portable JRE — скачается заново при следующем использовании дерева метаданных.
 *
 * @throws ComponentBusyError - JRE запущена в другом окне, кэш не тронут
 */
export async function clearPortableJreCache(context: vscode.ExtensionContext): Promise<void> {
	await stopMdSparrowResidents();
	await Promise.all(jreRoots(installBaseDir(context)).map((root) => clearJre(root)));
}
