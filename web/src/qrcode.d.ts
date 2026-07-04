declare module 'qrcode' {
  export function toDataURL(text: string, opts?: Record<string, unknown>): Promise<string>;
  const _default: { toDataURL: typeof toDataURL };
  export default _default;
}
