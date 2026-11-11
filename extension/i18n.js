// Text for the popup and the warning page, from _locales/<language>/messages.json.

// A message by name, with {0}, {1}… replaced by `args`.
function t(name, ...args) {
  return chrome.i18n.getMessage(name).replace(/\{(\d)\}/g, (_, i) => args[i] ?? "");
}

// Elements name their message in data-i18n (text) or data-i18n-title (tooltip). The English
// in the HTML stays if a message is missing.
for (const el of document.querySelectorAll("[data-i18n]")) {
  const text = t(el.dataset.i18n);
  if (text) el.textContent = text;
}
for (const el of document.querySelectorAll("[data-i18n-title]")) {
  const text = t(el.dataset.i18nTitle);
  if (text) el.title = text;
}
document.documentElement.lang = chrome.i18n.getUILanguage();
