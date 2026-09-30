// Lets the same logger run as a Chrome extension OR as a normal web page
// (Safari, Firefox, phones). Inside the extension this does nothing; on the
// web it stands in for chrome.storage (using localStorage) and chrome.tabs.
(function () {
  var inExtension = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  if (inExtension) return;

  var PREFIX = "debrief:";
  function read(key) {
    try {
      var raw = localStorage.getItem(PREFIX + key);
      return raw == null ? undefined : JSON.parse(raw);
    } catch (e) {
      return undefined;
    }
  }
  var local = {
    get: async function (key) {
      var out = {};
      [].concat(key).forEach(function (k) { out[k] = read(k); });
      return out;
    },
    set: async function (items) {
      Object.keys(items).forEach(function (k) {
        try {
          if (items[k] === undefined) localStorage.removeItem(PREFIX + k);
          else localStorage.setItem(PREFIX + k, JSON.stringify(items[k]));
        } catch (e) { /* storage full or blocked: keep working in memory */ }
      });
    },
    remove: async function (key) {
      [].concat(key).forEach(function (k) {
        try { localStorage.removeItem(PREFIX + k); } catch (e) {}
      });
    },
  };
  var shim = {
    storage: { local: local },
    tabs: { create: function (o) { window.open(o.url, "_blank", "noopener"); } },
  };
  try {
    window.chrome = Object.assign(window.chrome || {}, shim);
  } catch (e) {}
  if (!window.chrome || !window.chrome.storage) window.chrome = shim;
  document.documentElement.classList.add("web");
})();
