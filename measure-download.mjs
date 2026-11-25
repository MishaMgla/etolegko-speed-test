import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { performance } from 'node:perf_hooks';

const requestCount = 10;
const idleTimeoutMs = 60_000;
const maxPngBytes = 64 * 1_048_576;

async function download(get, url, checkPng) {
  const controller = new AbortController();
  const { signal } = controller;
  const timer = setTimeout(() => {
    controller.abort(new Error(`timed out after ${idleTimeoutMs / 1000} seconds without response progress`));
  }, idleTimeoutMs);

  try {
    const headers = checkPng ? { 'Accept-Encoding': 'identity' } : undefined;
    const response = await new Promise((resolve, reject) => {
      get(url, { agent: false, signal, headers }, resolve)
        .once('error', reject)
        .once('upgrade', (response, socket) => {
          socket.destroy();
          reject(new Error(`HTTP ${response.statusCode}`));
        });
    });

    if (response.statusCode < 200 || response.statusCode >= 300 || (checkPng && response.statusCode !== 200)) {
      response.destroy();
      throw new Error(`HTTP ${response.statusCode}`);
    }

    const encoding = response.headers['content-encoding'];
    if (checkPng && encoding && encoding.toLowerCase() !== 'identity') {
      response.destroy();
      throw new Error(`PNG validation requires an unencoded response, got ${encoding}`);
    }

    timer.refresh();
    const chunks = checkPng ? [] : null;
    let bytes = 0;
    for await (const chunk of response) {
      timer.refresh();
      bytes += chunk.length;
      if (chunks) {
        if (bytes > maxPngBytes) throw new Error('PNG exceeds the 64 MiB validation limit');
        chunks.push(chunk);
      }
    }
    return { bytes, chunks };
  } catch (error) {
    throw signal.reason ?? error;
  } finally {
    clearTimeout(timer);
  }
}

async function main(args) {
  const [address, option, format] = args;
  const checkPng = args.length === 3 && option === '--format' && format === 'png';
  if ((args.length !== 1 && !checkPng) || !/^https?:\/\//i.test(address) || !URL.canParse(address)) {
    throw new Error('Usage: node measure-download.mjs <http(s)://host/path> [--format png]');
  }

  const validator = checkPng ? await import('./validate-png.mjs') : null;
  const url = new URL(address);
  const get = url.protocol === 'https:' ? httpsGet : httpGet;
  let totalBytes = 0;
  let totalMs = 0;

  for (let attempt = 1; attempt <= requestCount; attempt += 1) {
    const start = performance.now();
    try {
      const { bytes, chunks } = await download(get, url, checkPng);
      const elapsedMs = performance.now() - start;
      if (validator) await validator.validatePng(Buffer.concat(chunks, bytes));
      totalBytes += bytes;
      totalMs += elapsedMs;
    } catch (error) {
      throw new Error(`Request ${attempt} failed: ${error.message}`);
    }
  }

  const averageMs = totalMs / requestCount;
  const speed = (totalBytes / 1_048_576) / (totalMs / 1000);

  console.log(`Requests: ${requestCount}`);
  console.log(`Average time: ${averageMs.toFixed(3)} ms`);
  console.log(`Total downloaded: ${totalBytes} bytes`);
  console.log(`Download speed: ${speed.toFixed(6)} MiB/s`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
