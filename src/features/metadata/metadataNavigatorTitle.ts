import type * as vscode from 'vscode';
import { ensureMdSparrowRuntime } from './mdSparrowBootstrap';
import { runMdSparrowParamsRead } from './mdSparrowParams';
import { mdSparrowSchemaFlagFromConfigurationXml } from './mdSparrowSchemaVersion';
import type { SourcePropertiesDto } from './metadataSourcePropertiesPanel';

/** Реальное имя из того же контракта, что использует палитра свойств конфигурации. */
export async function metadataConfigurationTitle(context: vscode.ExtensionContext, configurationXml: string, cwd: string): Promise<string> {
	const schemaVersion = await mdSparrowSchemaFlagFromConfigurationXml(configurationXml);
	const runtime = await ensureMdSparrowRuntime(context);
	const result = await runMdSparrowParamsRead(runtime, { op: 'cf-configuration-properties-get', configurationXml, schemaVersion }, { cwd });
	if (result.exitCode !== 0) { throw new Error(result.stderr.trim() || 'Не удалось прочитать имя конфигурации.'); }
	const dto = JSON.parse(result.stdout) as Partial<SourcePropertiesDto>;
	return (typeof dto.synonym === 'string' && dto.synonym.trim()) || (typeof dto.name === 'string' && dto.name.trim()) || 'Метаданные';
}
