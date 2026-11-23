import { uuid } from "../core/ids.ts";
import type { Db } from "../db/pool.ts";

export interface StationSeed {
  authority: string;
  externalId: string;
  cityLabel?: string;
  localZone?: string;
  kind?: string;
  aliases?: { alias: string; documented?: boolean }[];
}

/** Reference catalogue: stations and aliases are product data, desk-independent. */
export const REFERENCE_STATIONS: StationSeed[] = [
  {
    authority: "NOAA/NDBC",
    externalId: "46002",
    cityLabel: "West Oregon buoy",
    localZone: "America/Los_Angeles",
    kind: "buoy",
    aliases: [{ alias: "ndbc-46002", documented: true }, { alias: "west-oregon-buoy", documented: true }],
  },
  {
    authority: "NOAA/NDBC",
    externalId: "46050",
    cityLabel: "Stonewall Bank buoy",
    localZone: "America/Los_Angeles",
    kind: "buoy",
    aliases: [{ alias: "stonewall-bank", documented: true }],
  },
  {
    authority: "training-source",
    externalId: "EXAMPLE-A",
    cityLabel: "Example City A",
    localZone: "Asia/Shanghai",
    aliases: [{ alias: "example-a", documented: true }, { alias: "example-city", documented: false }],
  },
  {
    authority: "training-source",
    externalId: "EXAMPLE-B",
    cityLabel: "Example City B",
    localZone: "Asia/Shanghai",
    aliases: [{ alias: "example-b", documented: true }, { alias: "example-city", documented: false }],
  },
  {
    authority: "CMA",
    externalId: "ZBAA",
    cityLabel: "Beijing Capital Intl",
    localZone: "Asia/Shanghai",
    aliases: [{ alias: "beijing-airport", documented: true }],
  },
  {
    authority: "CMA",
    externalId: "ZBBB",
    cityLabel: "Beijing Daxing",
    localZone: "Asia/Shanghai",
    aliases: [{ alias: "beijing-airport", documented: true }],
  },
];

export async function seedCatalog(db: Db): Promise<{ stations: number }> {
  let count = 0;
  for (const s of REFERENCE_STATIONS) {
    const { rows } = await db.query(
      `INSERT INTO stations(id, authority, external_id, city_label, local_zone, kind)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (authority, external_id) DO UPDATE SET city_label=EXCLUDED.city_label
       RETURNING id`,
      [uuid(), s.authority, s.externalId, s.cityLabel ?? null, s.localZone ?? null, s.kind ?? "station"],
    );
    const stationId = rows[0].id as string;
    count++;
    for (const a of s.aliases ?? []) {
      await db.query(
        `INSERT INTO station_aliases(id, alias, station_id, documented)
         VALUES ($1,$2,$3,$4) ON CONFLICT (alias, station_id) DO NOTHING`,
        [uuid(), a.alias, stationId, a.documented ?? false],
      );
    }
  }
  return { stations: count };
}
