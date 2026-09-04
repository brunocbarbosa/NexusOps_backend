import type { TicketResponse } from '../tickets/ticket-response';

/**
 * The columns, in order. A tuple rather than a loop over `Object.keys`, because
 * a CSV whose column order depends on property order is a CSV that reorders
 * itself the day somebody rearranges a type.
 */
const COLUMNS = [
  'number',
  'title',
  'status',
  'priority',
  'category',
  'requester',
  'assignee',
  'createdAt',
  'resolvedAt',
  'closedAt',
] as const;

/**
 * RFC 4180 quoting: wrap in double quotes, and double any quote inside.
 *
 * Every field is quoted rather than only the ones that need it. Conditional
 * quoting means a rule about which characters are special, and getting that
 * rule slightly wrong produces a file that opens fine until one ticket title
 * contains a comma.
 *
 * The leading-character guard is not about CSV at all: a cell beginning with
 * `=`, `+`, `-` or `@` is executed as a formula when the file is opened in
 * Excel or Sheets, so a ticket titled `=cmd|...` becomes an injection into
 * whoever downloads the report. Prefixing a single quote is the standard
 * defence and is invisible in the spreadsheet.
 */
/**
 * Narrow on purpose rather than `unknown`: `String(someObject)` yields
 * "[object Object]" and would put it in a cell without complaining. Spelling
 * out what a cell may hold makes adding a column that carries an object a
 * compile error instead of a line in a customer's spreadsheet.
 */
type Cell = string | number | boolean | Date | null | undefined;

function cell(value: Cell): string {
  if (value === null || value === undefined) return '""';

  const text = value instanceof Date ? value.toISOString() : String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;

  return `"${guarded.replace(/"/g, '""')}"`;
}

export function ticketsToCsv(tickets: TicketResponse[]): string {
  const header = COLUMNS.map(cell).join(',');

  const rows = tickets.map((ticket) =>
    [
      ticket.number,
      ticket.title,
      ticket.status,
      ticket.priority,
      ticket.category,
      ticket.requester.email,
      ticket.assignee?.email ?? null,
      ticket.createdAt,
      ticket.resolvedAt,
      ticket.closedAt,
    ]
      .map(cell)
      .join(','),
  );

  // CRLF, which is what RFC 4180 says and what Excel expects.
  return [header, ...rows].join('\r\n');
}
