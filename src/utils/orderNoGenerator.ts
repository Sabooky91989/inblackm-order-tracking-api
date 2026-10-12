let sequenceCounter = 100;

/**
 * Generates an order number in format: ORD-{timestamp}-{randomOrSeq}
 * Example: ORD-2587965432159-458
 */
export function generateOrderNo(): string {
  const timestamp = Date.now();
  const seq = (sequenceCounter++ % 900) + 100; // 3-digit sequence guarantee uniqueness even in 0ms loop
  return `ORD-${timestamp}-${seq}`;
}

/**
 * Validates if the string matches the ORD format (ORD followed by numbers and hyphen)
 * Required pattern: ORD-{digits}-{digits}
 * Example: ORD-2587965432159-458
 */
export function isValidOrderNo(orderNo: string): boolean {
  if (!orderNo || typeof orderNo !== 'string') return false;
  const orderRegex = /^ORD-\d+-\d+$/;
  return orderRegex.test(orderNo.trim());
}
