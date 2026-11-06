"use strict";
(function () {
  const KEY = "ea:consent", VID = "ea:vid";
  const get = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const EAConsent = (window.EAConsent = {
    granted: () => get() === "yes",
    visitorId() {
      if (!EAConsent.granted()) return null;
      try { let v = localStorage.getItem(VID); if (!v) { v = crypto.randomUUID(); localStorage.setItem(VID, v); } return v; } catch { return null; }
    },
    ask() {
      if (document.getElementById("ea-consent")) return;
      const el = document.createElement("div");
      el.id = "ea-consent";
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-label", "Armazenamento no seu navegador");
      el.innerHTML = '<p><strong>Guardar a sua lista neste navegador?</strong> Para guardar «A minha lista» (o que decide seguir) só para si, o Estado Aberto grava no seu navegador um identificador aleatório (armazenamento local, sem cookies de rastreio). Serve apenas para separar a sua lista da dos outros visitantes: não é usado para publicidade, não identifica quem é e não é partilhado com terceiros. Pode recusar e continuar a navegar; sem isto, não é possível seguir. Pode retirar o consentimento a qualquer momento apagando os dados do site no navegador.</p><div class="ea-consent-b"><button type="button" data-c="yes">Aceitar</button><button type="button" data-c="no">Recusar</button></div>';
      el.addEventListener("click", (e) => {
        const c = e.target.closest("[data-c]")?.dataset.c;
        if (!c) return;
        try { localStorage.setItem(KEY, c); if (c === "no") localStorage.removeItem(VID); } catch {}
        el.remove();
        document.dispatchEvent(new CustomEvent("ea:consent", { detail: c }));
      });
      document.body.appendChild(el);
    },
  });
})();
