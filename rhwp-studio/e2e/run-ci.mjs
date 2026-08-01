import { spawn } from 'node:child_process';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const preferredPort = Number(process.env.VITE_PORT || '7700');
const defaultSuiteTimeoutMs = process.env.RHWP_RENDER_SAMPLE_SCOPE === 'full'
  ? 120 * 60 * 1000
  : 30 * 60 * 1000;
const suiteTimeoutMs = (() => {
  const parsed = Number.parseInt(process.env.RHWP_E2E_CI_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultSuiteTimeoutMs;
})();

function spawnCommand(args, extraEnv = {}) {
  return spawn(npmCmd, args, {
    cwd: studioRoot,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
}

function signalProcessTree(child, signal) {
  if (child.exitCode !== null || child.signalCode) {
    return;
  }
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return;
    }
    try {
      child.kill(signal);
    } catch (fallbackError) {
      if (fallbackError?.code !== 'ESRCH') {
        throw fallbackError;
      }
    }
  }
}

function waitForExitAfterSignal(child, signal) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    signalProcessTree(child, signal);
  });
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode) {
    return;
  }
  await Promise.race([
    waitForExitAfterSignal(child, 'SIGTERM'),
    delay(5000).then(async () => {
      if (child.exitCode === null && !child.signalCode) {
        await waitForExitAfterSignal(child, 'SIGKILL');
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
  let timeoutId;
  let timedOut = false;
  const exitPromise = new Promise((resolve, reject) => {
    child.once('error', (error) => {
      if (!timedOut) {
        reject(error);
      }
    });
    child.once('exit', (code, signal) => {
      if (timedOut) {
        return;
      }
      if (signal) {
        reject(new Error(`e2e suite terminated by signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      stopProcess(child)
        .then(() => reject(new Error(`e2e suite timed out after ${suiteTimeoutMs}ms`)))
        .catch(reject);
    }, suiteTimeoutMs);
  });
  const exitCode = await Promise.race([
    exitPromise,
    timeoutPromise,
  ]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
  if (exitCode !== 0) {
    throw new Error(`e2e suite failed with exit code ${exitCode}`);
  }
}

function registerShutdown(devServer) {
  const stopAndExit = (signal) => {
    stopProcess(devServer)
      .finally(() => {
        process.kill(process.pid, signal);
      });
  };

  process.once('SIGINT', stopAndExit);
  process.once('SIGTERM', stopAndExit);
}

const serverPort = await findAvailablePort(preferredPort);
const serverUrl = process.env.VITE_URL || `http://127.0.0.1:${serverPort}`;
const devServer = spawnCommand(
  ['run', 'dev', '--', '--host', '0.0.0.0', '--port', String(serverPort), '--strictPort'],
  { BROWSER: 'none' },
);
registerShutdown(devServer);

try {
  await waitForServer(serverUrl);
  await runSuite(serverUrl);
} finally {
  await stopProcess(devServer);
}
