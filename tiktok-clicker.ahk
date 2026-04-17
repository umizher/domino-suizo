#NoEnv
#SingleInstance Force
CoordMode, Mouse, Screen

global clickX := 0
global clickY := 0
global active := false

MsgBox, 48, TikTok Auto-Clicker,
(
1. Pon el mouse sobre el corazon de TikTok
2. Presiona Ctrl+1 para guardar posicion
3. Presiona Ctrl+2 para iniciar/detener
4. Presiona Ctrl+3 para cerrar
)
return

^1::
  MouseGetPos, clickX, clickY
  ToolTip, Posicion guardada: %clickX%`, %clickY%
  Sleep, 2000
  ToolTip
return

^2::
  if (clickX = 0) {
    MsgBox Primero presiona Ctrl+1 sobre el corazon.
    return
  }
  active := !active
  if (active) {
    ToolTip, ACTIVO - Ctrl+2 para detener
    SetTimer, Clicker, 800
  } else {
    SetTimer, Clicker, Off
    ToolTip, DETENIDO
    Sleep, 1000
    ToolTip
  }
return

Clicker:
  MouseMove, %clickX%, %clickY%
  Sleep, 30
  SendInput {LButton Down}
  Sleep, 50
  SendInput {LButton Up}
return

^3::ExitApp
