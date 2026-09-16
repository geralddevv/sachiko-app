// The web app prints ticket/action timestamps with toLocaleString("en-IN").
// Hermes' Intl support is uneven across builds, so this formats the same
// "DD/MM/YYYY, hh:mm am/pm" shape by hand rather than relying on it.
export function formatDateTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const pad = n => String(n).padStart(2, '0');
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  let hours = d.getHours();
  const minutes = pad(d.getMinutes());
  const meridiem = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12 || 12;
  return `${day}/${month}/${year}, ${hours}:${minutes} ${meridiem}`;
}
