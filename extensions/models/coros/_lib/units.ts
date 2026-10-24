// Units as a person says them, converted to the units Coros stores.
//
// Coros takes every pace in integer seconds per kilometre and every distance in
// metres. People in the US say "7:10 a mile" and "two miles easy". The gap
// between those is exactly where an agent composing a workout goes wrong: it
// rounds a mile pace into the km field, or hands over 800 where it meant 800
// metres in a field expecting seconds. So the conversion happens here, once,
// in code with tests, rather than in a prompt.

export type UnitSystem = "imperial" | "metric";

const METRES_PER_MILE = 1609.344;

/** Seconds from "m:ss" or "h:mm:ss". Returns null for anything else. */
export function clockSeconds(s: string): number | null {
  const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, h, min, sec] = m;
  if (Number(sec) >= 60) return null;
  if (h !== undefined && Number(min) >= 60) return null;
  return Number(h ?? 0) * 3600 + Number(min) * 60 + Number(sec);
}

/**
 * A pace as seconds per kilometre.
 *
 * Accepts "7:10/mi", "7:10 /mile", "4:30/km", or a bare "7:10", which takes the
 * unit system's default. A bare pace is allowed because that is how people say
 * it, and the default is a deliberate per-instance setting rather than a guess.
 */
export function paceSecPerKm(input: string, units: UnitSystem): number {
  const m = input.trim().toLowerCase().match(
    /^(\d+:\d{2})\s*(?:\/\s*|per\s+)?(km|k|mi|mile)?$/,
  );
  const secs = m ? clockSeconds(m[1]) : null;
  if (!m || secs === null) {
    throw new Error(
      `cannot read pace "${input}" — write it like "7:10/mi" or "4:30/km"`,
    );
  }
  const unit = m[2] ?? (units === "imperial" ? "mi" : "km");
  const perKm = unit === "mi" || unit === "mile"
    ? secs / (METRES_PER_MILE / 1000)
    : secs;
  return Math.round(perKm);
}

/**
 * A pace range as [slow, fast] seconds per kilometre.
 *
 * "7:20-7:00/mi" puts the unit once, at the end, and it applies to both ends.
 * A single pace is a range of one value, which is what Coros wants for "hold
 * 7:10" — widening it would change the workout.
 */
export function paceRange(input: string, units: UnitSystem): [number, number] {
  const unitMatch = input.trim().match(/\s*(\/\s*|per\s+)?(km|k|mi|mile)$/i);
  const suffix = unitMatch ? unitMatch[0] : "";
  const body = unitMatch ? input.trim().slice(0, -suffix.length) : input.trim();
  const parts = body.split(/\s*(?:-|–|to)\s*/);
  if (parts.length > 2) throw new Error(`cannot read pace range "${input}"`);
  const values = parts.map((p) => paceSecPerKm(p + suffix, units));
  const a = values[0];
  const b = values[1] ?? a;
  // Larger seconds-per-km is slower. Coros accepts either order for absolute
  // ranges, but a stable order keeps stored data comparable.
  return [Math.max(a, b), Math.min(a, b)];
}

/** Metres from "800m", "1.5 km", "2mi", "10k". A bare number is refused. */
export function distanceMetres(input: string): number {
  const m = input.trim().toLowerCase().match(
    /^(\d+(?:\.\d+)?)\s*(m|meters?|metres?|km|k|mi|miles?)$/,
  );
  if (!m) {
    throw new Error(
      `cannot read distance "${input}" — give a unit, like "800m", "2km" or "1.5mi"`,
    );
  }
  const n = Number(m[1]);
  const unit = m[2];
  const metres = unit.startsWith("mi")
    ? n * METRES_PER_MILE
    : unit === "km" || unit === "k"
    ? n * 1000
    : n;
  return Math.round(metres);
}

/** Seconds from "90s", "10min", "10 minutes", "1h", "10:00", "1:05:00". */
export function durationSeconds(input: string): number {
  const s = input.trim().toLowerCase();
  const clock = clockSeconds(s);
  if (clock !== null) return clock;
  const m = s.match(
    /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in(?:utes?|s)?)?)?\s*(?:(\d+)\s*s(?:ec(?:onds?|s)?)?)?$/,
  );
  if (!m || (!m[1] && !m[2] && !m[3])) {
    throw new Error(
      `cannot read duration "${input}" — write it like "10min", "90s" or "10:00"`,
    );
  }
  return Math.round(
    Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0),
  );
}

/** "1:05:00" or "7:10" style, for prose shown back to the athlete. */
export function formatClock(totalSeconds: number): string {
  const t = Math.round(totalSeconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Seconds per km rendered in the athlete's own unit, e.g. "7:10/mi". */
export function formatPace(secPerKm: number, units: UnitSystem): string {
  return units === "imperial"
    ? `${formatClock(secPerKm * METRES_PER_MILE / 1000)}/mi`
    : `${formatClock(secPerKm)}/km`;
}

/** Metres rendered the way a runner would say them. */
export function formatDistance(metres: number, units: UnitSystem): string {
  // Track distances read better in metres in either system: nobody runs
  // "0.25 mi repeats".
  if (
    metres < 1600 || metres % 100 === 0 && metres < 5000 && units === "metric"
  ) {
    return `${metres} m`;
  }
  if (units === "imperial") {
    const mi = metres / METRES_PER_MILE;
    return `${Number(mi.toFixed(2))} mi`;
  }
  return `${Number((metres / 1000).toFixed(2))} km`;
}

/** Normalise "2026-10-24" or "20261024" to Coros's yyyyMMdd. */
export function corosDate(input: string): string {
  const m = input.trim().match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!m) throw new Error(`cannot read date "${input}" — use YYYY-MM-DD`);
  return `${m[1]}${m[2]}${m[3]}`;
}

/** Coros's yyyyMMdd back to ISO, for data keys people will query. */
export function isoDate(coros: string): string {
  const m = String(coros).match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!m) throw new Error(`not a date: "${coros}"`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}
