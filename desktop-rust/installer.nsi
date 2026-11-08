!include "MUI2.nsh"

Name "Cillhub"
OutFile "target/x86_64-pc-windows-msvc/release/Cillhub-Rust-Setup-2.2.1.exe"
Unicode True
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define PRODUCT_NAME "Cillhub"
!define PRODUCT_VERSION "2.2.1"
!define PRODUCT_PUBLISHER "Cillhub Contributors"
!define PRODUCT_WEB_SITE "https://cillhub.cillerian.org"
!define PRODUCT_EXE "Cillhub.exe"
!define PRODUCT_APP_ID "io.github.mrciller.cillhub"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Cillhub"

VIProductVersion "2.2.1.0"
VIAddVersionKey "ProductName" "Cillhub"
VIAddVersionKey "FileDescription" "Cillhub Setup"
VIAddVersionKey "FileVersion" "2.2.1.0"
VIAddVersionKey "ProductVersion" "2.2.1.0"
VIAddVersionKey "CompanyName" "Cillhub"
VIAddVersionKey "LegalCopyright" "Cillhub Contributors"

InstallDir "$LOCALAPPDATA\Programs\Cillhub"
InstallDirRegKey HKCU "Software\Cillhub" "InstallDir"

!define MUI_ICON "icons/icon.ico"
!define MUI_UNICON "icons/icon.ico"

; Installer pages
!insertmacro MUI_PAGE_INSTFILES

; Finish page
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Cillhub"
!insertmacro MUI_PAGE_FINISH

; Uninstaller pages
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install" SecInstall
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  SetOverwrite on
  
  File "/oname=${PRODUCT_EXE}" "target/x86_64-pc-windows-msvc/release/cillhub-desktop.exe"
  File "/oname=icon.ico" "icons/icon.ico"
  
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Cillhub" "InstallDir" "$INSTDIR"
  
  ; Clean up legacy subfolder if previously created
  Delete "$SMPROGRAMS\Cillhub\Cillhub.lnk"
  Delete "$SMPROGRAMS\Cillhub\Uninstall Cillhub.lnk"
  RMDir "$SMPROGRAMS\Cillhub"
  
  ; Create Start Menu shortcut directly in $SMPROGRAMS so Windows Search indexes it
  CreateShortcut "$SMPROGRAMS\Cillhub.lnk" "$INSTDIR\${PRODUCT_EXE}" "" "$INSTDIR\${PRODUCT_EXE}" 0 "" "" "Cillhub"
  ClearErrors
  WinShell::SetLnkAUMI "$SMPROGRAMS\Cillhub.lnk" "${PRODUCT_APP_ID}"
  
  ; Desktop shortcut
  CreateShortcut "$DESKTOP\Cillhub.lnk" "$INSTDIR\${PRODUCT_EXE}" "" "$INSTDIR\${PRODUCT_EXE}" 0 "" "" "Cillhub"
  ClearErrors
  WinShell::SetLnkAUMI "$DESKTOP\Cillhub.lnk" "${PRODUCT_APP_ID}"
  
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
  WriteRegStr HKCU "Software\Cillhub\Capabilities" "ApplicationDescription" "Cillhub Chat"
  WriteRegStr HKCU "Software\Cillhub\Capabilities\URLAssociations" "cillhub" "cillhub"
  WriteRegStr HKCU "Software\Cillhub\Capabilities\URLAssociations" "cillcord" "cillcord"
  
  ; URL Protocol associations
  WriteRegStr HKCU "Software\Classes\cillhub" "" "URL:Cillhub Protocol"
  WriteRegStr HKCU "Software\Classes\cillhub" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\cillhub\DefaultIcon" "" "$INSTDIR\${PRODUCT_EXE},0"
  WriteRegStr HKCU "Software\Classes\cillhub\shell\open\command" "" '"$INSTDIR\${PRODUCT_EXE}" "%1"'
  
  WriteRegStr HKCU "Software\Classes\cillcord" "" "URL:Cillcord Protocol"
  WriteRegStr HKCU "Software\Classes\cillcord" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\cillcord\DefaultIcon" "" "$INSTDIR\${PRODUCT_EXE},0"
  WriteRegStr HKCU "Software\Classes\cillcord\shell\open\command" "" '"$INSTDIR\${PRODUCT_EXE}" "%1"'
  
  ; Windows Uninstall & Add/Remove Programs entry
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "${PRODUCT_WEB_SITE}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${PRODUCT_EXE},0"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" 15000
  
  ; Flush Windows Shell changes and notify SearchIndexer
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  
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
