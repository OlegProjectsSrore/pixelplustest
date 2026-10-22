# project_log

---

- Date/time: 2026-10-22 15:55
- Scope: S:\PROJECTS\pixelplustest
- Summary: в базу знаний добавлены четыре презентации PDF из /doc/ (общая, разработка, поддержка, SEO). /doc/ закрыт в robots.txt, файлы взяты явно по указанию пользователя. Новый модуль pdf_markdown.py переводит слайды в Markdown (раздел на слайд, карточки по порядку чтения, склейка переносов); в начале каждого документа указана дата файла на сервере (разработка — 2018-08-03, поддержка и SEO — 2023-12-13, общая — 2024-02-27). База пересобрана (1 705 документов), индекс перестроен (2 954 куска), векторы перезагружены в Vectorize pixelplus-services и проверены. Изменения отправлены на GitHub.
- Files changed:
  - knowledge-base/scripts/pdf_markdown.py (новый)
  - knowledge-base/scripts/crawl.py (DOCUMENTS, --documents-only)
  - knowledge-base/scripts/extract.py (документы PDF)
  - knowledge-base/kb/documents/*.md (новые)
  - knowledge-base/README.md, urls.json, index.json, search-index.json
  - knowledge-base/raw/doc/*.pdf (в Git не входит)
  - Cloudflare Vectorize: pixelplus-services (2 954 вектора)
- Reference: «Добавь все четыре PDF из /doc/ в базу знаний, переиндексируй и синхронизируй с GitHub.»

---

- Date/time: 2026-10-22 15:20
- Scope: S:\PROJECTS\pixelplustest
- Summary: база знаний и индекс поиска закоммичены в main двумя коммитами и отправлены в https://github.com/OlegProjectsSrore/pixelplustest. Перед отправкой GitHub проверен: новых коммитов там не было. Git запускался с `-c safe.directory=*` на время команды (глобальные настройки не менялись) и с той же идентичностью автора, что и прежние коммиты.
- Files changed:
  - .gitignore, project_log.md, knowledge-base/** (кроме raw/) — в коммитах
- Reference: «Синхронизируй с репозиторием https://github.com/OlegProjectsSrore/pixelplustest»

---

- Date/time: 2026-10-22 15:05
- Scope: S:\PROJECTS\pixelplustest
- Summary: построен гибридный индекс поиска по базе знаний. Нарезка и BM25 перенесены из сайта портфолио в knowledge-base/search/search-text.mjs; единственное отличие — короткие хвосты разделов присоединяются к соседним кускам (иначе база не помещается в бесплатные 5 млн хранимых измерений Vectorize). 1 701 документ → 2 919 кусков, search-index.json 4,3 МБ. В Cloudflare Vectorize создан индекс pixelplus-services (1024, cosine, индексы метаданных kind и section), загружены векторы Workers AI bge-m3 для всех кусков. Скрипты сборки, загрузки и проверки; README дополнен. Исправлена ошибка обхода: списки кейсов с двумя фильтрами (/portfolio/prodvizhenie-saytov/<отрасль>/<тип>/) принимались за кейсы и перезаписывали один файл; база пересобрана, устаревшие векторы удалены (embed-index.mjs теперь удаляет их сам), check-vectors.mjs подтверждает все 2 919 векторов. Сгенерированные файлы базы переведены на переводы строк LF, extract.py и crawl.py теперь пишут LF.
- Files changed:
  - knowledge-base/search/search-text.mjs
  - knowledge-base/search/build-index.mjs
  - knowledge-base/search/embed-index.mjs
  - knowledge-base/search/cloudflare.mjs
  - knowledge-base/search/search-cli.mjs
  - knowledge-base/search/check-vectors.mjs
  - knowledge-base/search-index.json
  - knowledge-base/README.md
  - knowledge-base/scripts/extract.py, knowledge-base/scripts/crawl.py (запись с LF)
  - knowledge-base/kb/**, index.json, excluded.json, urls.json (CRLF → LF, содержимое не менялось)
  - Cloudflare Vectorize: индекс pixelplus-services (внешнее состояние)
- Reference: «Строй гибридный индекс: нарезка и BM25 как в портфолио, затем векторы в Vectorize pixelplus-services.»

---

- Date/time: 2026-10-22 11:26
- Scope: S:\PROJECTS\pixelplustest
- Summary: собрана база знаний по услугам pixelplus.ru для гибридного поиска. Написаны скрипт обхода сайта (по ссылкам, с соблюдением robots.txt, продолжение с места остановки) и скрипт очистки HTML в Markdown (без меню, форм и призывов, повторяющиеся блоки вынесены в общие файлы, почти одинаковые страницы-шаблоны сведены к одной, страницы без текста отброшены). Скачано около 2 200 страниц, в базе 1 703 файла: услуги, кейсы, о компании и общие блоки. Статьи (/samostoyatelno/, /stati/, /studio/stat/), новости, команда, вакансии и публикации не включены.
- Files changed:
  - knowledge-base/scripts/crawl.py
  - knowledge-base/scripts/extract.py
  - knowledge-base/README.md
  - knowledge-base/urls.json
  - knowledge-base/index.json
  - knowledge-base/excluded.json
  - knowledge-base/kb/** (Markdown базы)
  - knowledge-base/raw/** (сырой HTML, в Git не входит)
  - project_log.md (создан)
- Reference: «Начинай: пиши скрипт обхода и собери страницы в knowledge-base.»

---

- Date/time: 2026-10-22 08:30
- Scope: S:\PROJECTS\pixelplustest
- Summary: создана папка knowledge-base для базы знаний по услугам «Пиксель Плюс» (raw/, kb/services, kb/cases, kb/company); сырые страницы исключены из Git.
- Files changed:
  - .gitignore (добавлено /knowledge-base/raw/)
  - knowledge-base/
- Reference: «Сделай в S:\PROJECTS\pixelplustest отдельную папку для базы данных. Если сырые материалы нужно добавить в Gitignor - добавь»
