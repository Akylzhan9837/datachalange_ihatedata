// Правила-подсказки: простые проверки транскрипта без модели.
// Они НЕ переопределяют ответ модели. Расхождение превращается во флаг «проверить» (crossCheck).
// Индексы реплик — позиции в массиве transcript (с нуля), как в evidence результата оценки.

export type Speaker = 'client' | 'operator' | 'bot' | 'system';
export type Lang = 'RU' | 'KZ' | 'EN';

export interface Utterance {
  timestamp: string;
  speaker: Speaker;
  text: string;
}

export type ClosingKind = 'operator_closed' | 'client_left' | 'connection_lost';

export interface RuleHints {
  /** Индекс первой реплики оператора (бот и система не считаются) или null. */
  firstOperatorIndex: number | null;
  greeting: { found: boolean; lang: Lang | null };
  introduction: boolean;
  /** Язык текста первой реплики оператора по алфавиту. */
  operatorTextLang: Lang | null;
  clientLanguage: Lang | null;
  /** Прощание в одной из двух последних реплик оператора. */
  farewell: { found: boolean; index: number | null };
  /** Системное сообщение о закрытии чата / уходе клиента / обрыве связи. */
  closing: { kind: ClosingKind | null; index: number | null };
  /** Системное сообщение «личность клиента подтверждена». */
  identityVerified: { found: boolean; index: number | null };
}

export interface RuleFlag {
  criterion_id: string;
  rule: string;
  message: string;
  index: number | null;
}

// В JS \b не работает с кириллицей, поэтому границы слова задаём через \p{L}.
const W = (src: string, flags = 'iu') => new RegExp(`(?<![\\p{L}\\p{N}])(?:${src})(?![\\p{L}\\p{N}])`, flags);

const GREETING: Record<Lang, RegExp> = {
  RU: W('здравствуй(?:те)?|добрый\\s+(?:день|вечер)|доброе\\s+утро|доброго\\s+времени\\s+суток|приветствую|привет'),
  KZ: W('сәлеметсіз\\s+бе|сәлеметсіздер\\s+ме|сәлем|қайырлы\\s+(?:күн|таң|кеш)|армысыз'),
  EN: W('hello|hi|hey|greetings|good\\s+(?:morning|afternoon|evening)'),
};

// Без флага i: \p{Lu} с i сработал бы и на строчные. Регистр ключевых слов перечислен вручную.
const INTRODUCTION: RegExp[] = [
  /(?<![\p{L}])[Мм]еня\s+зовут(?![\p{L}])/u,
  /(?<![\p{L}])[Мм]оё\s+имя|(?<![\p{L}])[Мм]ое\s+имя/u,
  /(?<![\p{L}])[Яя]\s+(?!Вам|Вас|Ваш|Вы)\p{Lu}\p{Ll}+/u, // «Я Алина», «здравствуйте, я Тимур»
  /\p{Lu}\p{Ll}+\s+из\s+(?:поддержки|службы|отдела)/u, // «Лера из поддержки»
  /(?<![\p{L}])[Мм]енің\s+атым/u,
  /(?<![\p{L}])[Мм]ен\s+(?!Сіз)\p{Lu}\p{Ll}+/u, // «Мен Дана», «Мен Нұрланмын»
  /(?<![\p{L}])(?:I'm|I’m|I\s+am|[Mm]y\s+name\s+is|[Tt]his\s+is)\s+\p{Lu}\p{Ll}+/u,
];

const FAREWELL: RegExp[] = [
  W('до\\s+свидания|всего\\s+(?:доброго|хорошего)|хорошего\\s+(?:дня|вечера|дня\\s+вам|вечера\\s+вам|выходных)|до\\s+связи|всех\\s+благ'),
  W('сау\\s+болыңыз(?:дар)?|қош\\s+болыңыз(?:дар)?|күніңіз\\s+сәтті\\s+өтсін|сәтті\\s+күн|аман\\s+болыңыз'),
  W('goodbye|good-bye|bye|take\\s+care|see\\s+you|have\\s+a\\s+(?:good|great|nice|lovely|wonderful)\\s+(?:day|evening|night|weekend)'),
];

const CLOSING: { kind: ClosingKind; re: RegExp }[] = [
  { kind: 'operator_closed', re: /оператор\s+закрыл\s+чат|agent\s+closed\s+the\s+chat|оператор\s+чатты\s+жапты/iu },
  { kind: 'client_left', re: /клиент\s+покинул\s+чат|customer\s+left\s+the\s+chat|client\s+left\s+the\s+chat|клиент\s+чаттан\s+шықты/iu },
  { kind: 'connection_lost', re: /соединение\s+с\s+клиентом\s+прервано|connection\s+to\s+customer\s+lost|клиентпен\s+байланыс\s+үзілді/iu },
];

const IDENTITY_VERIFIED = /личность\s+клиента\s+подтверждена|customer\s+identity\s+verified|клиенттің\s+жеке\s+басы\s+расталды/iu;

export function detectTextLang(text: string): Lang | null {
  if (/[әіңғүұқөһӘІҢҒҮҰҚӨҺ]/u.test(text)) return 'KZ';
  if (/\p{Script=Cyrillic}/u.test(text)) return 'RU';
  if (/[A-Za-z]/.test(text)) return 'EN';
  return null;
}

export function findGreeting(text: string): Lang | null {
  // Язык приветствия определяем по первому совпадению, KZ раньше RU (общие слова не пересекаются).
  for (const lang of ['KZ', 'RU', 'EN'] as Lang[]) if (GREETING[lang].test(text)) return lang;
  return null;
}

export const hasIntroduction = (text: string): boolean => INTRODUCTION.some((re) => re.test(text));
export const hasFarewell = (text: string): boolean => FAREWELL.some((re) => re.test(text));

export function analyzeTranscript(transcript: Utterance[], clientLanguage?: string | null): RuleHints {
  const lang = (clientLanguage ?? '').toUpperCase();
  const clientLang = lang === 'RU' || lang === 'KZ' || lang === 'EN' ? (lang as Lang) : null;

  const opIdx = transcript.flatMap((u, i) => (u.speaker === 'operator' ? [i] : []));
  const first = opIdx.length ? opIdx[0] : null;
  const firstText = first === null ? '' : transcript[first].text;

  let farewellIndex: number | null = null;
  for (const i of opIdx.slice(-2).reverse()) {
    if (hasFarewell(transcript[i].text)) {
      farewellIndex = i;
      break;
    }
  }

  let closing: RuleHints['closing'] = { kind: null, index: null };
  let verified: RuleHints['identityVerified'] = { found: false, index: null };
  transcript.forEach((u, i) => {
    if (u.speaker !== 'system') return;
    const hit = CLOSING.find((c) => c.re.test(u.text));
    if (hit) closing = { kind: hit.kind, index: i };
    if (!verified.found && IDENTITY_VERIFIED.test(u.text)) verified = { found: true, index: i };
  });

  const greetLang = first === null ? null : findGreeting(firstText);
  return {
    firstOperatorIndex: first,
    greeting: { found: greetLang !== null, lang: greetLang },
    introduction: first !== null && hasIntroduction(firstText),
    operatorTextLang: first === null ? null : detectTextLang(firstText),
    clientLanguage: clientLang,
    farewell: { found: farewellIndex !== null, index: farewellIndex },
    closing,
    identityVerified: verified,
  };
}

export interface AnswerLike {
  criterion_id: string;
  answer?: string | null;
}

/** Сверка правил с ответами модели. Пустой массив — расхождений нет. */
export function crossCheck(hints: RuleHints, answers: AnswerLike[]): RuleFlag[] {
  const flags: RuleFlag[] = [];
  const ans = (id: string) => String(answers.find((a) => a.criterion_id === id)?.answer ?? '').toLowerCase();
  const flag = (criterion_id: string, rule: string, message: string, index: number | null) =>
    flags.push({ criterion_id, rule, message, index });

  // 01 Установление контакта: приветствие + имя в первой реплике ОПЕРАТОРА, на языке клиента.
  const a01 = ans('01');
  if (a01) {
    const i = hints.firstOperatorIndex;
    const langOk = !hints.clientLanguage || !hints.greeting.lang || hints.greeting.lang === hints.clientLanguage;
    const complete = i !== null && hints.greeting.found && hints.introduction && langOk;
    if (a01 === 'yes' && !complete) {
      const why =
        i === null ? 'оператор не отвечал' : !hints.greeting.found ? 'в первой реплике оператора нет приветствия'
        : !hints.introduction ? 'в первой реплике оператора нет представления' : `приветствие на ${hints.greeting.lang}, клиент пишет на ${hints.clientLanguage}`;
      flag('01', 'first_operator_reply', `Модель: «Да», но правило не подтверждает: ${why}.`, i);
    }
    if (a01 === 'no' && complete) {
      flag('01', 'first_operator_reply', 'Модель: «Нет», но первая реплика оператора содержит приветствие на языке клиента и имя.', i);
    }
  }

  // 07 Завершение: прощание оператора; оборванные чаты.
  const a07 = ans('07');
  if (a07) {
    const { farewell, closing } = hints;
    if (a07 === 'yes' && !farewell.found) flag('07', 'farewell', 'Модель: «Да», но прощания в последних репликах оператора не найдено.', hints.closing.index);
    if (a07 === 'no' && farewell.found) flag('07', 'farewell', 'Модель: «Нет», но в последних репликах оператора есть прощание.', farewell.index);
    if (a07 === 'na' && farewell.found) flag('07', 'farewell', 'Модель: N/A, но оператор попрощался.', farewell.index);
    if (!farewell.found && (closing.kind === 'client_left' || closing.kind === 'connection_lost') && a07 === 'no') {
      flag('07', 'chat_closed', 'Чат оборвался (клиент ушёл или пропала связь). Возможно, правильно N/A.', closing.index);
    }
    if (!farewell.found && closing.kind === 'operator_closed' && a07 === 'na') {
      flag('07', 'chat_closed', 'Оператор сам закрыл чат без прощания. Возможно, правильно «Нет», а не N/A.', closing.index);
    }
  }

  // 03 Идентификация: в чате было системное «личность подтверждена», значит проверка требовалась.
  if (ans('03') === 'na' && hints.identityVerified.found) {
    flag('03', 'identity_event', 'Модель: N/A, но в чате есть системное сообщение о подтверждении личности.', hints.identityVerified.index);
  }
  return flags;
}
