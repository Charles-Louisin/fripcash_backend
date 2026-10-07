export function courierZoneIds(courier: {
  zoneId?: unknown;
  zoneIds?: unknown[] | null;
} | null | undefined): string[] {
  if (!courier) return [];
  const ids: string[] = [];
  for (const z of courier.zoneIds || []) {
    if (z) ids.push(String(z));
  }
  if (courier.zoneId) ids.push(String(courier.zoneId));
  return [...new Set(ids.filter(Boolean))];
}

export function courierCoversZone(
  courier: { zoneId?: unknown; zoneIds?: unknown[] | null } | null | undefined,
  zoneId: string | null | undefined
): boolean {
  if (!zoneId) return true;
  const ids = courierZoneIds(courier);
  if (ids.length === 0) return false;
  return ids.includes(String(zoneId));
}
