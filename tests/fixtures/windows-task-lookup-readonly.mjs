// Runs the real preflight lookup against Windows without creating, changing or deleting tasks.
// Every native command except the two task-read scripts is stopped before execution.
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { win32 } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const { default: helper } = await import(pathToFileURL(process.argv[2]).href);
const label = process.argv[3] || `LaixinW01Lookup-${randomUUID()}`;
const expected = process.argv[4] || 'missing';
const boundary = 'STOP_BEFORE_MUTATION';
const observed = [];
const target = win32.join(process.env.TEMP, 'LaixinW01ReadOnlySentinel');

async function readOnlyRunner(file, args, options) {
  const index = args.indexOf('-EncodedCommand');
  const script = index < 0 ? '' : Buffer.from(args[index + 1], 'base64').toString('utf16le');
  if (expected === 'com-account-error' && script.includes('LAIXIN_TASK_COM_QUERY')) {
    const injected = script.replace(/\$folder=\$service\.GetFolder\([^;]+;/,
      "throw [System.Runtime.InteropServices.COMException]::new('account',-2147216625);");
    if (injected === script) throw new Error('FAULT_INJECTION_NOT_APPLIED');
    const faultArgs = [...args];
    faultArgs[index + 1] = Buffer.from(injected, 'utf16le').toString('base64');
    const fault = await helper.runNative(file, faultArgs, options);
    observed.push({ kind: 'com-account-error', code: fault.code, timedOut: fault.timedOut === true });
    throw new Error(boundary);
  }
  const kind = script.includes('LAIXIN_TASK_XML_QUERY') ? 'xml'
    : script.includes('LAIXIN_TASK_EXISTENCE_QUERY') ? 'exists' : '';
  if (!kind) throw new Error(boundary);
  const result = await helper.runNative(file, args, options);
  observed.push({ kind, code: result.code, timedOut: result.timedOut === true });
  if (kind === 'exists' && !observed.some(item => item.kind === 'account-error')) {
    // Account information missing is not proof that a scheduled task is absent.
    const prefix = "function Get-ScheduledTask { throw [System.Runtime.InteropServices.COMException]::new('account',-2147216625) }\n" +
      "function New-Object { throw [System.Runtime.InteropServices.COMException]::new('account',-2147216625) }\n";
    const faultArgs = [...args];
    faultArgs[index + 1] = Buffer.from(prefix + script, 'utf16le').toString('base64');
    const fault = await helper.runNative(file, faultArgs, options);
    observed.push({ kind: 'account-error', code: fault.code, timedOut: fault.timedOut === true });
  }
  if (expected === 'mixed' && kind === 'exists') throw new Error(boundary);
  return result;
}

(async () => {
  let outcome = 'unexpected-success';
  try {
    await helper.windowsPreflight({
      mode: expected === 'com-account-error' ? 'uninstall' : 'update',
      target, executable: win32.join(target, 'absent.exe'), residentLabel: label
    }, readOnlyRunner);
  } catch (error) {
    outcome = error instanceof Error ? error.message : String(error);
  }
  const xml = observed.filter(item => item.kind === 'xml');
  const exists = observed.filter(item => item.kind === 'exists');
  const accountError = observed.find(item => item.kind === 'account-error');
  const expectedCodes = expected === 'mixed' ? [0, 1] : [1, 1];
  const passed = expected === 'com-account-error'
    ? outcome === boundary && observed.length === 1 && observed[0].code === 2 && !observed[0].timedOut
    : outcome === boundary && xml.length === 2 &&
    xml.every((item, index) => item.code === expectedCodes[index] && !item.timedOut) &&
    exists.length === (expected === 'mixed' ? 1 : 2) &&
    exists.every(item => item.code === 3 && !item.timedOut) &&
    accountError?.code === 2 && !accountError.timedOut;
  const result = `${JSON.stringify({ expected, outcome, observed, passed })}\n`;
  if (process.env.LAIXIN_W01_TEST_OUTPUT) writeFileSync(process.env.LAIXIN_W01_TEST_OUTPUT, result);
  process.stdout.write(result);
  if (!passed) process.exitCode = 1;
})().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
