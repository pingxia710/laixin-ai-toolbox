Unicode true
SilentInstall silent
RequestExecutionLevel user
Name "Laixin installer init regression"
OutFile "${OUTPUT_FILE}"
InstallDir "$EXEDIR\case-target"

!include "LogicLib.nsh"
!define PRODUCT_NAME "LaixinInstallerInitTest"
!define APP_EXECUTABLE_FILENAME "probe.exe"
!define INSTALL_REGISTRY_KEY "Software\LaixinInstallerInitTest\Install"
!define UNINSTALL_REGISTRY_KEY "Software\LaixinInstallerInitTest\Uninstall"
!define UNINSTALL_REGISTRY_KEY_2 "Software\LaixinInstallerInitTest\LegacyUninstall"
!include "${PROJECT_DIR}/build/installer.nsh"

Function .onInit
  SetShellVarContext current
  SetRegView 64
  StrCpy $R7 "saved-r7"
  StrCpy $R8 "saved-r8"
  StrCpy $R9 "saved-r9"
  !insertmacro customInit
  ${If} $R7 != "saved-r7"
  ${OrIf} $R8 != "saved-r8"
  ${OrIf} $R9 != "saved-r9"
    SetErrorLevel 3
    Abort
  ${EndIf}
FunctionEnd

Section
  SetErrorLevel 0
SectionEnd
