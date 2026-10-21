/**
 * Версия Java из JAR: читается из атрибута манифеста X-Required-Java-Version.
 * Запуск: npm run test:node
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { ZipFile } from 'yazl';
import { readJarJavaVersion } from '../../features/metadata/jarJavaVersion';

const roots: string[] = [];

after(() => {
	for (const root of roots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/** Заголовок class-файла: magic, minor, major. */
function classFile(major: number): Buffer {
	const bytes = Buffer.alloc(8);
	bytes.writeUInt32BE(0xcafebabe, 0);
	bytes.writeUInt16BE(0, 4);
	bytes.writeUInt16BE(major, 6);
	return bytes;
}

function manifest(...attributes: string[]): string {
	return ['Manifest-Version: 1.0', ...attributes, '', ''].join('\r\n');
}

async function writeJar(entries: Record<string, string | Buffer>): Promise<string> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jar-java-'));
	roots.push(root);
	const jar = path.join(root, 'md-sparrow-test-all.jar');
	const zip = new ZipFile();
	for (const [name, content] of Object.entries(entries)) {
		zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), name);
	}
	zip.end();
	await new Promise<void>((resolve, reject) => {
		const out = fs.createWriteStream(jar);
		zip.outputStream.pipe(out).on('close', resolve).on('error', reject);
	});
	return jar;
}

describe('версия Java из JAR', () => {
	test('читается из манифеста, а не из class-файла', async () => {
		const jar = await writeJar({
			'META-INF/MANIFEST.MF': manifest(
				'Main-Class: io.example.Main',
				'X-Required-Java-Version: 25'
			),
			'io/example/Main.class': classFile(52),
		});

		assert.strictEqual(await readJarJavaVersion(jar), 25);
	});

	test('class-файлы не нужны', async () => {
		const jar = await writeJar({
			'META-INF/MANIFEST.MF': manifest('X-Required-Java-Version: 21'),
		});

		assert.strictEqual(await readJarJavaVersion(jar), 21);
	});

	test('имя атрибута не зависит от регистра, продолжение строки склеивается', async () => {
		const jar = await writeJar({
			'META-INF/MANIFEST.MF': manifest('x-required-java-version: 2', ' 5'),
		});

		assert.strictEqual(await readJarJavaVersion(jar), 25);
	});

	test('JAR без атрибута отклоняется', async () => {
		const jar = await writeJar({
			'META-INF/MANIFEST.MF': manifest('Main-Class: io.example.Main'),
		});

		await assert.rejects(readJarJavaVersion(jar), /нет X-Required-Java-Version/);
	});

	test('JAR без манифеста отклоняется', async () => {
		const jar = await writeJar({ 'io/example/Main.class': classFile(69) });

		await assert.rejects(readJarJavaVersion(jar), /нет META-INF\/MANIFEST.MF/);
	});

	test('некорректное значение отклоняется', async () => {
		const jar = await writeJar({
			'META-INF/MANIFEST.MF': manifest('X-Required-Java-Version: 0'),
		});

		await assert.rejects(readJarJavaVersion(jar), /некорректное значение X-Required-Java-Version/);
	});
});
