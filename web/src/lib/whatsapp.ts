/**
 * Link that opens a WhatsApp chat with a Nigerian number, with a message already typed.
 * Works on phones (WhatsApp app) and laptops (WhatsApp Web / desktop).
 */
export function whatsappLink(phone: string | null | undefined, text: string): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = `234${digits.slice(1)}`;
  if (!/^234\d{10}$/.test(digits)) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
