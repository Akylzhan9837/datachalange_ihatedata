# Проверка: результаты сделала наша система

Как убедиться, что `results/dev/results.json` и `results/prod/results.json` получены нашим конвейером, а не вручную. И как прогнать любой транскрипт заново при вас.

Команда **ihatedata** · модель — Gemini API (`external_api`).

---

## 1. Запуск (3 минуты)

```bash
npm install
```
```bash
cp .env.example .env
```
В `.env` заполнить `GEMINI_API_KEY` (ключ Google AI Studio) и `CQA_API_URL` (ссылка GET организаторов).

```bash
npm run dev
```
Сервер: `http://localhost:3000`, проверка — `http://localhost:3000/api/health`.

Интерфейс — статические HTML/CSS/JS в `frontend/`. Если сервер его не раздаёт, во втором терминале:
```bash
npx --yes http-server frontend -p 5173 -c-1
```
и открыть `http://localhost:5173`. Адрес бэкенда по умолчанию `http://localhost:3000/api`, другой — параметр `?api=`.

---

## 2. Прогнать диалог заново при вас

Оценка без кэша — модель вызывается прямо сейчас, 20–40 секунд на диалог:

```bash
npx tsx scripts/try.ts ID_ДИАЛОГА --set data/sets/GROUP_ID.json
```

- Несколько диалогов — через пробел.
- Набор `GROUP_ID` скачивается при выгрузке prod или при открытии набора в интерфейсе (поле «Набор данных» внизу списка).
- По каждому критерию печатается ответ, реплики-доказательства, обоснование и пометка ⚠, если модель не уверена или ответ не прошёл проверку. Внизу — модель, число вызовов, токены, время.
- Сырой ответ сохраняется в `data/storage/tl-runs/ID.<время>.json`.

То же через API (с `force: true` — без кэша):
```bash
curl -s -X POST http://localhost:3000/api/evaluate -H "Content-Type: application/json" -d "{\"conversation_id\":\"ID_ДИАЛОГА\",\"checklist_id\":\"cqa-full\",\"force\":true}"
```

---

## 3. Сравнить со сданным файлом

```bash
node -e "const f=require('./results/prod/results.json');const r=f.results.find(x=>x.conversation_id===process.argv[1]);console.log(r.score);for(const c of r.criteria)console.log(c.criterion_id.padEnd(15),String(c.value).padEnd(6),c.evidence_turns.join(','))" ID_ДИАЛОГА
```

Соответствие кодов в файле и номеров критериев в выводе `try.ts`:

| Файл | Критерий | Значения |
|---|---|---|
| `contact` | 01 Установление контакта | `true` = Да, `false` = Нет |
| `discovery` | 02 Выявление потребности | `true` / `false` / `null` = N/A |
| `identification` | 03 Идентификация | `true` / `false` / `null` = N/A |
| `consultation` | 04 Консультация | 0 / 5 / 10 / 15 / 20 или `null` |
| `empathy` | 05 Эмпатия | `true` / `false` |
| `dialogue` | 06 Ведение диалога | 0 / 4 / 7 / 10 |
| `closure` | 07 Завершение | `true` / `false` / `null` = N/A |
| `critical` | 08 Грубая ошибка | `true` = есть, на итог не влияет |

**Почему возможны небольшие расхождения.** Модель не полностью детерминирована: на однозначных критериях ответ совпадает, на спорных (тон, полнота консультации) может сдвинуться на ступень. Режим голосования — `CQA_VOTES=3` в `.env`: три прогона, ответ большинства, расхождение помечается ⚠ для проверяющего. Итог при этом всегда считает код, не модель.

---

## 4. Свой транскрипт

Положить файл `data/sets/JURY.json` в формате API организаторов:

```json
{
  "isSuccess": true,
  "data": {
    "dataset_group_id": "JURY",
    "records": [
      {
        "conversation_id": "jury-1",
        "channel": "agent chat",
        "language": "RU",
        "audio_url": null,
        "transcript": [
          { "timestamp": "00:00", "speaker": "client", "text": "Здравствуйте, не могу вывести деньги" },
          { "timestamp": "00:30", "speaker": "operator", "text": "Здравствуйте! Меня зовут Анна, сейчас помогу." }
        ]
      }
    ]
  }
}
```
`speaker`: `client`, `operator`, `bot`, `system`. `channel`: `agent chat` или `voice call`. Язык: `RU`, `KZ`, `EN`.

```bash
npx tsx scripts/try.ts jury-1 --set data/sets/JURY.json
```
В интерфейсе — ввести `JURY` в поле «Набор данных».

---

## 5. Почему это не заготовленные ответы

- **В коде нет ни одного критерия.** Промпт и схема ответа собираются из чек-листа `data/checklists/cqa-full.json` (`server/evaluate.ts`). Поменяли критерий в редакторе — следующая оценка идёт по новому, без правки кода.
- **Модель не считает баллы.** Она возвращает ответ по критерию, номера реплик и обоснование; итог, веса, N/A и секции считает `shared/scoring.ts` (покрыт тестами).
- **Ответ модели проверяется кодом:** допустимые значения, номера реплик в пределах диалога, «Да» только с доказательством. Не прошло — ⚠, без тихой подмены.
- **У каждой оценки записаны** версия чек-листа, версия промпта, модель, время, токены (`data/storage/`).
- **Файл результатов собирает скрипт** `scripts/export-results.ts` из тех же оценок и сам проверяет формат JSON 1.0. Вручную не правится.

```bash
npm test
```

---

## 6. Для команды: перед показом

- Перед живым прогоном — тот же чек-лист, промпт и модель, что при сдаче. Правили чек-лист на демо → `git checkout data/checklists/cqa-full.json`.
- Квота: 2–4 запроса на показ, лучше с отдельного ключа (в `.env`, перезапустить сервер).
- `results/*.json` руками не трогать.
- Интернет нужен: Gemini и API организаторов.
