// 模拟 `claude auth login`：打印授权链接 → 要求粘登录码 → 收到后打印成功；mode=exit 则直接退出交给状态核实。
// docs-first＝先打印一条帮助/文档链接再打印真正的授权链接（审查发现的形态隐患）。
// domain-only-fail / domain-only-hang / domain-only-silent＝整场只出现同域名但路径形态对不上的链接
// （fail＝随即失败退出；hang＝照常问码等粘码；silent＝什么都不问，吊着）。
import readline from 'node:readline'
import process from 'node:process'
import { setInterval } from 'node:timers'
const mode = process.argv.includes('exit') ? 'exit'
  : process.argv.includes('bad') ? 'bad'
  : process.argv.includes('docs-first') ? 'docs-first'
  : process.argv.includes('domain-only-fail') ? 'domain-only-fail'
  : process.argv.includes('domain-only-hang') ? 'domain-only-hang'
  : process.argv.includes('domain-only-silent') ? 'domain-only-silent'
  : process.argv.includes('domain-only-chatty') ? 'domain-only-chatty'
  : 'ready'
if (mode === 'docs-first') {
  process.stdout.write('See https://docs.anthropic.com/en/docs/claude-code/troubleshooting for help before continuing.\n')
  process.stdout.write('If the browser does not open, visit: https://claude.ai/oauth/authorize?client_id=test&state=abc\n')
  setTimeout(() => process.stdout.write('\nLogin successful. You are now logged in.\n'), 30)
} else if (mode === 'domain-only-fail' || mode === 'domain-only-hang' || mode === 'domain-only-silent' || mode === 'domain-only-chatty') {
  process.stdout.write('If the browser does not open, visit: https://claude.ai/login?client_id=test&state=abc\n')
  if (mode === 'domain-only-silent') setTimeout(() => process.exit(0), 60_000) // 保活：既不问码也不退出，等保险计时或父进程来收
  // chatty＝真实 CLI 的形态：挂在伪终端上持续刷新（转圈、“等待授权中…”），同一窗口里那条链接一直被重扫。
  if (mode === 'domain-only-chatty') setInterval(() => process.stdout.write('Waiting for authorization…\r\n'), 50)
} else {
  process.stdout.write('\u001b[1mOpening browser…\u001b[0m\nIf the browser does not open, visit: https://claude.ai/oauth/authorize?client_id=test&state=abc\n')
}
if (mode === 'exit') { setTimeout(() => process.exit(0), 20) }
else if (mode === 'domain-only-fail') {
  setTimeout(() => { process.stdout.write('\nLogin failed: server said no\n'); process.exit(1) }, 30)
} else if (mode === 'ready' || mode === 'bad' || mode === 'domain-only-hang') {
  // 只有这三种问码：hang＝域名兜底夹具也要走「问码」这条触发路径。
  setTimeout(() => process.stdout.write('Paste code here if prompted > '), 20)
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (mode === 'bad' || line.trim() !== 'code-1234') { process.stdout.write('\nLogin failed: invalid code\n'); process.exit(1) }
    process.stdout.write('\nLogin successful. You are now logged in.\n'); process.exit(0)
  })
}
