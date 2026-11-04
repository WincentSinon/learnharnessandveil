/** Reader uploads are separate from the smaller notes-import allowance. */
export const MAX_READER_PDF_BYTES = 100 * 1024 * 1024;
export const MAX_READER_STATE_BYTES = 8 * 1024 * 1024;
export const MAX_READER_BODY_BYTES = MAX_READER_PDF_BYTES + MAX_READER_STATE_BYTES + 1024 * 1024;
// Proxy truncates rather than rejecting, so leave room for the route to return 413.
export const MAX_DESKTOP_PROXY_BODY_BYTES = MAX_READER_BODY_BYTES + 1024 * 1024;
