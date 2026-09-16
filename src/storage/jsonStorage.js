import AsyncStorage from '@react-native-async-storage/async-storage';

export async function getJson(key, fallback) {
  const raw = await AsyncStorage.getItem(key);
  if (raw == null) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}

export async function setJson(key, value) {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

export async function removeJson(key) {
  await AsyncStorage.removeItem(key);
}

export function generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
