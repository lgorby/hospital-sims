/** UI money formatting, one place: "$12,345" / "−$12,345". */
export function money(amount: number): string {
  const rounded = Math.round(amount);
  return `${rounded < 0 ? '−' : ''}$${Math.abs(rounded).toLocaleString('en-US')}`;
}
