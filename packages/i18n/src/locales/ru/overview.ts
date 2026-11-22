/** Страница «Обзор» (apps/web/src/overview.tsx). */
export const overview = {
  title: 'Обзор',

  sections: {
    status: 'Состояние',
  },

  stats: {
    api: 'API',
    alive: 'Работает',
    dependencies: 'Зависимости',
    ready: 'Готов',
    notReady: 'Не готов',
    version: 'Версия',
    dependenciesSummary: 'работает {{up}} из {{total}}',
  },

  /** Блок подключённой панели Remnawave (apps/web/src/panel/overview-block.tsx). */
  panel: {
    title: 'Панель Remnawave',
    connect: 'Подключить панель',
    notConnectedTitle: 'Панель не подключена',
    notConnectedText:
      'Подключите свою панель Remnawave, чтобы видеть здесь её ноды, хосты, профили и пользователей.',
    notConnectedTextNoRight:
      'Попросите того, кто может менять подключение, подключить панель Remnawave.',
    version: 'Версия панели',
    supported: 'Поддерживается: {{range}}',
    unsupported: 'Этим выпуском не поддерживается',
    nodesOnline: 'Нод онлайн',
    ofTotal: 'из {{total}}',
    nodesTrouble: 'Проблемные ноды',
    health: 'Здоровье',
    healthOk: 'В порядке',
    healthUnknown: 'Неизвестно',
    instances_one: 'сообщает {{count}} процесс',
    instances_few: 'сообщают {{count}} процесса',
    instances_many: 'сообщают {{count}} процессов',
    instances_other: 'сообщают {{count}} процесса',
    hosts: 'Хосты',
    profiles: 'Профили',
    users: 'Пользователи',
    usersOnline_one: '{{count}} онлайн сейчас',
    usersOnline_few: '{{count}} онлайн сейчас',
    usersOnline_many: '{{count}} онлайн сейчас',
    usersOnline_other: '{{count}} онлайн сейчас',
    token: 'Токен истекает через',
    tokenDays_one: '{{count}} день',
    tokenDays_few: '{{count}} дня',
    tokenDays_many: '{{count}} дней',
    tokenDays_other: '{{count}} дня',
    tokenExpired: 'Истёк',
    tokenNoExpiry: 'Нет даты истечения',
    snapshot: 'Последний снимок',
    snapshotNone: 'Пока нет',
    snapshotNoneHint: 'Сделайте его на странице «Снимки»',
    snapshotChanges_one: 'С тех пор изменился {{count}} объект',
    snapshotChanges_few: 'С тех пор изменились {{count}} объекта',
    snapshotChanges_many: 'С тех пор изменились {{count}} объектов',
    snapshotChanges_other: 'С тех пор изменились {{count}} объекта',
    snapshotSame: 'Панель такая же, как была',
    snapshotUnknown: 'С панелью ещё не сравнивали',
  },

  checks: {
    title: 'Проверки зависимостей',
    apiDescription: 'Описание API',
    noneTitle: 'Пока нечего проверять',
    none: 'Зависимости пока не настроены. Задайте SW_DATABASE_URL и SW_VALKEY_URL, чтобы они проверялись здесь.',
    up: 'Работает',
    down: 'Не работает',
    latencyValue: '{{ms}} мс',
  },

  error: {
    unreachableTitle: 'API не отвечает',
    unreachableText:
      'Запустите API (pnpm --filter @swellwright/api start) или проверьте обратный прокси-сервер, затем повторите.',
    unexpectedTitle: 'API ответил неожиданно',
    unexpectedText:
      'Ответ не соответствует контракту API. Скорее всего, API и консоль из разных версий.',
  },
} as const;
