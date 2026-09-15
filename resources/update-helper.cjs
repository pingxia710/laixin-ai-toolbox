// Runs as a separate Node process so the app can finish its normal network cleanup before replacement.
const physicalFs = process.versions.electron ? require('original-fs') : require('node:fs');
const fs = physicalFs.promises;
const { createReadStream } = physicalFs;
const { createHash, randomUUID } = require('node:crypto');
const { dirname, join } = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const digest = async file => { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };
const cleanEnv = { ...process.env }; delete cleanEnv.ELECTRON_RUN_AS_NODE;
// 拿主程序当 node 跑的随包进程（守护、内核看门狗）的判据：参数里带 sidecar 目录下的 .mjs。
const RUNS_SIDECAR_SCRIPT = /(?:^|\s)\S*[/\\]sidecar[/\\]\S*\.mjs(?:\s|$)/;

async function run(job, commands = exec) {
  if (!Number.isSafeInteger(job.parentPid) || job.parentPid < 1 || job.platform !== 'mac' ||
      !/^\d+\.\d+\.\d+(?:-unified\.\d+)?$/.test(job.version) || !/^[a-f0-9]{64}$/.test(job.asarSha256) || !/^[a-f0-9]{64}$/.test(job.assetSha256)) throw new Error('INVALID_UPDATE_JOB');
  const result = value => fs.writeFile(job.result, JSON.stringify({ version: job.version, ...value }), { mode: 0o600 });
  const launch = async () => {
    const args = ['-n', '-a', job.target, '--args', `--user-data-dir=${job.userData}`];
    await commands('/usr/bin/open', args, { env: cleanEnv, timeout: 15_000 });
  };
  const appRunning = async () => {
    const { stdout } = await commands('/bin/ps', ['-axo', 'pid=,command=']);
    return stdout.split('\n').some(line => {
      const match = /^\s*(\d+) (.*)$/.exec(line);
      if (!match || Number(match[1]) === process.pid) return false;
      if (match[2] !== job.executable && !match[2].startsWith(job.executable + ' ')) return false;
      // 随包的守护与内核看门狗都是拿主程序当 node 跑的（ELECTRON_RUN_AS_NODE + sidecar 里的 .mjs），
      // 命令行前缀与主程序一模一样。常驻守护在界面退出后还活着，按前缀算就是「应用又被打开了」，
      // 每次更新都会停在 UPDATE_APP_REOPENED——装了常驻之后 mac 根本更新不了。这里把它们排掉：
      // 判据是参数里带着 sidecar 目录下的 .mjs，真正的应用进程 ⛔ 有这种参数。
      return !RUNS_SIDECAR_SCRIPT.test(match[2].slice(job.executable.length));
    });
  };
  await fs.rm(job.acknowledgement, { force: true });
  await fs.writeFile(job.ready, 'ready', { mode: 0o600 });
  const deadline = Date.now() + 30_000;
  while (alive(job.parentPid)) {
    if (Date.now() >= deadline) { await result({ state: 'error', message: '工具箱尚未完成退出，更新已取消。' }); return; }
    await pause(100);
  }
  let backup, next, swapped = false, stage = 'prepare';
  try {
    if ((await fs.stat(job.installer)).size !== job.assetSize || await digest(job.installer) !== job.assetSha256) throw new Error('UPDATE_ASSET_CHANGED');
    {
      const suffix = randomUUID();
      backup = join(dirname(job.target), `.laixin-previous-${suffix}.app`);
      next = join(dirname(job.target), `.laixin-next-${suffix}.app`);
      await commands('/usr/bin/ditto', [job.staged, next], { timeout: 120_000 });
      await commands('/usr/bin/codesign', ['--verify', '--deep', '--strict', next], { timeout: 60_000 });
      if (await digest(join(next, 'Contents', 'Resources', 'app.asar')) !== job.asarSha256) throw new Error('UPDATE_STAGE_CHANGED');
      // 新包已验完、马上要换 bundle：这时候才停常驻守护，验不过的包 ⛔ 白白把客户的网停一次。
      await handOffResident(job, commands);
      if (await appRunning()) throw new Error('UPDATE_APP_REOPENED');
      stage = 'replace';
      await fs.rename(job.target, backup);
      try { await fs.rename(next, job.target); swapped = true; }
      catch (error) { await fs.rename(backup, job.target); throw error; }
    }
    stage = 'launch';
    await launch();
    stage = 'startup';
    // 等回执的上限由主进程按「更新前客户连着没有」定:没连着照旧 45 秒;连着的要容下
    // 「新版起来 → 装常驻 → 首连(守护自己还有 42 秒的退避梯子)」,再留时间给新版让台。
    const startupDeadline = Date.now() + (Number.isSafeInteger(job.startupTimeoutMs) && job.startupTimeoutMs > 0 ? job.startupTimeoutMs : 45_000);
    let started = false;
    while (Date.now() < startupDeadline) {
      try { started = JSON.parse(await fs.readFile(job.acknowledgement, 'utf8')).version === job.version; } catch { /* Startup has not acknowledged yet. */ }
      if (started) break;
      await pause(200);
    }
    if (!started) throw new Error('UPDATE_STARTUP_UNCONFIRMED');
    // Keep the previous application as a recoverable update backup, never touch user account/config data.
    if (backup) {
      const retained = join(dirname(job.result), `previous-${Date.now()}.app`);
      try { await fs.rename(backup, retained); backup = retained; } catch { /* The old app stays at its same-volume backup path. */ }
      await pruneOldBackups(dirname(job.result), backup);
    }
    await result({ state: 'complete', message: '工具箱已更新，账号和配置已保留。', backup: backup ?? '' });
    await fs.rm(join(dirname(job.result), 'pending.json'), { force: true });
  } catch {
    if (swapped && backup) {
      // A slow but running new app must not be moved underneath its process.
      // 新版「起来了但连不上」时会自己退出让台(它不写回执、先记下这一版别再自动装),
      // 而退出要几秒。⛔ 只看一眼就定:那会把本该回退的这一次判成「进程还在」,客户留在连不上的新版上。
      let running = true;
      try {
        const waitUntil = Date.now() + 10_000;
        do { running = await appRunning(); if (!running) break; await pause(250); } while (Date.now() < waitUntil);
      } catch { /* Unknown process state keeps both copies in place. */ }
      if (running) {
        await result({ state: 'error', message: '新版启动尚未确认，原程序副本已保留。', stage, backup });
        return;
      }
      try {
        await fs.rename(job.target, join(dirname(job.target), `.laixin-failed-${Date.now()}.app`));
        await fs.rename(backup, job.target);
      } catch { /* Preserve both copies for recovery if replacement is denied. */ }
    }
    await result({ state: 'error', message: '更新未完成，已保留原程序和账号配置，请重试。', stage, backup: backup ?? '' });
    try { await launch(); } catch { /* Result remains readable on the next manual launch. */ }
  }
}

// 更新时的常驻交接（0.5.0）。
//
// mac 是原地换 bundle：路径不变，所以 LaunchAgent 里的路径换完还是对的。真正会出事的是**跑着的那个守护**——
// 它是旧版的代码，换完 bundle 之后再去起内核，拿到的是新版的 xray-runner 与内核；两个版本混着跑，
// 而且客户更新完永远还用着旧守护（它不退出就永远不换代）。所以按派题里「更新前先停常驻」那条走：
//   1) 先把「客户本来是连着的」这件事记下来（resume-on-launch 标记，tunnel-service 认这个）——
//      因为下一步 bootout 会让守护按正常关停流程把意图写成 shutdown，不先记就变成「更新完不再连」；
//   2) launchctl bootout：给守护发 SIGTERM，它走完整还原后退出（0），系统 ⛔ 再拉起；
//   3) 换 bundle、起新版；新版启动时按 resume 标记接着连，并重新装上常驻。
// 全程 ⛔ 抛异常：常驻停不掉也要让更新继续（最坏是旧守护活到下次重启），⛔ 因为这一步把更新卡死。
async function handOffResident(job, commands) {
  const outcome = { resumeMarked: false, stopped: false };
  if (job.platform !== 'mac') return outcome;
  if (typeof job.tunnelDataDir === 'string' && job.tunnelDataDir !== '') {
    // 「客户本来是连着的」以工具箱退出前拍下的那一眼为准（job.tunnelResume）：等到这里，工具箱自己的
    // 退出流程可能已经把意图文件改成 shutdown 了。再读一次文件只是兜底（快照没拍到时还有一次机会）。
    let resume = job.tunnelResume === true;
    if (!resume) {
      try { resume = JSON.parse(await fs.readFile(join(job.tunnelDataDir, 'intent.json'), 'utf8')).desired === 'connected'; }
      catch { /* 没有意图文件 = 客户本来就没连着，更新完也不该自己连上。 */ }
    }
    if (resume) {
      try {
        await fs.writeFile(join(job.tunnelDataDir, 'resume-on-launch'), `${JSON.stringify({ at: Date.now() })}\n`, { mode: 0o600 });
        outcome.resumeMarked = true;
      } catch { /* 标记写不进去,最坏是客户更新完要自己点一次连接 ⛔ 因此把更新卡死。 */ }
    }
  }
  if (typeof job.residentLabel === 'string' && job.residentLabel !== '') {
    try {
      // bootout 会等服务真的停掉再返回（超时才 SIGKILL），所以这里不用再自己轮询守护进程。
      await commands('/usr/bin/launchctl', ['bootout', `gui/${String(process.getuid ? process.getuid() : 0)}/${job.residentLabel}`], { timeout: 40_000 });
      outcome.stopped = true;
    } catch { /* 没装常驻、或已经停了：bootout 一律报错，这里不是失败。 */ }
  }
  return outcome;
}

// 更新成功确认后只保留最近一份可回退备份,⛔ previous-*.app 随更新次数无限累积。
async function pruneOldBackups(directory, keep) {
  try {
    const entries = await fs.readdir(directory);
    const stampOf = name => Number(/^previous-(\d+)\.app$/.exec(name)[1]);
    const backups = entries.filter(name => /^previous-\d+\.app$/.test(name)).sort((left, right) => stampOf(left) - stampOf(right));
    for (const name of backups.slice(0, -1)) await fs.rm(join(directory, name), { recursive: true, force: true });
    void keep;
  } catch { /* 清理失败不影响本次更新结果。 */ }
}

if (require.main === module) {
  fs.readFile(process.argv[2], 'utf8').then(JSON.parse).then(run).catch(() => { process.exitCode = 1; });
}
module.exports = { run, pruneOldBackups, handOffResident };
