import { STORAGE_KEYS } from '../constants/storageKeys';
import { DEFAULT_PORT, DEFAULT_TIMEOUT_MS } from '../constants/printer';
import { getJson, setJson, generateId } from './jsonStorage';

export function emptyPrinter() {
  return {
    id: null,
    name: 'TSC Printer',
    ip: '',
    port: DEFAULT_PORT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    autoReconnect: true,
    isDefault: false,
  };
}

export async function getPrinters() {
  return getJson(STORAGE_KEYS.PRINTERS, []);
}

export async function getPrinter(id) {
  const printers = await getPrinters();
  return printers.find(printer => printer.id === id) ?? null;
}

export async function getDefaultPrinter() {
  const printers = await getPrinters();
  return printers.find(printer => printer.isDefault) ?? printers[0] ?? null;
}

export async function savePrinter(printer) {
  const printers = await getPrinters();
  const isNew = !printer.id;
  const record = { ...emptyPrinter(), ...printer, id: printer.id ?? generateId('printer') };

  const shouldBeDefault = record.isDefault || printers.length === 0;
  let next = printers.some(p => p.id === record.id)
    ? printers.map(p => (p.id === record.id ? record : p))
    : [...printers, record];

  if (shouldBeDefault) {
    next = next.map(p => ({ ...p, isDefault: p.id === record.id }));
  }

  await setJson(STORAGE_KEYS.PRINTERS, next);
  return isNew ? { ...record, isDefault: shouldBeDefault } : record;
}

export async function deletePrinter(id) {
  const printers = await getPrinters();
  const wasDefault = printers.find(p => p.id === id)?.isDefault;
  let next = printers.filter(printer => printer.id !== id);
  if (wasDefault && next.length > 0) {
    next = next.map((p, index) => ({ ...p, isDefault: index === 0 }));
  }
  await setJson(STORAGE_KEYS.PRINTERS, next);
}

export async function setDefaultPrinter(id) {
  const printers = await getPrinters();
  const next = printers.map(printer => ({ ...printer, isDefault: printer.id === id }));
  await setJson(STORAGE_KEYS.PRINTERS, next);
}
