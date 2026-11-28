# Разработка с Codex и Claude Code

Общие инструкции находятся в корневом `AGENTS.md`; отдельного файла инструкций для
Claude Code в репозитории нет, он читает этот файл напрямую. Оба агента используют
один UI-навык из `.agents/skills/swellwright-ui`; файл в `.claude/skills` — точка
входа, а не отдельный набор правил.

Каноническая подробная инструкция: [English development guide](../en/development.md).
Текущее состояние: [project-status.md](project-status.md).

## Подготовка

Нужны Node 26 и pnpm 10.34.9 (точная версия в `package.json`). После переноса каталога
переустанавливайте зависимости: Windows junction-ссылки могут сохранить старые абсолютные пути.

```text
pnpm install --frozen-lockfile --ignore-scripts
pnpm run doctor
pnpm run check
pnpm run openapi:check
python scripts/check-hygiene.py
pnpm run artifacts:check
```

Для API и консоли скопируйте `.env.example` в `.env` внутри репозитория, задайте локальный
`SW_AUTH_KEY`, запустите dev-compose с PostgreSQL/Valkey, выполните сборку и
`pnpm run db:migrate:deploy`. Затем отдельно запускайте
`pnpm --filter @swellwright/api dev` и `pnpm --filter @swellwright/web dev`.
Вход на локальный стенд — через setup token, собственного owner и TOTP.
Боевые секреты и старые скрипты приёмки для обычной разработки не нужны.

## Что подтверждают проверки

У веб-консоли (`apps/web`) есть модульные тесты логики без браузера: `test/*.test.ts`
собираются `test/tsconfig.json` в `test-dist/` и запускаются `node --test`. Отрисовку,
вёрстку и доступность они не проверяют.

`check` включает тесты, но тесты БД без `SW_TEST_DATABASE_URL` и `SW_TEST_VALKEY_URL`
пропускаются; часть shell/SSH-тестов требует Linux. Указывайте эти пропуски в отчёте.
Для миграций нужен также `db:schema:check`; для установщика — artifact suite и shellcheck
на Linux. Изменённый `install.sh` — новая версия: `pnpm run artifacts:build` записывает её
в `releases.json`, а `artifacts:check` падает, если у записанной версии другие байты, в том
числе по сравнению с `origin/main` (или `SW_ARTIFACT_BASE_REF`; CI берёт целевую ветку PR).
Проверяйте реальное поведение SSH и брандмауэра на одноразовом Linux-стенде. Без
терминала шаг `ssh` не закрывает вход root или вход по паролю. До срабатывания
отката проверьте новый вход указанным администратором и `sudo id -u` с результатом
`0` до и после применения настроек. После перезагрузки включённый таймер
отсчитывает срок заново; проверьте и этот сценарий на стенде. Отдельный workflow
**Released artifact integrity** использует проверяющий скрипт из базовой ревизии и
становится доступен после его слияния в целевую ветку.
Docker smoke и реальные sshd-проверки описаны в CI. Git Bash подходит для
DCO, но не заменяет Linux-стенд. PGlite не доказывает корректность параллельных транзакций PostgreSQL.

Не меняйте системные политики доступа ради прохождения теста. MCP боевой панели
не является зависимостью сборки. PR и merge выполняются в пределах текущего разрешения.
