// Choose one WIA scanner when Windows lists more than one entry.
// The Brother DCP-L2640DW often appears twice: a Microsoft WSD driver and the
// manufacturer's own "LAN" driver. Those are the same model, so we keep the
// manufacturer's driver. Genuinely different models are not guessed.

const MODEL_RE = /\b(dcp|mfc|hl)[- ]?[a-z0-9]+\b/i;

export function scannerModelKey(name) {
  const raw = String(name ?? "");
  const hit = raw.match(MODEL_RE);
  if (hit) return hit[0].toLowerCase().replace(/[- ]/g, "");
  return raw
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(lan|series|wsd|usb|network|scanner|printer)\b/gi, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

export function isMicrosoftDriver(device) {
  return /^microsoft\b/i.test(String(device?.manufacturer ?? "").trim());
}

/**
 * @returns {{ ok: true, device: object, auto: boolean, sameModel: boolean } | { ok: false, sameModel: boolean, error: string }}
 */
export function pickScanner(scanners) {
  const list = (Array.isArray(scanners) ? scanners : []).filter((s) => s && (s.deviceId || s.name));
  if (!list.length) return { ok: false, sameModel: false, error: "No scanners were found." };
  const keys = [...new Set(list.map((s) => scannerModelKey(s.name)).filter(Boolean))];
  const sameModel = keys.length <= 1;
  if (list.length === 1) return { ok: true, device: list[0], auto: false, sameModel };
  const own = list.filter((s) => !isMicrosoftDriver(s));
  const pool = own.length ? own : list;
  if (sameModel) return { ok: true, device: pool[0], auto: true, sameModel: true };
  const names = list.map((s) => s.name || s.deviceId).join("; ");
  return { ok: false, sameModel: false, error: `Several different scanners were found: ${names}. Choose the one on this desk.` };
}
