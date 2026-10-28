# Руководство для контрибьютеров

Спасибо за интерес к **VSConfigurator**, независимому форку [1C: Platform Tools](https://github.com/yellow-hammer/vscode-1c-platform-tools). Проект развивается как расширение VS Code для повседневной разработки 1С: команды vanessa-runner, панели проектов и артефактов, дерево метаданных, TODO, отладка и интеграция с AI/MCP.

## Как помочь

- Сообщить об ошибке через [bug report](.github/ISSUE_TEMPLATE/bug_report.md).
- Предложить функцию через [feature request](.github/ISSUE_TEMPLATE/feature_request.md).
- Исправить баг, добавить тесты, улучшить фичу или документацию.
- Помочь проверить работу на разных версиях платформы 1С, ОС и сценариях запуска.

Проблемы безопасности отправляйте по правилам из [SECURITY.md](SECURITY.md), не через публичные Issues.

## Окружение разработки

- Для сборки: Node.js `24.19.0` (зафиксирован в `.nvmrc` и CI), npm, Git. Зафиксированные инструменты упаковки и тестирования требуют Node.js 22 или новее.
- Для ручной проверки: VS Code `1.125.0` или новее.
- Для ручной проверки команд 1С: платформа 1С:Предприятие, OneScript, OPM и vanessa-runner.
- Для отладки 1С: ничего ставить не нужно, расширение скачивает адаптер с рантаймом внутри; на Linux рантайму нужен системный пакет `libicu`.
- Для дерева метаданных: JDK/JRE версии из md-sparrow; при настройках по умолчанию расширение скачивает portable JRE само.

Рабочий цикл: `npm ci` → `F5` (Extension Development Host) → в новом окне открыть проект 1С с `packagedef`. Скрипты сборки и тестов — в `package.json` и задачах VS Code.

### Сборка установочного пакета

Из корня репозитория с указанной версией Node.js:

```sh
npm ci
npm run typecheck
npm run lint
npm run compile
npm test
npm run package
```

`npm ci` устанавливает зависимости из `package-lock.json`; обновлять lock-файл для сборки не нужно. `npm test` дополнительно выполняет `pretest` (проверку сгенерированных схем, компиляцию, типы и линтер), затем тесты в отдельном Extension Host VS Code `1.125.0` и Node.js-тесты. При первом запуске тестовый VS Code скачивается автоматически; на Linux без графического сеанса используйте `xvfb-run -a npm test`.

`npm run package` запускает `vscode:prepublish` (генерацию схем и компиляцию) и создаёт в корне `vsconfigurator-0.9.18.vsix` для текущей версии. Имя, publisher и версия берутся из `package.json`. Сборка не публикует расширение в маркетплейсы и не требует их токенов. Одинаковые исходники, Node.js и lock-файл фиксируют входы сборки; побайтовая идентичность VSIX не гарантируется из-за метаданных ZIP.

В GitHub откройте **Actions → CI → запуск для нужного коммита → Artifacts → vsix-<SHA>**. Скачайте ZIP и извлеките `.vsix`. Артефакт хранится 14 дней и появляется после успешных проверок и упаковки в задании `test`; для скачивания войдите в GitHub. CI запускается для Pull Request (включая Draft) и пушей в `main`. Установка пакета и ручная проверка обычного VS Code выполняются отдельно.

### Идентичность и совместимость форка

Пакет: `smazovec.vsconfigurator`, видимое имя: `VSConfigurator`. Версия `0.9.18` унаследована от исходного проекта; MIT LICENSE, copyright и авторство Ivan Karlo сохранены. Проверка `publisher` при упаковке подтверждает синтаксис, но не регистрацию или владение в Marketplace. Порядок установки и проверки ID — в [README](README.md#установка-vsix).

Изменённые ссылки на package identity:

| Место | Причина |
| --- | --- |
| `shared/commandCatalog.ts` | Чтение contribution-команд из манифеста установленного форка. |
| `shared/collectEnvironmentSummary.ts` | Версия форка в диагностике окружения. |
| `shared/ipcServer.ts` | ID и версия форка в ответе IPC ping. Протокол и порт сохранены. |
| `features/tools/settingsSections.ts` | Фильтр `@ext:smazovec.vsconfigurator` для настроек панелей. |

Идентификаторы команд, view, context keys, настройки `1c-platform-tools.*`, debug adapter, webview, файлы `.1cpt` и ключи persisted state сохранены. Старые названия источников задач и терминалов также сохранены, чтобы не менять идентификацию задач. Внешние компоненты и отдельное расширение `yellow-hammer.mcp-1c-platform-tools` остаются upstream-зависимостями. Их ссылки не означают принадлежность VSConfigurator к upstream. Совместимость отдельного MCP-расширения с новым ID требует ручной проверки; его код в эту задачу не входит.

VS Code создаёт отдельное хранилище для нового package ID; миграция globalStorage, workspaceState и secret storage не выполняется. Для приёмки используется чистый профиль, одновременная установка с оригиналом не гарантируется. Автоматические тесты Extension Host проверяют обнаружение нового ID, чтение каталога команд и привязку фильтра настроек. Ручная проверка дерева метаданных, редактора форм и внешних инструментов остаётся отдельной проверкой Сергея.

## Архитектура проекта

Ключевые точки входа:

```txt
src/
├── extension.ts                 # re-export точки входа
├── app/
│   ├── activate.ts              # активация расширения
│   ├── bootstrapApp.ts          # сборка приложения
│   ├── register*Flow.ts         # подключение крупных фич
│   └── projectLifecycle.ts      # контекст проекта 1С
├── commands/
│   ├── baseCommand.ts           # базовый класс команд
│   ├── commandRegistry.ts       # регистрация core-команд
│   └── *Commands.ts             # доменные команды vrunner и сервиса
├── features/
│   ├── tools/                   # дерево «1С: Инструменты», избранное, помощь
│   ├── projects/                # панель «1С: Проекты»
│   ├── artifacts/               # панель «1С: Артефакты»
│   ├── metadata/                # дерево метаданных, свойства объектов, ER
│   ├── todo/                    # TODO-панель и сканер
│   └── debug/                   # DAP-интеграция
├── shared/                      # инфраструктура, vrunner, IPC, логирование
├── utils/                       # общие утилиты
├── webviews/                    # webview-код
└── test/                        # тесты
```

Полезные файлы:

- `src/features/tools/treeStructure.ts` — единый источник групп дерева **1С: Инструменты** и команд избранного.
- `src/features/tools/commandNames.ts` — пользовательские названия команд.
- `src/shared/vrunnerManager.ts` — запуск vanessa-runner.
- `src/shared/projectStructure.ts` — структура проекта для команды инициализации.
- `src/shared/logger.ts` — логирование в Output.
- `package.json` — contribution points VS Code: команды, панели, настройки, walkthrough.
- `resources/skills/` — навыки для AI-агентов.
- `walkthrough/` — страницы onboarding в VS Code.

## Стандарты кода

- Пишите на TypeScript и избегайте `any`.
- Используйте типы из `@types/vscode`.
- Импорты держите в начале файла.
- Для VS Code API и команд vrunner ориентируйтесь на существующие паттерны в коде: `BaseCommand`, `VRunnerManager`.
- Не используйте `console.log`/`console.error` в production-коде; используйте `logger` (скоуп на модуль: `logger.scope('компонент')`).
- Свой канал Output заводите только под живой поток чужого долгоживущего процесса, который читают как консоль (так сделано у автономного сервера с выводом `ibsrv`). Всё, что пишет сам код расширения, идёт в общий журнал `VSConfigurator` со скоупом модуля: один канал с уровнями и фильтром удобнее набора мелких, а событие не дублируется в двух местах.
- Комментарии в коде и сообщения пользователю пишите на русском.
- UI-тексты должны быть короткими и полезными: без внутренних терминов, планов реализации и длинных пояснений.
- Рутинное подтверждение («дерево обновлено», «файл создан», «свойства сохранены») показывайте через `notifyQuiet` из `shared/notify`: строка состояния и запись в журнал. Всплывающее окно оставляйте для ошибок, предупреждений, сообщений с кнопками и подсказок, что делать дальше.
- Не добавляйте legacy/fallback-совместимость без явной необходимости.
- XML метаданных не правьте вручную из TypeScript; операции с метаданными должны идти через md-sparrow.

## Команды и настройки

- Новые команды добавляйте в `package.json`, `src/features/tools/commandNames.ts` и нужный доменный модуль.
- Если команда должна быть в дереве **1С: Инструменты**, добавьте её в `TREE_GROUPS`.
- Для новых панелей добавляйте view/container в `package.json`, runtime-регистрацию в соответствующей feature-папке и flow в `src/app`.
- Кнопка **Настройки** в панели должна открывать релевантный раздел настроек.
- Все настройки расширения должны открываться с фильтром `@ext:smazovec.vsconfigurator`.

## Внешние компоненты

Часть инструментов не бандлится в VSIX: расширение скачивает их с GitHub Releases в рантайме и держит в globalStorage. Что это за компоненты, откуда берутся и какими настройками подставляется свой файл — [Внешние компоненты](docs/components.md).

Чтобы работать со своей сборкой, соберите компонент (`dotnet build -c Release` у адаптера отладки, `gradlew shadowJar` у md-sparrow) и укажите путь в `components.path.*`, выключив парную автозагрузку. Расширение переустанавливать не нужно: пересобранный адаптер подхватывается следующей сессией отладки, md-sparrow — обновлением дерева.

## Коммиты и Pull Request

Используйте [Conventional Commits](https://www.conventionalcommits.org/ru/v1.0.0/) на русском языке:

```txt
feat(metadata): добавить фильтр по подсистемам
fix(projects): исправить открытие проекта из пустого окна
docs(readme): обновить описание панелей
```

Перед PR:

1. Проверьте, что изменения сфокусированы на одной задаче.
2. Запустите `npm run lint`, `npm run compile` и `npm test`; для изменённых фич добавьте или обновите тесты в `src/test/`.
3. Обновите документацию (`README.md`, `docs/`, walkthrough, навыки), если менялось пользовательское поведение. `CHANGELOG.md` формируется релизным процессом — вручную его менять не нужно.
4. Заполните шаблон PR: что изменилось, как проверено, какие issues связаны.

Мейнтейнеры могут попросить доработки или дополнительные проверки.

## Релизы

В этой задаче workflow Release, теги, GitHub Releases и публикации Marketplace / Open VSX не запускаются. Следующая процедура унаследована от исходного проекта; она не подтверждает настройку публикации или подписи форка.

Релиз выпускается тегом `vX.Y.Z` (`git tag v0.1.0 && git push origin v0.1.0`) или вручную: **Actions** → workflow **Release** → **Run workflow** (параметры: `version`, `skip_publish`, `draft`, `prerelease`). Workflow обновит версию в `package.json`, сгенерирует `CHANGELOG.md` из Conventional Commits, создаст GitHub Release и опубликует расширение в маркетплейсы.

Для публикации в секретах репозитория (**Settings** → **Secrets and variables** → **Actions**) должны быть заданы токены:

- `VSCE_PAT` — VS Code Marketplace: [Azure DevOps](https://dev.azure.com/) → Personal Access Tokens → New Token → Scopes: **Custom defined** → **Marketplace: Manage**;
- `OVSX_TOKEN` — Open VSX Registry: [open-vsx.org](https://open-vsx.org/) → [Access Tokens](https://open-vsx.org/user-settings/keys) → Generate Token (если namespace не создан — сначала создайте его в Namespaces и запросите ownership через issue в [EclipseFdn/open-vsx.org](https://github.com/EclipseFdn/open-vsx.org)).

## Вопросы и помощь

- [Discussions](https://github.com/yellow-hammer/vscode-1c-platform-tools/discussions)
- [Issues](https://github.com/yellow-hammer/vscode-1c-platform-tools/issues)
- Email: [i.karlo@outlook.com](mailto:i.karlo@outlook.com)

## Код поведения

Будьте вежливы, конструктивны и уважайте время других участников. Критика должна помогать улучшить проект.

## Лицензия

Внося вклад в проект, вы соглашаетесь с тем, что ваш вклад распространяется по [MIT License](LICENSE).
