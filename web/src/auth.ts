/** Constant-time check of an `Authorization: Bearer <token>` header. */
export async function authorized(header: string | undefined, expected: string | undefined): Promise<boolean> {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const encoder = new TextEncoder();
  const a = encoder.encode(header.slice(7));
  const b = encoder.encode(expected);
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean };
  return a.byteLength === b.byteLength && subtle.timingSafeEqual(a, b);
}
