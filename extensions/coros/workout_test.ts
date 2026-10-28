/**
 * Workout conversion: units, COROS's rule matrix, and the error messages.
 *
 * Run with: ~/.swamp/deno/deno test
 */
import { assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import {
  distanceMetres,
  durationSeconds,
  formatPace,
  paceRange,
  paceSecPerKm,
} from "./_lib/units.ts";
import { toCourse, type WorkoutSpec } from "./_lib/workout.ts";

Deno.test("mile pace converts to seconds per km, rounded", () => {
  // 7:10/mi = 430 s per 1.609344 km = 267.19 s/km.
  assertEquals(paceSecPerKm("7:10/mi", "imperial"), 267);
  assertEquals(paceSecPerKm("4:30/km", "imperial"), 270);
  // A bare pace takes the unit system's default.
  assertEquals(paceSecPerKm("7:10", "imperial"), 267);
  assertEquals(paceSecPerKm("7:10", "metric"), 430);
  assertEquals(paceSecPerKm("6:30 per mile", "metric"), 242);
});

Deno.test("pace ranges put the unit once and store slow before fast", () => {
  assertEquals(paceRange("7:00-7:20/mi", "imperial"), [273, 261]);
  assertEquals(paceRange("7:20 - 7:00 /mi", "imperial"), [273, 261]);
  assertEquals(paceRange("4:30/km", "imperial"), [270, 270]);
});

Deno.test("distances need a unit; a bare number is refused", () => {
  assertEquals(distanceMetres("800m"), 800);
  assertEquals(distanceMetres("1.5 mi"), 2414);
  assertEquals(distanceMetres("10k"), 10000);
  assertThrows(() => distanceMetres("800"), Error, "give a unit");
});

Deno.test("durations in every common spelling", () => {
  assertEquals(durationSeconds("90s"), 90);
  assertEquals(durationSeconds("10min"), 600);
  assertEquals(durationSeconds("10 minutes"), 600);
  assertEquals(durationSeconds("10:00"), 600);
  assertEquals(durationSeconds("1:05:00"), 3900);
  assertEquals(durationSeconds("1h 5min"), 3900);
  assertThrows(() => durationSeconds("ten minutes"));
});

Deno.test("formatPace round-trips the athlete's unit", () => {
  assertEquals(formatPace(267, "imperial"), "7:10/mi");
  assertEquals(formatPace(270, "metric"), "4:30/km");
});

const track: WorkoutSpec = {
  name: "6 x 800m",
  sport: "run",
  steps: [
    { kind: "warmup", distance: "1.5mi", hrZone: 2 },
    {
      repeat: 6,
      steps: [
        { kind: "work", distance: "800m", pace: "6:50/mi" },
        { kind: "recover", distance: "400m", hrZone: 1 },
      ],
    },
    { kind: "cooldown", distance: "1mi", hrZone: 1 },
  ],
};

Deno.test("a track session becomes the course COROS expects", () => {
  const c = toCourse(track, "imperial");
  assertEquals(c.sportType, 1);
  assertEquals(c.courseName, "6 x 800m");
  assertEquals(c.sections, [
    { sectionType: 1, targetType: 1, targetValue: 2414, intensityType: 1, sectionIntensity: 2 },
    {
      intervalGroup: true,
      repeats: 6,
      sets: [
        { sectionType: 2, targetType: 1, targetValue: 800, intensityType: 2, intensityValueStart: 255, intensityValueEnd: 255 },
        { sectionType: 3, targetType: 1, targetValue: 400, intensityType: 1, sectionIntensity: 1 },
      ],
    },
    { sectionType: 4, targetType: 1, targetValue: 1609, intensityType: 1, sectionIntensity: 1 },
  ]);
});

Deno.test("the generated description is plain words in the athlete's units", () => {
  const c = toCourse(track, "imperial");
  assertEquals(
    c.courseDescription,
    "Warm up 1.5 mi in heart-rate zone 2; 6 x (800 m at 6:50/mi, recover 400 m in heart-rate zone 1); Cool down 1 mi in heart-rate zone 1.",
  );
  // No field names or enum numbers leak into what the athlete reads.
  assertEquals(/sectionType|intensityType|\b[0-9]=/.test(c.courseDescription), false);
});

Deno.test("a given description is used as written", () => {
  const c = toCourse({ ...track, description: "Goal-pace 800s." }, "imperial");
  assertEquals(c.courseDescription, "Goal-pace 800s.");
});

Deno.test("open steps send free mode and no target value", () => {
  const c = toCourse({
    name: "Strides",
    steps: [{ kind: "warmup", open: true, hrZone: 1 }, { kind: "work", time: "20s", pace: "5:30/mi" }],
  }, "imperial");
  assertEquals(c.sections[0], { sectionType: 1, targetType: 4, intensityType: 1, sectionIntensity: 1 });
});

Deno.test("a step with no intensity omits every intensity field, never sends 0", () => {
  const c = toCourse({ name: "Easy", steps: [{ kind: "work", time: "40min" }] }, "imperial");
  assertEquals(c.sections[0], { sectionType: 2, targetType: 2, targetValue: 2400 });
});

Deno.test("COROS's rules are enforced before anything is sent", () => {
  const bad = (steps: WorkoutSpec["steps"], sport: WorkoutSpec["sport"] = "run") =>
    () => toCourse({ name: "x", sport, steps }, "imperial");

  assertThrows(bad([{ kind: "work" }]), Error, "step 1: give one target");
  assertThrows(bad([{ kind: "work", time: "5min", distance: "1km" }]), Error, "not distance and time");
  assertThrows(bad([{ kind: "work", time: "5min", pace: "7:00/mi", hrZone: 3 }]), Error, "give one intensity");
  assertThrows(bad([{ kind: "work", time: "20min" }], "trail"), Error, "time targets on trail runs");
  assertThrows(bad([{ kind: "work", time: "5min", pace: "7:00/mi" }], "bike"), Error, "pace targets are not allowed for bike");
  assertThrows(bad([{ kind: "work", time: "5min", powerZone: 3 }]), Error, "running power takes watts");
  assertThrows(bad([{ kind: "work", time: "5min", hr: "250" }]), Error, "heart rate 250 is outside");
  assertThrows(bad([{ kind: "work", time: "5min", pace: "1:00/km" }]), Error, "outside 120-1499");
  assertThrows(bad([{ kind: "work", time: "5min", hrPercent: [90, 85] }]), Error, "start < end");
  assertThrows(bad([{ kind: "work", time: "5min", hrPercent: [100, 125] }]), Error, "<= 120");
});

Deno.test("repeats allow only work and recover, and the error names the step", () => {
  const e = assertThrows(() =>
    toCourse({
      name: "x",
      steps: [{ kind: "warmup", time: "10min" }, { repeat: 3, steps: [{ kind: "work", time: "1min" }, { kind: "cooldown", time: "1min" }] }],
    }, "imperial")
  );
  assertStringIncludes((e as Error).message, "step 2.2");
  assertStringIncludes((e as Error).message, "not cooldown");
});

Deno.test("repeats are capped at 20, as COROS caps them", () => {
  assertThrows(() =>
    toCourse({ name: "x", steps: [{ repeat: 21, steps: [{ kind: "work", distance: "200m" }] }] }, "imperial")
  );
});

Deno.test("trail runs take climb targets in metres", () => {
  const c = toCourse({ name: "Hill repeats", sport: "trail", steps: [{ kind: "work", climb: "30m", hrZone: 4 }] }, "imperial");
  assertEquals(c.sportType, 5);
  assertEquals(c.sections[0].targetType, 3);
  assertEquals(c.sections[0].targetValue, 30);
});
