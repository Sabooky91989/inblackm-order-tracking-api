import { generateOrderNo, isValidOrderNo } from '../../src/utils/orderNoGenerator';

describe('OrderNoGenerator & Validator Unit Tests', () => {
  it('should generate order number matching ORD-{timestamp}-{random} pattern', () => {
    const orderNo = generateOrderNo();
    expect(orderNo).toMatch(/^ORD-\d+-\d{3}$/);
    expect(isValidOrderNo(orderNo)).toBe(true);
  });

  it('should generate unique numbers across multiple invocations', () => {
    const numbers = new Set();
    for (let i = 0; i < 50; i++) {
      numbers.add(generateOrderNo());
    }
    expect(numbers.size).toBe(50);
  });

  it('should accept valid order numbers', () => {
    expect(isValidOrderNo('ORD-2587965432159-458')).toBe(true);
    expect(isValidOrderNo('ORD-1712900000000-123')).toBe(true);
    expect(isValidOrderNo('ORD-1-999')).toBe(true);
  });

  it('should reject invalid formats (letters, missing prefix, negative signs, symbols)', () => {
    expect(isValidOrderNo('ORD-abc-123')).toBe(false);
    expect(isValidOrderNo('ORD-2587965432159')).toBe(false);
    expect(isValidOrderNo('2587965432159-458')).toBe(false);
    expect(isValidOrderNo('ORD-')).toBe(false);
    expect(isValidOrderNo('ORD--458')).toBe(false);
    expect(isValidOrderNo('ORDER-123-456')).toBe(false);
    expect(isValidOrderNo('')).toBe(false);
    expect(isValidOrderNo(null as any)).toBe(false);
    expect(isValidOrderNo(undefined as any)).toBe(false);
  });
});
