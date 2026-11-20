; Per-user BEINGS scanner helper setup. No administrator password.
; Built on Linux or Windows with NSIS (makensis). The published file is
; BEINGS-Scanner-Helper-Setup.exe. Code signing is not available yet:
; Windows SmartScreen may say the publisher is unknown. Choose More info, then Run anyway.
;
; Placeholders @VERSION@ @STAGE@ @OUT@ are filled in by tools/build-windows-installer.mjs.

Unicode true
RequestExecutionLevel user
ManifestDPIAware true

!define APP_NAME "BEINGS scanner helper"
!define APP_VERSION "@VERSION@"
!define STAGE "@STAGE@"
!define OUTFILE "@OUT@"

Name "${APP_NAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\BEINGS\scanner-helper"
InstallDirRegKey HKCU "Software\BEINGS\Scanner Helper" "InstallDir"

SetCompressor /SOLID lzma
SetCompressorDictSize 32
ShowInstDetails nevershow
AutoCloseWindow true
BrandingText "BEINGS scanner helper"

!include MUI2.nsh
!include LogicLib.nsh
!include nsDialogs.nsh
!include WinMessages.nsh

!insertmacro MUI_PAGE_INSTFILES
Page custom FinishCreate
!insertmacro MUI_LANGUAGE "English"

Var FinishDialog

Function .onInit
  SetShellVarContext current
FunctionEnd

Function un.onInit
  SetShellVarContext current
FunctionEnd

Section "Install"
  DetailPrint "Stopping any helper that is already running"
  IfFileExists "$INSTDIR\Stop-BEINGS-Helper.vbs" 0 skip_old_stop
    ExecWait '"$WINDIR\System32\wscript.exe" //B "$INSTDIR\Stop-BEINGS-Helper.vbs"'
  skip_old_stop:
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.Name -eq ''node.exe'' -and $$_.CommandLine -like ''*cli.mjs*bridge*'' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Pop $0
  Sleep 600

  SetOutPath "$INSTDIR"
  SetOverwrite on
  File /r "${STAGE}/*.*"

  DetailPrint "Writing install.json"
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\Write-InstallStamp.ps1"'
  Pop $0

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "BEINGS scanner helper" '"$WINDIR\System32\wscript.exe" //B "$INSTDIR\Launch-BEINGS-Helper.vbs"'

  WriteRegStr HKCU "Software\Classes\beings-helper" "" "URL:BEINGS Helper Protocol"
  WriteRegStr HKCU "Software\Classes\beings-helper" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\beings-helper\shell\open\command" "" '"$WINDIR\System32\wscript.exe" //B "$INSTDIR\Launch-BEINGS-Helper.vbs" "%1"'

  CreateDirectory "$SMPROGRAMS"
  CreateShortcut "$SMPROGRAMS\Start BEINGS helper.lnk" "$WINDIR\System32\wscript.exe" '//B "$INSTDIR\Launch-BEINGS-Helper.vbs"'
  CreateShortcut "$SMPROGRAMS\Stop BEINGS helper.lnk" "$WINDIR\System32\wscript.exe" '//B "$INSTDIR\Stop-BEINGS-Helper.vbs"'
  CreateDirectory "$SMPROGRAMS\Startup"
  CreateShortcut "$SMPROGRAMS\Startup\Start BEINGS helper.lnk" "$WINDIR\System32\wscript.exe" '//B "$INSTDIR\Launch-BEINGS-Helper.vbs"'

  WriteUninstaller "$INSTDIR\Uninstall-BEINGS-Helper.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BEINGS scanner helper" "DisplayName" "BEINGS scanner helper"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BEINGS scanner helper" "UninstallString" '"$INSTDIR\Uninstall-BEINGS-Helper.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BEINGS scanner helper" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BEINGS scanner helper" "Publisher" "BEINGS"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BEINGS scanner helper" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BEINGS scanner helper" "NoRepair" 1
  WriteRegStr HKCU "Software\BEINGS\Scanner Helper" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\BEINGS\Scanner Helper" "Version" "${APP_VERSION}"

  Exec '"$WINDIR\System32\wscript.exe" //B "$INSTDIR\Launch-BEINGS-Helper.vbs"'
SectionEnd

Section "Uninstall"
  nsExec::ExecToLog '"$WINDIR\System32\wscript.exe" //B "$INSTDIR\Stop-BEINGS-Helper.vbs"'
  Pop $0
  Sleep 400
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "BEINGS scanner helper"
  DeleteRegKey HKCU "Software\Classes\beings-helper"
  Delete "$SMPROGRAMS\Start BEINGS helper.lnk"
  Delete "$SMPROGRAMS\Stop BEINGS helper.lnk"
  Delete "$SMPROGRAMS\Startup\Start BEINGS helper.lnk"
  Delete "$INSTDIR\Uninstall-BEINGS-Helper.exe"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BEINGS scanner helper"
  DeleteRegKey HKCU "Software\BEINGS\Scanner Helper"
SectionEnd

Function FinishCreate
  ${If} ${Silent}
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $FinishDialog
  ${If} $FinishDialog == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 12u 100% 48u "Installed. You can close this. The helper is running in the background. No window needs to stay open."
  Pop $0
  ${NSD_CreateTimer} FinishTick 3000
  nsDialogs::Show
FunctionEnd

Function FinishTick
  ${NSD_KillTimer} FinishTick
  SendMessage $HWNDPARENT ${WM_CLOSE} 0 0
FunctionEnd
