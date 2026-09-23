; 来信 AI 工具箱 · NSIS 卸载钩子(electron-builder `nsis.include`)。
; 目的:卸载时把系统代理还给客户。工具箱连接期间把当前用户的 WinINET 代理指到本机中继
; (127.0.0.1:18080),正常退出由守护按账本还原;被强杀/断电后再卸载,注册表里就会留着一个
; 指向已不存在端口的代理 → 客户卸完永久断网,而且不知道要去哪里关。
;
; 0.5.0 起守护可以是「由系统看着的常驻」(每用户登录计划任务 cn.laixin.toolbox.tunnel),
; 所以这里的顺序变成硬的,反了就白做:
;   1) 先删登录任务 —— 任务还在的话,下面刚停掉的守护会被系统再拉起来,把代理又改回去;
;   2) 再停守护与内核 —— 守护是拿主程序当 node 跑的,内核是 xray.exe;
;   3) 再按账本逐项写回原值(含客户原有的代理/PAC);
;   4) 最后兜底:ProxyServer 仍指向 127.0.0.1:18080 就把 ProxyEnable 关掉,客户回到直连。
; 守护随包用 Electron 主程序当 node 跑(ELECTRON_RUN_AS_NODE=1);数据目录 = %APPDATA%\<产品名>\tunnel。
!macro customUnInstall
  ; 「升级/覆盖安装」与「真卸载」必须分开:NSIS 每次装新版都会先跑旧版卸载器,
  ; 一起删任务的话客户每升一次级就丢一次常驻(网络也就不再是「界面关了也在」)。
  ; 判据 = 命令行上有没有 --updated:安装器调旧卸载器时一定带(app-builder-lib
  ; templates/nsis/include/installUtil.nsh 的 `StrCpy $0 "$0 --updated"`),
  ; 本产品的 Windows 更新助手 resources\update-helper.ps1 也是用 `/S --updated` 调安装器;
  ; 客户从「应用和功能」里自己卸载时没有这个参数。
  ClearErrors
  ${GetParameters} $3
  ${GetOptions} $3 "--updated" $4
  ${If} ${Errors}
    StrCpy $5 "uninstall"
  ${Else}
    StrCpy $5 "update"
  ${EndIf}

  ; 1) 先删登录任务(只在真卸载时)。0.4.10 网络修复版起任务住在 \Laixin\ 子文件夹
  ;    (根文件夹任务非提升建不了,2026-09-14 真机实测);旧版可能留的根文件夹残账一并清,都 ⛔ 因删不掉而中断。
  ${If} $5 == "uninstall"
    nsExec::ExecToLog 'schtasks.exe /delete /tn "\Laixin\cn.laixin.toolbox.tunnel" /f'
    Pop $0
    nsExec::ExecToLog 'schtasks.exe /delete /tn "cn.laixin.toolbox.tunnel" /f'
    Pop $0
  ${EndIf}

  ; 2) 再停守护与内核。⛔ 指望它们自己优雅退出——还原不靠自觉,靠第 3 步按账本写回;
  ;    内核不停会一直占着 resources\xray\xray.exe,卸载连文件都删不掉。
  nsExec::ExecToLog 'taskkill.exe /f /im "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  nsExec::ExecToLog 'taskkill.exe /f /im "xray.exe"'
  Pop $0

  ; 3) 按账本还原(升级与真卸载都要做:升级时安装目录整个会被换掉,旧守护已经没了)
  ;    退出码要留着给第 4 步判断:守护的 restore 子命令 0 = 已还干净,65 = 还有未恢复项,
  ;    脚本不在/起不来 = 根本没跑。⛔ 像以前那样 Pop 完就丢。
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
  System::Call 'Kernel32::SetEnvironmentVariable(t "TOOLBOX_REAL_NETWORK_ADAPTER", t "1")'
  System::Call 'Kernel32::SetEnvironmentVariable(t "TOOLBOX_REAL_TERMINAL_ENVIRONMENT", t "1")'
  StrCpy $6 "not-run"
  ${If} ${FileExists} "$INSTDIR\resources\sidecar\win\tunnel-daemon.mjs"
    nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\sidecar\win\tunnel-daemon.mjs" restore --data-dir "$APPDATA\${PRODUCT_NAME}\tunnel" --adapter "$INSTDIR\resources\sidecar\win\managed-adapter.mjs"'
    Pop $0
    StrCpy $6 $0
  ${EndIf}

  ; 4) 兜底关代理。两条判据都变了,原来那条两头都不对:
  ;    · **只在还原没成功时开火**(比原来窄)。还原报 0 = 客户的原设置已经写回去了,
  ;      这时再动注册表就是在改客户自己的东西。
  ;    · **认口放宽到整个回环**(比原来宽)。原来是 `127.0.0.1:18` 前缀,只认 18 开头的口;
  ;      而入口候选表最后一项是 0 = 系统随便挑一个空闲口(固定候选全被占时走这条),
  ;      那时注册表里是个高位口,原判据认不出 → 客户卸完永久断网,而且工具箱已经没了没法修。
  ;      ⛔ 按「大概率撞不上」写判据。
  ;    取舍说明:万一那个回环代理其实是客户自己的(他装了别的代理软件),而我们又恰好还原失败,
  ;    我们只把 ProxyEnable 关掉、**⛔ 删他的 ProxyServer 值**——他的代理软件下次启动会自己写回去,
  ;    最坏是手动再开一次。另一边是「卸完永久断网且无法自救」。轻的那头可恢复,重的那头不可恢复。
  ${If} $6 != "0"
    ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" "ProxyServer"
    StrCpy $2 $1 10
    ${If} $2 == "127.0.0.1:"
    ${OrIf} $2 == "localhost:"
      WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" "ProxyEnable" 0
    ${EndIf}
  ${EndIf}
!macroend
; ---- 安装器钩子:换文件前先停常驻与网络进程(2026-09-15,Windows「点更新重启又换回旧版」)----
; 背景:0.5.5 客户端里的更新助手(update-helper.ps1)在调安装器前不停守护/内核;旧卸载器虽然会
; taskkill(上面的 customUnInstall),但「升级」分支 ⛔ 删任务——常驻任务每 1 分钟重入,守护可能在
; 「杀掉 → 新文件落盘」的窗口里被任务再拉起来,占住安装目录里的文件让静默安装失败,更新助手按设计
; 整目录还原旧版,客户看到「点了更新重启,又换回旧版」(2026-09-15 客户实测)。
; 顺序是硬的:先禁任务(⛔ 删——升级删任务 = 客户每升一级丢一次常驻,删除判断在 customUnInstall),
; 再杀守护(主程序当 node 跑)与内核 xray.exe。任务被禁不影响:新版/旧版启动时的「按开关校准常驻」
; 会按客户选择重装任务(Register-ScheduledTask -Force 顺带解禁);点连接的叫醒路径也会先 /change /enable。
; 首次安装没有任务也没有进程,这两步安静失败,与 customUnInstall 同一取舍。
; ⛔ 这里照搬卸载钩子的按映像名杀法:.onInit 阶段拿不到命令行过滤,靠「早于一切文件操作」兜底;
; 新客户端的助手已在调安装器前做过带路径限定的精准停进程(0.5.6-winupdate.1 起),那是正门,
; 这道是旧客户端升级那一跳的保险,两道都要。
!macro customInit
  nsExec::ExecToLog 'schtasks.exe /change /tn "\Laixin\cn.laixin.toolbox.tunnel" /disable'
  Pop $0
  nsExec::ExecToLog 'schtasks.exe /change /tn "cn.laixin.toolbox.tunnel" /disable'
  Pop $0
  nsExec::ExecToLog 'taskkill.exe /f /im "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  nsExec::ExecToLog 'taskkill.exe /f /im "xray.exe"'
  Pop $0
!macroend
