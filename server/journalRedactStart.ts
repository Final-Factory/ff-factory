// The portal's first import (w5525): its stdout and stderr, so the journal, redacted before any other module of it loads.
import { redactProcessOutput } from './journalRedact.ts';

redactProcessOutput();
