Unicode true
SilentInstall silent
RequestExecutionLevel user
Name "Laixin recovery guard"
OutFile "${OUTPUT_FILE}"

!include "LogicLib.nsh"
!include "Util.nsh"

Var Transaction
Var ErrorPath
Var StartedPath
Var ReadyPath
Var OwnerPid
Var OwnerPath
Var OwnerStarted
Var WorkerPid
Var WorkerPath
Var WorkerStarted

!macro GuardFailure CODE
  ${If} $R2 != 0
    System::Call 'kernel32::CloseHandle(p R2)'
    StrCpy $R2 0
  ${EndIf}
  ${If} $R1 != 0
    System::Call 'kernel32::CloseHandle(p R1)'
    StrCpy $R1 0
  ${EndIf}
  ClearErrors
  FileOpen $R9 "$ErrorPath" w
  ${IfNot} ${Errors}
    FileWrite $R9 "${CODE}"
    FileClose $R9
  ${EndIf}
  SetErrorLevel 70
  Quit
!macroend

!macro WriteRecord PATH FAILURE
  ClearErrors
  FileOpen $R9 "${PATH}" w
  ${If} ${Errors}
    !insertmacro GuardFailure "${FAILURE}"
  ${EndIf}
  FileWrite $R9 "$Transaction:$R0"
  FileClose $R9
!macroend

Section
  StrCpy $R1 0
  StrCpy $R2 0
  ReadEnvStr $Transaction "LAIXIN_RECOVERY_GUARD_TRANSACTION"
  ReadEnvStr $ErrorPath "LAIXIN_RECOVERY_GUARD_ERROR_PATH"
  ReadEnvStr $StartedPath "LAIXIN_RECOVERY_GUARD_STARTED_PATH"
  ReadEnvStr $ReadyPath "LAIXIN_RECOVERY_GUARD_READY_PATH"
  ReadEnvStr $OwnerPid "LAIXIN_RECOVERY_GUARD_OWNER_PID"
  ReadEnvStr $OwnerPath "LAIXIN_RECOVERY_GUARD_OWNER_PATH"
  ReadEnvStr $OwnerStarted "LAIXIN_RECOVERY_GUARD_OWNER_STARTED"
  ReadEnvStr $WorkerPid "LAIXIN_RECOVERY_GUARD_WORKER_PID"
  ReadEnvStr $WorkerPath "LAIXIN_RECOVERY_GUARD_WORKER_PATH"
  ReadEnvStr $WorkerStarted "LAIXIN_RECOVERY_GUARD_WORKER_STARTED"
  ${If} $Transaction == ""
  ${OrIf} $ErrorPath == ""
  ${OrIf} $StartedPath == ""
  ${OrIf} $ReadyPath == ""
  ${OrIf} $OwnerPid == ""
  ${OrIf} $OwnerPath == ""
  ${OrIf} $OwnerStarted == ""
  ${OrIf} $WorkerPid == ""
  ${OrIf} $WorkerPath == ""
  ${OrIf} $WorkerStarted == ""
    !insertmacro GuardFailure "UPDATE_RECOVERY_GUARD_INPUT_INVALID"
  ${EndIf}

  System::Call 'kernel32::GetCurrentProcessId() i .R0'
  !insertmacro WriteRecord "$StartedPath" "UPDATE_RECOVERY_GUARD_START_WRITE_FAILED"

  ; Open and validate the exact NSIS owner instance before acknowledging readiness.
  System::Call 'kernel32::OpenProcess(i 0x101000, i 0, i $OwnerPid) p .R1'
  ${If} $R1 == 0
    !insertmacro GuardFailure "UPDATE_RECOVERY_GUARD_PROCESS_OPEN_FAILED"
  ${EndIf}
  StrCpy $R4 ""
  StrCpy $R5 ${NSIS_MAX_STRLEN}
  System::Call 'kernel32::QueryFullProcessImageNameW(p R1, i 0, t .R4, *i R5) i .R3'
  ${If} $R3 == 0
    !insertmacro GuardFailure "UPDATE_RECOVERY_GUARD_PROCESS_PATH_FAILED"
  ${EndIf}
  System::Call 'kernel32::lstrcmpiW(w R4, w $OwnerPath) i .R3'
  ${If} $R3 != 0
    !insertmacro GuardFailure "UPDATE_RECOVERY_GUARD_PROCESS_PATH_MISMATCH"
  ${EndIf}
  System::Call 'kernel32::GetProcessTimes(p R1, *l .R6, *l .R7, *l .R8, *l .R9) i .R3'
  ${If} $R3 == 0
    !insertmacro GuardFailure "UPDATE_RECOVERY_GUARD_PROCESS_TIME_FAILED"
  ${EndIf}
  ${Int64Op} $R8 $R6 - $OwnerStarted
  ${Int64Cmp} $R8 0 owner_time_ok owner_time_negative owner_time_ok
owner_time_negative:
  ${Int64Op} $R8 0 - $R8
owner_time_ok:
  ${Int64Cmp} $R8 10 owner_valid owner_valid owner_time_bad
owner_time_bad:
  !insertmacro GuardFailure "UPDATE_RECOVERY_GUARD_PROCESS_START_TIME_MISMATCH"
owner_valid:

  ; Open the helper's exact process instance as the second held handle.
  System::Call 'kernel32::OpenProcess(i 0x101000, i 0, i $WorkerPid) p .R2'
  ${If} $R2 == 0
    !insertmacro GuardFailure "UPDATE_RECOVERY_GUARD_PROCESS_OPEN_FAILED"
  ${EndIf}
  StrCpy $R4 ""
  StrCpy $R5 ${NSIS_MAX_STRLEN}
  System::Call 'kernel32::QueryFullProcessImageNameW(p R2, i 0, t .R4, *i R5) i .R3'
  ${If} $R3 == 0
    !insertmacro GuardFailure "UPDATE_RECOVERY_GUARD_PROCESS_PATH_FAILED"
  ${EndIf}
  System::Call 'kernel32::lstrcmpiW(w R4, w $WorkerPath) i .R3'
  ${If} $R3 != 0
    !insertmacro GuardFailure "UPDATE_RECOVERY_GUARD_PROCESS_PATH_MISMATCH"
  ${EndIf}
  System::Call 'kernel32::GetProcessTimes(p R2, *l .R6, *l .R7, *l .R8, *l .R9) i .R3'
  ${If} $R3 == 0
    !insertmacro GuardFailure "UPDATE_RECOVERY_GUARD_PROCESS_TIME_FAILED"
  ${EndIf}
  ${Int64Op} $R8 $R6 - $WorkerStarted
  ${Int64Cmp} $R8 0 worker_time_ok worker_time_negative worker_time_ok
worker_time_negative:
  ${Int64Op} $R8 0 - $R8
worker_time_ok:
  ${Int64Cmp} $R8 10 worker_valid worker_valid worker_time_bad
worker_time_bad:
  !insertmacro GuardFailure "UPDATE_RECOVERY_GUARD_PROCESS_START_TIME_MISMATCH"
worker_valid:

  ; LAIXIN_RECOVERY_NATIVE_WAIT: ready means both exact process handles are already held.
  !insertmacro WriteRecord "$ReadyPath" "UPDATE_RECOVERY_GUARD_READY_WRITE_FAILED"
  System::Call 'kernel32::WaitForSingleObject(p R1, i 0xffffffff) i .R3'
  ${If} $R3 != 0
    !insertmacro GuardFailure "UPDATE_RECOVERY_GUARD_PROCESS_WAIT_FAILED"
  ${EndIf}
  System::Call 'kernel32::WaitForSingleObject(p R2, i 0xffffffff) i .R3'
  ${If} $R3 != 0
    !insertmacro GuardFailure "UPDATE_RECOVERY_GUARD_PROCESS_WAIT_FAILED"
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p R2)'
  StrCpy $R2 0
  System::Call 'kernel32::CloseHandle(p R1)'
  StrCpy $R1 0

  ; PowerShell is now a short recovery consumer only; it is not the long-running guard.
  ReadEnvStr $R4 "LAIXIN_RECOVERY_GUARD_POWERSHELL"
  ReadEnvStr $R5 "LAIXIN_RECOVERY_GUARD_LAUNCHER"
  ${If} $R4 == ""
  ${OrIf} $R5 == ""
    !insertmacro GuardFailure "UPDATE_RECOVERY_GUARD_RECOVERY_INPUT_INVALID"
  ${EndIf}
  nsExec::ExecToStack '"$R4" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$R5" -Reboot -Transaction "$Transaction"'
  Pop $R3
  ${If} $R3 != 0
    !insertmacro GuardFailure "UPDATE_RECOVERY_GUARD_RECOVERY_FAILED"
  ${EndIf}
SectionEnd
