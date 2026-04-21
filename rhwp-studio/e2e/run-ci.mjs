import { spawn } from 'node:child_process';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const preferredPort = Number(process.env.VITE_PORT || '7700');

function spawnCommand(args, extraEnv = {}) {
  return spawn(npmCmd, args, {
    cwd: studioRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
}

function waitForExit(child, signal) {
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill(signal);
  });
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode) {
    return;
  }
  await Promise.race([
    waitForExit(child, 'SIGTERM'),
    delay(5000).then(async () => {
      if (child.exitCode === null && !child.signalCode) {
        await waitForExit(child, 'SIGKILL');
      }
    }),
  ]);
}

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`server responded with status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }

  throw lastError ?? new Error(`timed out waiting for ${url}`);
}

async function findAvailablePort(startPort, attempts = 20) {
  for (let port = startPort; port < startPort + attempts; port += 1) {
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true));
      });
    });
    if (available) {
      return port;
    }
  }
  throw new Error(`failed to find an available port starting at ${startPort}`);
}

async function runSuite(serverUrl) {
  const child = spawnCommand(['run', 'e2e:headless'], { VITE_URL: serverUrl });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`e2e suite terminated by signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) {
    throw new Error(`e2e suite failed with exit code ${exitCode}`);
  }
}

const serverPort = await findAvailablePort(preferredPort);
const serverUrl = process.env.VITE_URL || `http://127.0.0.1:${serverPort}`;
const devServer = spawnCommand(
  ['run', 'dev', '--', '--host', '0.0.0.0', '--port', String(serverPort), '--strictPort'],
  { BROWSER: 'none' },
);

try {
  await waitForServer(serverUrl);
  await runSuite(serverUrl);
} finally {
  await stopServer(devServer);
}
