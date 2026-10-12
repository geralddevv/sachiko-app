export const STORAGE_KEYS = {
  PRINTERS: '@sachikoop/printers',
  AUTH: '@sachikoop/auth',
  JOB_CARD_DRAFT_PREFIX: '@sachikoop/jobcard_draft:',
  DEVICE: '@sachikoop/device',
  PRINT_QUEUE: '@sachikoop/print_queue',
  OUTBOX: '@sachikoop/outbox',
  // Which Deckle a slitting card has scanned/confirmed but not yet produced, by
  // card id -- so the Scan Deckle field survives leaving and reopening the card.
  SLITTING_ARMED_PREFIX: '@sachikoop/slitting_armed:',
  // The overtime reminder's running Deckle timers (services/overtimeReminder.js).
  OVERTIME_TIMERS: '@sachikoop/overtime_timers',
};
