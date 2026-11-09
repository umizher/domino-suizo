/* Bloqueo automático con clave (Inicio, Árbitro y Vista Pública).
 *
 * Pide la clave otra vez cuando la app lleva más de 3 minutos sin usarse:
 * sin tocarla con la pantalla encendida, o fuera de ella (teléfono bloqueado,
 * otra app). Las idas cortas —mandar el mensaje por WhatsApp, una captura—
 * no la piden. No se pierde nada: los puntos se guardan al escribirlos.
 *
 * La "última vez que se usó" vive en sessionStorage, compartida por las tres
 * páginas; si el iPhone cierra la app, se pierde y la clave se pide igual que
 * al abrirla. Cada página registra con DominoLock.onLock() cómo se bloquea. */
(function () {
  "use strict";
  var LIMIT_MIN = 3;
  var LIMIT = LIMIT_MIN * 60 * 1000;
  var PIN_KEY = "domino_pin_ok", LAST_KEY = "domino_last_use";
  var lockFn = null, last = 0, lastSaved = 0, lockedByTime = false;

  function get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  function del(k) { try { sessionStorage.removeItem(k); } catch (e) {} }
  function unlocked() { return get(PIN_KEY) === "1"; }
  function save() { set(LAST_KEY, String(last)); lastSaved = last; }
  function expired() {
    var now = Date.now();
    if (last > now) last = now; // si el reloj del teléfono se atrasó
    return now - last > LIMIT;
  }

  // Cualquier toque, tecla o desplazamiento cuenta como uso
  function used() {
    last = Date.now();
    if (last - lastSaved > 5000) save();
  }

  function lock() {
    del(PIN_KEY);
    lockedByTime = true;
    if (lockFn) { try { lockFn(); } catch (e) {} }
  }
  function check() {
    if (document.hidden || !unlocked()) return;
    if (expired()) lock();
  }

  // Al abrir la página: si la última vez que se usó fue hace más de 3
  // minutos, la clave guardada ya no vale (antes de que la página decida si
  // muestra la app o la pantalla de clave).
  last = Number(get(LAST_KEY)) || 0;
  if (!last) { last = Date.now(); save(); }
  else if (unlocked() && expired()) { del(PIN_KEY); lockedByTime = true; }

  ["pointerdown", "touchstart", "keydown", "input", "wheel"].forEach(function (ev) {
    document.addEventListener(ev, used, { capture: true, passive: true });
  });
  window.addEventListener("scroll", used, { capture: true, passive: true });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) save(); else check();
  });
  window.addEventListener("pageshow", check);
  window.addEventListener("pagehide", save);
  setInterval(check, 10000);

  window.DominoLock = {
    LIMIT_MIN: LIMIT_MIN,
    // fn: cómo se bloquea esta página (mostrar la pantalla de clave)
    onLock: function (fn) { lockFn = fn; },
    // true si la clave se pidió por el tiempo (para mostrar el aviso)
    lockedByTime: function () { return lockedByTime; },
    // al entrar con la clave correcta
    unlocked: function () { lockedByTime = false; used(); save(); },
    _check: check
  };
})();
