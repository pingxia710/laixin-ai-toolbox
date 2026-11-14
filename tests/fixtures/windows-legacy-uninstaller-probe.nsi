Unicode true
SilentInstall silent
RequestExecutionLevel user
Name "Laixin legacy uninstaller compatibility probe"
OutFile "${OUTPUT_FILE}"
InstallDir "$EXEDIR\case-target"

!include "LogicLib.nsh"
!define PRODUCT_NAME "LaixinCompatibilityProbe"
!define APP_EXECUTABLE_FILENAME "来信AI工具箱统一版.exe"
!define UNINSTALL_FILENAME "Uninstall 来信AI工具箱统一版.exe"
!include "${PROJECT_DIR}/build/installer.nsh"

Var uninstallerFileName
Var installationDir

Section
  ReadINIStr $INSTDIR "$EXEDIR\case.ini" "case" "target"
  ReadINIStr $installationDir "$EXEDIR\case.ini" "case" "registered"
  ReadINIStr $uninstallerFileName "$EXEDIR\case.ini" "case" "uninstaller"
  StrCpy $R4 $uninstallerFileName
  StrCpy $7 "saved-seven"
  StrCpy $8 "saved-eight"
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "previous")'
  !insertmacro useLaixinCompatibleUninstaller
  ReadEnvStr $R5 "ELECTRON_RUN_AS_NODE"
  WriteINIStr "$EXEDIR\result.ini" "result" "seven" "$7"
  WriteINIStr "$EXEDIR\result.ini" "result" "eight" "$8"
  WriteINIStr "$EXEDIR\result.ini" "result" "environment" "$R5"
  ${If} $uninstallerFileName == $R4
    WriteINIStr "$EXEDIR\result.ini" "result" "selected" "original"
  ${Else}
    WriteINIStr "$EXEDIR\result.ini" "result" "selected" "compatible"
    CopyFiles /SILENT "$uninstallerFileName" "$EXEDIR\selected.exe"
  ${EndIf}
  SetErrorLevel 0
SectionEnd
