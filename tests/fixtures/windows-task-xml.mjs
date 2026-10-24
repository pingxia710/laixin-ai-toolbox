import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import process from 'node:process';
const [helperPath, task, expectedPath, resultPath] = process.argv.slice(2);
// Exercise the real private snapshot function without adding a production export.
const loaded = new Module(helperPath);
loaded.filename = helperPath;
loaded.paths = Module._nodeModulePaths(path.dirname(helperPath));
loaded._compile(fs.readFileSync(helperPath, 'utf8') + '\nmodule.exports.queryResidentTask = queryResidentTask;', helperPath);
const helper = loaded.exports;
helper.queryResidentTask(task, helper.runNative, path.win32.join(process.env.SystemRoot, 'System32', 'schtasks.exe'), Date.now() + 30000, Date.now)
  .then(snapshot => {
    const expected = fs.readFileSync(expectedPath, 'utf8').replace(/^\uFEFF/, '').trim();
    const result = { state: snapshot.state, exactXmlMatch: snapshot.xml.trim() === expected, preservesChinese: snapshot.xml.includes('中文任务路径'), xml: snapshot.xml };
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
    process.stdout.write(JSON.stringify({ state: result.state, exactXmlMatch: result.exactXmlMatch, preservesChinese: result.preservesChinese }) + '\n');
    process.exitCode = result.state === 'disabled' && result.exactXmlMatch && result.preservesChinese ? 0 : 1;
  }).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
