// Runs before first paint so a saved light/dark choice doesn't flash the wrong theme.
try {
  const t = localStorage.getItem("beings.theme");
  if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
} catch {
  /* private mode: follow the system setting */
}
