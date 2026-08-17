; "Open in ZedCode" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInZedCode" "" "Open in ZedCode"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInZedCode" "Icon" '"$INSTDIR\zedcode.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInZedCode" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInZedCode\command" "" '"$INSTDIR\zedcode.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInZedCode" "" "Open in ZedCode"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInZedCode" "Icon" '"$INSTDIR\zedcode.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInZedCode" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInZedCode\command" "" '"$INSTDIR\zedcode.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInZedCode" "" "Open in ZedCode"
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInZedCode" "Icon" '"$INSTDIR\zedcode.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInZedCode" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInZedCode\command" "" '"$INSTDIR\zedcode.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInZedCode"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInZedCode"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInZedCode"
!macroend
