import { calculateHmacSignature, verifyHmacSignature, hashPayload } from '../../src/utils/crypto';

describe('Crypto Utilities Unit Tests', () => {
  const secret = 'test-secret-key-123';
  const payload = { eventId: 'evt-001', orderNo: 'ORD-123-456', amount: 150 };

  it('should generate valid HMAC signature and verify successfully', () => {
    const signature = calculateHmacSignature(payload, secret);
    expect(signature).toBeDefined();
    expect(typeof signature).toBe('string');
    expect(signature.length).toBe(64); // SHA-256 hex is 64 chars

    const isValid = verifyHmacSignature(payload, secret, signature);
    expect(isValid).toBe(true);
  });

  it('should fail HMAC verification when signature is altered or tampered with', () => {
    const signature = calculateHmacSignature(payload, secret);
    const tamperedSignature = signature.substring(0, 63) + '0';
    const isValid = verifyHmacSignature(payload, secret, tamperedSignature);
    expect(isValid).toBe(false);
  });

  it('should produce identical sha256 hash for identical payloads in idempotency check', () => {
    const hash1 = hashPayload({ a: 1, b: 'test' });
    const hash2 = hashPayload({ a: 1, b: 'test' });
    expect(hash1).toBe(hash2);

    const hashDifferent = hashPayload({ a: 2, b: 'test' });
    expect(hash1).not.toBe(hashDifferent);
  });
});
