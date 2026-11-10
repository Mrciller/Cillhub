; Before the files go in: remove a 2.2.x install (the earlier app of the same name) if it is there, so its shortcuts and
; uninstall entry do not linger next to ours. Its key is electron-builder's GUID for our app id; its silent uninstaller
; keeps the user's data folder. The 2.2.x updater runs this installer as its last update.
!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\59cd2796-830e-5e8c-88dd-c707d7eebc0a" "QuietUninstallString"
  ${If} $R0 != ""
    ExecWait '$R0'
    ; an NSIS uninstaller re-runs itself from a temp copy, so ExecWait returns early: wait (max 30 s) until its entry is
    ; gone, else it would delete our new shortcuts and cillhub:// keys after we wrote them
    StrCpy $R1 0
    ${Do}
      Sleep 500
      IntOp $R1 $R1 + 1
      ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\59cd2796-830e-5e8c-88dd-c707d7eebc0a" "QuietUninstallString"
      ${If} $R0 == ""
      ${OrIf} $R1 >= 60
        ${Break}
      ${EndIf}
    ${Loop}
  ${EndIf}
!macroend

; The 2.2.x updater starts this installer with "--updated /S --force-run" and expects the app to start afterwards.
!macro NSIS_HOOK_POSTINSTALL
  ${GetOptions} $CMDLINE "--force-run" $R0
  ${IfNot} ${Errors}
    Exec '"$INSTDIR\${MAINBINARYNAME}.exe"'
  ${EndIf}
!macroend
