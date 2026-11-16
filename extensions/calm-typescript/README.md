# Calm TypeScript

![Calm TypeScript](https://raw.githubusercontent.com/safarovmurod/antigravity-workstation/main/extensions/calm-typescript/icon.png)

Ошибки JavaScript и TypeScript видны, но не режут глаз: ошибки примерно на 70% непрозрачности, предупреждения — 55%, подсказки — 45% и 35%; в светлой теме цвета темнее. С 3.4.0 старые цвета 15% из 3.3.x заменяются автоматически. Проверка типов и обычные подсказки продолжают работать. Курсор плавный; после **Ctrl+S** строка мягко подсвечивается. С версии 3.3.7 расширение само ничего не сохраняет: автосохранение делает IDE (`files.autoSave: afterDelay`, 1 с), поэтому код не переформатируется во время набора.

Настройки: **Settings → Extensions → Calm TypeScript**. Reset возвращает значения, запомненные при первой активации этого расширения; состояние старого расширения не переносится.

Снимки ниже относятся к версии 3.3.0; текущая версия рисует ошибки заметнее.

| До | После (снимок 3.3.0) |
|---|---|
| ![Обычная диагностика](https://raw.githubusercontent.com/safarovmurod/antigravity-workstation/main/docs/images/diagnostics-before.png) | ![Calm TypeScript: ошибки остаются, оформление спокойнее](https://raw.githubusercontent.com/safarovmurod/antigravity-workstation/main/docs/images/diagnostics-after.png) |

Расширение входит в [Antigravity Workstation](https://github.com/safarovmurod/antigravity-workstation#quick-start).
