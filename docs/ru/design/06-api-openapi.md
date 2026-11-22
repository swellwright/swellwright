# 06. API и OpenAPI

OpenAPI 3.1 — первоклассный артефакт: документация, SDK, CLI, MCP, контрактные тесты строятся из него. Спецификация OpenAPI обязательна для каждой версии API.

## 1. Принципы
- Базовый путь `/api/v1`; JSON; Zod-схемы в `packages/contracts` одновременно задают валидацию, типы и OpenAPI (`nestjs-zod` + `@nestjs/swagger`).
- Спека генерируется при сборке, сохраняется в репозитории (`openapi/swellwright.json`), раздаётся на `/api/v1/openapi.json`, документация Scalar на `/docs` (как у панели).
- Ошибки по RFC 9457 (`application/problem+json`): `type`, `title`, `status`, `detail`, `instance`, `code`, `errors[]`. Кодов ограниченный перечень (см. п. 6).
- Пагинация курсорная (`limit`, `cursor`), фильтры и сортировка единообразно (`filter[...]`, `sort`), `ETag` и `If-Match` для оптимистичных обновлений.
- Долгие операции: `202 Accepted` + ресурс запуска `runs/{id}`; повторный `POST` с тем же `Idempotency-Key` возвращает тот же запуск.
- Расширения OpenAPI: `x-sw-risk` (`low|medium|high`), `x-sw-approval` (требуется согласование), `x-sw-scopes`, `x-sw-locks` (какие ресурсы блокируются), `x-sw-permission` (разрешение, которое должна иметь роль вошедшего вызывающего; реализовано, ADR 0015), `x-sw-step-up` (сессия должна быть повышена, иначе 403 `step_up_required`; реализовано, ADR 0017).
- Версионирование: мажорная версия в пути; несовместимые изменения только с новой мажорной; политика устаревания (`Deprecation`, `Sunset`).

## 2. Аутентификация
| Способ | Кто | Особенности |
|---|---|---|
| Cookie-сессия | интерфейс | TOTP/passkey, CSRF, step-up |
| Bearer-токен Swellwright | CLI, автоматизация, MCP | scopes `sw:<ресурс>:<действие>`, срок, IP |
| Токен агента | probe-agent | только запись результатов и чтение своей конфигурации |
| Подписанные вебхуки (исходящие) | внешние системы | HMAC-SHA256 в заголовке |

## 3. Группы ресурсов и эндпоинты (основные)
| Группа | Эндпоинты (суть) |
|---|---|
| setup | `GET /setup/status`, `POST /setup/owner` (только первый запуск, нужен токен установки) |
| auth | `POST /auth/login`, `/auth/logout`, `/auth/totp`, `/auth/totp/enrollment`, `/auth/totp/confirm`, `/auth/passkeys/*`, `POST /auth/step-up` (реализовано, ADR 0017: код аутентификатора или код восстановления повышает сессию на несколько минут), `GET /auth/me`; реализовано с ADR 0016: `POST /auth/invitations/accept` (выбрать пароль по токену приглашения), `POST /auth/password` (сменить свой) |
| users, roles | CRUD пользователей и ролей Swellwright. Реализовано (ADR 0015, 0016): `GET /roles` (встроенные роли с наборами разрешений и каталог разрешений одним документом); `GET /users`, `POST /users` (приглашение: без пароля, одноразовое приглашение), `PATCH /users/{id}` (роль, статус, имя, e-mail), `POST /users/{id}/reset-credentials`; удаления пока нет |
| tokens | `POST/GET/DELETE /tokens` (токены Swellwright), `GET /tokens/scopes` |
| vault | `GET /vault/status`, `POST /vault/unseal`, `/vault/seal`, `/vault/rotate-kek`; `POST/GET/DELETE /secrets` (значения только на запись), `POST /secrets/{id}/reveal` (step-up), `GET /secrets/{id}/usage`. Реализовано (ADR 0018): `GET /vault/status`, `POST /vault/initialize` (один раз; возвращает ключ восстановления), `POST /vault/unseal` (фраза или ключ восстановления), `POST /vault/seal`, `GET/POST /secrets`, `PATCH /secrets/{id}` (описание или новое значение), `DELETE /secrets/{id}`, `POST /secrets/{id}/reveal`; запечатанное хранилище отвечает 423 `vault_sealed`; ротации и использования пока нет |
| servers | CRUD, `POST /servers/{id}/facts/refresh`, `GET /servers/{id}/facts`, `/events`, `/snapshots`, `/baseline-results`. Сделано (ADR 0034): `GET/POST /servers` (фильтры `state`, `tag`, `q`), `GET/PATCH/DELETE /servers/{id}` (удаляют только черновик или выведенный сервер), `POST /servers/{id}/host-keys` (закрепить вручную, идемпотентно: 200, если уже закреплён, 201, если новый), `DELETE /servers/{id}/host-keys/{keyId}`, `POST /servers/{id}/access`, `PATCH` и `DELETE /servers/{id}/access/{accessId}`; права `servers:read` и `servers:write`, без step-up; события, снимки и результаты эталона пока нет. Сделано (ADR 0037): `POST /servers/{id}/host-keys/scan` и `.../accept` (`replace` отзывает закреплённые ключи), `POST /servers/{id}/access/{accessId}/verify` (вход, который не удался, это результат: 200 с `ok: false`), `POST /servers/{id}/facts/refresh` (по одному на сервер, второй запрос присоединяется) и `GET /servers/{id}/facts` (`servers:read`, не подключается); всё, что подключается, требует `servers:write`, без step-up, и ограничено по частоте на пользователя; ошибки `host_key_not_pinned`, `host_key_mismatch` (с `expected` и `actual`), `host_key_replace_required`, `address_not_allowed`, `no_access_entry`, `ssh_connect_failed`, `ssh_auth_failed`, `ssh_key_invalid`, `ssh_timeout`, `ssh_failed`, `facts_unreadable` |
| commands | Сделано (ADR 0038): `GET/POST /scripts`, `GET/PATCH/DELETE /scripts/{id}` (встроенный скрипт только для чтения: 409), `POST /command-runs` (201, ставит в очередь запуск скрипта с параметрами или введённой команды на одном-пятидесяти серверах; для уровня, отличного от `read`, нужен `confirmedLevel`: 409 `confirmation_required` с `details.level`), `GET /command-runs` (сначала новые, фильтры `state` и `serverId`), `GET /command-runs/{id}` (текст, что выполнялся, параметры, каждый сервер с состоянием, кодом выхода, кодом ошибки и концом вывода), `GET /command-runs/{id}/targets/{targetId}/output` (страница по смещению в байтах, никогда не внутри символа UTF-8, до 256 КиБ) и `POST /command-runs/{id}/cancel` (повторный запрос безвреден, завершённый запуск это 409); чтение это `servers:read` и допускает API-токены, всё, что пишет, запускает или останавливает, требует `servers:exec` и свежий код и доступно только сессии |
| access | `POST /servers/{id}/access/verify`, `/access/rotate`, `/host-keys/accept` |
| terminal | `POST /servers/{id}/terminal/sessions` (step-up), `WS /ws/terminal/{sessionId}`, `GET /terminal/sessions`, `DELETE ...`, записи: `GET /terminal/recordings/{id}` |
| commands, scripts | `POST /commands` (выбор серверов, стратегия), `GET/POST /scripts`, `GET /commands/{id}` |
| files | `GET /servers/{id}/files?path=`, `PUT`, `DELETE`, `POST /files/distribute` |
| panels | `POST /panels` (мастер подключения), `GET /panels/{id}`, `/health`, `/compatibility`, `/tokens` |
| panel-objects | чтение кэша и прокси записи: `/panels/{id}/nodes`, `/hosts`, `/profiles`, `/squads`, `/templates`, `/subscription-settings`, `/page-configs`, `/plugins`, `/snippets`, `/billing`, `/users` (опц.) |
| panel-console | `GET /panels/{id}/console/operations`, `POST /panels/{id}/console/plan`, `POST /panels/{id}/console/execute` (согласование) |
| snapshots | `/panels/{id}/snapshots`, `/diff?from=&to=`, `POST /snapshots/{id}/restore` (объект) |
| conventions | CRUD, `POST /conventions/check` (дрейф), `POST /conventions/fix` (план) |
| panel-checks | Сделано в фазе 3 (ADR 0044), `panel:read`, если не сказано иное: `GET /panel/checks/rules`, `GET /panel/checks/convention` (`?refresh=true`), `GET /panel/checks/convention/last`, `GET /panel/checks/reconciliation`, `GET /panel/checks/convention-pack` (`?version=`), `PUT` и `DELETE` набора (`panel:write`, повышенная аутентификация), `GET .../convention-pack/versions`, `POST .../convention-pack/validate`, `GET /panel/impact/target`, `POST /panel/impact` (пробный прогон); ничто здесь не пишет в панель |
| chains | CRUD цепочек хопов, `POST /chains/{id}/verify`, `GET /chains/{id}/topology` |
| dns | `/dns/providers`, `/dns/zones`, `/dns/records`, `POST /dns/plan`, `/dns/apply`, `/dns/propagation`, `/dns/changes` |
| certs | `/certsync/entries`, `POST /certsync/sync`, `/certs/status`, ACME: `/acme/orders` (опц.) |
| blueprints | CRUD шаблонов развёртывания, `POST /blueprints/{id}/preview` |
| baselines | CRUD эталонов, `POST /baselines/{id}/run`, `GET /baseline-results`, `POST /baselines/fix` (план) |
| workflows | `GET /workflows` (каталог со схемами параметров), `POST /workflows/{code}/plan` (сухой прогон), `POST /workflows/{code}/runs` |
| runs | `GET /runs`, `/runs/{id}`, `/stages`, `/steps`, `/events`, `/logs`, `POST /runs/{id}/approve\|reject\|cancel\|pause\|resume\|retry\|rollback`, `GET /runs/{id}/undo-plan` |
| approvals | `GET /approvals`, `POST /approvals/{id}/decision` |
| policies | CRUD правил, `GET /policies/violations`, `POST /policies/evaluate` |
| schedules | CRUD расписаний, `POST /schedules/{id}/run-now` |
| probes | `/probes/agents`, `/targets`, `/results`, `POST /probes/run`, `GET /probes/matrix` |
| alerts, notifications | `/alerts`, `/alert-rules`, `/notification-channels`, `POST /notifications/test` |
| reports | `POST /reports`, `GET /reports/{id}` (HTML, Markdown, PDF) |
| audit | `GET /audit` (сначала новые, `cursor`, фильтры по действию, исходу и субъекту), `POST /audit/verify-chain` (оба реализованы, ADR 0015); экспорт |
| artifacts | `/artifacts` (установщик, node-engine, эталоны), `POST /artifacts/{id}/promote` | Сделано (ADR 0039): `GET /artifacts`, `GET /artifacts/{name}`, `GET /artifacts/{name}/versions/{version}`, `GET /artifacts/{name}/content` и `.../versions/{version}/content` (файл потоком, с `X-Content-SHA256`), а на серверах `GET/POST /servers/{id}/artifacts`, `POST /servers/{id}/artifacts/{name}/verify`, `DELETE /servers/{id}/artifacts/{name}/{version}` (`servers:read` для чтения, `servers:write` для отправки, проверки и удаления). Продвижение версии не сделано.
| advisories | `/advisories`, `POST /advisories/{id}/ack` |
| system | `GET /system/health\|ready\|version\|metrics`, `/settings`, `/backups`, `/updates` |
| webhooks | `/webhooks` (подписки), `POST /webhooks/{id}/test` |
| plugins | `GET /plugins`, `POST /plugins/{id}/enable\|disable`, `GET/PUT /plugins/{id}/config` (схема из манифеста), `GET /plugins/{id}/permissions`, `POST /plugins/{id}/test`; эндпоинты плагинов с префиксом `/ext/{pluginId}/...` включаются в общую OpenAPI |
| import-export | `POST /export`, `POST /import` |

## 4. События и каналы реального времени
- WebSocket `/ws`: каналы `runs/{id}`, `fleet`, `alerts`, `terminal/{id}`, `servers/{id}`; SSE `/events` как запасной вариант.
- Схема события: `{id, type, time, runId?, stage?, step?, severity, data}`; типы: `run.created`, `run.awaiting_approval`, `run.started`, `stage.started`, `stage.progress`, `stage.finished`, `step.log`, `run.finished`, `run.rolled_back`, `alert.fired`, `alert.resolved`, `server.drift_detected`, `panel.object_changed`, `probe.result`, `vault.sealed`.
- Подтверждения и повторная доставка: `id` монотонный, клиент запрашивает пропущенное по `Last-Event-ID`.

## 5. SDK, CLI, MCP
- **SDK TypeScript** генерируется из спеки (`openapi-typescript` + тонкий клиент); Python-клиент по необходимости (генератор).
- **CLI `sw`:** `sw runs start deploy --server ... --blueprint ...`, `sw runs watch`, `sw plan`, `sw approve`, `sw rollback`, `sw servers`, `sw dns`, `sw vault status`, `sw status`; вывод копируется как обычный текст, режимы `--ascii` и `--json`.
- **MCP-сервер** (опционально): инструменты чтения, запись через черновики и согласование; маскирование данных по умолчанию (стабильные псевдонимы).
- **Вебхуки наружу:** подписки по типам событий, повторы с экспоненциальной задержкой, подпись HMAC, журнал доставки.

## 6. Коды ошибок (перечень)
`validation_failed`, `unauthenticated`, `forbidden`, `step_up_required`, `vault_sealed`, `not_found`, `conflict`, `lock_held`, `precondition_failed`, `policy_blocked`, `approval_required`, `rate_limited`, `panel_unavailable`, `panel_contract_mismatch`, `ssh_unreachable`, `ssh_host_key_changed`, `dns_conflict`, `remote_step_failed`, `rollback_failed`, `internal_error`.

## 7. Управление спекой (в CI)
Линтер Spectral (правила имён, обязательные `x-sw-*`, описания, примеры), `oasdiff` (запрет несовместимых изменений в `v1`), контрактные тесты (Schemathesis против запущенного API), проверка, что каждый эндпоинт имеет тест и пример, генерация SDK и проверка, что клиент компилируется, публикация артефакта спеки в релизе.

## 8. Совместимость с идиомами Remnawave
Для узнаваемости используются те же соглашения там, где это не ухудшает дизайн: UUID для объектов, плоские имена полей в camelCase, `Authorization: Bearer`, документация Scalar. Конверт ответов `{response: ...}` панели **не копируется** (обычный JSON), чтобы не усложнять клиенты; генерируемый SDK скрывает различия.

## 9. Плагины в API
Плагины могут добавлять свои маршруты только в пространство `/api/v1/ext/{pluginId}/...`, описанные Zod-схемами и попадающие в общую спеку с пометкой источника (`x-sw-plugin`). Права плагина проверяются при каждом вызове, ответы проходят редактирование секретов. Спека без плагинов (только ядро) публикуется отдельно как каноническая.
