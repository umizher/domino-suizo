#NoEnv
#SingleInstance Force
SetWorkingDir %A_ScriptDir%
CoordMode, Mouse, Screen

; ── TikTok Auto-Clicker ──────────────────────────────────────────
;  F2  → Iniciar / Detener
;  F3  → Guardar posición actual del mouse como punto de clic
;  Esc → Salir
; ─────────────────────────────────────────────────────────────────

global running  := false
global clickX   := 0
global clickY   := 0
global interval := 800   ; ms entre clicks (puedes cambiar este valor)

; Mostrar instrucciones al inicio
MsgBox, 48, TikTok Auto-Clicker,
(
INSTRUCCIONES:

1. Pon el mouse ENCIMA del botón corazón en TikTok Live
2. Presiona F3 para guardar esa posición
3. Presiona F2 para INICIAR los clicks automáticos
4. Presiona F2 de nuevo para DETENER
5. Presiona Esc para cerrar el programa
)

return

F3::
  MouseGetPos, clickX, clickY
  ToolTip, ✓ Posición guardada: X=%clickX% Y=%clickY%`nAhora presiona F2 para iniciar
  Sleep, 3000
  ToolTip
return

F2::
  if (clickX = 0 && clickY = 0) {
    MsgBox, 48, Error, Primero presiona F3 con el mouse sobre el corazón de TikTok.
    return
  }
  running := !running
  if (running) {
    ToolTip, ▶ Auto-Clicker ACTIVO — F2 para detener
    SetTimer, DoClick, %interval%
  } else {
    SetTimer, DoClick, Off
    ToolTip, ■ Auto-Clicker DETENIDO
    Sleep, 1500
    ToolTip
  }
return

DoClick:
  Click, %clickX%, %clickY%
return

Esc::
  SetTimer, DoClick, Off
  ExitApp
