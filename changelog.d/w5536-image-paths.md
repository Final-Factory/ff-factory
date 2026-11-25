- **`/api/image` compares folders case-sensitively on Linux; a report's image must be its own media path** (w5536, audit finding 28):
  Windows and macOS hosts keep the case-insensitive compare. In a report, only `/api/reports/rN/media/<name>` is an image source;
  any other `/api/…` path shows as text.
