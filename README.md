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
- `GET /api/audio?url=...` — извлечение прямой ссылки на аудиопоток (только для `*.api.powerplatform.com`)
- `POST /api/evaluate` — запуск оценки диалога через LLM
  - Body: `{ "conversation_id": "p1-ru-001", "checklist_id": "default", "force": false }`
  - Response: объект `EvaluationResult` с рассчитанными `total_score`, `section_scores`, `gross_violation`, флагами `rule_flags` и `points` по каждому критерию.
  - Кэш по паре (диалог + версия чек-листа), при `force: true` переоценивает заново.
- `GET /api/evaluations` — список результатов оценок
- `GET /api/evaluations/:id` — результат оценки по идентификатору
- `GET /api/evaluations/by-conversation/:conversation_id` — результат оценки по идентификатору диалога
- `POST /api/appeals` — регистрация апелляции
  - Body: `{ "evaluation_id": "...", "criterion_id": "01", "comment": "..." }`
- `GET /api/appeals` — список зарегистрированных апелляций (поддерживает `?evaluation_id=...`)
- `POST /api/appeals/:id/decide` — принятие решения по апелляции
  - Body: `{ "status": "accepted" | "rejected", "reviewer_answer": "yes", "reviewer_reason": "..." }`
  - При `accepted` автоматически пересчитывает итоговый балл `total_score` и баллы по секциям.
