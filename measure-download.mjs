import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { performance } from 'node:perf_hooks';

const requestCount = 10;
const requestTimeoutMs = 60_000;

async function download(get, url, signal) {
  const response = await new Promise((resolve, reject) => {
    get(url, { signal }, resolve)
      .once('error', reject)
      .once('upgrade', (response, socket) => {
        socket.destroy();
        reject(new Error(`HTTP ${response.statusCode}`));
      });
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.destroy();
    throw new Error(`HTTP ${response.statusCode}`);
  }

  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
  }
  return bytes;
}

async function main(args) {
  const [address] = args;
  if (args.length !== 1 || !/^https?:\/\//i.test(address) || !URL.canParse(address)) {
    throw new Error('Usage: node measure-download.mjs <http(s)://host/path>');
  }

  const url = new URL(address);
  const get = url.protocol === 'https:' ? httpsGet : httpGet;
  let totalBytes = 0;
  let totalMs = 0;

  for (let attempt = 1; attempt <= requestCount; attempt += 1) {
    const signal = AbortSignal.timeout(requestTimeoutMs);
    const start = performance.now();
    try {
      totalBytes += await download(get, url, signal);
      totalMs += performance.now() - start;
    } catch (error) {
      const reason = signal.aborted ? 'timed out after 60 seconds' : error.message;
      throw new Error(`Request ${attempt} failed: ${reason}`);
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
