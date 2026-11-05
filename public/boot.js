"use strict";
window.PORTAL_START && window.PORTAL_START();
if ("serviceWorker" in navigator && location.protocol !== "file:" && !/[?&]sw=0\b/.test(location.search)) {
  addEventListener("load", () => (window.requestIdleCallback || setTimeout)(() => navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {}), { timeout: 3000 }));
}
