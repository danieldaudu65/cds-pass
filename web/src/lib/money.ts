export const naira = (kobo: number) =>
  `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** Same maths as duesCharges on the server: dues + 3% service + Paystack's exact charge, rounded up to the naira. */
const SERVICE_FEE_PERCENT = Number(import.meta.env.VITE_SERVICE_FEE_PERCENT ?? 3);
const PAYSTACK_FEE_PERCENT = Number(import.meta.env.VITE_PAYSTACK_FEE_PERCENT ?? 1.5);

export function duesCharges(amountKobo: number) {
  const servicePercent = SERVICE_FEE_PERCENT;
  const paystackPercent = PAYSTACK_FEE_PERCENT;
  const up = (k: number) => Math.ceil(k / 100) * 100;
  const serviceKobo = up((amountKobo * servicePercent) / 100);
  // Paystack charges 1.5% of the TOTAL, plus ₦100 when the total is ₦2,500 or more, capped at ₦2,000.
  // Work out the part that exactly covers that, so the group gets the full dues and you keep the full 3%.
  const base = amountKobo + serviceKobo;
  const rate = paystackPercent / 100;
  let paystackKobo = up((base * rate) / (1 - rate));
  if (base + paystackKobo >= 250_000) paystackKobo = up((base * rate + 10_000) / (1 - rate));
  paystackKobo = Math.min(paystackKobo, 200_000);
  return { serviceKobo, paystackKobo, chargesKobo: serviceKobo + paystackKobo, totalKobo: base + paystackKobo };
}
