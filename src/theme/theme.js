// Design tokens extracted from SACHIKO2's web app (public/css/common.css,
// tableDisp.css, login.css) so this native app matches its visual identity
// instead of reading as a generic RN app. Sachiko shares the same navy
// palette as FAIRTECH-ERP's own web app (#044A78 primary, #03365A dark) --
// both are forks of the same ERP codebase -- so these values are identical
// to FairtechOperatorApp's own theme.js by design, not coincidence.
//
// Font: the web app uses Poppins everywhere (`* { font-family: "poppins" }`).
// No .ttf/.otf build of Poppins was available to bundle without a font
// conversion step this pass skipped (only woff/woff2 could be sourced) --
// FONT_FAMILY falls back to the platform default sans-serif for now. Drop
// Poppins-Regular/Medium/SemiBold/Bold.ttf into assets/fonts/, link them
// (`npx react-native-asset`), and set FONT_FAMILY below to switch over later
// without touching every screen.
export const FONT_FAMILY = undefined; // undefined -> RN's platform default (Roboto on Android)

export const colors = {
  primary: '#044A78', // Sachiko navy -- header bars, primary buttons, brand mark
  primaryDark: '#03365A', // hover/active shade
  success: '#10B981', // "start"/go actions, Start Production, punch buttons
  danger: '#EF4444', // per-row stop punch button
  disabled: '#9CA3AF', // greyed-out action of any variant
  dangerStrong: '#DC2626', // short-allotment status text, hard errors
  warning: '#D97706', // over-allotted badge
  warningText: '#B45309', // roll-note warning text (scanned roll not on this job)
  rowMatchBg: '#DCFCE7', // fully-allotted row tint
  rowShortBg: '#FEE2E2', // short-allotted row tint
  noticeBg: '#FFF8E1',
  noticeBorder: '#F0C36D',
  noticeText: '#7A5B00',
  border: '#E2E8F0',
  borderLight: '#E5E7EB',
  cardBg: '#FFFFFF',
  headerRowBg: '#F8FAFC',
  infoPanelBg: '#F0F7FF',
  // Advance order -- a job set before its sales order was placed. The web
  // app flags it in the same cornflowerblue (.adv-tag in common.css).
  advance: '#6495ED',
  advanceBg: '#EAF1FD',
  advanceText: '#1E3A8A',
  // A job on hold (Pause) -- slate, the same as the WIP tab's "Paused" on the
  // web: not a warning, just stopped.
  hold: '#475569',
  holdBg: '#F1F5F9',
  holdBorder: '#CBD5E1',
  holdText: '#334155',
  textDark: '#1F2A44',
  textMuted: '#6B7280',
  background: '#F4F7FB',
};

export const radii = {
  sm: 6, // buttons/cards -- ~0.5rem convention on the web app's 12px-rem base
  md: 10, // cards
  lg: 14, // dialogs/modals
  pill: 999, // count badges
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
};

export const theme = { colors, radii, spacing, fontFamily: FONT_FAMILY };

export default theme;
