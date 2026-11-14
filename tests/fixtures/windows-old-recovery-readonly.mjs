// Replays a private copy of a pending transaction. Native task queries are read-only;
// proxy and registry actions are simulated and every other native command is refused.
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const { default: helper } = await import(pathToFileURL(process.argv[2]).href);
const originalPath = process.env.LAIXIN_W01_ORIGINAL_MARKER;
const cloneRoot = process.env.LAIXIN_W01_CLONE_ROOT;
if (!originalPath || !cloneRoot) throw new Error('MISSING_FIXTURE_PATH');
const original = readFileSync(originalPath);
const hash = value => createHash('sha256').update(value).digest('hex');
const originalHash = hash(original);
const marker = JSON.parse(original.toString('utf8'));
if (marker.tasks?.[0]?.state !== 'disabled' || marker.tasks?.[1]?.state !== 'missing') {
  throw new Error('UNEXPECTED_SNAPSHOT_STATES');
}
const directory = join(cloneRoot, `clone-${randomUUID()}`);
mkdirSync(directory);
const markerPath = join(directory, 'windows-preflight-recovery.json');
marker.markerPath = markerPath;
marker.tasks = marker.tasks.map(task => ({ task: task.task, state: task.state,
  xml: task.state === 'missing' ? '' : '<Task><Settings><Enabled>false</Enabled></Settings></Task>' }));
writeFileSync(markerPath, JSON.stringify(marker));
writeFileSync(join(directory, 'windows-preflight-recovery.armed'), JSON.stringify({ version: 1, transactionId: marker.transactionId }));

const observed = [];
async function safeRunner(file, args, options) {
  const index = args.indexOf('-EncodedCommand');
  const script = index < 0 ? '' : Buffer.from(args[index + 1], 'base64').toString('utf16le');
  if (script.includes('LAIXIN_TASK_XML_QUERY') || script.includes('LAIXIN_TASK_EXISTENCE_QUERY')) {
    const result = await helper.runNative(file, args, options);
    observed.push({ kind: script.includes('LAIXIN_TASK_XML_QUERY') ? 'task-xml' : 'task-exists', code: result.code });
    return result;
  }
  if (script.includes('LAIXIN_PROXY_FALLBACK') || script.includes('LAIXIN_RECOVERY_REGISTER') ||
      script.includes('LAIXIN_RECOVERY_UNREGISTER')) {
    observed.push({ kind: script.includes('LAIXIN_PROXY_FALLBACK') ? 'proxy-simulated' : 'registry-simulated', code: 0 });
    return { code: 0, stdout: '', stderr: '' };
  }
  observed.push({ kind: 'unapproved-command-refused', code: null });
  throw new Error('UNAPPROVED_COMMAND_REFUSED');
}

(async () => {
  let outcome = 'completed';
  try {
    await helper.recoverWindowsPreflight(markerPath, safeRunner, marker.transactionId, async () => async () => {});
  } catch (error) {
    outcome = error instanceof Error ? error.message.split(':')[0] : 'unexpected-error';
  }
  const result = { outcome, originalUnchanged: hash(readFileSync(originalPath)) === originalHash,
    originalStillPresent: existsSync(originalPath), cloneMarkerRemaining: existsSync(markerPath), observed };
  const output = `${JSON.stringify(result)}\n`;
  if (process.env.LAIXIN_W01_TEST_OUTPUT) writeFileSync(process.env.LAIXIN_W01_TEST_OUTPUT, output);
  process.stdout.write(output);
})().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
