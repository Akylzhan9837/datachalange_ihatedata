# CQA Quality Assurance System

## Быстрый старт

1. Установка зависимостей:
```bash
npm install
```

2. Настройка переменных окружения:
```bash
cp .env.example .env
```

3. Запуск сервера разработки:
```bash
npm run dev
```

Сервер доступен по адресу: `http://localhost:3000`

## Проверка качества кода

```bash
npm run typecheck
npm test
```

## API Endpoints

- `GET /api/health` — проверка работоспособности сервиса
- `GET /api/sets/:group_id` — получение набора диалогов (с автоматическим кэшированием)
- `GET /api/checklists` — список доступных чек-листов
- `GET /api/checklists/:id` — получение чек-листа по идентификатору
- `POST /api/checklists` — сохранение новой версии чек-листа
- `GET /api/audio?url=...` — извлечение прямой ссылки на аудиопоток для плеера
- `GET /api/evaluations` — список результатов оценок
- `GET /api/evaluations/:id` — результат оценки по идентификатору
- `GET /api/evaluations/by-conversation/:conversation_id` — результат оценки по идентификатору диалога
- `POST /api/appeals` — регистрация апелляции
- `GET /api/appeals` — список зарегистрированных апелляций
- `POST /api/appeals/:id/decide` — принятие решения по апелляции
