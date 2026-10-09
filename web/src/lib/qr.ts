// QR codes (TV sign-in, Install): the qrcode library loads on first use, not
// with every page (PERF-3). The service worker precaches its chunk for offline.
export function qrDataUrl(text: string): Promise<string> {
  return import('qrcode').then(({ default: QRCode }) =>
    QRCode.toDataURL(text, { width: 320, margin: 1, color: { dark: '#05070a', light: '#ffffff' } })
  );
}
