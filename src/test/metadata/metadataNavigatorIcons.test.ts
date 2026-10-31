import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { MetadataNavigatorView } from '../../features/metadata/metadataNavigatorView';
import { adoptedIcon, initAdoptedIcons, supportIcon } from '../../features/metadata/objectBelonging';

suite('Ресурсы значков webview', () => {
	test('vscode-userdata storage разрешает file URI составных SVG, не открывая всё хранилище', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'navigator-icons-'));
		const extensionUri = vscode.Uri.file(path.resolve(__dirname, '../../..'));
		const storageUri = vscode.Uri.file(path.join(directory, 'метки поддержки')).with({ scheme: 'vscode-userdata' });
		const cache = path.join(storageUri.fsPath, 'metadata-tree-icons');
		const events = new vscode.EventEmitter<void>();
		const messages = new vscode.EventEmitter<unknown>();
		const disposed = new vscode.EventEmitter<void>();
		const base = {
			light: vscode.Uri.joinPath(extensionUri, 'resources/metadata-tree-icons/catalog.svg'),
			dark: vscode.Uri.joinPath(extensionUri, 'resources/metadata-tree-icons/dark/catalog.svg'),
		};
		initAdoptedIcons(cache);
		const icons = [base, supportIcon(base, 'editable'), supportIcon(base, 'locked'), adoptedIcon(base), supportIcon(base, 'locked', true)];
		const items = icons.map((iconPath, index) => { const item = new vscode.TreeItem(`Узел${index}`); item.iconPath = iconPath; return item; });
		const context = { extensionUri, globalStorageUri: storageUri } as unknown as vscode.ExtensionContext;
		let options: vscode.WebviewOptions = {};
		const webview = {
			get options() { return options; }, set options(value: vscode.WebviewOptions) { options = value; },
			html: '', cspSource: 'https://test.vscode-cdn.net',
			asWebviewUri: (uri: vscode.Uri) => uri,
			onDidReceiveMessage: messages.event, postMessage: async () => true,
		};
		const view = new MetadataNavigatorView(context, { getChildren: async () => items, getParent: () => undefined, onDidChangeTreeData: events.event }, () => undefined, () => '', async () => undefined);
		try {
			await view.resolveWebviewView({ webview, title: '', show: () => undefined, onDidDispose: disposed.event } as unknown as vscode.WebviewView);
			const roots = options.localResourceRoots ?? [];
			assert.strictEqual(roots.length, 2);
			assert.ok(roots.some(root => root.scheme === 'file' && root.fsPath === cache));
			assert.ok(!roots.some(root => root.fsPath === storageUri.fsPath), 'разрешён только каталог значков');
			const page = await view.model.page(undefined, 0, view.model.epoch);
			assert.strictEqual(page?.nodes.length, 5);
			for (const node of page!.nodes) {
				assert.ok(node.icon);
				for (const src of [node.icon.light, node.icon.dark]) {
					const uri = vscode.Uri.parse(src);
					assert.ok(fs.existsSync(uri.fsPath));
					assert.ok(roots.some(root => root.scheme === uri.scheme && uri.path.startsWith(root.path + '/')), 'URI и разрешённый корень должны иметь одну схему');
				}
			}
			assert.ok(fs.readFileSync(icons[2].dark.fsPath, 'utf8').includes('#E8952D'), 'метка замка сохранена');
		} finally {
			view.dispose(); events.dispose(); messages.dispose(); disposed.dispose();
			assert.strictEqual(path.dirname(directory), path.resolve(os.tmpdir()));
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
