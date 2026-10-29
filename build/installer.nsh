; Antes de instalar, encerra o app atual e versões anteriores/derivadas que estejam abertas
; (substitui a checagem padrão do electron-builder, que só pedia para fechar manualmente)
!macro killApp exe
  nsExec::Exec `taskkill /F /T /IM "${exe}"`
  Pop $0
!macroend

!macro customCheckAppRunning
  !insertmacro killApp "${APP_EXECUTABLE_FILENAME}"
  !insertmacro killApp "MultiHub Chat.exe"
  !insertmacro killApp "Chatwoot Desktop.exe"
  !insertmacro killApp "Chatwoot Publica.exe"
  ; Dá tempo para o Windows liberar os arquivos
  Sleep 1500
!macroend
