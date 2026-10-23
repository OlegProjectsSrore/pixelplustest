# Граница голосового адаптера

Модули этого каталога не изменяют D1, интервалы интервью, баланс, слоты, ответы и состояние отчёта. Публичные экспорты находятся в `index.ts`. Проектные поля используют snake_case, поля Ultravox — имена официального API. OpenAPI проверена 2026-10-22 через `GET https://api.ultravox.ai/api/schema/`.

## Создание и продолжение

`createVoiceStartHandler(plan_provider)` соответствует `AdapterHandler`. Вход `plan_provider(core, session, body)` получает уже аутентифицированную сессию; основной router проверяет Turnstile. Планировщик ядра обязан атомарно проверить ревизии, активный канал, доступный остаток и актуальный подтверждённый баланс/параллелизм аккаунта, затем зарезервировать вызов. Для повторной операции он возвращает `{ kind: 'existing', response }`; для новой — `{ kind: 'create', call_record_id, config, provider_dependencies, on_created, on_failure }`.

`provider_dependencies` содержит `api_key`, `account_slot`, внедряемый `fetch` и обязательный `run_authorized(context, execute)`. Каждое создание, чтение звонка и страницы истории проходит через runner. Runner проверяет полномочия и разрешённые расходы; адаптер не создаёт резерв самостоятельно и не подменяет runner прямым fetch.

`config` содержит `system_prompt`, `model`, `voice`, `remaining_seconds`, `first_message`, `callback_url`, `webhook_secrets`, необязательные `metadata`, `prior_call_id` либо `initial_messages`. Модель/голос должны быть проверены в выбранном аккаунте. Лимит равен остатку, максимум 900 секунд; округление только вниз до миллисекунды. Callback — HTTPS. Ключи не передаются браузеру или модели.

На том же аккаунте `prior_call_id` превращается в query-параметр `priorCallId`. На другом аккаунте ядро передаёт нужный контекст и `initial_messages` с проектными `user/assistant`; адаптер преобразует их в проверенные `MESSAGE_ROLE_USER/MESSAGE_ROLE_AGENT`. Оба способа одновременно запрещены. Продолжение создаёт новый call ID.

`on_created({ call, join_url })` записывает provider ID в ранее зарезервированную запись и возвращает актуальное представление сессии. Только после этого handler возвращает браузеру `{ call_id, provider_call_id, join_url, session }`; `call_id` — ID записи ядра, `provider_call_id` — UUID Ultravox. `join_url` не входит в сохраняемый `ProviderCall`.

`on_failure(error)` получает `VoiceProviderError` с `creation_outcome`: `not_created`, `unknown`, `not_applicable`. Сетевая ошибка POST, невалидный ответ 201 и сбой сохранения после создания означают `unknown`; повтор создания и освобождение резерва до сверки запрещены. При известном ID он возвращён в `provider_call_id`. Адаптер сам не повторяет запросы, `Retry-After` сохраняет отдельно.

## Ответы и завершение

Имена client tools: `saveAnswers`, `finishAudit`, `offTopicReply`; добавлен встроенный `hangUp` с `strict: true`. Запись имеет `precomputable: false`. Функции `parseVoiceAnswerPayload`, `parseVoiceFinishPayload`, `parseVoiceOffTopicPayload` проверяют только форму кандидатов, не подтверждают их содержание.

В `answers` модель передаёт `question_id`, `fact_id`, `state`, `value`, `source_quotes`, опционально `answer_id`, `parameters`, `source_ordinals`, `is_correction`, `confirmation_candidate`. `id`, `event_ids`, `confirmation`, session/call/operation ID, ревизии и версии модель не назначает. Адаптер ядра должен найти только уже доставленные пользовательские события, разрешить цитаты/ordinal без неоднозначного склеивания, проверить явность исправления/подтверждения и сформировать `AuditAnswer`. Недоставленное или неразрешимое свидетельство не становится фактом.

Перед инструментом браузер доставляет накопленные версии SDK transcripts и ждёт подтверждения. SDK-массив содержит обновления и `null`; ключ браузерной реплики — `(call_id, ordinal)`. Серверные stage/index не равны ordinal. `isFinal` не означает правильность распознавания или окончание воспроизведения аудио.

`finishAudit` принимает `answers` и причины `sufficient`, `visitor_request`, `declined`, `time_limit`. Причина ядра `recovery_expired` определяется только сервером и отклоняется голосовым HTTP-адаптером. Браузер сначала подтверждает последний пакет через `/api/voice/answers`, затем вызывает `/api/audit/finish` без кандидатов с актуальной ревизией и серверным `through_event_id`. Успешный client tool возвращает `{ result: JSON.stringify(ответ_ядра), responseType: 'tool-response', agentReaction: 'speaks' }`; браузер не вызывает `leaveCall` до благодарности. Промпт требует произнести согласованную фразу и вызвать `hangUp`. Hard limit `maxDuration` остаётся страховкой; завершённый текст не доказывает слышимость фразы.

Для просьбы о паузе промпт предусматривает сохранение ответов, `offTopicReply` с `kind: 'pause'`, подтверждение сервером и `hangUp`. Ядро должно подтверждать закрытие активного интервала только по остановке, затем фиксировать паузу; service reply не выдаёт шутку и не завершает аудит. При смене канала сначала останавливается предыдущий звонок.

## Вебхуки и история

`parseVerifiedWebhook(raw_bytes, headers, options)` проверяет HMAC перед JSON parsing, возвращает `{ event, call }`; metadata и provider summaries не становятся полномочиями или фактами. Обязательная точка ядра — поиск call по provider ID, проверка связи с session/slot/channel revision, идемпотентное применение `call.joined`, `call.ended`, `call.billed`. Вебхук старого звонка не завершает новую сессию/канал. Provider не документирует отдельный event ID; дедупликация нужна в ядре.

Подпись: raw body + исходная UTF-8 строка `X-Ultravox-Webhook-Timestamp`, HMAC-SHA256 hex; несколько подписей в `X-Ultravox-Webhook-Signature` разделяются запятыми. Значения по умолчанию адаптера: максимальный возраст 60 секунд, допустимое будущее 5 секунд. `now` и `subtle` внедряются; для ротации доступны несколько секретов. Семантическая идемпотентность дополняет проверку времени.

`createVoiceProvider(deps).getCallHistory(provider_id)` читает все страницы `mode=in_call`, исключая унаследованные initialMessages. Обход ограничен 100 страницами/10 000 сообщениями; превышение — ошибка, а не частичная «полная» история. Следующие URL проверяются на origin/path/режим, редиректы запрещены. Идентичные пересечения страниц устраняются по stage/index, конфликтующие версии отклоняются. Для полного интервью ядро обходит цепочку звонков; после `call.ended` история данного звонка неизменяема.

`ProviderMessage` сохраняет происхождение, порядок, роль, stage/index и относительные duration-поля. `wall_clock_timespan` — смещение от joined, не ISO-дата. Сопоставление с SDK и превращение в `AuditEvent` выполняет ядро. Неизвестные роли не переименовываются в пользователя.

`createVoiceReconcileHandler(hooks)` соответствует общему `reconcile(session, now, core)`. Альтернатива — `createVoiceReconciler(core, hooks)` для замыкания в рамках текущего invocation. Возвращать `complete: true` можно только после сохранения всей доступной истории и фиксации пробелов. Нет доступа к аккаунту, неоконченный звонок или ошибка истории дают ограничение/повтор согласно политике ядра.

## HTTP factories и обязательные hooks ядра

`createVoiceHandlers(hooks)` возвращает `voiceTranscript`, `voiceAnswers`, `voiceFinish`, `ultravoxWebhook`, совместимые с `AdapterHandler`. Router отвечает за аутентификацию и передаёт актуальный `context.session`, не сохранённый до внешних операций снимок. Handler дополнительно проверяет принадлежность local call ID сессии и правила активного канала. Повтор операции без сохранённого хеша запроса либо с другим хешем не разрешает обход проверок.

1. `acceptTranscriptBatch(request, context, { call, events })` — обязательный атомарный hook записи всего нормализованного пакета. Возвращает `{ response: Json, accepted_event_ids: string[] }` только после durable commit. ID каждой версии назначает сервер: `voice:<local_call_id>:<ordinal>:<source_revision>`. Присланные браузером ID, source, kind, received_at, confirmation и correction metadata не задают серверные полномочия. HTTP-ответ содержит `accepted_events` и `through_event_id`; браузер сохраняет этот серверный ID для завершения. Частичное подтверждение вызывает `pending_events`, а не успешное опустошение outbox. Hook проверяет ревизии, хеш операции, повторные версии, позднюю доставку и не продвигает интервью из late evidence.
2. `assessEvidence({ candidate, evidence, history, existing_answers, session })` — необязательная доверенная оценка смысла подтверждения/исправления. Без неё ответы имеют `confirmation: unconfirmed`, модельный `confirmation_candidate` не повышает доверие, замены нет. Возвращённый `replaces_answer_id` проверяется на принадлежность тому же факту и актуальность. Кандидат связывается только с последними, завершёнными, уже сохранёнными пользовательскими репликами этого звонка; неоднозначная цитата без подходящего ordinal отклоняется. `resolveVoiceAnswers` присваивает ID/версии/время на сервере и передаёт запись в `core.accept`. Обычный пакет имеет event kind `answer`; доказанное исправление — `correction` с исходными evidence ID.
3. `assessServiceIntent(request, context, { call, candidate, evidence })` — обязательная доверенная проверка редкого вызова `offTopicReply` по сохранённым репликам. `kind`, `certain` и категории из браузера — кандидаты; без hook возвращается 503. Результат проверяется и передаётся в `core.humor` с серверным now. Для mixed/sensitive/жалоб нельзя повышать намерение до off_topic по одному клиентскому флагу. Hook не вызывается на каждой голосовой реплике. `kind: finish` не закрывает опрос обходным путём: требуется отдельное подтверждённое завершение.
4. `requestPause(request, context, call)` — фиксирует запрос остановки, но не состояние stopped. Пока звонок active/stopping/unknown, HTTP-адаптер возвращает `pause_pending: true, stop_required: true`. После подтверждения провайдером stopped/failed он допускает `core.channel(action: pause)`. SDK disconnected и успешный local leave сами по себе серверной остановкой не считаются.
5. `webhookOptions(core)` — секреты и параметры HMAC без зависимости от непроверенного тела. `applyProviderEvent(core, event, source)` — общий идемпотентный hook применения событий после HMAC (`source: webhook`) либо доверенного GET (`source: lookup`). Проверяет связь provider/local call ID, slot/session/channel, интервал и состояние старых звонков; выполняет необходимые записи ядра. HTTP-адаптер не применяет события, пока оба hook не подключены.
6. `providerForCall(core, call)` — возвращает provider с ключом исходного слота и обязательным runner. `ingestProviderHistory(core, session, call, messages)` — сопоставляет provider/browser identity, сохраняет недостающие события и возвращает `{ complete, limitations, events }` с реальными persisted ID. `recoverAnswers(core, session, call, uncovered_events, existing_answers)` — классифицирует только ещё не подтверждённые события, проверяет и сохраняет recovery answers с закреплённой библиотекой; возвращает `{ complete, limitations }`. Этот hook обязан быть идемпотентен по границе извлечения и бюджету. Отсутствие любого необходимого hook оставляет `complete: false`; снимок незавершённого звонка не объявляется полной историей.

Для core validation также нужен полный просмотр страниц сохранённых событий: ограничение первыми 1000 строками отвергнет корректные поздние evidence ID. `readSessionEvents` предоставляет такой просмотр, но не изменяет ядро. Все записи выполняются через перечисленные hooks или согласованные `core.accept`, `core.humor`, `core.channel`, `core.finish`.

Recovery не считает подтверждённым покрытием ответы `unconfirmed`, `disputed` и заменённые ответы. При сопоставлении повторов hook проверяет пару «fact_id + набор исходных событий», учитывает замены и уже сохранённую границу извлечения; одна реплика может содержать несколько фактов. Ссылка одного подтверждённого ответа на реплику сама по себе не доказывает извлечение всех её фактов. Hook должен фиксировать завершённую обработку и ограничение для неразрешимых реплик, чтобы не классифицировать их бесконечно при каждой сверке.

## Совместимость с подключением `channel-voice.ts`

`channel-voice.ts` использует provider primitives напрямую и реализует свои HTTP handlers; factory этого каталога автоматически его поведение не заменяет. Его предел пакета — 40 событий, поэтому браузер ограничивает отправку этим размером. Серверные ID этого подключения имеют собственный формат `ve:<hash>`; браузер использует возвращённые `accepted_event_ids` и `through_event_id`, не вычисляет ID самостоятельно.

При подключении обязательны следующие проверки контракта:

- `offTopicReply` проходит серверную оценку сохранённых реплик перед `core.humor`; клиентские `kind`, `certain` и категории не являются доверенной классификацией.
- `kind: finish` не обходит подтверждение последнего пакета. Публичный finish отклоняет серверную причину `recovery_expired` и её aliases; состояние завершает ядро.
- Запрос паузы возвращает понятное браузеру `stop_required: true` с актуальной сессией; `status: stopping` сам по себе не подтверждает остановку или фиксирование паузы.
- Подтверждение voice answers требует доверенной оценки исходных реплик. Постоянное присвоение `unconfirmed` без такой оценки сохраняет кандидаты, но не обеспечивает продвижение по подтверждённым фактам. При recovery такие кандидаты не считаются окончательно обработанными.
- После внешних операций возвращается заново прочитанная сессия; изменение call status не разрешает применять устаревший снимок ревизии.

## Явно не реализовано в этом слое

Запросы баланса/лимитов аккаунта, распределение слотов, billing settlement и поиск неизвестного созданного звонка по операции остаются внешними. Нет предположения о бесплатных 30 минутах и нет резерва из неподтверждённой env-константы. `billed_duration` сохраняется сырой строкой: формат ответа в проверенной OpenAPI не специфицирован, автоматическое преобразование/списание не производится. Неизвестный результат биллинга остаётся неизвестным.

Источники: [Create Call](https://docs.ultravox.ai/api-reference/calls/calls-post), [история](https://docs.ultravox.ai/api-reference/calls/calls-messages-list), [вебхуки](https://docs.ultravox.ai/webhooks/available-webhooks), [подпись](https://docs.ultravox.ai/webhooks/securing-webhooks), [SDK source](https://github.com/fixie-ai/ultravox-client-sdk-js/blob/main/src/index.ts), [hangUp](https://docs.ultravox.ai/tools/built-in-tools).
