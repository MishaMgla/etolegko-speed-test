import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../measure-download.mjs', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPgEpH7DwABpAE8k4sOtwAAAABJRU5ErkJggg==', 'base64');

function runCli(...args) {
  return exec(process.execPath, [script, ...args], { timeout: 5000 });
}

function runCliWithShortTimeout(url) {
  const preload = `
    const setTimer = globalThis.setTimeout;
    globalThis.setTimeout = (callback, ms, ...args) =>
      setTimer(callback, ms === 60_000 ? 600 : ms, ...args);
  `;
  const moduleUrl = `data:text/javascript,${encodeURIComponent(preload)}`;
  return exec(process.execPath, ['--import', moduleUrl, script, url], { timeout: 5000 });
}

async function serve(t, handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}/file?sample=1`;
}

function readMetrics(stdout) {
  const match = stdout.match(/^Requests: (\d+)\nAverage time: (\d+\.\d{3}) ms\nTotal downloaded: (\d+) bytes\nDownload speed: (\d+\.\d{6}) MiB\/s\r?\n$/);
  assert.ok(match, stdout);
  const [, requests, averageMs, bytes, speed] = match.map(Number);
  return { requests, averageMs, bytes, speed };
}

function expectFailure(args, message) {
  return assert.rejects(runCli(...args), { code: 1, stdout: '', stderr: message });
}

test('downloads ten complete responses sequentially over new sockets and reports consistent metrics', async (t) => {
  const received = [];
  const sockets = new Set();
  const headerDelayMs = 20;
  const tailDelayMs = 30;
  let active = 0;
  let peakActive = 0;
  const url = await serve(t, async (request, response) => {
    received.push([request.method, request.url]);
    sockets.add(request.socket);
    const firstChunkBytes = received.length * 1024;
    active += 1;
    peakActive = Math.max(peakActive, active);
    await delay(headerDelayMs);
    response.write(Buffer.alloc(firstChunkBytes, 0xff));
    await delay(tailDelayMs);
    response.end(Buffer.alloc(512, 0x80));
    active -= 1;
  });

  const start = performance.now();
  const { stdout, stderr } = await runCli(url);
  const elapsedMs = performance.now() - start;
  const metrics = readMetrics(stdout);
  assert.equal(stderr, '');
  assert.deepEqual(received, Array.from({ length: 10 }, () => ['GET', '/file?sample=1']));
  assert.equal(sockets.size, 10);
  assert.equal(peakActive, 1);
  assert.equal(metrics.requests, 10);
  assert.equal(metrics.bytes, 61440);
  assert.ok(metrics.averageMs >= headerDelayMs + tailDelayMs - 5, `Average time: ${metrics.averageMs} ms`);
  assert.ok(metrics.averageMs * metrics.requests <= elapsedMs + 0.005);

  const mebibytes = metrics.bytes / 1048576;
  const fastest = mebibytes / ((metrics.averageMs - 0.0005) * 10 / 1000);
  const slowest = mebibytes / ((metrics.averageMs + 0.0005) * 10 / 1000);
  assert.ok(metrics.speed >= slowest - 0.0000005 && metrics.speed <= fastest + 0.0000005);
});

test('reports zero downloaded bytes and zero speed for empty responses', async (t) => {
  const url = await serve(t, (_, response) => response.writeHead(204).end());
  const { stdout } = await runCli(url);
  const { bytes, speed } = readMetrics(stdout);
  assert.equal(bytes, 0);
  assert.equal(speed, 0);
});

test('validates PNG on all ten responses without Content-Length', async (t) => {
  const encodings = [];
  const url = await serve(t, (request, response) => {
    encodings.push(request.headers['accept-encoding']);
    response.write(png.subarray(0, 12));
    response.end(png.subarray(12));
  });

  const { stdout } = await runCli(url, '--format', 'png');
  assert.deepEqual(encodings, Array(10).fill('identity'));
  assert.equal(readMetrics(stdout).bytes, 10 * png.length);
});

test('detects damaged PNG image data on the ninth response', async (t) => {
  const corrupt = Buffer.from(png);
  corrupt[corrupt.indexOf('IDAT') + 7] ^= 1;
  let requests = 0;
  const url = await serve(t, (_, response) => {
    requests += 1;
    response.setHeader('Content-Length', png.length);
    response.end(requests === 9 ? corrupt : png);
  });

  await expectFailure([url, '--format', 'png'], /Request 9 failed: invalid PNG/);
  assert.equal(requests, 9);
});

test('rejects a PNG without IEND despite a correctly framed HTTP body', async (t) => {
  const truncated = png.subarray(0, -12);
  const url = await serve(t, (_, response) => {
    response.setHeader('Content-Length', truncated.length);
    response.end(truncated);
  });

  await expectFailure([url, '--format', 'png'], /Request 1 failed: invalid PNG/);
});

test('rejects HTML labeled as a PNG', async (t) => {
  const url = await serve(t, (_, response) => {
    response.writeHead(200, { 'Content-Type': 'image/png' }).end('<h1>Error</h1>');
  });

  await expectFailure([url, '--format', 'png'], /Request 1 failed: invalid PNG/);
});

test('rejects PNG image data that cannot be decoded even with matching CRCs', async (t) => {
  const undecodable = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQAAAAAAAAAAAAAAAAAQvdO+gAAAABJRU5ErkJggg==', 'base64');
  const url = await serve(t, (_, response) => response.end(undecodable));

  await expectFailure([url, '--format', 'png'], /Request 1 failed: invalid PNG/);
});

test('rejects partial or HTTP-compressed responses in PNG mode', async (t) => {
  const partial = await serve(t, (_, response) => response.writeHead(206).end(png));
  await expectFailure([partial, '--format', 'png'], /Request 1 failed: HTTP 206/);

  const encoded = await serve(t, (_, response) => {
    response.writeHead(200, { 'Content-Encoding': 'gzip' }).end(png);
  });
  await expectFailure([encoded, '--format', 'png'], /Request 1 failed: PNG validation requires an unencoded response/);
});

test('finishes a download that exceeds the idle timeout while headers and chunks keep arriving', async (t) => {
  let requests = 0;
  const url = await serve(t, async (_, response) => {
    requests += 1;
    if (requests === 1) {
      await delay(350);
      response.flushHeaders();
      await delay(350);
      response.write('a');
      await delay(350);
    }
    response.end('b');
  });

  const { stdout } = await runCliWithShortTimeout(url);
  assert.equal(requests, 10);
  assert.equal(readMetrics(stdout).bytes, 11);
});

test('aborts idle requests before headers and during the body', async (t) => {
  for (const startBody of [false, true]) {
    let requests = 0;
    const url = await serve(t, (_, response) => {
      requests += 1;
      if (startBody) response.write('partial');
    });

    await assert.rejects(runCliWithShortTimeout(url), {
      code: 1,
      stdout: '',
      stderr: /Request 1 failed: timed out after 60 seconds without response progress/,
    });
    assert.equal(requests, 1);
  }
});

test('rejects missing, extra, malformed, and non-HTTP arguments', async () => {
  for (const args of [[], ['http://example.com', 'extra'], ['not a URL'], ['file:///tmp/file']]) {
    await expectFailure(args, /Usage:/);
  }
});

test('stops after an HTTP error and discards metrics from earlier successes', async (t) => {
  let requests = 0;
  const url = await serve(t, (_, response) => {
    requests += 1;
    if (requests === 3) {
      response.writeHead(404).end('Missing');
      return;
    }
    response.end('Available');
  });
  await expectFailure([url], /Request 3 failed: HTTP 404/);
  assert.equal(requests, 3);
});

test('rejects a redirect without requesting its destination', async (t) => {
  let requests = 0;
  const url = await serve(t, (_, response) => {
    requests += 1;
    response.writeHead(302, { Location: '/redirected' }).end();
  });
  await expectFailure([url], /HTTP 302/);
  assert.equal(requests, 1);
});

test('rejects an unsolicited protocol upgrade as an HTTP error', async (t) => {
  const url = await serve(t, (_, response) => {
    response.writeHead(101, { Connection: 'Upgrade', Upgrade: 'websocket' }).end();
  });
  await expectFailure([url], /HTTP 101/);
});

test('rejects a response whose connection closes before the whole body arrives', async (t) => {
  let requests = 0;
  const url = await serve(t, (_, response) => {
    requests += 1;
    response.writeHead(200, { 'Content-Length': 1024 });
    response.write(Buffer.alloc(512), () => response.destroy());
  });
  await expectFailure([url], /Request 1 failed/);
  assert.equal(requests, 1);
});
