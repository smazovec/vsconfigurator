/**
 * Версия Java, под которую собран JAR: читается из атрибута манифеста
 * `X-Required-Java-Version`, который md-sparrow пишет при сборке.
 * @module jarJavaVersion
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

const MANIFEST_ENTRY = 'META-INF/MANIFEST.MF';
const REQUIRED_JAVA_ATTRIBUTE = 'x-required-java-version';
const MIN_JAVA_VERSION = 8;

const cache = new Map<string, Promise<number>>();

/**
 * Читает версию Java из манифеста JAR.
 *
 * @param jarPath - Путь к JAR
 * @returns Версия Java, объявленная сборкой md-sparrow
 */
export async function readJarJavaVersion(jarPath: string): Promise<number> {
	const stat = await fs.stat(jarPath);
	const key = `${path.resolve(jarPath)}|${stat.size}|${stat.mtimeMs}`;
	const cached = cache.get(key);
	if (cached) {
		return cached;
	}
	const started = readUncached(jarPath).catch((error: unknown) => {
		cache.delete(key);
		throw error;
	});
	cache.set(key, started);
	return started;
}

async function readUncached(jarPath: string): Promise<number> {
	const manifest = await readManifest(jarPath);
	const value = manifest.get(REQUIRED_JAVA_ATTRIBUTE);
	if (value === undefined || value === '') {
		throw new Error(
			`JAR ${path.basename(jarPath)}: в манифесте нет X-Required-Java-Version. Пересоберите md-sparrow.`
		);
	}
	const javaVersion = Number(value);
	if (!Number.isInteger(javaVersion) || javaVersion < MIN_JAVA_VERSION) {
		throw new Error(
			`JAR ${path.basename(jarPath)}: некорректное значение X-Required-Java-Version: ${JSON.stringify(value)}.`
		);
	}
	return javaVersion;
}

/** Атрибуты манифеста без учёта регистра имён; продолжения строк склеиваются. */
function parseManifest(text: string): Map<string, string> {
	const attributes = new Map<string, string>();
	let current: string | undefined;
	for (const line of text.split(/\r\n|\r|\n/)) {
		if (line.startsWith(' ')) {
			if (current !== undefined) {
				attributes.set(current, `${attributes.get(current) ?? ''}${line.slice(1)}`);
			}
			continue;
		}
		const colon = line.indexOf(':');
		if (colon <= 0) {
			current = undefined;
			continue;
		}
		current = line.slice(0, colon).trim().toLowerCase();
		attributes.set(current, line.slice(colon + 1).trim());
	}
	return attributes;
}

async function readManifest(jarPath: string): Promise<Map<string, string>> {
	const zip = await openZip(jarPath);
	try {
		const entry = await findEntry(zip, MANIFEST_ENTRY);
		if (!entry) {
			throw new Error(`JAR ${path.basename(jarPath)}: нет ${MANIFEST_ENTRY}.`);
		}
		return parseManifest((await readEntryStream(zip, entry)).toString('utf8'));
	} finally {
		zip.close();
	}
}

function openZip(jarPath: string): Promise<ZipFile> {
	return new Promise((resolve, reject) => {
		yauzl.open(jarPath, { lazyEntries: true, autoClose: true }, (error, zip) =>
			error ? reject(error) : resolve(zip)
		);
	});
}

/** Ищет запись с указанным именем, не читая её содержимое. */
function findEntry(zip: ZipFile, fileName: string): Promise<Entry | undefined> {
	return new Promise((resolve, reject) => {
		const cleanup = (): void => {
			zip.off('entry', onEntry);
			zip.off('error', onError);
			zip.off('end', onEnd);
		};
		const onEntry = (entry: Entry): void => {
			if (entry.fileName === fileName) {
				cleanup();
				resolve(entry);
				return;
			}
			zip.readEntry();
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		const onEnd = (): void => {
			cleanup();
			resolve(undefined);
		};
		zip.on('entry', onEntry);
		zip.on('error', onError);
		zip.on('end', onEnd);
		zip.readEntry();
	});
}

function readEntryStream(zip: ZipFile, entry: Entry): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		zip.openReadStream(entry, (error, stream) => {
			if (error) {
				reject(error);
				return;
			}
			const chunks: Buffer[] = [];
			stream.on('data', (chunk: Buffer) => chunks.push(chunk));
			stream.on('error', reject);
			stream.on('end', () => resolve(Buffer.concat(chunks)));
		});
	});
}
