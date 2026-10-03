import fs from "node:fs";
import path from "node:path";

export interface CsvExercise {
  /** One-based source record order, retained as the final stable tie-breaker. */
  sourceIndex: number;
  exercise: string;
  machine: string;
  muscle: string;
  muscleCategories: string[];
  /** Dataset's exact one-set duration string, retained without interpretation. */
  timeTakenOneSet: string;
  /** Dataset's exact targeted-muscle cell and parsed individual values. */
  targetedMuscle: string;
  targetedMuscles: string[];
  /** Present in the curated alternatives dataset; all six rows share a group. */
  alternativeGroupId?: string;
  /** Rank 1 is the source exercise; ranks 2–6 are its five alternatives. */
  alternativeRank?: number;
}

export function normalizeExerciseValue(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function parseCsvRecords(source: string): string[][] {
  const text = source.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuotedField = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        closedQuotedField = true;
      } else {
        field += character;
      }
      continue;
    }

    if (closedQuotedField && character !== "," && character !== "\n" && character !== "\r") {
      throw new Error("Unexpected characters after a quoted CSV field.");
    }

    if (character === '"') {
      if (field.length !== 0) throw new Error("Unexpected quote in unquoted CSV field.");
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
      closedQuotedField = false;
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim() !== "")) records.push(row);
      row = [];
      field = "";
      closedQuotedField = false;
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("CSV ends inside a quoted field.");
  row.push(field);
  if (row.some((value) => value.trim() !== "")) records.push(row);
  return records;
}

export function parseExerciseCsv(source: string): CsvExercise[] {
  let records: string[][];
  try {
    records = parseCsvRecords(source);
  } catch (error) {
    throw new Error(`Bundled exercise CSV is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (records.length === 0) throw new Error("Bundled exercise CSV is empty.");

  const headers = records[0].map((header) => normalizeExerciseValue(header));
  const indexes = new Map<string, number>();
  headers.forEach((header, index) => {
    if (indexes.has(header)) throw new Error(`Bundled exercise CSV has a duplicate "${header}" column.`);
    indexes.set(header, index);
  });
  for (const required of ["exercise", "machine", "muscle"]) {
    if (!indexes.has(required)) throw new Error(`Bundled exercise CSV is missing the required "${required}" column.`);
  }
  const timeIndex = indexes.get("time taken 1 set");
  const targetedMuscleIndex = indexes.get("targeted muscle");
  const alternativeGroupIndex = indexes.get("alternative group id");
  const alternativeRankIndex = indexes.get("alternative rank");

  const exercises: CsvExercise[] = [];
  for (const [recordIndex, record] of records.slice(1).entries()) {
    if (record.length !== headers.length) {
      throw new Error(`Bundled exercise CSV record ${recordIndex + 2} has ${record.length} fields; expected ${headers.length}.`);
    }
    // Keep the original cell values for API/display. Normalization is applied
    // only when matching or validating them.
    const exercise = record[indexes.get("exercise")!];
    const machine = record[indexes.get("machine")!];
    const muscle = record[indexes.get("muscle")!];
    if (!exercise || !machine || !muscle) {
      throw new Error(`Bundled exercise CSV record ${recordIndex + 2} must include exercise, machine, and muscle values.`);
    }

    const muscleCategories = [...new Map(
      muscle.split(",").map((category) => category.trim()).filter(Boolean)
        .map((category) => [normalizeExerciseValue(category), category] as const)
    ).values()];
    if (muscleCategories.length === 0) {
      throw new Error(`Bundled exercise CSV record ${recordIndex + 2} has no muscle categories.`);
    }
    const timeTakenOneSet = timeIndex === undefined ? "" : record[timeIndex].trim();
    const targetedMuscle = targetedMuscleIndex === undefined ? "" : record[targetedMuscleIndex].trim();
    const alternativeGroupId = alternativeGroupIndex === undefined ? undefined : record[alternativeGroupIndex].trim();
    const alternativeRankValue = alternativeRankIndex === undefined ? undefined : Number(record[alternativeRankIndex]);
    const targetedMuscles = [...new Map(
      targetedMuscle.split(",").map((value) => value.trim()).filter(Boolean)
        .map((value) => [normalizeExerciseValue(value), value] as const)
    ).values()];
    exercises.push({
      sourceIndex: recordIndex + 2,
      exercise,
      machine,
      muscle,
      muscleCategories,
      timeTakenOneSet,
      targetedMuscle,
      targetedMuscles,
      ...(alternativeGroupId ? { alternativeGroupId } : {}),
      ...(alternativeRankValue !== undefined && Number.isInteger(alternativeRankValue)
        ? { alternativeRank: alternativeRankValue }
        : {}),
    });
  }
  if (exercises.length === 0) throw new Error("Bundled exercise CSV contains no exercise records.");
  return exercises;
}

export class CsvExerciseRepository {
  private cachedExercises?: readonly CsvExercise[];

  constructor(
    private readonly csvPath = path.resolve(__dirname, "../../../data/exercises.csv"),
    private readonly readFile: (filePath: string) => string = (filePath) => fs.readFileSync(filePath, "utf8"),
  ) {}

  getAll(): readonly CsvExercise[] {
    if (this.cachedExercises) return this.cachedExercises;
    let source: string;
    try {
      source = this.readFile(this.csvPath);
    } catch (error) {
      throw new Error(`Unable to read bundled exercise CSV at ${this.csvPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.cachedExercises = Object.freeze(parseExerciseCsv(source).map((row) => Object.freeze(row)));
    return this.cachedExercises;
  }
}

export const csvExerciseRepository = new CsvExerciseRepository();

export const csvExerciseAlternativesRepository = new CsvExerciseRepository(
  path.resolve(__dirname, "../../../data/exercise_alternatives.csv"),
);
