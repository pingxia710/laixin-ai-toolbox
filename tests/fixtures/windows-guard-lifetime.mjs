import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

async function main() {
  const [helperPath, specPath] = process.argv.slice(2);
  const { default: helper } = await import(pathToFileURL(path.resolve(helperPath)).href);
  const spec = JSON.parse(await fs.readFile(specPath, 'utf8'));
  const processInfo = await helper.runNative(spec.powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${process.pid}').CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()`]);
  if (processInfo.code !== 0) throw new Error('WORKER_IDENTITY_QUERY_FAILED');
  const workerStarted = processInfo.stdout.trim();
  if (!/^\d{15,19}$/.test(workerStarted)) throw new Error('WORKER_IDENTITY_INVALID');
  const guardPid = await helper.defaultRecoveryGuardLauncher({
    ...spec,
    marker: { ownerPid: spec.ownerPid, ownerExecutable: spec.ownerExecutable,
      ownerStartFileTime: spec.ownerStarted, workerPid: process.pid,
      workerExecutable: process.execPath, workerStartFileTime: workerStarted }
  });
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      const ready = (await fs.readFile(spec.readyPath, 'utf8')).trim();
      if (ready === `${spec.transactionId}:${guardPid}`) break;
    } catch { /* Guard is still checking the held process handles. */ }
    if (Date.now() > deadline) throw new Error('GUARD_NOT_READY');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await fs.writeFile(spec.workerReady, JSON.stringify({ pid: process.pid, guardPid }));
  if (spec.workerWait) {
    const releaseDeadline = Date.now() + 30_000;
    while (true) {
      try { await fs.access(spec.workerRelease); break; } catch { /* Controller releases this owned worker. */ }
      if (Date.now() > releaseDeadline) throw new Error('CONTROLLER_RELEASE_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
