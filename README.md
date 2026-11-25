# etolegko-speed-test

CLI делает 10 последовательных GET по прямому HTTP(S)-адресу, каждый по новому соединению. Скорость в MiB/s считается по общему объёму тел и суммарному времени запросов. 1 MiB = 1 048 576 байт.

## Запуск

Нужен Node.js 22 или новее. Обычный замер работает без установки пакетов.

```sh
git clone https://github.com/MishaMgla/etolegko-speed-test.git
cd etolegko-speed-test
node measure-download.mjs 'https://example.com/'
```

Пример вывода:

```text
Requests: 10
Average time: 34.016 ms
Total downloaded: 5770 bytes
Download speed: 0.016177 MiB/s
```

## Проверка формата

Режим `--validate` определяет формат по байтам и проверяет статические PNG, JPEG и WebP. Нужен Node.js 22.2 или новее.

```sh
npm ci
node measure-download.mjs 'https://raw.githubusercontent.com/MishaMgla/etolegko-speed-test/main/docs/terminal-example.png' --validate
```

Отчёт добавляет строку `Validation: 10/10 verified (PNG); 0 not verified`. Для HTML по адресу `https://example.com/` она будет `Validation: 0/10 verified; 10 not verified (unsupported format)`.

Повреждённый файл распознанного формата завершает замер с ошибкой. `--format png` доступен для строгой проверки именно PNG.

## Ошибки

```console
$ node measure-download.mjs 'https://example.com/etolegko-speed-test-missing'
Request 1 failed: HTTP 404
$ node measure-download.mjs 'https://example.com/' --format png
Request 1 failed: invalid PNG: missing PNG signature
```

При первой ошибке CLI пишет причину в stderr и выходит с кодом `1`. Тайм-аут срабатывает после 60 секунд без прогресса.

Тесты (Node.js 22.2+) запускаются командой `npm ci && node --test`. [Документация и скриншот](docs/README.md)
