// Exercises the actual recovery launcher's task lookup without running recovery or changing Windows state.
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { win32 } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const helperPath = process.argv[2];
const { default: helper } = await import(pathToFileURL(helperPath).href);
const source = readFileSync(helperPath, 'utf8');
const start = source.indexOf('function Get-RecoveryTask(');
const end = source.indexOf('function Disabled-TaskXml(', start);
if (start < 0 || end <= start) throw new Error('RECOVERY_TASK_LOOKUP_NOT_FOUND');
const lookup = source.slice(start, end);
const missing = `LaixinW01Lookup-${randomUUID()}`;
const powershell = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

async function probe(name, prefix, taskPath, taskName, expectedCode) {
  const script = `$ErrorActionPreference='Stop';\n${prefix}\n${lookup}\ntry { $task=Get-RecoveryTask '${taskPath}' '${taskName}'; if($null -eq $task){exit 3};exit 0 } catch {exit 2}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = await helper.runNative(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeoutMs: 10000 });
  return { name, code: result.code, timedOut: result.timedOut === true, passed: result.code === expectedCode && result.timedOut !== true };
}

(async () => {
  const denied = "function Get-ScheduledTask { throw [System.UnauthorizedAccessException]::new('denied') }\n" +
    "function New-Object { throw [System.UnauthorizedAccessException]::new('denied') }";
  const accountError = "function Get-ScheduledTask { throw [System.Runtime.InteropServices.COMException]::new('account',-2147216625) }\n" +
    "function New-Object { throw [System.Runtime.InteropServices.COMException]::new('account',-2147216625) }";
  const results = [
    await probe('missing-root', '', '\\', missing, 3),
    await probe('missing-nested', '', '\\Laixin\\', missing, 3),
    await probe('access-denied', denied, '\\', missing, 2),
    await probe('account-information-missing', accountError, '\\', missing, 2)
  ];
  if (process.env.LAIXIN_W01_TEST_EXISTING === '1') {
    results.push(await probe('existing-nested', '', '\\Laixin\\', 'cn.laixin.toolbox.tunnel', 0));
  }
  const passed = results.every(result => result.passed);
  const output = `${JSON.stringify({ results, passed })}\n`;
  if (process.env.LAIXIN_W01_TEST_OUTPUT) writeFileSync(process.env.LAIXIN_W01_TEST_OUTPUT, output);
  process.stdout.write(output);
  if (!passed) process.exitCode = 1;
})().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
