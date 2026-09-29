; 来信 AI 工具箱 · NSIS 卸载钩子(electron-builder `nsis.include`)。
; 目的:卸载时把系统代理还给客户。工具箱连接期间把当前用户的 WinINET 代理指到本机中继
; (127.0.0.1:18080),正常退出由守护按账本还原;被强杀/断电后再卸载,注册表里就会留着一个
; 指向已不存在端口的代理 → 客户卸完永久断网,而且不知道要去哪里关。
;
; 0.5.0 起守护可以是「由系统看着的常驻」(每用户登录计划任务 cn.laixin.toolbox.tunnel),
; 所以这里的顺序变成硬的,反了就白做:
;   1) 先收敛新旧登录任务 —— 真卸载删除，升级停用，并逐个回读确认;
;   2) 再按当前安装路径停守护与内核 —— 守护是拿主程序当 node 跑的,内核是 xray.exe;
;   3) 再按账本逐项写回原值(含客户原有的代理/PAC);
;   4) 最后兜底:只有账本确认来信写入且本机端口已死才关 ProxyEnable；归属不明则保留现场。
; 守护随包用 Electron 主程序当 node 跑(ELECTRON_RUN_AS_NODE=1);数据目录 = %APPDATA%\<产品名>\tunnel。

; 真卸载前置闸使用「本次安装包内嵌的」update-helper.cjs，不依赖旧安装目录里的版本。
; 0.6.1 更新助手会在调用新安装器前完成持久化 preflight，并把安装目录交接标记传入子进程。
; customInit 只放行能用恢复事务、owner 身份、任务与进程状态重新验证的交接；
; 直接手工覆盖或任何缺失证据的历史版本仍失败关闭。旧卸载器虽会被 electron-builder 复制执行，
; 但同一安装进程树内会复用这份已验证 handoff，不再二次拍已 Disabled 的错误快照。
!define LAIXIN_PREFLIGHT_HANDOFF_ENV "LAIXIN_PREFLIGHT_HANDOFF_TARGET"

; 真卸载在 electron-builder 的入口钩子内先禁常驻任务并停进程。等到删除文件前的
; customUnInstall 才做这件事时，现场的 Un_A 可能长时间停在该入口与 Section 之间。
; 安装器不定义此宏，仍使用 electron-builder 自带的进程检查。
!ifdef BUILD_UNINSTALLER
Var /GLOBAL laixinEarlyUninstallPreflight
Var /GLOBAL laixinEarlyUninstallTarget
Var /GLOBAL laixinAiRouterCleanup
!macro customCheckAppRunning
  StrCpy $laixinEarlyUninstallPreflight "not-run"
  ClearErrors
  ${GetParameters} $3
  ${GetOptions} $3 "--updated" $4
  ${If} ${Errors}
    ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      StrCpy $laixinEarlyUninstallTarget "$INSTDIR"
      !insertmacro runLaixinWindowsPreflight uninstall
      StrCpy $laixinEarlyUninstallPreflight $7
    ${EndIf}
  ${EndIf}
!macroend
!endif

; 同一次覆盖安装可能依次经过更新助手、新安装器 customInit、旧卸载器 customUnInstall，后者失败时
; 只看得到已经 Disabled 的任务，无法恢复第一次调用前的 Enabled 状态。用仅随当前进程树继承的
; 安装目录标记把第一次成功交给后续钩子；它只是提示，必须再读本地恢复事务、看守身份、
; 任务与进程状态，不能凭外部可设置的环境变量跳过前置闸。
!macro readLaixinWindowsPreflightHandoff RESULT
  Push $8
  Push $9
  ReadEnvStr $8 "${LAIXIN_PREFLIGHT_HANDOFF_ENV}"
  StrCpy ${RESULT} "0"
  ${If} $8 != ""
    System::Call 'Kernel32::lstrcmpiW(w r8, w "$INSTDIR") i .r9'
    ${If} $9 == 0
      ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        InitPluginsDir
        SetOutPath "$PLUGINSDIR"
        File /oname=laixin-update-helper.cjs "${PROJECT_DIR}/resources/update-helper.cjs"
        System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
        nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$PLUGINSDIR\laixin-update-helper.cjs" windows-preflight-handoff "$INSTDIR" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$APPDATA\${PRODUCT_NAME}\updates"'
        Pop $9
        System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", i 0)'
        ${If} $9 == "0"
          StrCpy ${RESULT} "1"
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $9
  Pop $8
!macroend

!macro setLaixinWindowsPreflightHandoff
  System::Call 'Kernel32::SetEnvironmentVariable(t "${LAIXIN_PREFLIGHT_HANDOFF_ENV}", t "$INSTDIR")'
!macroend

!macro clearLaixinWindowsPreflightHandoff
  System::Call 'Kernel32::SetEnvironmentVariable(t "${LAIXIN_PREFLIGHT_HANDOFF_ENV}", i 0)'
!macroend

!macro runLaixinWindowsPreflight MODE
  Push $8
  StrCpy $7 "not-run"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=laixin-update-helper.cjs "${PROJECT_DIR}/resources/update-helper.cjs"
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LAIXIN_PREFLIGHT_TARGET", t "$INSTDIR")'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LAIXIN_PREFLIGHT_EXECUTABLE", t "$INSTDIR\${APP_EXECUTABLE_FILENAME}")'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LAIXIN_PREFLIGHT_RESIDENT_LABEL", t "cn.laixin.toolbox.tunnel")'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LAIXIN_PREFLIGHT_RECOVERY_DIRECTORY", t "$APPDATA\${PRODUCT_NAME}\updates")'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LAIXIN_PREFLIGHT_TUNNEL_DIRECTORY", t "$APPDATA\${PRODUCT_NAME}\tunnel")'
  System::Call 'Kernel32::GetCurrentProcessId() i .r8'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LAIXIN_PREFLIGHT_OWNER_PID", t "$8")'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LAIXIN_PREFLIGHT_OWNER_EXECUTABLE", t "$EXEPATH")'
  nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$PLUGINSDIR\laixin-update-helper.cjs" windows-preflight ${MODE}'
  Pop $7
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", i 0)'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LAIXIN_PREFLIGHT_TARGET", i 0)'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LAIXIN_PREFLIGHT_EXECUTABLE", i 0)'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LAIXIN_PREFLIGHT_RESIDENT_LABEL", i 0)'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LAIXIN_PREFLIGHT_RECOVERY_DIRECTORY", i 0)'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LAIXIN_PREFLIGHT_TUNNEL_DIRECTORY", i 0)'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LAIXIN_PREFLIGHT_OWNER_PID", i 0)'
  System::Call 'Kernel32::SetEnvironmentVariable(t "LAIXIN_PREFLIGHT_OWNER_EXECUTABLE", i 0)'
  Pop $8
!macroend

!macro commitLaixinWindowsPreflight
  Push $8
  Push $9
  System::Call 'Kernel32::GetCurrentProcessId() i .r8'
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
  nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$PLUGINSDIR\laixin-update-helper.cjs" windows-preflight-commit "$APPDATA\${PRODUCT_NAME}\updates" "$8"'
  Pop $9
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", i 0)'
  ${If} $9 != "0"
    StrCpy $7 $9
  ${EndIf}
  Pop $9
  Pop $8
!macroend

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
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=laixin-uninstall-task-cleanup.ps1 "${PROJECT_DIR}/resources/uninstall-task-cleanup.ps1"

  ; AI 路由与网络隧道是两个独立 owner。在任何文件替换前，让已安装的 D+
  ; 用 HMAC + runtime + seat 证明并停止自己的 headless。结果单独保留，网络恢复完成后再统一失败关闭。
  StrCpy $laixinAiRouterCleanup "0"
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --laixin-ai-router-cleanup'
    Pop $laixinAiRouterCleanup
  ${EndIf}

  ; 1) 先把任务和进程收敛到可换文件的状态。真卸载必须删除新旧任务并回读不存在；
  ;    升级只停用并回读 Disabled。同一安装进程树已完成过 update 前置闸时必须复用，不能
  ;    对 Disabled 状态重新拍快照后丢掉第一次调用前的 Enabled 恢复责任。
  ${If} $5 == "uninstall"
    ${If} $laixinEarlyUninstallPreflight != ""
    ${AndIf} $laixinEarlyUninstallPreflight != "not-run"
      Push $8
      System::Call 'Kernel32::lstrcmpiW(w "$laixinEarlyUninstallTarget", w "$INSTDIR") i .r8'
      ${If} $8 == 0
        StrCpy $7 $laixinEarlyUninstallPreflight
      ${Else}
        StrCpy $7 "target-changed"
      ${EndIf}
      Pop $8
    ${Else}
      ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        !insertmacro runLaixinWindowsPreflight uninstall
      ${Else}
        ; 安装目录已残缺时没有可运行 CJS 的 Electron。真卸载仍先清理两代任务，随后继续走
        ; ledger restore 尝试与代理兜底；⛔ 因主 EXE 缺失在恢复网络之前 Abort。
        ; PowerShell 按结构化 TaskPath/TaskName 枚举、删除并再次枚举。退出码来自最终状态，
        ; ⛔ `schtasks /delete` 发过命令就当成功，也不解析本地化的“不存在”文案。
        nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\laixin-uninstall-task-cleanup.ps1"'
        Pop $7
      ${EndIf}
    ${EndIf}
  ${Else}
    !insertmacro readLaixinWindowsPreflightHandoff $R9
    ${If} $R9 == "1"
      StrCpy $7 "0"
    ${Else}
      ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        !insertmacro runLaixinWindowsPreflight update
      ${Else}
        StrCpy $7 "1"
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; 2) 按账本还原(升级与真卸载都要做:升级时安装目录整个会被换掉,旧守护已经没了)
  ;    退出码要留着给第 4 步判断:守护的 restore 子命令 0 = 已还干净,65 = 还有未恢复项,
  ;    脚本或主程序不在、进程起不来 = 根本没跑。⛔ 像以前那样 Pop 完就丢。
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")'
  System::Call 'Kernel32::SetEnvironmentVariable(t "TOOLBOX_REAL_NETWORK_ADAPTER", t "1")'
  System::Call 'Kernel32::SetEnvironmentVariable(t "TOOLBOX_REAL_TERMINAL_ENVIRONMENT", t "1")'
  StrCpy $6 "not-run"
  ${If} ${FileExists} "$INSTDIR\resources\sidecar\win\tunnel-daemon.mjs"
  ${AndIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\sidecar\win\tunnel-daemon.mjs" restore --data-dir "$APPDATA\${PRODUCT_NAME}\tunnel" --adapter "$INSTDIR\resources\sidecar\win\managed-adapter.mjs"'
    Pop $0
    ${If} $0 == "error"
      StrCpy $6 "not-run"
    ${Else}
      StrCpy $6 $0
    ${EndIf}
  ${EndIf}

  ; 3) 还原没成功才兜底；脚本核同会话未结算账目、当前值及端口监听。
  ;    空账本或无法核归属返回非零并中止卸载，保留程序和现场供离线客服接力。
  ${If} $6 != "0"
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\laixin-uninstall-task-cleanup.ps1" -ProxyFallbackOnly -TunnelDataDir "$APPDATA\${PRODUCT_NAME}\tunnel"'
    Pop $0
    ${If} $0 != "0"
      StrCpy $7 $0
    ${EndIf}
  ${EndIf}
  ${If} $laixinAiRouterCleanup != "0"
  ${AndIf} $7 == "0"
    StrCpy $7 $laixinAiRouterCleanup
  ${EndIf}
  ; WinINET 兜底成功不代表账本涉及的环境变量、终端设置等也已恢复。
  ; 守护实际执行而返回非零时保留原有前置闸/兜底错误；否则用 restore 退出码阻止删程序。
  ; daemon 缺失的残缺安装仍沿用既有兜底路径。
  ${If} $6 != "0"
  ${AndIf} $6 != "not-run"
  ${AndIf} $7 == "0"
    StrCpy $7 $6
  ${EndIf}
  ; 真卸载已经完成任务删除回读和网络恢复后才提交恢复事务；如果这里失败，保留 marker，
  ; 看守会在卸载器退出后按原快照恢复，而不是留下半卸载。升级必须等新版启动回执，不能在旧卸载器里提交。
  ${If} $5 == "uninstall"
  ${AndIf} $7 == "0"
  ${AndIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    !insertmacro commitLaixinWindowsPreflight
  ${EndIf}
  ; 前置闸失败时 CJS 已补偿任务和死回环代理。这里仍先完成独立的 ledger 恢复/兜底，
  ; 然后才中止卸载或升级，绝不把客户留在「程序还在、网络先死了」的半状态。
  ${If} $7 != "0"
    ${If} $5 == "uninstall"
      ; oneClick 卸载器在确认后内部 SetSilent silent；只用命令行 /S 判定用户是否要求无界面。
      ClearErrors
      ${GetOptions} $3 "/S" $4
      ${If} ${Errors}
        MessageBox MB_OK|MB_ICONSTOP "卸载前检查未完成，程序尚未删除。请关闭所有来信 AI 工具箱的安装和卸载窗口，等待几秒后重新尝试卸载；仍失败时，请重新打开工具箱使用“一键诊断”联系来信客服。"
      ${EndIf}
    ${EndIf}
    SetErrorLevel 1
    Abort
  ${EndIf}

  ; 只在真卸载且网络/常驻收尾成功后清理本产品独占的下载缓存。
  ; reparse point 不能递归追进去；Roaming 会话、tunnel 账本与恢复证据不在此范围。
  ${If} $5 == "uninstall"
    Push $8
    Push $9
    System::Call 'Kernel32::GetFileAttributesW(w "$LOCALAPPDATA\laixin-ai-toolbox-updater") i .r8'
    IntOp $9 $8 & 0x400
    ${If} $8 != -1
    ${AndIf} $9 == 0
      RMDir /r "$LOCALAPPDATA\laixin-ai-toolbox-updater"
    ${EndIf}
    RMDir "$LOCALAPPDATA\Laixin"
    Pop $9
    Pop $8
  ${EndIf}
!macroend
; ---- 安装器钩子:换文件前先停常驻与网络进程(2026-09-15,Windows「点更新重启又换回旧版」)----
; 背景:0.5.5 客户端里的更新助手(update-helper.ps1)在调安装器前不停守护/内核;历史卸载器虽然会
; 按映像名 taskkill,但「升级」分支 ⛔ 删任务——常驻任务每 1 分钟重入,守护可能在
; 「杀掉 → 新文件落盘」的窗口里被任务再拉起来,占住安装目录里的文件让静默安装失败,更新助手按设计
; 整目录还原旧版,客户看到「点了更新重启,又换回旧版」(2026-09-15 客户实测)。
; 顺序是硬的:先禁任务(升级不删),回读确认，再只按当前 $INSTDIR 的精确路径停进程。
; 真正无旧程序及当前安装模式登记时可继续；残缺旧安装即使 EXE 丢失也必须在
; 任务/进程操作和旧卸载器之前失败关闭。静默 /S 不弹框，返回非零。
!macro customInit
  Push $R7
  Push $R8
  Push $R9
  StrCpy $R8 "0"
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    StrCpy $R8 "1"
  ${EndIf}
  ReadRegStr $R9 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R9 != ""
    StrCpy $R8 "1"
  ${EndIf}
  ReadRegStr $R9 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $R9 != ""
    StrCpy $R8 "1"
  ${EndIf}
  !ifdef UNINSTALL_REGISTRY_KEY_2
    ReadRegStr $R9 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    ${If} $R9 != ""
      StrCpy $R8 "1"
    ${EndIf}
  !endif
  ${If} $R8 == "1"
    !insertmacro readLaixinWindowsPreflightHandoff $R7
    ${If} $R7 != "1"
      Pop $R9
      Pop $R8
      Pop $R7
      IfSilent +2
      MessageBox MB_OK|MB_ICONSTOP "检测到已安装版本，但无法确认本次更新交接。请先完成或关闭正在进行的卸载，关闭所有来信 AI 工具箱的安装和卸载窗口后，再从已安装的来信 AI 工具箱内检查更新。为保护现有程序，本次未开始覆盖。"
      SetErrorLevel 1
      Abort
    ${EndIf}
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
!macroend

; electron-builder 在这个宏之后才可能启动新版。先清掉继承标记，避免新应用日后发起真卸载时
; 把一次历史更新误当成仍在进行的同一事务。
!macro customInstall
  !insertmacro clearLaixinWindowsPreflightHandoff
!macroend
