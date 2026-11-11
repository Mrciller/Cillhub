!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !define VERSION "3.0.2"
!endif

Name "Cillhub"
OutFile "target/x86_64-pc-windows-msvc/release/Cillhub-Rust-Setup-${VERSION}.exe"
Unicode True
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define PRODUCT_NAME "Cillhub"
!define PRODUCT_VERSION "${VERSION}"
!define PRODUCT_PUBLISHER "Pascal Oraze & Cillhub Contributors"
!define PRODUCT_WEB_SITE "https://cillhub.cillerian.org"
!define PRODUCT_EXE "Cillhub.exe"
!define PRODUCT_APP_ID "io.github.mrciller.cillhub"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Cillhub"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Cillhub (Full Rust Client)"
VIAddVersionKey "FileDescription" "Cillhub Pure-Rust Native Desktop Installer"
VIAddVersionKey "FileVersion" "${VERSION}.0"
VIAddVersionKey "ProductVersion" "${VERSION}.0"
VIAddVersionKey "CompanyName" "Cillhub"
VIAddVersionKey "LegalCopyright" "AGPL-3.0 · Pascal Oraze"

InstallDir "$LOCALAPPDATA\Programs\Cillhub"
InstallDirRegKey HKCU "Software\Cillhub" "InstallDir"

!define MUI_ICON "icons/icon.ico"
!define MUI_UNICON "icons/icon.ico"

; Installer pages
!insertmacro MUI_PAGE_INSTFILES

; Finish page
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Cillhub (Pure Rust Native Client)"
!insertmacro MUI_PAGE_FINISH

; Uninstaller pages
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install" SecInstall
  SetShellVarContext current

  ; Terminate any running old Tauri/Electron or Rust Cillhub instance so files are unlocked
  nsExec::ExecToLog 'taskkill /F /IM Cillhub.exe /T'
  nsExec::ExecToLog 'taskkill /F /IM cillhub.exe /T'
  Sleep 500

  SetOutPath "$INSTDIR"
  SetOverwrite on

  File "/oname=${PRODUCT_EXE}" "target/x86_64-pc-windows-msvc/release/cillhub.exe"
  File "/oname=icon.ico" "icons/icon.ico"

  ; Also replace any legacy Tauri v2 installation in $LOCALAPPDATA\Cillhub so old taskbar pins launch Pure Rust
  ${If} ${FileExists} "$LOCALAPPDATA\Cillhub\*.*"
    CopyFiles /SILENT "$INSTDIR\${PRODUCT_EXE}" "$LOCALAPPDATA\Cillhub\Cillhub.exe"
    CopyFiles /SILENT "$INSTDIR\${PRODUCT_EXE}" "$LOCALAPPDATA\Cillhub\cillhub.exe"
  ${EndIf}

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Cillhub" "InstallDir" "$INSTDIR"

  ; Clean up legacy Start Menu subfolder if previously created by Tauri/Electron
  Delete "$SMPROGRAMS\Cillhub\Cillhub.lnk"
  Delete "$SMPROGRAMS\Cillhub\Uninstall Cillhub.lnk"
  RMDir "$SMPROGRAMS\Cillhub"

  ; Create Start Menu and Desktop shortcuts
  CreateShortcut "$SMPROGRAMS\Cillhub.lnk" "$INSTDIR\${PRODUCT_EXE}" "" "$INSTDIR\icon.ico" 0 "" "" "Cillhub Pure-Rust Native Client"
  CreateShortcut "$DESKTOP\Cillhub.lnk" "$INSTDIR\${PRODUCT_EXE}" "" "$INSTDIR\icon.ico" 0 "" "" "Cillhub Pure-Rust Native Client"

  ; App Paths: Enables typing 'cillhub' or 'Cillhub' in Windows Search or Run (Win+R)
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${PRODUCT_EXE}" "" "$INSTDIR\${PRODUCT_EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${PRODUCT_EXE}" "Path" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\cillhub.exe" "" "$INSTDIR\${PRODUCT_EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\cillhub.exe" "Path" "$INSTDIR"

  ; Applications registration for Windows Search & Open With
  WriteRegStr HKCU "Software\Classes\Applications\${PRODUCT_EXE}" "FriendlyAppName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Classes\Applications\${PRODUCT_EXE}" "ApplicationCompany" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "Software\Classes\Applications\${PRODUCT_EXE}\shell\open\command" "" '"$INSTDIR\${PRODUCT_EXE}" "%1"'
  WriteRegStr HKCU "Software\Classes\Applications\${PRODUCT_EXE}\SupportedProtocols" "cillhub" ""
  WriteRegStr HKCU "Software\Classes\Applications\${PRODUCT_EXE}\SupportedProtocols" "cillcord" ""

  ; RegisteredApplications & Capabilities
  WriteRegStr HKCU "Software\RegisteredApplications" "${PRODUCT_NAME}" "Software\Cillhub\Capabilities"
  WriteRegStr HKCU "Software\Cillhub\Capabilities" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Cillhub\Capabilities" "ApplicationDescription" "Cillhub Pure-Rust Native Chat & Game Voice"
  WriteRegStr HKCU "Software\Cillhub\Capabilities\URLAssociations" "cillhub" "cillhub"
  WriteRegStr HKCU "Software\Cillhub\Capabilities\URLAssociations" "cillcord" "cillcord"

  ; URL Protocol associations (cillhub://invite/..., cillhub://game-invite?...)
  WriteRegStr HKCU "Software\Classes\cillhub" "" "URL:Cillhub Protocol"
  WriteRegStr HKCU "Software\Classes\cillhub" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\cillhub\DefaultIcon" "" "$INSTDIR\icon.ico,0"
  WriteRegStr HKCU "Software\Classes\cillhub\shell\open\command" "" '"$INSTDIR\${PRODUCT_EXE}" "%1"'

  WriteRegStr HKCU "Software\Classes\cillcord" "" "URL:Cillcord Protocol"
  WriteRegStr HKCU "Software\Classes\cillcord" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\cillcord\DefaultIcon" "" "$INSTDIR\icon.ico,0"
  WriteRegStr HKCU "Software\Classes\cillcord\shell\open\command" "" '"$INSTDIR\${PRODUCT_EXE}" "%1"'

  ; Windows Uninstall & Add/Remove Programs entry
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${PRODUCT_NAME} (Pure Rust)"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "${PRODUCT_WEB_SITE}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\icon.ico,0"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" 12000

  ; Flush Windows Shell changes
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'

  ; Launch after silent update if --force-run is passed
  ${GetOptions} $CMDLINE "--force-run" $R0
  ${IfNot} ${Errors}
    Exec '"$INSTDIR\${PRODUCT_EXE}"'
  ${EndIf}
SectionEnd

Section "Uninstall"
  SetShellVarContext current

  nsExec::ExecToLog 'taskkill /F /IM Cillhub.exe /T'
  nsExec::ExecToLog 'taskkill /F /IM cillhub.exe /T'

  Delete "$DESKTOP\Cillhub.lnk"
  Delete "$SMPROGRAMS\Cillhub.lnk"
  Delete "$SMPROGRAMS\Cillhub\Cillhub.lnk"
  Delete "$SMPROGRAMS\Cillhub\Uninstall Cillhub.lnk"
  RMDir "$SMPROGRAMS\Cillhub"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${PRODUCT_EXE}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\cillhub.exe"
  DeleteRegKey HKCU "Software\Classes\Applications\${PRODUCT_EXE}"
  DeleteRegValue HKCU "Software\RegisteredApplications" "${PRODUCT_NAME}"
  DeleteRegKey HKCU "Software\Classes\cillhub"
  DeleteRegKey HKCU "Software\Classes\cillcord"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\Cillhub"

  Delete "$INSTDIR\${PRODUCT_EXE}"
  Delete "$INSTDIR\icon.ico"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
SectionEnd
