import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { performance } from 'node:perf_hooks';

const requestCount = 10;
const idleTimeoutMs = 60_000;

async function download(get, url, validator, requirePng) {
  const controller = new AbortController();
  const { signal } = controller;
  const timer = setTimeout(() => {
    controller.abort(new Error(`timed out after ${idleTimeoutMs / 1000} seconds without response progress`));
  }, idleTimeoutMs);

  try {
    const headers = validator ? { 'Accept-Encoding': 'identity' } : undefined;
    const response = await new Promise((resolve, reject) => {
      get(url, { agent: false, signal, headers }, resolve)
        .once('error', reject)
        .once('upgrade', (response, socket) => {
          socket.destroy();
          reject(new Error(`HTTP ${response.statusCode}`));
        });
    });

    if (response.statusCode < 200 || response.statusCode >= 300 || (requirePng && response.statusCode !== 200)) {
      response.destroy();
      throw new Error(`HTTP ${response.statusCode}`);
    }

    const encoding = response.headers['content-encoding'];
    const encoded = encoding && encoding.toLowerCase() !== 'identity';
    if (requirePng && encoded) {
      response.destroy();
      throw new Error(`PNG validation requires an unencoded response, got ${encoding}`);
    }
    let skipReason;
    if (response.statusCode !== 200) skipReason = `HTTP ${response.statusCode}`;
    else if (encoded) skipReason = 'HTTP content encoding';

    timer.refresh();
    const image = validator?.collectImage(requirePng, skipReason);
    let bytes = 0;
    for await (const chunk of response) {
      timer.refresh();
      bytes += chunk.length;
      image?.add(chunk);
    }
    return { bytes, image };
  } catch (error) {
    throw signal.reason ?? error;
  } finally {
    clearTimeout(timer);
  }
}

async function main(args) {
  const [address, option, format] = args;
  const requirePng = args.length === 3 && option === '--format' && format === 'png';
  const autoValidate = args.length === 2 && option === '--validate';
  if ((args.length !== 1 && !requirePng && !autoValidate) || !/^https?:\/\//i.test(address) || !URL.canParse(address)) {
    throw new Error('Usage: node measure-download.mjs <http(s)://host/path> [--validate | --format png]');
  }

  const validator = requirePng || autoValidate ? await import('./validate-image.mjs') : null;
  const url = new URL(address);
  const get = url.protocol === 'https:' ? httpsGet : httpGet;
  let totalBytes = 0;
  let totalMs = 0;
  const formats = new Set();
  const skipReasons = new Set();
  let verified = 0;

  for (let attempt = 1; attempt <= requestCount; attempt += 1) {
    const start = performance.now();
    try {
      const { bytes, image } = await download(get, url, validator, requirePng);
      const elapsedMs = performance.now() - start;
      if (image) {
        const result = await image.finish();
        if (result.format) {
          verified += 1;
          formats.add(result.format);
        } else {
          skipReasons.add(result.reason);
        }
      }
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
  if (autoValidate) {
    const formatList = formats.size ? ` (${[...formats].join(', ')})` : '';
    const reasonList = skipReasons.size ? ` (${[...skipReasons].join(', ')})` : '';
    console.log(`Validation: ${verified}/${requestCount} verified${formatList}; ${requestCount - verified} not verified${reasonList}`);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
