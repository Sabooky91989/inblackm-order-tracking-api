import crypto from 'crypto';

export function calculateHmacSignature(payload: string | object, secret: string): string {
  const content = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHmac('sha256', secret).update(content).digest('hex');
}

export function verifyHmacSignature(payload: string | object, secret: string, signature: string): boolean {
  if (!signature) return false;
  const expectedSignature = calculateHmacSignature(payload, secret);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'utf8'),
      Buffer.from(expectedSignature, 'utf8')
    );
  } catch {
    return false;
  }
}

export function hashPayload(payload: any): string {
  const content = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
  return crypto.createHash('sha256').update(content).digest('hex');
}
